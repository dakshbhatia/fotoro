import type {Photo} from "../library/catalog";
export interface AlbumPhotoGroup {photo: Photo; copies: Photo[];}
// Arrows follow the visible tiles; choosing another contributor's copy keeps
// the same position rather than adding repeated originals to the sequence.
export function albumPreviewNavigation(groups: readonly AlbumPhotoGroup[], preview: Photo | null) {
  const index = preview ? groups.findIndex(group => group.copies.includes(preview)) : -1;
  return {
    index, count: groups.length,
    previous: index > 0 ? groups[index - 1].photo : undefined,
    next: index >= 0 ? groups[index + 1]?.photo : undefined,
    copies: index >= 0 ? groups[index].copies : [],
  };
}
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
