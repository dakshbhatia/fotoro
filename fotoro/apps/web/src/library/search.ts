import type { Photo } from "./catalog";
import type { SearchPhoto } from "../local/search";
/* Only owner annotations validated against immutable original identity enter account search. */
export function cloudSearchRecords(photos: Photo[]): SearchPhoto[] {
  return photos.map(photo => {
    const annotation = !photo.grantId && photo.annotations?.photoId === photo.manifest.photoId && photo.annotations.originalSha256 === photo.metadata.originalSha256 ? photo.annotations : undefined;
    const ocr = annotation?.ocr;
    return {
      id: photo.manifest.photoId,
      digest: photo.metadata.originalSha256,
      filename: photo.metadata.filename,
      date: photo.metadata.sourceDate,
      dateSource: photo.metadata.dateSource === "exif" ? "exif" : "selected",
      labels: annotation?.labels,
      caption: annotation?.caption,
      keywords: annotation?.keywords,
      facts: annotation?.facts,
      favorite: annotation?.favorite,
      ocr: ocr ? {photoID: photo.manifest.photoId, revision: photo.metadata.originalSha256, status: "complete", ...ocr} : undefined,
    };
  });
}
