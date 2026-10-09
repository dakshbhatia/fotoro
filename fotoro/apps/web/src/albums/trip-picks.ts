import type {Photo} from "../library/catalog";
import type {LocalPhoto} from "../local/resources";
import type {AlbumAccess} from "./service";
import {albumPhotoGroups} from "./browse";

export const TRIP_PICK_LIMIT = 200;
type PreviewAccess = Pick<AlbumAccess, "current" | "bytes" | "signal">;

// The caller supplies the already filtered, authenticated Trip window. Review
// never expands the catalog or reads an original, including for missing previews.
export function tripPickPhotos(photos: readonly Photo[], access: PreviewAccess): LocalPhoto[] {
  const current = () => !access.signal.aborted && access.current();
  return albumPhotoGroups(photos, true, current)
    .map(group => group.photo)
    .filter(photo => photo.metadata.mediaType.startsWith("image/") || photo.metadata.mediaType === "application/vnd.fotoro.live-photo")
    .slice(0, TRIP_PICK_LIMIT)
    .map(photo => {
      const derivative = photo.manifest.representations.find(rep => rep.binding.kind === "thumbnail" && rep.ciphertextBytes <= 4 * 1024 * 1024)
        ?? photo.manifest.representations.find(rep => rep.binding.kind === "preview" && rep.ciphertextBytes <= 4 * 1024 * 1024);
      const captured = ["photos", "exif"].includes(photo.metadata.dateSource) && Number.isFinite(Date.parse(photo.metadata.sourceDate));
      return {
        id: photo.manifest.photoId,
        digest: photo.metadata.originalSha256,
        filename: photo.metadata.filename,
        date: photo.metadata.sourceDate,
        dateSource: photo.metadata.dateSource === "import" ? "selected" : photo.metadata.dateSource,
        captureVerified: captured ? true : undefined,
        previewAvailable: !!derivative,
        current,
        previewLoader: async () => {
          if (!current() || !derivative) throw new DOMException("Trip review unavailable", "AbortError");
          const bytes = await access.bytes(photo, derivative.binding.kind as "thumbnail" | "preview", access.signal);
          try {
            if (!current()) throw new DOMException("Trip review cancelled", "AbortError");
            return new Blob([new Uint8Array(bytes)], {type: "image/jpeg"});
          } finally {bytes.fill(0);}
        },
      } satisfies LocalPhoto;
    });
}
