import type {AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import type {OwnedAlbumDetails} from "./details";

// Retain only details the contributor already shared and still owns unchanged.
// New names, renamed labels and changed coordinates require an explicit choice.
export function albumDetailsSelection(source: OwnedAlbumDetails, latest?: AlbumPhotoFactsContentV1) {
  if (!source.current()) throw new Error("ALBUM_SELECTION_CHANGED");
  if (latest && (latest.photoId !== source.photoId || latest.ownerAccountId !== source.ownerAccountId
    || latest.originalSha256 !== source.originalSha256)) throw new Error("ALBUM_FACTS_BINDING_MISMATCH");
  const people = latest?.people.filter(name => source.people.includes(name)) ?? [];
  const location = !!latest?.location && !!source.location &&
    (["latitude", "longitude", "source", "name", "accuracyMeters"] as const)
      .every(key => latest.location![key] === source.location![key]);
  const unavailable = (latest?.people.length ?? 0) - people.length + (latest?.location && !location ? 1 : 0);
  return {people, location, unavailable, existing: !!latest && (!!latest.people.length || !!latest.location)};
}
