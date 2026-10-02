import type {LocalPhoto} from "./resources";
export interface PhotoSignals {
  hash: bigint;
  luminance: number;
  contrast: number;
  sharpness: number;
  color: [number, number, number];
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
  if (!a.width || !a.height || !b.width || !b.height || Math.abs((a.width / a.height) / (b.width / b.height) - 1) > .01) return false;
  if (Math.abs(x.luminance - y.luminance) > .03 || Math.abs(x.contrast - y.contrast) > .04 || x.color.some((value, i) => Math.abs(value - y.color[i]) > 8)) return false;
  let bits = x.hash ^ y.hash, distance = 0;
  while (bits) {if (++distance > 2) return false; bits &= bits - 1n;}
  return true;
}
function score(photo: LocalPhoto, signal: PhotoSignals) {
  return (photo.favorite ? 2 : 0) + (photo.labels?.length ? .15 : 0) + .45 * Math.min(1, signal.sharpness * 6) +
    .2 * Math.max(0, 1 - Math.abs(signal.luminance - .5) * 2) + .15 * Math.min(1, signal.contrast * 4);
}
export function recommendPhotos(photos:LocalPhoto[], signals:ReadonlyMap<string,PhotoSignals>):PhotoRecommendations {
  const unique = [...new Map(photos.map(photo => [photo.id, photo])).values()];
  const candidates = unique.flatMap((photo, order) => {
    const signal = signals.get(photo.id);
    if (!signal || !valid(signal) || (signal.contrast < .006 && (signal.luminance < .02 || signal.luminance > .98))) return [];
    return [{photo, signal, order, time: captured(photo), score: score(photo, signal)}];
  }).sort((a, b) => ((a.time ?? Infinity) - (b.time ?? Infinity)) || a.order - b.order);
  type Candidate = typeof candidates[number];
  type Group = {anchor: Candidate; best: Candidate; count: number};
  const groups: Group[] = [], recent: Group[] = [];
  for (const candidate of candidates) {
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
  }
  const buckets = new Map<string, Group[]>();
  for (const group of groups) {
    const day = group.best.time === undefined ? "unknown" : new Date(group.best.time).toISOString().slice(0, 10);
    const values = buckets.get(day); values ? values.push(group) : buckets.set(day, [group]);
  }
  const compare = (a: Group, b: Group) => b.best.score - a.best.score || a.best.order - b.best.order;
  const queues = [...buckets.values()].map(values => values.sort(compare)).sort((a, b) => compare(a[0], b[0]));
  const ids = new Set<string>(), reasons = new Map<string, string[]>(), target = Math.ceil(groups.length * .1);
  for (let round = 0; ids.size < target; round++) {
    let added = false;
    for (const queue of queues) {
      const group = queue[round]; if (!group || ids.size === target) continue;
      ids.add(group.best.photo.id); added = true;
      reasons.set(group.best.photo.id, [group.best.photo.favorite ? "Favorite" : "Clarity and exposure",
        ...(group.count > 1 ? [`Representative of ${group.count} similar photos`] : []),
        ...(queues.length > 1 && group.best.time !== undefined ? ["Variety across capture dates"] : [])]);
    }
    if (!added) break;
  }
  return {ids, reasons, groupCount: groups.length, duplicateCount: candidates.length - groups.length,
    unassessed: unique.filter(photo => !signals.has(photo.id) || !valid(signals.get(photo.id)!)).length};
}
export class PickAnalyzer {
  private version = 0;
  private cache = new Map<string, {source: unknown; promise: Promise<PhotoSignals | undefined>}>();
  async run(photos:LocalPhoto[], load:(photo:LocalPhoto)=>Promise<PhotoSignals>, progress?:(done:number,total:number)=>void):Promise<PhotoRecommendations|undefined> {
    const version = ++this.version, unique = [...new Map(photos.map(photo => [photo.id, photo])).values()];
    const ids = new Set(unique.map(photo => photo.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    const signals = new Map<string, PhotoSignals>();
    for (let i = 0; i < unique.length; i++) {
      if (version !== this.version) return;
      const photo = unique[i], source = photo.file ?? photo.preview ?? photo.previewLoader;
      if (source && photo.previewAvailable !== false) {
        let entry = this.cache.get(photo.id);
        if (!entry || entry.source !== source) {
          entry = {source, promise: load(photo).catch(() => undefined)}; this.cache.set(photo.id, entry);
        }
        const signal = await entry.promise;
        if (version !== this.version) return;
        if (signal) signals.set(photo.id, signal);
      }
      if ((i + 1) % 8 === 0 || i + 1 === unique.length) progress?.(i + 1, unique.length);
    }
    return version === this.version ? recommendPhotos(unique, signals) : undefined;
  }
  clear() {this.version++; this.cache.clear();}
}
