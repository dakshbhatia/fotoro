import type {LocalPhoto} from "./resources";
import type {SearchResult} from "./search";
import {ConsumerPreviewResources} from "../library/consumer-search";
import {parseNaturalDateQuery} from "./natural-date";
import {SEMANTIC_DIMENSIONS, SEMANTIC_THRESHOLD} from "./semantic-config";
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  if (values.length !== SEMANTIC_DIMENSIONS) throw new Error("Visual search output is invalid.");
  const vector = Float32Array.from(values);
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) throw new Error("Visual search output is invalid.");
  return vector.map(value => value / magnitude);
}
export function cosine(left: Float32Array, right: Float32Array) {
  if (left.length !== SEMANTIC_DIMENSIONS || right.length !== SEMANTIC_DIMENSIONS) return -1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}
function scopedSemanticPhotos(photos: LocalPhoto[], query: string, now?: number) {
  const parsed = parseNaturalDateQuery(query, {now});
  return parsed.text.length < 3 ? [] : photos.filter(photo => {
    if (photo.current?.() === false) return false;
    if (parsed.from === undefined && parsed.until === undefined) return true;
    if (photo.dateSource !== "photos" && photo.dateSource !== "exif") return false;
    const time = Date.parse(photo.date);
    return Number.isFinite(time) && (parsed.from === undefined || time >= parsed.from)
      && (parsed.until === undefined || time < parsed.until);
  });
}
const hasSemanticPreview = (photo: LocalPhoto) => photo.previewAvailable !== false && !!(photo.file || photo.preview || photo.previewLoader);
export function eligibleSemanticPhotos(photos: LocalPhoto[], query: string, now?: number) {
  return scopedSemanticPhotos(photos, query, now).filter(hasSemanticPreview);
}
export function semanticPreviewStatus(photos: LocalPhoto[], query: string, now?: number): SearchResult["visualStatus"] {
  const scoped = scopedSemanticPhotos(photos, query, now), available = scoped.filter(hasSemanticPreview).length;
  return available < scoped.length ? available ? "incomplete" : "missing-preview" : undefined;
}
export function addSemanticMatches(base: SearchResult, scores: ReadonlyMap<string, number>, permitted: ReadonlySet<string>, committedMeaning?: string): SearchResult {
  if (committedMeaning) return base;
  const ranked = [...scores].filter(([id, score]) => permitted.has(id) && Number.isFinite(score) && score >= SEMANTIC_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 100).map(([id]) => id);
  if (!ranked.length) return base;
  const photoIds = [...new Set([...base.photoIds, ...ranked])];
  const meaning = base.meaning ? {...base.meaning, photoIds, evidence: {...base.meaning.evidence,
    ...Object.fromEntries(ranked.filter(id => !base.photoIds.includes(id)).map(id => [id, "visual" as const]))}} : {id: "semantic:" + base.query, term: base.query, kind: "visual" as const,
    photoIds: ranked, evidence: Object.fromEntries(ranked.map(id => [id, "visual" as const]))};
  return {...base, photoIds, photoId: base.photoId ?? photoIds[0], meaning,
    meanings: base.meaning ? base.meanings : [meaning]};
}

export function subscribeSemanticLifecycle(cancel: () => void, resume: () => void, environment = {window, document, visible: () => document.visibilityState !== "hidden"}) {
  const visibility = () => {if (environment.visible()) resume(); else cancel();};
  environment.window.addEventListener("fotoro-lock", cancel); environment.window.addEventListener("pagehide", cancel); environment.window.addEventListener("online", visibility);
  environment.document.addEventListener("visibilitychange", visibility);
  return () => {
    environment.window.removeEventListener("fotoro-lock", cancel); environment.window.removeEventListener("pagehide", cancel); environment.window.removeEventListener("online", visibility);
    environment.document.removeEventListener("visibilitychange", visibility); cancel();
  };
}

// One worker owns the model and source vectors. Closing or locking the view destroys both.
export class SemanticFindSession {
  private worker?: Worker;
  private requests = new Map<number, {resolve: (value: Float32Array) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  private sequence = 0;
  private generation = 0;
  private controller = new AbortController();
  private failedGeneration?: number;
  private vectors = new Map<string, {source: WeakRef<object>; digest?: string; vector: Float32Array}>();
  constructor(private createWorker = () => new Worker(new URL("./semantic-worker.ts", import.meta.url), {type: "module"}),
    private resources: Pick<ConsumerPreviewResources, "load" | "clear"> = new ConsumerPreviewResources(), private requestTimeout = 90000) {}
  reconcile(photos: readonly LocalPhoto[]) {
    const sources = new Map(photos.filter(photo => photo.current?.() !== false && photo.previewAvailable !== false).map(photo => [photo.id, photo]));
    for (const [id, cached] of this.vectors) {
      const photo = sources.get(id), source = photo && (photo.file ?? photo.preview ?? photo.previewLoader);
      if (!photo || !source || (cached.digest ? cached.digest !== photo.digest : cached.source.deref() !== source)) {
        cached.vector.fill(0); this.vectors.delete(id);
      }
    }
  }
  private request(payload: {kind: "text"; text: string} | {kind: "image"; blob: Blob}) {
    if (!this.worker) {
      const worker = this.createWorker(); this.worker = worker;
      worker.onmessage = event => {
        if (this.worker !== worker) return;
        const request = this.requests.get(event.data.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.requests.delete(event.data.id);
        if (event.data.error) request.reject(new Error("Visual search is unavailable."));
        else {try {request.resolve(normalizeVector(event.data.vector));} catch (error) {request.reject(error as Error);}}
      };
      worker.onerror = () => {if (this.worker === worker) this.fail();};
    }
    const id = ++this.sequence;
    return new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), this.requestTimeout);
      this.requests.set(id, {resolve, reject, timer});
      try {this.worker!.postMessage({id, ...payload});} catch {this.fail();}
    });
  }
  async search(photos: LocalPhoto[], query: string, current: () => boolean,
    progress: (scores: ReadonlyMap<string, number>) => void): Promise<SearchResult["visualStatus"]> {
    this.cancel();
    const token = this.generation, signal = this.controller.signal;
    const valid = () => {
      if (!current()) return false;
      if (token === this.failedGeneration) throw new Error("Visual search is unavailable.");
      return token === this.generation;
    };
    const scoped = scopedSemanticPhotos(photos, query), selected = scoped.filter(hasSemanticPreview);
    if (!valid()) return;
    if (!selected.length) return scoped.length ? "missing-preview" : undefined;
    this.reconcile(photos);
    const text = await this.request({kind: "text", text: parseNaturalDateQuery(query).text});
    if (!valid()) return;
    const scores = new Map<string, number>();
    let missingPreviews = scoped.filter(photo => !hasSemanticPreview(photo)).length, modelErrors = 0;
    const selectedByID = new Map(selected.map(photo => [photo.id, photo]));
    const emit = () => {if (valid()) progress(new Map([...scores].filter(([id]) => selectedByID.get(id)?.current?.() !== false)));};
    for (let index = 0; index < selected.length; index++) {
      const photo = selected[index];
      if (!valid()) return;
      if (photo.current?.() === false) continue;
      const source = photo.file ?? photo.preview ?? photo.previewLoader;
      if (!source) {missingPreviews++; continue;}
      let cached = this.vectors.get(photo.id);
      if (!cached || (cached.digest ? cached.digest !== photo.digest : cached.source.deref() !== source)) {
        let blob: Blob | undefined;
        try {blob = (await this.resources.load(photo, "thumbnail", signal)).blob;} catch {
          if (!valid()) return;
          if (photo.current?.() !== false) missingPreviews++;
          continue;
        }
        if (!valid()) return;
        if (photo.current?.() === false) continue;
        if (!blob) {missingPreviews++; continue;}
        try {
          const vector = await this.request({kind: "image", blob});
          if (!valid()) return;
          if (photo.current?.() === false) continue;
          cached = {source: new WeakRef(source), digest: photo.digest, vector}; this.vectors.set(photo.id, cached);
          if (this.vectors.size > 4096) {
            const oldest = this.vectors.entries().next().value!; oldest[1].vector.fill(0); this.vectors.delete(oldest[0]);
          }
        } catch (error) {if (!valid()) throw error; if (photo.current?.() !== false) modelErrors++; continue;}
      }
      scores.set(photo.id, cosine(text, cached.vector));
      if ((index + 1) % 8 === 0) emit();
      // Cached vectors need only a dot product; yield in bounded batches rather than
      // paying a timer turn per photo. Uncached inference already yields to the worker.
      if ((index + 1) % 32 === 0 && index + 1 < selected.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    emit();
    if (valid() && (missingPreviews || modelErrors)) return [...scores.keys()].some(id => selectedByID.get(id)?.current?.() !== false)
      ? "incomplete" : modelErrors ? "unavailable" : "missing-preview";
  }
  private fail() {
    this.failedGeneration = this.generation;
    this.clear();
  }
  cancel() {
    this.generation++;
    this.controller.abort(); this.controller = new AbortController();
    try {this.worker?.postMessage({kind: "cancel", through: this.sequence});} catch {}
    for (const request of this.requests.values()) {clearTimeout(request.timer); request.reject(new DOMException("Visual search cancelled", "AbortError"));}
    this.requests.clear();
  }
  clear() {
    this.cancel();
    if (this.worker) {this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = undefined;}
    for (const cached of this.vectors.values()) cached.vector.fill(0);
    this.vectors.clear(); this.resources.clear();
  }
}
