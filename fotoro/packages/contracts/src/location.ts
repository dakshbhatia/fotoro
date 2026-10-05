export interface PhotoLocationV1 {
  latitude: number;
  longitude: number;
  source: "exif" | "photos" | "google-timeline";
  name?: string;
  accuracyMeters?: number;
}
export const LOCATION_FACT_PREFIX = "fotoro.location.v1:";
export const PLACE_FACT_PREFIX = "fotoro.place.v1:";
export const isLocationFact = (fact: string) => fact.startsWith(LOCATION_FACT_PREFIX) || fact.startsWith(PLACE_FACT_PREFIX);
const length = (value: string) => Array.from(value).length;
export function validatedPhotoLocation(value: unknown): PhotoLocationV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["latitude", "longitude", "source", "name", "accuracyMeters"].includes(key))) return;
  if (typeof item.latitude !== "number" || !Number.isFinite(item.latitude) || item.latitude < -90 || item.latitude > 90 ||
    typeof item.longitude !== "number" || !Number.isFinite(item.longitude) || item.longitude < -180 || item.longitude > 180 ||
    !["exif", "photos", "google-timeline"].includes(item.source as string) ||
    (item.name !== undefined && (typeof item.name !== "string" || length(item.name) > 200)) ||
    (item.accuracyMeters !== undefined && (typeof item.accuracyMeters !== "number" || !Number.isFinite(item.accuracyMeters) || item.accuracyMeters < 0 || item.accuracyMeters > 100000))) return;
  return item as unknown as PhotoLocationV1;
}
/* Reserved facts stay inside the existing private annotation wire format so
   strict older clients can still validate and sync the same photo records. */
export function annotationLocation(value: {facts?: string[]}): PhotoLocationV1 | undefined {
  const facts = value.facts;
  if (!facts || !Array.isArray(facts) || facts.length > 64 || facts.some(fact => typeof fact !== "string")) return;
  const coordinates = facts.filter(fact => fact.startsWith(LOCATION_FACT_PREFIX));
  const names = facts.filter(fact => fact.startsWith(PLACE_FACT_PREFIX));
  if (coordinates.length !== 1 || names.length > 1 || length(coordinates[0]) > 240) return;
  try {
    const raw = coordinates[0].slice(LOCATION_FACT_PREFIX.length), item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object" || Object.hasOwn(item, "name")) return;
    // Count every JSON member token, including escaped spellings. JSON.parse
    // collapses equivalent keys, so a larger raw count is ambiguous evidence.
    if ((raw.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? []).length !== Object.keys(item).length) return;
    const location = validatedPhotoLocation({...item, ...(names.length ? {name: names[0].slice(PLACE_FACT_PREFIX.length)} : {})});
    return location;
  } catch {return;}
}
export function withAnnotationLocation<T extends {facts?: string[]}>(value: T, location: PhotoLocationV1 | undefined): T {
  if (location !== undefined && !validatedPhotoLocation(location)) throw new Error("Invalid photo location");
  const facts = (value.facts ?? []).filter(fact => !isLocationFact(fact));
  if (location) {
    const {latitude, longitude, source, accuracyMeters, name} = location;
    const coordinate = LOCATION_FACT_PREFIX + JSON.stringify({latitude, longitude, source, ...(accuracyMeters === undefined ? {} : {accuracyMeters})});
    if (length(coordinate) > 240) throw new Error("Photo location exceeds fact capacity");
    facts.push(coordinate);
    if (name !== undefined) facts.push(PLACE_FACT_PREFIX + name);
  }
  if (facts.length > 64) throw new Error("Photo location exceeds 64 fact capacity");
  return {...value, ...(value.facts || location ? {facts} : {})};
}
