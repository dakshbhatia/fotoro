import type { Photo } from "./catalog";
import type { SearchPhoto } from "../local/search";
import {requireVault} from "../vault/vault";
import {sameVault} from "../vault/scope";
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
      favorite: annotation?.favorite,
      ocr: ocr ? {photoID: photo.manifest.photoId, revision: photo.metadata.originalSha256, status: "complete", ...ocr} : undefined,
      visual: annotation?.visual && current?.() ? {photoID: photo.manifest.photoId, revision: photo.metadata.originalSha256, status: "complete", ...annotation.visual} : undefined,
      current,
    };
  });
}
