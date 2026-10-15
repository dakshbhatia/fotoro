import type { Photo } from "./catalog";
import type { SearchPhoto } from "../local/search";
import {requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
import {annotationLocation} from "@fotoro/contracts/location";
/* Only owner annotations validated against immutable original identity enter account search. */
export function cloudSearchRecords(photos: Photo[]): SearchPhoto[] {
  let session: ReturnType<typeof requireVault> | undefined;
  try {session = requireVault();} catch {}
  return photos.map(photo => {
    const annotation = !photo.grantId && (!session || photo.manifest.ownerAccountId === session.accountId)
      && photo.annotations?.photoId === photo.manifest.photoId && photo.annotations.originalSha256 === photo.metadata.originalSha256 ? photo.annotations : undefined;
    const ocr = annotation?.ocr;
    const photoId = photo.manifest.photoId, digest = photo.metadata.originalSha256, owner = photo.manifest.ownerAccountId, grant = photo.grantId;
    const current = session ? () => sameVault(session!) && photo.manifest.ownerAccountId === owner
      && photo.grantId === grant && photo.manifest.photoId === photoId && photo.metadata.originalSha256 === digest
      && (!annotation || photo.annotations === annotation) : undefined;
    return {
      id: photo.manifest.photoId,
      digest: photo.metadata.originalSha256,
      filename: photo.metadata.filename,
      date: photo.metadata.sourceDate,
      dateSource: photo.metadata.dateSource === "exif" || photo.metadata.dateSource === "photos" ? photo.metadata.dateSource : "selected",
      labels: annotation?.labels,
      caption: annotation?.caption,
      keywords: annotation?.keywords,
      facts: annotation?.facts,
      location: annotation ? annotationLocation(annotation) : undefined,
      favorite: annotation?.favorite,
      ocr: ocr ? {photoID: photo.manifest.photoId, revision: photo.metadata.originalSha256, status: "complete", ...ocr} : undefined,
      visual: annotation?.visual && current?.() ? {photoID: photo.manifest.photoId, revision: photo.metadata.originalSha256, status: "complete", ...annotation.visual} : undefined,
      current,
    };
  });
}

// Search hydration joins existing admitted sources instead of replacing the browse/selection window.
export function mergeSearchPhotos(previous: Photo[], matches: Photo[], added: Set<string>, retained: ReadonlySet<string>) {
  const requested = new Set(matches.map(photo => photo.manifest.photoId));
  const next = previous.filter(photo => !added.has(photo.manifest.photoId) || retained.has(photo.manifest.photoId) || requested.has(photo.manifest.photoId));
  const nextAdded = new Set(next.filter(photo => added.has(photo.manifest.photoId)).map(photo => photo.manifest.photoId));
  for (const photo of previous) if (!next.includes(photo)) photo.metadataKey.fill(0);
  for (const match of matches) {
    const index = next.findIndex(photo => photo.manifest.photoId === match.manifest.photoId);
    if (index < 0) {next.push(match); nextAdded.add(match.manifest.photoId);}
    else if (JSON.stringify([next[index].manifest, next[index].metadata, next[index].annotations, next[index].annotationRevision]) === JSON.stringify([match.manifest, match.metadata, match.annotations, match.annotationRevision])) match.metadataKey.fill(0);
    else {next[index].metadataKey.fill(0); next[index] = match;}
  }
  return {photos: next, added: nextAdded};
}

// Pending owner edits take effect while the encrypted metadata index refreshes.
export function currentSearchRecords(cached: SearchPhoto[], loaded: SearchPhoto[]): SearchPhoto[] {
  const current = new Map(loaded.map(photo => [photo.id, photo]));
  const records = cached.map(photo => current.get(photo.id) ?? photo);
  const cachedIDs = new Set(cached.map(photo => photo.id));
  return [...records, ...loaded.filter(photo => !cachedIDs.has(photo.id))];
}
