import {peopleNames} from "@fotoro/contracts/people";
import {annotationLocation, type PhotoLocationV1} from "@fotoro/contracts/location";
import type {Photo} from "../library/catalog";
import type {OwnedPhotoSnapshot} from "../library/consumer-search";

export interface OwnedAlbumDetails {photoId: string; ownerAccountId: string; originalSha256: string; people: string[]; location?: PhotoLocationV1; current: () => boolean;}
// Sharing is restricted to the contributor's current, source-bound reviewed data.
export function ownedAlbumDetails(photo: Photo, snapshot: OwnedPhotoSnapshot | null): OwnedAlbumDetails | undefined {
  if (!snapshot?.current() || photo.manifest.ownerAccountId !== snapshot.accountId || photo.grantId) return;
  const owned = snapshot.photos.find(item => !item.grantId && item.manifest.ownerAccountId === snapshot.accountId && item.manifest.photoId === photo.manifest.photoId
    && item.metadata.originalSha256 === photo.metadata.originalSha256 && item.metadata.originalBytes === photo.metadata.originalBytes && item.metadata.mediaType === photo.metadata.mediaType);
  if (!owned || snapshot.sourceCurrent?.(owned) === false) return;
  const annotation = owned.annotations;
  const current = () => snapshot.current() && snapshot.photos.includes(owned) && snapshot.sourceCurrent?.(owned) !== false && owned.annotations === annotation;
  if (annotation && (annotation.photoId !== owned.manifest.photoId || annotation.originalSha256 !== owned.metadata.originalSha256)) return;
  return {photoId: photo.manifest.photoId, ownerAccountId: snapshot.accountId, originalSha256: photo.metadata.originalSha256, people: peopleNames(annotation?.facts, photo.metadata.originalSha256), location: annotation ? annotationLocation(annotation) : undefined, current};
}
