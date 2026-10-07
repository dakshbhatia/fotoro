import type {LocalPhoto} from "./resources";
export const PICK_PROCESSOR = "moment-highlights-v3";
export interface PhotoSignals {
  hash: bigint;
  luminance: number;
  contrast: number;
  sharpness: number;
  color: [number, number, number];
  width?: number;
  height?: number;
}
export interface PhotoRecommendations {
  ids: Set<string>;
  reasons: Map<string, string[]>;
  groupCount: number;
  duplicateCount: number;
  unassessed: number;
}
export function analyzePixels(image: {width:number; height:number; data:Uint8ClampedArray}):PhotoSignals {
  const {width, height, data} = image, count = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || count > 65536 || data.length !== count * 4)
    throw new Error("Preview measurements unavailable.");
  const gray = new Float32Array(count), color: [number, number, number] = [0, 0, 0];
  let mean = 0, variance = 0, detail = 0, measured = 0;
  for (let i = 0; i < count; i++) {
    const offset = i * 4, alpha = data[offset + 3] / 255;
    const r = data[offset] * alpha + 255 * (1 - alpha), g = data[offset + 1] * alpha + 255 * (1 - alpha), b = data[offset + 2] * alpha + 255 * (1 - alpha);
    color[0] += r; color[1] += g; color[2] += b;
    const luminance = .2126 * r + .7152 * g + .0722 * b;
    gray[i] = luminance;
    const delta = luminance - mean; mean += delta / (i + 1); variance += delta * (luminance - mean);
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const laplacian = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
    detail += laplacian * laplacian; measured++;
  }
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const row = Math.round(y * (height - 1) / 7) * width;
    if (gray[row + Math.round(x * (width - 1) / 8)] > gray[row + Math.round((x + 1) * (width - 1) / 8)])
      hash |= 1n << BigInt(y * 8 + x);
  }
  return {hash, luminance: mean / 255, contrast: Math.sqrt(Math.max(0, variance / count)) / 255,
    sharpness: measured ? Math.sqrt(detail / measured) / 1020 : 0, color: color.map(value => value / count) as [number, number, number]};
}
const hashLimit = (1n << 64n) - 1n;
function valid(signal: PhotoSignals) {
  return typeof signal.hash === "bigint" && signal.hash >= 0n && signal.hash <= hashLimit &&
    [signal.luminance, signal.contrast, signal.sharpness].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    signal.color.length === 3 && signal.color.every(value => Number.isFinite(value) && value >= 0 && value <= 255);
}
function captured(photo: LocalPhoto) {
  const time = photo.captureVerified === true && photo.dateSource === "exif" ? Date.parse(photo.date) : NaN;
  return Number.isFinite(time) ? time : undefined;
}
function similar(a: LocalPhoto, b: LocalPhoto, x: PhotoSignals, y: PhotoSignals) {
  const aw = a.width ?? x.width, ah = a.height ?? x.height, bw = b.width ?? y.width, bh = b.height ?? y.height;
  if (!aw || !ah || !bw || !bh || Math.abs((aw / ah) / (bw / bh) - 1) > .01) return false;
  if (Math.abs(x.luminance - y.luminance) > .03 || Math.abs(x.contrast - y.contrast) > .04 || x.color.some((value, i) => Math.abs(value - y.color[i]) > 8)) return false;
  let bits = x.hash ^ y.hash, distance = 0;
  while (bits) {if (++distance > 2) return false; bits &= bits - 1n;}
  return true;
}
function score(photo: LocalPhoto, signal: PhotoSignals) {
  return (photo.favorite ? 2 : 0) + (photo.labels?.length ? .15 : 0) + .45 * Math.min(1, signal.sharpness * 6) +
    .2 * Math.max(0, 1 - Math.abs(signal.luminance - .5) * 2) + .15 * Math.min(1, signal.contrast * 4);
}
const PICK_WORK_BATCH = 128;
function* recommendationSteps(photos: LocalPhoto[], signals: ReadonlyMap<string, PhotoSignals>): Generator<void, PhotoRecommendations> {
  const byID = new Map<string, LocalPhoto>();
  for (let i = 0; i < photos.length; i++) {
    if (photos[i].current?.() !== false) byID.set(photos[i].id, photos[i]);
    if ((i + 1) % PICK_WORK_BATCH === 0) yield;
  }
  const unique = [...byID.values()];
  type Candidate = {photo: LocalPhoto; signal: PhotoSignals; order: number; time?: number; score: number};
  const candidates: Candidate[] = [];
  let unassessed = 0;
  for (let order = 0; order < unique.length; order++) {
    const photo = unique[order], signal = signals.get(photo.id);
    if (photo.current?.() !== false) {
      if (!signal || !valid(signal)) unassessed++;
      else if (signal.contrast >= .006) candidates.push({photo, signal, order, time: captured(photo), score: score(photo, signal)});
    }
    if ((order + 1) % PICK_WORK_BATCH === 0) yield;
  }
  candidates.sort((a, b) => ((a.time ?? Infinity) - (b.time ?? Infinity)) || a.order - b.order);
  type Group = {anchor: Candidate; best: Candidate; count: number};
  const groups: Group[] = [], recent: Group[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    let group: Group | undefined;
    // Only verified bursts are grouped. The fixed candidate window bounds collision-heavy work.
    if (candidate.time !== undefined) for (let i = recent.length - 1; i >= 0; i--) {
      const previous = recent[i];
      if (candidate.time - previous.anchor.time! > 30000) break;
      if (similar(previous.anchor.photo, candidate.photo, previous.anchor.signal, candidate.signal)) {group = previous; break;}
    }
    if (group) {
      group.count++;
      if (candidate.score > group.best.score) group.best = candidate;
    } else {
      group = {anchor: candidate, best: candidate, count: 1}; groups.push(group);
      if (candidate.time !== undefined) {recent.push(group); if (recent.length > 24) recent.shift();}
    }
    if ((index + 1) % PICK_WORK_BATCH === 0) yield;
  }
  const moments: Group[][] = [];
  const unknown: Group[] = [];
  let start: number | undefined, day: number | undefined;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index], time = group.best.time;
    if (time === undefined) unknown.push(group);
    else {
      const captureDay = Math.floor(time / 86400000);
      if (start !== undefined && day === captureDay && time - start <= 2 * 3600000)
        moments[moments.length - 1].push(group);
      else {moments.push([group]); start = time; day = captureDay;}
    }
    if ((index + 1) % PICK_WORK_BATCH === 0) yield;
  }
  if (unknown.length) moments.push(unknown);
  const compare = (a: Group, b: Group) => b.best.score - a.best.score || a.best.order - b.best.order;
  const ids = new Set<string>(), reasons = new Map<string, string[]>();
  let reviewed = 0;
  for (const moment of moments) {
    const budget = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(moment.length) / 2)));
    const bestQuality = moment.reduce((best, group) => Math.max(best, group.best.score - (group.best.photo.favorite ? 2 : 0)), -Infinity);
    const chosen: Group[] = [];
    let suggestions = 0;
    for (const group of moment.sort(compare)) {
      if (++reviewed % PICK_WORK_BATCH === 0) yield;
      if (!group.best.photo.favorite && (group.best.score < bestQuality * .65 || suggestions >= budget || chosen.some(previous =>
        similar(previous.best.photo, group.best.photo, previous.best.signal, group.best.signal)))) continue;
      chosen.push(group);
      if (!group.best.photo.favorite) suggestions++;
    }
    for (const group of chosen) {
      ids.add(group.best.photo.id);
      reasons.set(group.best.photo.id, [group.best.photo.favorite ? "Favorite" : "Moment highlight",
        ...(group.count > 1 ? [`Representative of ${group.count} similar photos`] : []),
        ...(moments.length > 1 && group.best.time !== undefined ? ["Variety across moments"] : [])]);
    }
  }
  return {ids, reasons, groupCount: groups.length, duplicateCount: candidates.length - groups.length, unassessed};
}
export function recommendPhotos(photos: LocalPhoto[], signals: ReadonlyMap<string, PhotoSignals>): PhotoRecommendations {
  const steps = recommendationSteps(photos, signals);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
interface CachedSignals {
  source: WeakRef<object>;
  digest?: string;
  width?: number;
  height?: number;
  signal?: PhotoSignals;
  promise?: Promise<PhotoSignals | undefined>;
}
export class PickAnalyzer {
  private version = 0;
  private controller = new AbortController();
  private cache = new Map<string, CachedSignals>();
  constructor(private readonly yieldWork: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))) {}
  async run(photos:LocalPhoto[], load:(photo:LocalPhoto, signal?: AbortSignal)=>Promise<PhotoSignals>, progress?:(done:number,total:number)=>void):Promise<PhotoRecommendations|undefined> {
    this.cancel();
    const version = this.version, cancellationSignal = this.controller.signal, unique = [...new Map(photos.map(photo => [photo.id, photo])).values()];
    const ids = new Set(unique.map(photo => photo.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    const signals = new Map<string, PhotoSignals>();
    for (let i = 0; i < unique.length; i++) {
      if (version !== this.version) return;
      const photo = unique[i], source = photo.file ?? photo.preview ?? photo.previewLoader;
      if (source && photo.previewAvailable !== false && photo.current?.() !== false) {
        let entry = this.cache.get(photo.id);
        if (!entry || entry.source.deref() !== source || entry.digest !== photo.digest || entry.width !== photo.width || entry.height !== photo.height) {
          entry = {source: new WeakRef(source), digest: photo.digest, width: photo.width, height: photo.height};
          this.cache.set(photo.id, entry);
        }
        const cached = entry;
        if (!cached.signal && !cached.promise) cached.promise = (async () => {
          try {
            const measured = await load(photo, cancellationSignal);
            if (!valid(measured)) return;
            if (version === this.version && photo.current?.() !== false && this.cache.get(photo.id) === cached) cached.signal = measured;
            return measured;
          } catch {return;}
          finally {
            cached.promise = undefined;
            if (!cached.signal && this.cache.get(photo.id) === cached) this.cache.delete(photo.id);
          }
        })();
        const signal = cached.signal ?? await cached.promise;
        if (version !== this.version) return;
        if (photo.current?.() === false) this.cache.delete(photo.id);
        else if (signal) signals.set(photo.id, signal);
      } else this.cache.delete(photo.id);
      if ((i + 1) % 8 === 0 || i + 1 === unique.length) progress?.(i + 1, unique.length);
      if ((i + 1) % PICK_WORK_BATCH === 0) await this.yieldWork();
    }
    let rankedPhotos = unique.filter(photo => photo.current?.() !== false);
    let steps = recommendationSteps(rankedPhotos, signals);
    while (version === this.version) {
      const next = steps.next();
      if (next.done) {
        // A per-photo permission/source fence can change while the batch yields,
        // even when the overall account snapshot remains current. Re-rank so a
        // withdrawn winner cannot suppress a still-permitted runner-up.
        const remaining = rankedPhotos.filter(photo => photo.current?.() !== false);
        if (remaining.length !== rankedPhotos.length) {
          for (const photo of rankedPhotos) if (photo.current?.() === false) this.cache.delete(photo.id);
          rankedPhotos = remaining; steps = recommendationSteps(rankedPhotos, signals); continue;
        }
        return version === this.version ? next.value : undefined;
      }
      await this.yieldWork();
    }
  }
  // Completed measurements survive harmless metadata updates; pending work never crosses a cancellation.
  cancel() {
    this.version++;
    this.controller.abort(); this.controller = new AbortController();
    for (const [id, entry] of this.cache) if (!entry.signal) this.cache.delete(id);
  }
  clear() {this.cancel(); this.cache.clear();}
}
