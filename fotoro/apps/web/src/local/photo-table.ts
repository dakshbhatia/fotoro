import {photoFormat} from "../media/photo-source";
import type {LocalPhoto} from "./resources";
import {peopleNames} from "@fotoro/contracts/people";

export const photoColumns = [
  {id: "name", label: "Name"}, {id: "date", label: "Capture date"},
  {id: "type", label: "Type"}, {id: "dimensions", label: "Dimensions"},
  {id: "location", label: "Location"}, {id: "tags", label: "Tags"},
  {id: "people", label: "People"},
  {id: "text", label: "Text"}, {id: "availability", label: "Availability"},
] as const;
export type PhotoColumn = typeof photoColumns[number]["id"];
export interface PhotoSort {column: PhotoColumn; descending: boolean}
const capturedDate = (photo: LocalPhoto) => (photo.dateSource === "exif" || photo.dateSource === "photos") && Number.isFinite(Date.parse(photo.date));
export function photoCell(photo: LocalPhoto, column: PhotoColumn): string {
  switch (column) {
    case "name": return photo.filename;
    case "date": return capturedDate(photo)
      ? new Date(photo.date).toLocaleDateString(undefined, {year: "numeric", month: "short", day: "numeric"}) : "Unavailable";
    case "type": return photoFormat({name: photo.filename, type: photo.file?.type ?? ""})?.toUpperCase() ?? "Unknown";
    case "dimensions": return photo.width && photo.height ? `${photo.width} × ${photo.height}` : "Unavailable";
    case "location": return photo.location ? photo.location.name || `${photo.location.latitude.toFixed(4)}, ${photo.location.longitude.toFixed(4)}` : "Unavailable";
    case "tags": return photo.labels?.join(", ") || "—";
    case "people": return peopleNames(photo.facts,photo.digest??"").join(", ") || "—";
    case "text": return photo.ocr?.status === "complete" ? photo.ocr.text.trim() ? "Read" : "No text found" : photo.ocr?.status === "failed" ? "Could not read" : "Not read";
    case "availability": return photo.file ? "Original on device" : photo.previewAvailable !== false && (photo.preview || photo.previewLoader) ? "Preview only" : "Reselect original";
  }
}
function sortableValue(photo: LocalPhoto, column: PhotoColumn): string | number | undefined {
  if (column === "date") return capturedDate(photo) ? Date.parse(photo.date) : undefined;
  if (column === "dimensions") return photo.width && photo.height ? photo.width * photo.height : undefined;
  return photoCell(photo, column);
}
export function sortTablePhotos(photos: readonly LocalPhoto[], sort: PhotoSort): LocalPhoto[] {
  return [...photos].sort((a, b) => {
    const left = sortableValue(a, sort.column), right = sortableValue(b, sort.column);
    // Unknown capture dates remain unknown, and sort after verified capture dates in either direction.
    if (left === undefined || right === undefined) return left === right ? a.id.localeCompare(b.id) : left === undefined ? 1 : -1;
    const compared = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, {numeric: true});
    return (sort.descending ? -compared : compared) || a.id.localeCompare(b.id);
  });
}
