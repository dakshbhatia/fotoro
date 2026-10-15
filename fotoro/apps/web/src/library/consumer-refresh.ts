export function subscribeSavedRefresh(windowTarget: EventTarget, documentTarget: EventTarget & {visibilityState: string}, refresh: () => void) {
  const update = () => {if (documentTarget.visibilityState === "visible") refresh();};
  windowTarget.addEventListener("online", update);
  windowTarget.addEventListener("focus", update);
  windowTarget.addEventListener("pageshow", update);
  documentTarget.addEventListener("visibilitychange", update);
  return () => {
    windowTarget.removeEventListener("online", update);
    windowTarget.removeEventListener("focus", update);
    windowTarget.removeEventListener("pageshow", update);
    documentTarget.removeEventListener("visibilitychange", update);
  };
}

// Keep one read request when foreground events arrive during an account action.
// The action owner calls flush after releasing its gate; no retry timer or write
// intent is needed. A burst during a read produces at most one trailing read.
export class DeferredSavedRefresh {
  private pending = false;
  private reading = false;
  private disposed = false;
  constructor(private read: () => false | Promise<unknown>, private eligible: () => boolean) {}
  request() {if (!this.disposed) {this.pending = true; this.flush();}}
  flush() {
    if (this.disposed || this.reading || !this.pending || !this.eligible()) return;
    this.pending = false;
    let operation: false | Promise<unknown>;
    try {operation = this.read();}
    catch {return;}
    if (operation === false) {this.pending = true; return;}
    this.reading = true;
    void operation.catch(() => undefined).finally(() => {
      this.reading = false;
      this.flush();
    });
  }
  dispose() {this.disposed = true; this.pending = false;}
}

// Check and publish in the same continuation. Returning an admitted snapshot
// across another await would let withdrawal run before the caller publishes it.
// The synchronous publisher takes ownership; discarded snapshots wipe their keys.
export async function readSavedSnapshot<T extends {photos: {metadataKey: Uint8Array}[]}>(options: {
  signal?: AbortSignal; current: () => boolean; read: () => Promise<T>; publish: (result: T) => void;
}): Promise<void> {
  const check = () => {
    options.signal?.throwIfAborted();
    if (!options.current()) throw new DOMException("Saved browse changed", "AbortError");
  };
  check();
  const result = await options.read();
  let published = false;
  try {check(); options.publish(result); published = true;}
  finally {if (!published) for (const photo of result.photos) photo.metadataKey.fill(0);}
}

// Cached paging does not own Save status or drain uploads.
export async function readSavedBrowsePage(options: {
  signal: AbortSignal; current: () => boolean;
  read: () => Promise<{photos: import("./catalog").Photo[]; coverage: import("./catalog").CatalogCoverage}>;
  publish: (result: {photos: import("./catalog").Photo[]; coverage: import("./catalog").CatalogCoverage}) => void;
}) {
  return readSavedSnapshot(options);
}
