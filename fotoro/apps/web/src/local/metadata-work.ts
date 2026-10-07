import type {SearchPhoto, SearchResult} from "./search";
import {parseNaturalDateQuery} from "./natural-date";

export function metadataDatePhotoIDs(photos: readonly SearchPhoto[], query: string, allowedIDs: ReadonlySet<string>) {
  const parsed = parseNaturalDateQuery(query);
  return new Set(photos.filter(photo => {
    if (!allowedIDs.has(photo.id) || photo.current?.() === false) return false;
    if (parsed.from === undefined && parsed.until === undefined) return true;
    if (photo.dateSource !== "exif" && photo.dateSource !== "photos") return false;
    const captured = Date.parse(photo.date);
    return Number.isFinite(captured) && (parsed.from === undefined || captured >= parsed.from) && (parsed.until === undefined || captured < parsed.until);
  }).map(photo => photo.id));
}

export function metadataBackgroundPhotoIDs(result: SearchResult, allowedIDs: ReadonlySet<string>, sources: readonly SearchResult[] = [result]) {
  const matched = new Set<string>();
  if (result.meaning) for (const source of sources) for (const meaning of source.meanings) {
    if (meaning.id !== result.meaning.id) continue;
    for (const id of meaning.photoIds) if (allowedIDs.has(id) && meaning.evidence[id] !== "ocr" && meaning.evidence[id] !== "visual") matched.add(id);
  }
  // Unread text cannot prefilter its own discovery. Keep the current date/People
  // scope when a query has no known metadata matches, rather than stopping at its first OCR hit.
  return matched.size ? matched : new Set(allowedIDs);
}
