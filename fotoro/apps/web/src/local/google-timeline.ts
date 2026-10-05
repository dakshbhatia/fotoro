// Observed file formats, not a Google API or a guaranteed export schema:
// https://github.com/kurupted/google-maps-timeline-viewer/tree/main/sample_data/Local_format/iOS
// https://github.com/hossain-khan/kgeo-device-timeline/blob/main/lib/src/test/resources/test-data.json
// https://github.com/GPSBabel/gpsbabel/blob/master/googletakeout.cc
// https://github.com/CarlosBergillos/LocationHistoryFormat/blob/main/schemas/Records.schema.json
// Parsing and matching are ephemeral. Callers save only confirmed photo annotations;
// this module does not retain the file, write image bytes, store history, or use a network.
export const MAX_TIMELINE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_INTERVAL_MS = 31 * 86_400_000;
const POINT_WINDOW_MS = 5 * 60_000;
const MATCH_ACCURACY_METERS = 100;
type RecordValue = Record<string, unknown>;
interface TimelineCoordinates {
  latitude: number;
  longitude: number;
  name?: string;
  accuracyMeters?: number;
}
export interface TimelinePoint extends TimelineCoordinates {at: string}
export interface TimelineVisit extends TimelineCoordinates {start: string; end: string}
export interface GoogleTimelineData {
  format: "device-ios" | "device-semantic-segments" | "takeout-timeline-objects" | "takeout-locations";
  points: TimelinePoint[];
  visits: TimelineVisit[];
  // entryCount includes top-level segments/records/rawSignals. skippedCount also
  // includes invalid nested path points; it can exceed the top-level entry count.
  summary: {entryCount: number; pointCount: number; visitCount: number; skippedCount: number; duplicateCount: number};
}
export interface TimelinePhoto {
  id: string;
  date: string;
  dateSource?: string;
  captureVerified?: true;
  captureTimezoneVerified?: true;
  location?: unknown;
}
export interface TimelineCandidate {
  photoID: string;
  location: TimelineCoordinates & {source: "google-timeline"};
  basis: "point" | "visit";
  capturedAt: string;
  evidenceStart: string;
  evidenceEnd: string;
}
export interface GoogleTimelinePreview {
  candidates: TimelineCandidate[];
  summary: {photoCount: number; candidateCount: number; existingLocationCount: number; unverifiedTimestampCount: number; ambiguousCount: number; unmatchedCount: number};
}
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const iso = (at: number) => new Date(at).toISOString();
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function absoluteTime(value: unknown): number | undefined {
  if (typeof value !== "string") return;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const offsetHours = Number(parts[10] ?? 0), offsetMinutes = Number(parts[11] ?? 0);
  // -00:00 denotes an unknown offset in RFC 3339, so cannot verify an instant.
  if (parts[8] === "-00:00" || offsetHours > 14 || offsetMinutes > 59 || offsetHours === 14 && offsetMinutes !== 0) return;
  const calendar = new Date(`${value.slice(0, 19)}Z`), at = Date.parse(value);
  if (!Number.isFinite(at) || ![calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()].every((part, index) => part === [year, month, day, hour, minute, second][index])) return;
  return at;
}
function milliseconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,15}$/.test(value)) return;
  const at = Number(value);
  return Number.isSafeInteger(at) && at <= 253402300799999 ? at : undefined;
}
function recordTime(record: RecordValue): number | undefined {
  const at = record.timestamp === undefined ? undefined : absoluteTime(record.timestamp);
  const ms = record.timestampMs === undefined ? undefined : milliseconds(record.timestampMs);
  if (record.timestamp !== undefined && at === undefined || record.timestampMs !== undefined && ms === undefined || at !== undefined && ms !== undefined && at !== ms) return;
  return at ?? ms;
}
function coordinates(latitude: unknown, longitude: unknown): TimelineCoordinates | undefined {
  if (!finite(latitude) || !finite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
  return {latitude: latitude === 0 ? 0 : latitude, longitude: longitude === 0 ? 0 : longitude};
}
function coordinateText(value: unknown): TimelineCoordinates | undefined {
  if (typeof value !== "string" || value.length > 100) return;
  const parts = /^(?:geo:)?\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*,\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*$/.exec(value);
  return parts ? coordinates(Number(parts[1]), Number(parts[2])) : undefined;
}
function coordinateE7(value: unknown): TimelineCoordinates | undefined {
  const record = object(value);
  if (!record || !finite(record.latitudeE7) || !Number.isInteger(record.latitudeE7) || !finite(record.longitudeE7) || !Number.isInteger(record.longitudeE7)) return;
  return coordinates(record.latitudeE7 / 1e7, record.longitudeE7 / 1e7);
}
function accuracy(value: unknown): number | undefined | false {
  if (value === undefined) return;
  return finite(value) && value >= 0 && value <= 100_000 ? value : false;
}
function name(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}
function probableVisit(value: unknown): boolean {
  if (value === undefined) return true;
  const probability = typeof value === "string" && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value) ? Number(value) : value;
  return finite(probability) && probability >= 0.5 && probability <= 1;
}
function interval(startValue: unknown, endValue: unknown): {start: number; end: number} | undefined {
  const start = absoluteTime(startValue), end = absoluteTime(endValue);
  return start !== undefined && end !== undefined && end > start && end - start <= MAX_INTERVAL_MS ? {start, end} : undefined;
}
function boundedJSON(input: Uint8Array | string): unknown {
  let text: string;
  if (typeof input === "string") {
    if (input.length > MAX_TIMELINE_BYTES || new TextEncoder().encode(input).length > MAX_TIMELINE_BYTES) throw new Error("Choose a Timeline JSON file smaller than 20 MiB.");
    text = input;
  } else {
    if (input.byteLength > MAX_TIMELINE_BYTES) throw new Error("Choose a Timeline JSON file smaller than 20 MiB.");
    try {text = new TextDecoder("utf-8", {fatal: true}).decode(input);}
    catch {throw new Error("This Timeline file is not valid UTF-8 JSON.");}
  }
  // Bound nesting before JSON.parse's reviver traverses untrusted objects. Braces
  // inside strings do not contribute; malformed syntax is rejected by JSON.parse.
  let depth = 0, quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") {if (++depth > 64) throw new Error("This Timeline JSON is nested too deeply.");}
    else if (character === "]" || character === "}") depth--;
  }
  try {
    return JSON.parse(text, (key: string, value: unknown) => {
      if (key === "__proto__" || key === "prototype" || key === "constructor" || typeof value === "number" && !Number.isFinite(value)) throw new Error("unsafe");
      if (Array.isArray(value) && value.length > MAX_ENTRIES) throw new Error("limit");
      return value;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "limit") throw new Error("Choose a Timeline export with at most 100,000 entries and points.");
    throw new Error("This Timeline file contains invalid or unsafe JSON.");
  }
}
export async function parseGoogleTimelineFile(file: Blob): Promise<GoogleTimelineData> {
  if (file.size > MAX_TIMELINE_BYTES) throw new Error("Choose a Timeline JSON file smaller than 20 MiB.");
  return parseGoogleTimeline(new Uint8Array(await file.arrayBuffer()));
}
export function parseGoogleTimeline(input: Uint8Array | string): GoogleTimelineData {
  const raw = boundedJSON(input), root = object(raw);
  let format: GoogleTimelineData["format"], entries: unknown[], rawSignals: unknown[] = [];
  if (Array.isArray(raw)) {format = "device-ios"; entries = raw;}
  else {
    const formats = root && ["semanticSegments", "timelineObjects", "locations"].filter(key => Object.hasOwn(root, key));
    if (!root || !formats || formats.length !== 1 || !Array.isArray(root[formats[0]])) throw new Error("This Timeline export format is not supported. Choose the JSON exported by Google Maps.");
    entries = root[formats[0]] as unknown[];
    format = formats[0] === "semanticSegments" ? "device-semantic-segments" : formats[0] === "timelineObjects" ? "takeout-timeline-objects" : "takeout-locations";
    if (format === "device-semantic-segments" && root.rawSignals !== undefined) {
      if (!Array.isArray(root.rawSignals)) throw new Error("This Timeline export has invalid raw location signals.");
      rawSignals = root.rawSignals;
    }
  }
  let consumed = 0, skippedCount = 0;
  const reserve = (count: number) => {consumed += count; if (consumed > MAX_ENTRIES) throw new Error("Choose a Timeline export with at most 100,000 entries and points.");};
  reserve(entries.length + rawSignals.length);
  const points: TimelinePoint[] = [], visits: TimelineVisit[] = [];
  const addPoint = (location: TimelineCoordinates | undefined, at: number | undefined, accuracyValue?: unknown) => {
    const accuracyMeters = accuracy(accuracyValue);
    if (!location || at === undefined || accuracyMeters === false) {skippedCount++; return;}
    points.push({...location, ...(accuracyMeters === undefined ? {} : {accuracyMeters}), at: iso(at)});
  };
  const addVisit = (location: TimelineCoordinates | undefined, duration: ReturnType<typeof interval>, nameValue?: unknown, accuracyValue?: unknown) => {
    const accuracyMeters = accuracy(accuracyValue), placeName = name(nameValue);
    if (!location || !duration || accuracyMeters === false) {skippedCount++; return;}
    visits.push({...location, ...(placeName === undefined ? {} : {name: placeName}), ...(accuracyMeters === undefined ? {} : {accuracyMeters}), start: iso(duration.start), end: iso(duration.end)});
  };
  for (const entry of entries) {
    const segment = object(entry);
    if (!segment) {skippedCount++; continue;}
    if (format === "takeout-locations") {addPoint(coordinateE7(segment), recordTime(segment), segment.accuracy); continue;}
    if (format === "takeout-timeline-objects") {
      const visit = object(segment.placeVisit), location = object(visit?.location), duration = object(visit?.duration);
      if (!visit) {skippedCount++; continue;}
      addVisit(coordinateE7(location), interval(duration?.startTimestamp, duration?.endTimestamp), location?.name, location?.accuracy);
      continue;
    }
    const path = segment.timelinePath;
    if (Array.isArray(path)) reserve(path.length);
    const duration = interval(segment.startTime, segment.endTime);
    if (!duration) {skippedCount++; continue;}
    let recognized = false;
    if (segment.visit !== undefined) {
      recognized = true;
      const visit = object(segment.visit), candidate = object(visit?.topCandidate), place = candidate?.placeLocation;
      if (!probableVisit(visit?.probability) || !probableVisit(candidate?.probability)) skippedCount++;
      else addVisit(coordinateText(typeof place === "string" ? place : object(place)?.latLng), duration, candidate?.name, candidate?.accuracyMeters);
    }
    if (path !== undefined) {
      recognized = true;
      if (!Array.isArray(path)) {skippedCount++; continue;}
      for (const item of path) {
        const point = object(item);
        if (!point) {skippedCount++; continue;}
        let at = absoluteTime(point.time);
        if (format === "device-ios" && point.durationMinutesOffsetFromStartTime !== undefined) {
          const value = point.durationMinutesOffsetFromStartTime;
          const offset = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : finite(value) ? value : undefined;
          const relative = offset !== undefined && offset >= 0 ? duration.start + offset * 60_000 : undefined;
          if (relative === undefined || !Number.isSafeInteger(relative) || at !== undefined && at !== relative) {skippedCount++; continue;}
          at = relative;
        }
        if (at === undefined || at < duration.start || at > duration.end || point.time !== undefined && absoluteTime(point.time) === undefined) {skippedCount++; continue;}
        addPoint(coordinateText(point.point), at, point.accuracyMeters);
      }
    }
    if (!recognized) skippedCount++; // Activities and untimed paths are not visits.
  }
  for (const signal of rawSignals) {
    const position = object(object(signal)?.position);
    if (!position) {skippedCount++; continue;}
    addPoint(coordinateText(position.LatLng), absoluteTime(position.timestamp), position.accuracyMeters);
  }
  const order = (a: TimelineCoordinates, b: TimelineCoordinates) => a.latitude - b.latitude || a.longitude - b.longitude || (a.accuracyMeters ?? Infinity) - (b.accuracyMeters ?? Infinity) || compareText(a.name ?? "", b.name ?? "");
  points.sort((a, b) => compareText(a.at, b.at) || order(a, b));
  visits.sort((a, b) => compareText(a.start, b.start) || compareText(a.end, b.end) || order(a, b));
  let duplicateCount = 0;
  const unique = <T extends TimelinePoint | TimelineVisit>(values: T[]) => {
    const seen = new Set<string>();
    return values.filter(value => {const key = JSON.stringify(value); if (seen.has(key)) {duplicateCount++; return false;} seen.add(key); return true;});
  };
  const uniquePoints = unique(points), uniqueVisits = unique(visits);
  return {format, points: uniquePoints, visits: uniqueVisits, summary: {entryCount: entries.length + rawSignals.length, pointCount: uniquePoints.length, visitCount: uniqueVisits.length, skippedCount, duplicateCount}};
}

function distance(a: TimelineCoordinates, b: TimelineCoordinates): number {
  const radians = Math.PI / 180, lat = (b.latitude - a.latitude) * radians, lon = (b.longitude - a.longitude) * radians;
  const square = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, square)), Math.sqrt(Math.max(0, 1 - square)));
}
interface TimedPoint {point: TimelinePoint; at: number}
// Range extrema keep matching bounded when many photos share a dense point trail.
// A 100m box is conservative: distant corners or a dateline crossing skip a match.
class PointBounds {
  private size = 1;
  private minLat: Float64Array;
  private maxLat: Float64Array;
  private minLon: Float64Array;
  private maxLon: Float64Array;
  constructor(points: TimedPoint[]) {
    while (this.size < points.length) this.size *= 2;
    this.minLat = new Float64Array(this.size * 2).fill(Infinity); this.maxLat = new Float64Array(this.size * 2).fill(-Infinity);
    this.minLon = new Float64Array(this.size * 2).fill(Infinity); this.maxLon = new Float64Array(this.size * 2).fill(-Infinity);
    points.forEach(({point}, index) => {const at = this.size + index; this.minLat[at] = this.maxLat[at] = point.latitude; this.minLon[at] = this.maxLon[at] = point.longitude;});
    for (let at = this.size - 1; at > 0; at--) {
      this.minLat[at] = Math.min(this.minLat[at * 2], this.minLat[at * 2 + 1]); this.maxLat[at] = Math.max(this.maxLat[at * 2], this.maxLat[at * 2 + 1]);
      this.minLon[at] = Math.min(this.minLon[at * 2], this.minLon[at * 2 + 1]); this.maxLon[at] = Math.max(this.maxLon[at * 2], this.maxLon[at * 2 + 1]);
    }
  }
  agrees(from: number, to: number, location: TimelineCoordinates): boolean {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    const take = (at: number) => {minLat = Math.min(minLat, this.minLat[at]); maxLat = Math.max(maxLat, this.maxLat[at]); minLon = Math.min(minLon, this.minLon[at]); maxLon = Math.max(maxLon, this.maxLon[at]);};
    for (let left = from + this.size, right = to + this.size; left < right; left = Math.floor(left / 2), right = Math.floor(right / 2)) {
      if (left % 2) take(left++);
      if (right % 2) take(--right);
    }
    return from === to || [minLat, maxLat].every(latitude => [minLon, maxLon].every(longitude => distance(location, {latitude, longitude}) <= MATCH_ACCURACY_METERS));
  }
}
function bound(points: TimedPoint[], at: number, after = false): number {
  let low = 0, high = points.length;
  while (low < high) {const middle = Math.floor((low + high) / 2); if (points[middle].at < at || after && points[middle].at === at) low = middle + 1; else high = middle;}
  return low;
}
export function previewGoogleTimeline(photos: readonly TimelinePhoto[], timeline: GoogleTimelineData): GoogleTimelinePreview {
  if (photos.length > MAX_ENTRIES) throw new Error("Preview at most 100,000 photos at a time.");
  const summary: GoogleTimelinePreview["summary"] = {photoCount: photos.length, candidateCount: 0, existingLocationCount: 0, unverifiedTimestampCount: 0, ambiguousCount: 0, unmatchedCount: 0};
  const candidates: TimelineCandidate[] = [], eligible: {photo: TimelinePhoto; at: number}[] = [];
  const ids = new Map<string, number>();
  for (const photo of photos) ids.set(photo.id, (ids.get(photo.id) ?? 0) + 1);
  for (const photo of photos) {
    if (photo.location !== undefined && photo.location !== null) {summary.existingLocationCount++; continue;}
    const at = absoluteTime(photo.date);
    if (at === undefined || !(photo.dateSource === "photos" || photo.dateSource === "exif" && photo.captureVerified === true && photo.captureTimezoneVerified === true)) {summary.unverifiedTimestampCount++; continue;}
    if (ids.get(photo.id)! > 1) {summary.ambiguousCount++; continue;}
    eligible.push({photo, at});
  }
  eligible.sort((a, b) => a.at - b.at || compareText(a.photo.id, b.photo.id));
  const points = timeline.points.filter(point => point.accuracyMeters !== undefined && point.accuracyMeters <= MATCH_ACCURACY_METERS).map(point => ({point, at: Date.parse(point.at)}));
  points.sort((a, b) => a.at - b.at || a.point.accuracyMeters! - b.point.accuracyMeters! || a.point.latitude - b.point.latitude || a.point.longitude - b.point.longitude);
  const bounds = new PointBounds(points);
  const visits = timeline.visits.map(visit => ({visit, start: Date.parse(visit.start), end: Date.parse(visit.end)})).sort((a, b) => a.start - b.start);
  const ends = [...visits].sort((a, b) => a.end - b.end), active = new Set<typeof visits[number]>();
  let nextStart = 0, nextEnd = 0;
  for (const {photo, at} of eligible) {
    while (nextStart < visits.length && visits[nextStart].start <= at) active.add(visits[nextStart++]);
    while (nextEnd < ends.length && ends[nextEnd].end <= at) active.delete(ends[nextEnd++]);
    // Half-open intervals avoid an overlap at the shared boundary of two visits.
    if (active.size > 1) {summary.ambiguousCount++; continue;}
    const from = bound(points, at - POINT_WINDOW_MS), to = bound(points, at + POINT_WINDOW_MS, true);
    const visit = active.values().next().value?.visit;
    let nearest: TimelinePoint | undefined;
    if (from < to) {
      const split = bound(points, at), right = split < to ? points[split] : undefined;
      const left = split > from ? points[bound(points, points[split - 1].at)] : undefined;
      const ordered = [left, right].filter((value): value is TimedPoint => value !== undefined).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at) || a.point.accuracyMeters! - b.point.accuracyMeters! || a.at - b.at);
      nearest = ordered[0]?.point;
    }
    const location = visit ?? nearest;
    if (!location) {summary.unmatchedCount++; continue;}
    if (!bounds.agrees(from, to, location)) {summary.ambiguousCount++; continue;}
    const {latitude, longitude, name: placeName, accuracyMeters} = location;
    candidates.push({photoID: photo.id, location: {latitude, longitude, source: "google-timeline", ...(placeName === undefined ? {} : {name: placeName}), ...(accuracyMeters === undefined ? {} : {accuracyMeters})}, basis: visit ? "visit" : "point", capturedAt: iso(at), evidenceStart: visit?.start ?? nearest!.at, evidenceEnd: visit?.end ?? nearest!.at});
  }
  candidates.sort((a, b) => compareText(a.photoID, b.photoID));
  summary.candidateCount = candidates.length;
  return {candidates, summary};
}
