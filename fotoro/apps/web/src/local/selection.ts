import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../library/consumer-search";
import type {LocalPhoto} from "./resources";

export function selectedOwnedPhotos(snapshot: OwnedPhotoSnapshot | null, token: object | null, ids: ReadonlySet<string>) {
  if (!snapshot?.current() || snapshot.token !== token) return [];
  return snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId && ids.has(photo.manifest.photoId));
}

export function ownedPhotoForLocal(snapshot: OwnedPhotoSnapshot | null, local: LocalPhoto) {
  if (!snapshot?.current() || !(local.file instanceof File) || !local.digest) return undefined;
  const index = savedSearchPhotos(snapshot, [local]).findIndex(photo => photo.id === local.id);
  return index < 0 ? undefined : snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId)[index];
}
