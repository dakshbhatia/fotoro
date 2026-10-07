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
