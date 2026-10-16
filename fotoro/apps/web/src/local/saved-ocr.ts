import type {Photo} from "../library/catalog";
import {savedInferenceSource, type OwnedPhotoSnapshot} from "../library/consumer-search";
import {isPhotoTrashed} from "@fotoro/contracts/organization";
import type {LocalPhoto} from "./resources";
import {imageDimensions} from "./resources";
import {LocalOcrQueue, type OcrResult} from "./ocr";

export interface SavedTextProgress {checked: number; total: number; kept: number; failed: number}
export interface SavedTextResult extends SavedTextProgress {cancelled: boolean; applied: Photo[]}
interface SavedTextOptions {
  current: () => boolean; signal: AbortSignal; queue?: LocalOcrQueue;
  write: (photo: Photo, result: OcrResult, current: () => boolean) => Promise<boolean>;
  onProgress?: (value: SavedTextProgress) => void;
}
// This is one explicit loaded-scope batch, never a catalog discovery loop.
export function savedTextCandidates(snapshot: OwnedPhotoSnapshot, photos: readonly LocalPhoto[]): LocalPhoto[] {
  if (!snapshot.current()) return [];
  const seen = new Set<string>(), candidates: LocalPhoto[] = [];
  const byId = new Map(snapshot.photos.map(photo => [photo.manifest.photoId, photo]));
  for (const photo of photos) {
    // Admission can validate catalog membership. Skip completed/hidden sources
    // first so an already indexed library does not pay that cost per record.
    if (photo.ocr || isPhotoTrashed(photo) || !photo.previewLoader) continue;
    const source = savedInferenceSource(photo);
    if (!source || source.token !== snapshot.token || source.accountId !== snapshot.accountId || seen.has(source.photoId)) continue;
    const owned = byId.get(source.photoId);
    if (!owned || owned.grantId || owned.manifest.ownerAccountId !== snapshot.accountId
      || owned.metadata.originalSha256 !== source.digest || owned.annotations?.ocr
      || !owned.manifest.representations.some(value => value.binding.kind === "preview")) continue;
    seen.add(source.photoId); candidates.push(photo);
    if (candidates.length === 25) break;
  }
  return candidates;
}
export async function readSavedPhotoText(snapshot: OwnedPhotoSnapshot, photos: readonly LocalPhoto[], options: SavedTextOptions): Promise<SavedTextResult> {
  const current = () => !options.signal.aborted && options.current() && snapshot.current();
  const candidates = current() ? savedTextCandidates(snapshot, photos) : [];
  const result: SavedTextResult = {checked: 0, total: candidates.length, kept: 0, failed: 0, cancelled: false, applied: []};
  options.onProgress?.({...result});
  if (!candidates.length) return {...result, cancelled: !current()};
  const worker = options.queue ?? new LocalOcrQueue();
  const cancel = () => {void worker.cancel();};
  options.signal.addEventListener("abort", cancel, {once: true});
  try {
    for (const photo of candidates) {
      const source = savedInferenceSource(photo);
      const valid = () => current() && source?.current() === true;
      if (!source || !valid()) break;
      const owned = snapshot.photos.find(value => value.manifest.photoId === source.photoId)!;
      const recognized = await worker.recognize(photo.id, source.digest, async () => {
        const blob = await photo.previewLoader!();
        const dimensions = imageDimensions(new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer()));
        if (!dimensions) throw new Error("Saved preview unavailable.");
        return {blob, ...dimensions};
      }, valid);
      if (!valid()) break;
      if (recognized?.status === "complete") {
        try {
          if (await options.write(owned, recognized, valid)) {result.kept++; result.applied.push(owned);}
        } catch {if (valid()) result.failed++;}
      } else result.failed++;
      result.checked++;
      if (current()) options.onProgress?.({checked: result.checked, total: result.total, kept: result.kept, failed: result.failed});
    }
    return {...result, cancelled: !current() || result.checked < result.total};
  } finally {
    options.signal.removeEventListener("abort", cancel);
    await worker.cancel();
  }
}
