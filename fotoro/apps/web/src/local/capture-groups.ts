import type {LocalPhoto} from "./resources";

export function captureGroup(photo: Pick<LocalPhoto, "date" | "dateSource">, now = new Date()) {
  const date = new Date(photo.date);
  if ((photo.dateSource !== "exif" && photo.dateSource !== "photos") || !Number.isFinite(date.getTime())) return {key: "undated", heading: "Capture date unavailable"};
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return {key, heading: day === today.getTime() ? "Today" : day === yesterday.getTime() ? "Yesterday" : date.toLocaleDateString(undefined, {month: "long", day: "numeric", year: "numeric"})};
}
