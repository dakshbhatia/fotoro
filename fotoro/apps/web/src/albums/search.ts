import type {Photo} from "../library/catalog";
import {PhotoSearchIndex, normalizeSearch} from "../local/search";

// Album members receive original metadata, never account-private annotations.
export function searchAlbumPhotos(photos: Photo[], query: string, current: () => boolean, now = Date.now()) {
  if (!current()) return [];
  if (!normalizeSearch(query)) return photos;
  const records = photos.map(photo => ({id: photo.manifest.photoId, filename: photo.metadata.filename,
    digest: photo.metadata.originalSha256, date: photo.metadata.sourceDate,
    dateSource: photo.metadata.dateSource === "import" ? "selected" as const : photo.metadata.dateSource,
    keywords: [photo.metadata.filename], current}));
  const result = new PhotoSearchIndex(records).search(query, {scope: "album", now});
  // The meaning contains all eligible members, before the normal 200-result shortlist.
  const ids = new Set(result.meaning?.photoIds ?? []);
  return current() ? photos.filter(photo => ids.has(photo.manifest.photoId)) : [];
}
