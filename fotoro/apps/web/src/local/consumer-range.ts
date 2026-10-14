import type {LocalPhoto} from "./resources";
import {parseNaturalDateQuery} from "./natural-date";
export function recentBrowseActive(enabled: boolean, query: string) {
  return enabled && parseNaturalDateQuery(query).from === undefined;
}
export function inRecentSelectedRange(photo: Pick<LocalPhoto, "date" | "dateSource">, now = Date.now()) {
  if (photo.dateSource !== "exif" && photo.dateSource !== "photos") return true;
  const captured = Date.parse(photo.date);
  return captured >= now - 30 * 86400000 && captured <= now;
}
export function inBrowseRange(photo: Pick<LocalPhoto, "date" | "dateSource" | "favorite">,
  recent: boolean, favorites: boolean, now = Date.now()) {
  return (!favorites || photo.favorite === true) && (!recent || inRecentSelectedRange(photo, now));
}
export function browseFavoritePhotoIDs(records: readonly Pick<LocalPhoto, "id" | "favorite">[],
  displayed: readonly Pick<LocalPhoto, "id" | "favorite">[]) {
  // A pending local Unfavorite takes precedence over older Saved metadata.
  const sources = new Map([...records, ...displayed].map(photo => [photo.id, photo]));
  return new Set([...sources.values()].filter(photo => photo.favorite === true).map(photo => photo.id));
}
