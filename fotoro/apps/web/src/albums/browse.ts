import type {Photo} from "../library/catalog";
export interface AlbumPhotoGroup {photo: Photo; copies: Photo[];}
export function albumPhotoGroups(photos: readonly Photo[], groupCopies = true, current = () => true): AlbumPhotoGroup[] {
  if (!current()) return [];
  const groups = new Map<string, AlbumPhotoGroup>();
  for (const photo of photos) {
    const {originalSha256: digest, originalBytes: bytes, mediaType: type} = photo.metadata;
    const key = groupCopies && /^[\w-]{43}$/.test(digest) && Number.isSafeInteger(bytes) && bytes > 0
      ? JSON.stringify([digest, bytes, type]) : JSON.stringify([photo.manifest.ownerAccountId, photo.manifest.photoId]);
    const group = groups.get(key);
    if (group) group.copies.push(photo); else groups.set(key, {photo, copies: [photo]});
  }
  return current() ? [...groups.values()] : [];
}
