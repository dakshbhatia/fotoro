import type {Photo} from "../library/catalog";
import type {PendingImport} from "../exchange/journal";
import type {OwnedPhotoDetailsSource} from "../library/catalog";

// An upload can finish before the current browse window includes its change.
// Hydrate only the selected committed sources, using their exact staged manifests.
export function tripSavedSources(photoIds: readonly string[], ownerAccountId: string, pending: readonly PendingImport[]): OwnedPhotoDetailsSource[] {
  if (!photoIds.length || photoIds.length > 100) throw new Error("TRIP_SAVE_INCOMPLETE");
  const byID = new Map(pending.map(value => [value.photoId, value]));
  return [...new Set(photoIds)].map(photoId => {
    const saved = byID.get(photoId), manifest = saved?.manifest;
    if (!saved || saved.state !== "committed" || !manifest || manifest.photoId !== photoId
      || manifest.ownerAccountId !== ownerAccountId || !/^[A-Za-z0-9_-]{43}$/.test(saved.sourceDigest)) throw new Error("TRIP_SAVE_INCOMPLETE");
    return {ownerAccountId, photoId, originalSha256: saved.sourceDigest, manifest};
  });
}

// Keep originals and their staged IDs only for this explicitly chosen panel lifetime.
export class TripImportChoice {
  private files: readonly File[];
  private staged: ({photoId: string; sourceDigest: string} | undefined)[];
  private cancelled = false;
  constructor(files: readonly File[], private readonly admitted: () => boolean) {
    if (!files.length || files.length > 100) throw new Error("TRIP_CHOOSE_1_TO_100_FILES");
    this.files = [...files]; this.staged = Array(files.length);
  }
  get current() {
    if (this.cancelled) return false;
    if (this.admitted()) return true;
    this.cancel(); return false;
  }
  get count() {return this.files.length;}
  get sources() {return this.current ? this.staged.flatMap(source => source ? [{...source}] : []) : [];}
  cancel() {this.cancelled = true; this.files = []; this.staged = [];}
  async save(options: TripImportOptions): Promise<Photo[]> {
    const check = () => {options.signal.throwIfAborted(); if (!this.current || !options.current()) {this.cancel(); throw new DOMException("Trip closed", "AbortError");}};
    const drain = async (ids: readonly string[]) => {
      if (!ids.length) return;
      await options.drain(ids); check();
      const unresolved = await options.unresolved(ids); check();
      if (unresolved) throw new Error("TRIP_SAVE_INCOMPLETE");
    };
    try {
      check(); await drain(this.sources.map(source => source.photoId)); check();
      for (let index = 0; index < this.files.length; index++) {
        check();
        if (this.staged[index]) continue;
        const source = await options.stage(this.files[index]); check();
        this.staged[index] = {...source};
        await drain([source.photoId]); check();
      }
      const ids = this.sources.map(source => source.photoId);
      const photos = await options.load(ids); check();
      const selected = ids.map(id => photos.find(photo => photo.manifest.photoId === id));
      if (selected.some(photo => !photo)) throw new Error("TRIP_SAVE_INCOMPLETE");
      if (selected.some((photo, index) => photo!.metadata.originalSha256 !== this.staged[index]!.sourceDigest)) throw new Error("TRIP_SOURCE_CHANGED");
      const seen = new Set<string>();
      return (selected as Photo[]).filter(photo => {
        const identity = photo.metadata?.originalSha256
          ? JSON.stringify([photo.metadata.originalSha256, photo.metadata.originalBytes, photo.metadata.mediaType]) : photo.manifest.photoId;
        if (seen.has(identity)) return false;
        seen.add(identity); return true;
      });
    } catch (failure) {
      if (options.signal.aborted || !this.current || !options.current() || failure instanceof Error && failure.message === "TRIP_SOURCE_CHANGED") this.cancel();
      throw failure;
    }
  }
}
interface TripImportOptions {
  signal: AbortSignal; current: () => boolean;
  stage: (file: File) => Promise<{photoId: string; sourceDigest: string}>;
  drain: (photoIds: readonly string[]) => Promise<void>; unresolved: (photoIds: readonly string[]) => Promise<boolean>;
  load: (photoIds: readonly string[]) => Promise<Photo[]>;
}

// All chosen originals must commit before an explicit contribution can continue.
export function saveTripFiles(choice: TripImportChoice, options: TripImportOptions) {return choice.save(options);}
