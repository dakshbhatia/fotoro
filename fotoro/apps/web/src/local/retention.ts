import type { LocalPhoto } from "./resources";
import { emptyFeedback, type SearchFeedback } from "./search";

export const RETAINED_PREVIEW_BUDGET = 100 * 1024 * 1024;
const CLEAR_CHANNEL = "fotoro-local-search-clear";
type Envelope = { iv: Uint8Array; data: ArrayBuffer };
type SavedPhoto = { meta: Envelope };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const empty = () => ({ enabled: false, photos: [] as LocalPhoto[], feedback: emptyFeedback(), skipped: 0 });
const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Search could not be retained.")); tx.onerror = () => {}; });
async function seal(key: CryptoKey, bytes: ArrayBuffer, context: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, bytes) };
}
async function open(key: CryptoKey, value: Envelope, context: string) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: value.iv.slice().buffer as ArrayBuffer, additionalData: encoder.encode(context) }, key, value.data);
}
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).buffer as ArrayBuffer;
function validOcr(ocr: any, photo: LocalPhoto) {
  return ocr && ocr.photoID === photo.id && ocr.revision === (photo.digest ?? photo.id) &&
    typeof ocr.processor === "string" && ocr.processor.length > 0 && ocr.processor.length <= 256 &&
    ["complete", "failed"].includes(ocr.status) && typeof ocr.text === "string" && ocr.text.length <= 256 * 1024 &&
    Number.isFinite(ocr.confidence) && ocr.confidence >= 0 && ocr.confidence <= 1 &&
    (ocr.error === undefined || (typeof ocr.error === "string" && ocr.error.length <= 4096));
}
function validPhoto(value: any): value is LocalPhoto {
  const texts = (list: any) => list === undefined || (Array.isArray(list) && list.length <= 64 && list.every((text: any) => typeof text === "string" && text.length <= 512));
  return value && typeof value.id === "string" && value.id.length <= 128 && typeof value.filename === "string" && value.filename.length <= 512 &&
    (value.digest === undefined || (typeof value.digest === "string" && value.digest.length <= 128)) &&
    typeof value.date === "string" && Number.isFinite(Date.parse(value.date)) && ["exif", "selected"].includes(value.dateSource) &&
    Array.isArray(value.labels) && value.labels.length <= 64 && value.labels.every((label: unknown) => typeof label === "string" && label.length <= 120) &&
    Number.isFinite(value.width) && value.width > 0 && Number.isFinite(value.height) && value.height > 0 &&
    (value.previewSize === undefined || (Number.isFinite(value.previewSize) && value.previewSize >= 0 && value.previewSize <= RETAINED_PREVIEW_BUDGET)) &&
    texts(value.keywords) && texts(value.facts) && (value.caption === undefined || (typeof value.caption === "string" && value.caption.length <= 4096)) &&
    (value.favorite === undefined || typeof value.favorite === "boolean");
}
function validFeedback(value: any): value is SearchFeedback {
  const events = (map: any) => map && typeof map === "object" && !Array.isArray(map) && Object.values(map).every((list: any) => Array.isArray(list) && list.length <= 64 && list.every(event => event && Number.isFinite(event.at) && typeof event.session === "string"));
  return value?.version === 1 && events(value.meanings) && events(value.photos) && value.pins && typeof value.pins === "object" && !Array.isArray(value.pins) && Object.values(value.pins).every(id => typeof id === "string");
}

/** Optional origin-local encryption. Metadata hydrates independently of bounded image bytes. */
export class LocalRetention {
  readonly name: string;
  private budget: number;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private instance = crypto.randomUUID();
  private knownEpoch: string | undefined;
  private knownPreviews = new Map<string, number>();
  private lastFiles = new Map<string, File>();
  get previewCoverage() {
    return { count: this.knownPreviews.size, bytes: [...this.knownPreviews.values()].reduce((total, size) => total + size, 0) };
  }
  constructor({ name = "fotoro-local-search-v1", budget = RETAINED_PREVIEW_BUDGET }: { name?: string; budget?: number } = {}) {
    this.name = name; this.budget = Math.max(0, Math.min(budget, RETAINED_PREVIEW_BUDGET));
  }
  private database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("data")) req.result.createObjectStore("data");
        if (!req.result.objectStoreNames.contains("previews")) req.result.createObjectStore("previews");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Local search storage is unavailable."));
      req.onblocked = () => reject(new Error("Close other Fotoro tabs to open local search storage."));
    });
  }
  watchClear(callback: () => void) {
    if (typeof window === "undefined") return () => {};
    let last = "";
    const receive = (value: any) => {
      if (value?.name !== this.name || value.source === this.instance || typeof value.epoch !== "string" || value.epoch === last) return;
      last = value.epoch; this.knownEpoch = value.epoch; this.generation++;
      this.knownPreviews.clear(); this.lastFiles.clear(); callback();
    };
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CLEAR_CHANNEL) : undefined;
    if (channel) channel.onmessage = event => receive(event.data);
    const storage = (event: StorageEvent) => { if (event.key === CLEAR_CHANNEL && event.newValue) { try { receive(JSON.parse(event.newValue)); } catch {} } };
    window.addEventListener("storage", storage);
    return () => { channel?.close(); window.removeEventListener("storage", storage); };
  }
  async load() {
    const generation = this.generation, db = await this.database();
    try {
      const tx = db.transaction("data"), store = tx.objectStore("data");
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      const data = new Map(keys.map((key, i) => [String(key), values[i]]));
      this.knownEpoch = data.get("epoch") ?? "0";
      if (generation !== this.generation) return empty();
      if (!data.get("enabled")) { this.knownPreviews.clear(); this.lastFiles.clear(); return empty(); }
      const key: CryptoKey | undefined = data.get("key"), epoch = data.get("epoch") ?? "0";
      if (!key) throw new Error("Saved search could not be opened. Reselect your photos.");
      const result = { ...empty(), enabled: true };
      for (const [name, raw] of data) {
        if (!name.startsWith("photo:")) continue;
        try {
          const photo = JSON.parse(decoder.decode(await open(key, (raw as SavedPhoto).meta, name)));
          if (!validPhoto(photo) || name !== "photo:" + photo.id) throw new Error("Invalid photo");
          delete photo.file; delete photo.preview;
          if (!validOcr(photo.ocr, photo)) delete photo.ocr;
          // A missing/corrupt optional preview never deletes the valid label record.
          photo.previewLoader = () => this.loadPreview(photo.id, epoch);
          result.photos.push(photo);
        } catch { result.skipped++; }
        if (generation !== this.generation) return empty();
      }
      if (data.get("feedback")) {
        try {
          const feedback = JSON.parse(decoder.decode(await open(key, data.get("feedback"), "feedback")));
          if (!validFeedback(feedback)) throw new Error("Invalid feedback");
          result.feedback = feedback;
        } catch { result.skipped++; }
      }
      if (generation !== this.generation) return empty();
      this.knownPreviews = new Map(result.photos.filter(photo => photo.previewAvailable && photo.previewSize).map(photo => [photo.id, photo.previewSize!]));
      return result;
    } finally { db.close(); }
  }
  private async loadPreview(id: string, epoch: string) {
    const db = await this.database();
    try {
      const tx = db.transaction(["data", "previews"]), data = tx.objectStore("data");
      const [current, key, preview] = await Promise.all([request(data.get("epoch")), request<CryptoKey>(data.get("key")), request<Envelope>(tx.objectStore("previews").get(id))]);
      if ((current ?? "0") !== epoch || !key || !preview) throw new Error("Preview unavailable. Reselect this photo.");
      return new Blob([await open(key, preview, "preview:" + id)], { type: "image/jpeg" });
    } finally { db.close(); }
  }
  save(photos: LocalPhoto[], feedback: SearchFeedback, isCurrent: () => boolean = () => true, previewProvider?: (photo: LocalPhoto) => Promise<Blob | undefined>) {
    const generation = this.generation, current = () => generation === this.generation && isCurrent();
    // Snapshot before waiting behind another save: queued old work cannot adopt a clear.
    const expectedEpoch = this.knownEpoch;
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!current()) return false;
      const feedbackBytes = jsonBytes(feedback), db = await this.database();
      try {
        const read = db.transaction("data").objectStore("data");
        const [existing, previousEpoch] = await Promise.all([request<CryptoKey | undefined>(read.get("key")), request<string | undefined>(read.get("epoch"))]);
        const epoch = expectedEpoch ?? previousEpoch ?? "0", key = existing ?? await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        this.knownEpoch ??= epoch;
        const records: [string, SavedPhoto][] = [], previews = new Map<string, Envelope>(), keep = new Set<string>();
        const sizes = new Map<string, number>(), files = new Map<string, File>();
        let retained = 0;
        for (const photo of photos) {
          if (!current()) return false;
          let preview = photo.preview;
          if (!preview && photo.file && previewProvider && retained < this.budget && this.lastFiles.get(photo.id) !== photo.file) {
            // Prepare, encrypt and release one image before asking for the next.
            preview = await previewProvider(photo);
          }
          if (!current()) return false;
          if (photo.file) files.set(photo.id, photo.file);
          const size = preview?.size ?? (photo.previewAvailable === false ? 0 : photo.previewSize ?? this.knownPreviews.get(photo.id) ?? 0);
          const hasPreview = size > 0 && retained + size <= this.budget;
          if (hasPreview) {
            retained += size; keep.add(photo.id); sizes.set(photo.id, size);
            if (preview) previews.set(photo.id, await seal(key, await preview.arrayBuffer(), "preview:" + photo.id));
          }
          const meta = { id: photo.id, digest: photo.digest, filename: photo.filename, labels: photo.labels ?? [], date: photo.date, dateSource: photo.dateSource, width: photo.width, height: photo.height, originalSize: photo.originalSize ?? photo.file?.size, previewAvailable: hasPreview, previewSize: hasPreview ? size : 0, caption: photo.caption, keywords: photo.keywords, facts: photo.facts, favorite: photo.favorite, ocr: validOcr(photo.ocr, photo) ? photo.ocr : undefined };
          if (!validPhoto(meta)) throw new Error("Search metadata could not be retained.");
          records.push(["photo:" + photo.id, { meta: await seal(key, jsonBytes(meta), "photo:" + photo.id) }]);
        }
        const encryptedFeedback = await seal(key, feedbackBytes, "feedback");
        if (!current()) return false;
        // Read the durable clear marker inside the SAME transaction as the commit.
        const committed = await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction(["data", "previews"], "readwrite"), data = tx.objectStore("data"), images = tx.objectStore("previews");
          let wrote = false;
          tx.oncomplete = () => resolve(wrote);
          tx.onabort = () => wrote ? reject(tx.error ?? new Error("Search could not be retained.")) : resolve(false);
          tx.onerror = () => {};
          const check = data.get("epoch");
          check.onsuccess = () => {
            if (!current() || (check.result ?? "0") !== epoch) { tx.abort(); return; }
            wrote = true;
            data.clear(); data.put(epoch, "epoch"); data.put(key, "key"); data.put(true, "enabled"); data.put(encryptedFeedback, "feedback");
            for (const [id, value] of records) data.put(value, id);
            const keys = images.getAllKeys();
            keys.onsuccess = () => { for (const id of keys.result) if (!keep.has(String(id))) images.delete(id); };
            for (const [id, value] of previews) images.put(value, id);
          };
        });
        if (committed && current()) { this.knownPreviews = sizes; this.lastFiles = files; }
        return committed;
      } finally { db.close(); }
    });
    this.queue = operation; return operation;
  }
  clear() {
    this.generation++;
    this.knownPreviews.clear(); this.lastFiles.clear();
    const epoch = crypto.randomUUID();
    this.knownEpoch = epoch;
    const operation = this.queue.catch(() => {}).then(async () => {
      const db = await this.database();
      try {
        const tx = db.transaction(["data", "previews"], "readwrite"), done = finished(tx), data = tx.objectStore("data");
        data.clear(); data.put(epoch, "epoch"); tx.objectStore("previews").clear(); await done;
      } finally { db.close(); }
      if (typeof window !== "undefined") {
        const value = { name: this.name, epoch, source: this.instance };
        if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel(CLEAR_CHANNEL); channel.postMessage(value); channel.close(); }
        try { localStorage.setItem(CLEAR_CHANNEL, JSON.stringify(value)); } catch {}
      }
    });
    this.queue = operation; return operation;
  }
}
