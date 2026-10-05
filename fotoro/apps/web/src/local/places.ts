import type {PhotoLocationV1} from "@fotoro/contracts";
import {validatedPhotoLocation} from "@fotoro/contracts/location";
import type {SearchPhoto} from "./search";
import type {TimelineCandidate} from "./google-timeline";

export interface PlaceVisit<T extends SearchPhoto = SearchPhoto> {
  id: string;
  location: PhotoLocationV1;
  photos: T[];
}
export interface PlaceDay<T extends SearchPhoto = SearchPhoto> {
  key: string;
  date?: string;
  visits: PlaceVisit<T>[];
}
export function validPlace(location: PhotoLocationV1 | undefined): location is PhotoLocationV1 {
  return validatedPhotoLocation(location) !== undefined;
}
export function placeTitle(location: PhotoLocationV1): string {
  return location.name || `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
}
export function placeSource(location: PhotoLocationV1): string {
  return location.source === "google-timeline" ? "Estimated from Google Timeline" : "Location from the photo";
}
export function placeMapURL(location: PhotoLocationV1): string | undefined {
  if (!validPlace(location)) return;
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", `${location.latitude},${location.longitude}`);
  return url.href;
}
export function currentTimelineCandidates(candidates: readonly TimelineCandidate[], photos: readonly SearchPhoto[]): TimelineCandidate[] {
  const current = new Map(photos.filter(photo => photo.current?.() !== false).map(photo => [photo.id, photo]));
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const photo = current.get(candidate.photoID);
    if (!photo || photo.location !== undefined || seen.has(candidate.photoID) || candidate.location.source !== "google-timeline"
      || !validPlace(candidate.location) || !Number.isFinite(Date.parse(photo.date)) || Date.parse(photo.date) !== Date.parse(candidate.capturedAt)
      || !(photo.dateSource === "photos" || photo.dateSource === "exif" && photo.captureVerified === true && photo.captureTimezoneVerified === true)) return false;
    seen.add(candidate.photoID); return true;
  });
}
function meters(a: PhotoLocationV1, b: PhotoLocationV1) {
  const radians = Math.PI / 180, latitude = (b.latitude - a.latitude) * radians,
    longitude = (b.longitude - a.longitude) * radians;
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 12_742_000 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}
function captureTime(photo: SearchPhoto) {
  const time = ["photos", "exif"].includes(photo.dateSource) ? Date.parse(photo.date) : NaN;
  return Number.isFinite(time) ? time : undefined;
}
function dayKey(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/* These are photo stops, not a record of the routes between them. */
export function groupPhotoPlaces<T extends SearchPhoto>(photos: readonly T[]): PlaceDay<T>[] {
  const seen = new Set<string>(), days = new Map<string, PlaceDay<T>>();
  const located = photos.filter(photo => {
    if (photo.current?.() === false || !validPlace(photo.location) || seen.has(photo.id)) return false;
    seen.add(photo.id); return true;
  }).sort((a, b) => (captureTime(a) ?? Infinity) - (captureTime(b) ?? Infinity) || a.id.localeCompare(b.id));
  for (const photo of located) {
    const time = captureTime(photo), key = time === undefined ? "undated" : dayKey(time);
    let day = days.get(key);
    if (!day) {day = {key, date: time === undefined ? undefined : photo.date, visits: []}; days.set(key, day);}
    const location = photo.location!, previous = day.visits.at(-1), last = previous?.photos.at(-1), previousTime = last && captureTime(last);
    if (previous && time !== undefined && previousTime !== undefined && time - previousTime <= 2 * 60 * 60 * 1000
      && previous.location.source === location.source && meters(previous.location, location) <= 250) previous.photos.push(photo);
    else day.visits.push({id: photo.id, location, photos: [photo]});
  }
  return [...days.values()].sort((a, b) => a.key === "undated" ? b.key === "undated" ? 0 : 1 : b.key === "undated" ? -1 : b.key.localeCompare(a.key));
}
