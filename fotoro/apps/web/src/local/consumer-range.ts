import type {LocalPhoto} from "./resources";
export function inRecentSelectedRange(photo: Pick<LocalPhoto, "date" | "dateSource">, now = Date.now()) {
  if (photo.dateSource !== "exif") return true;
  const captured = Date.parse(photo.date);
  return captured >= now - 10 * 86400000 && captured <= now;
}
