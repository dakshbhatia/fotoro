import type {PhotoMetadataV1} from "./models.js";

export const LIVE_PHOTO_TYPE = "application/vnd.fotoro.live-photo";
export const CAMERA_ORIGINAL_LIMIT = 50 * 1024 * 1024;
export const MEDIA_MANIFEST_KIND = "photo-media-manifest-v1";
export const PHOTO_MANIFEST_KIND = "photo-manifest";
export function isCameraMedia(type: string) {
  return type === LIVE_PHOTO_TYPE || type === "video/mp4" || type === "video/quicktime";
}
export function photoManifestKind(metadata: Pick<PhotoMetadataV1, "mediaType">) {
  return isCameraMedia(metadata.mediaType) ? MEDIA_MANIFEST_KIND : PHOTO_MANIFEST_KIND;
}
export function acceptedPhotoManifestKind(kind: string) {
  if (kind !== PHOTO_MANIFEST_KIND && kind !== MEDIA_MANIFEST_KIND) throw new Error("INVALID_MANIFEST_KIND");
  return kind;
}
export interface LivePhotoResourceV1 {
  filename: string;
  mediaType: "image/jpeg" | "image/png" | "image/heic" | "video/mp4" | "video/quicktime";
  bytes: number;
  sha256: string;
}
export interface LivePhotoArchiveHeaderV1 {
  version: 1;
  still: LivePhotoResourceV1;
  motion: LivePhotoResourceV1;
}
