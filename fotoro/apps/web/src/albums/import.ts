import type {Photo} from "../library/catalog";
import {syncSelectedSequential} from "../exchange/selected";
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

// A device choice authorizes only these originals. Finish saving before contributing.
export async function saveTripFiles(files: readonly File[], options: {
  signal: AbortSignal; current: () => boolean;
  stage: (file: File) => Promise<string>;
  drain: () => Promise<void>; unresolved: () => Promise<boolean>;
  load: (photoIds: readonly string[]) => Promise<Photo[]>;
}) {
  if (!files.length || files.length > 100) throw new Error("TRIP_CHOOSE_1_TO_100_FILES");
  const check = () => {options.signal.throwIfAborted(); if (!options.current()) throw new DOMException("Trip closed", "AbortError");};
  check();
  const ids: string[] = [];
  let failure: unknown;
  const result = await syncSelectedSequential([...files], {...options,
    stage: async file => {const id = await options.stage(file); check(); ids.push(id);},
    skipped: async (_file, error) => {failure ??= error;},
  });
  check();
  if (failure) throw failure;
  if (result.stopped) throw new Error("TRIP_SAVE_INCOMPLETE");
  const photos = await options.load(ids); check();
  const selected = ids.map(id => photos.find(photo => photo.manifest.photoId === id));
  if (selected.some(photo => !photo)) throw new Error("TRIP_SAVE_INCOMPLETE");
  const seen = new Set<string>();
  return (selected as Photo[]).filter(photo => {
    const identity = photo.metadata?.originalSha256
      ? JSON.stringify([photo.metadata.originalSha256, photo.metadata.originalBytes, photo.metadata.mediaType]) : photo.manifest.photoId;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}
