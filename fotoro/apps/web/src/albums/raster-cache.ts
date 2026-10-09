// Decrypted derivatives belong to one open album, never an account-wide cache.
// Active views own separate URLs so eviction cannot blank a visible image.
export class AlbumRasterCache {
  private entries = new Map<string, {blob: Blob; cost: number}>();
  private pending = new Map<string, Promise<Blob>>();
  private leases = new Map<string, Set<() => void>>();
  private bytes = 0;
  private generation = 0;
  constructor(private budget = 24 * 1024 * 1024,
    private createURL = URL.createObjectURL.bind(URL), private revokeURL = URL.revokeObjectURL.bind(URL)) {}
  async load(key: string, decodedBytes: number, current: () => boolean, read: () => Promise<Uint8Array>): Promise<Blob> {
    const check = () => {if (!current()) throw new DOMException("Album photo changed", "AbortError");};
    check();
    const found = this.entries.get(key);
    if (found) {this.entries.delete(key); this.entries.set(key, found); return found.blob;}
    let pending = this.pending.get(key);
    if (!pending) {
      const generation = this.generation;
      let request!: Promise<Blob>;
      pending = request = (async () => {
        const bytes = await read();
        try {
          check();
          if (generation !== this.generation || this.pending.get(key) !== request) throw new DOMException("Album closed", "AbortError");
          const blob = new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});
          const cost = Math.max(blob.size, decodedBytes);
          if (cost <= this.budget) {
            while (this.bytes + cost > this.budget) this.remove(this.entries.keys().next().value!);
            this.entries.set(key, {blob, cost}); this.bytes += cost;
          }
          return blob;
        } finally {bytes.fill(0);}
      })();
      this.pending.set(key, pending);
      void request.then(() => {if (this.pending.get(key) === request) this.pending.delete(key);},
        () => {if (this.pending.get(key) === request) this.pending.delete(key);});
    }
    const blob = await pending;
    check();
    return blob;
  }
  lease(key: string, blob: Blob, signal: AbortSignal, current: () => boolean) {
    signal.throwIfAborted();
    if (!current()) throw new DOMException("Album photo changed", "AbortError");
    const url = this.createURL(blob), leases = this.leases.get(key) ?? new Set<() => void>();
    const release = () => {
      if (!leases.delete(release)) return;
      signal.removeEventListener("abort", release); this.revokeURL(url);
      if (!leases.size && this.leases.get(key) === leases) this.leases.delete(key);
    };
    leases.add(release); this.leases.set(key, leases);
    signal.addEventListener("abort", release, {once: true});
    return url;
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) {this.bytes -= entry.cost; this.entries.delete(key);}
  }
  retain(keys: ReadonlySet<string>) {
    for (const key of this.pending.keys()) if (!keys.has(key)) this.pending.delete(key);
    for (const key of this.entries.keys()) if (!keys.has(key)) this.remove(key);
    for (const [key, leases] of this.leases) if (!keys.has(key)) for (const release of [...leases]) release();
  }
  clear() {this.generation++; this.retain(new Set());}
}
