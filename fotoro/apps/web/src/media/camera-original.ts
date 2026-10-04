import type {PhotoMetadataV1} from "@fotoro/contracts";
import {CAMERA_ORIGINAL_LIMIT, LIVE_PHOTO_TYPE, isCameraMedia} from "@fotoro/contracts/camera-media";
import {ready, b64, sodium, decodeLivePhoto} from "@fotoro/crypto";
import {photoBytes, type Photo} from "../library/catalog";

function verify(bytes: Uint8Array, metadata: PhotoMetadataV1) {
  if (!bytes.length || bytes.length > CAMERA_ORIGINAL_LIMIT || bytes.length !== metadata.originalBytes ||
    b64(sodium.crypto_hash_sha256(bytes)) !== metadata.originalSha256) throw new Error("ORIGINAL_DIGEST_MISMATCH");
}
export async function cameraOriginalFiles(bytes: Uint8Array, metadata: PhotoMetadataV1): Promise<File[]> {
  await ready;
  verify(bytes, metadata);
  if (metadata.mediaType === LIVE_PHOTO_TYPE) {
    const pair = await decodeLivePhoto(bytes);
    return [new File([new Uint8Array(pair.still)], pair.metadata.still.filename, {type: pair.metadata.still.mediaType}),
      new File([new Uint8Array(pair.motion)], pair.metadata.motion.filename, {type: pair.metadata.motion.mediaType})];
  }
  const filename = metadata.filename.split(/[\\/]/).at(-1);
  if (!filename || filename === "." || filename === "..") throw new Error("INVALID_ORIGINAL_FILENAME");
  return [new File([new Uint8Array(bytes)], filename, {type: metadata.mediaType})];
}
export async function readCameraPlayback(photo: Photo, signal: AbortSignal, current: () => boolean, read = photoBytes): Promise<Blob | undefined> {
  if (!isCameraMedia(photo.metadata.mediaType) || signal.aborted || !current()) return;
  const bytes = await read(photo, "original", signal);
  try {
    await ready;
    if (signal.aborted || !current()) return;
    verify(bytes, photo.metadata);
    if (photo.metadata.mediaType === LIVE_PHOTO_TYPE) {
      const pair = await decodeLivePhoto(bytes);
      if (signal.aborted || !current()) return;
      return new Blob([new Uint8Array(pair.motion)], {type: pair.metadata.motion.mediaType});
    }
    return new Blob([new Uint8Array(bytes)], {type: photo.metadata.mediaType});
  } finally {bytes.fill(0);}
}
