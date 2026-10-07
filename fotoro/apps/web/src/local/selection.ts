import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../library/consumer-search";
import type {LocalPhoto} from "./resources";

export function availablePhotoSelection(selection: Set<string>, photos: readonly LocalPhoto[]) {
  const available = new Set(photos.filter(photo => selection.has(photo.id) && photo.current?.() !== false).map(photo => photo.id));
  return available.size === selection.size ? selection : available;
}

export function selectedOwnedPhotos(snapshot: OwnedPhotoSnapshot | null, token: object | null, ids: ReadonlySet<string>) {
  if (!snapshot?.current() || snapshot.token !== token) return [];
  return snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId && ids.has(photo.manifest.photoId));
}

export function reconcileSavedSelection(snapshot: OwnedPhotoSnapshot | null, token: object | null, ids: ReadonlySet<string>, local: readonly LocalPhoto[]) {
  const chosen = selectedOwnedPhotos(snapshot, token, ids);
  const savedIDs = new Set(chosen.map(photo => photo.manifest.photoId)), localIDs = new Set<string>();
  if (!snapshot || !chosen.length) return {savedIDs, localIDs};
  const available = local.filter(photo => photo.file instanceof File && photo.digest && photo.current?.() !== false);
  const originals = new Map(available.map(photo => [photo.id, photo]));
  // Use the search adapter's digest identity when a saved hit becomes a local hit.
  savedSearchPhotos({...snapshot, photos: chosen}, available).forEach((photo, index) => {
    const original = originals.get(photo.id);
    if (photo.id.startsWith("saved:") || !original || original.current?.() === false || photo.current?.() === false) return;
    savedIDs.delete(chosen[index].manifest.photoId); localIDs.add(original.id);
  });
  if (!snapshot.current() || snapshot.token !== token) {savedIDs.clear(); localIDs.clear();}
  return {savedIDs, localIDs};
}

export function ownedPhotoForLocal(snapshot: OwnedPhotoSnapshot | null, local: LocalPhoto) {
  if (!snapshot?.current() || !(local.file instanceof File) || !local.digest) return undefined;
  const index = savedSearchPhotos(snapshot, [local]).findIndex(photo => photo.id === local.id);
  return index < 0 ? undefined : snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId)[index];
}

export function chosenAlbumPhotos(snapshot: OwnedPhotoSnapshot | null, local: readonly LocalPhoto[], saved: readonly import("../library/catalog").Photo[]) {
  const photos = new Map<string, import("../library/catalog").Photo>();
  let needsSave = 0;
  if (!snapshot?.current()) return {photos: [], needsSave: local.length + saved.length};
  for (const photo of saved) {
    if (!photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId && snapshot.photos.includes(photo)) photos.set(photo.manifest.photoId, photo);
    else needsSave++;
  }
  for (const source of local) {
    const photo = source.current?.() !== false ? ownedPhotoForLocal(snapshot, source) : undefined;
    if (photo) photos.set(photo.manifest.photoId, photo); else needsSave++;
  }
  if (!snapshot.current()) return {photos: [], needsSave: local.length + saved.length};
  return {photos: [...photos.values()], needsSave};
}
