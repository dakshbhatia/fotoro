import {CAMERA_ORIGINAL_LIMIT, type LivePhotoArchiveHeaderV1} from "../../contracts/src/camera-media.js";
import {validateWire} from "../../contracts/src/validate.js";
import {b64, sodium, ready} from "./common.js";

const MAGIC = new TextEncoder().encode("FOTOROLIVE1\n");
const MAX_HEADER = 4096;
function header(value: unknown): LivePhotoArchiveHeaderV1 {
  const result = validateWire<LivePhotoArchiveHeaderV1>("LivePhotoArchiveHeaderV1", value);
  const extensions: Record<string, string[]> = {"image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/heic": ["heic"], "video/mp4": ["mp4", "m4v"], "video/quicktime": ["mov"]};
  if (!result.still.mediaType.startsWith("image/") || !result.motion.mediaType.startsWith("video/") ||
    [result.still, result.motion].some(part => new TextEncoder().encode(part.filename).length > 255 || !extensions[part.mediaType]?.includes(part.filename.split(".").at(-1)!.toLowerCase()))) throw new Error("INVALID_LIVE_PHOTO");
  return result;
}
export async function encodeLivePhoto(
  still: {filename: string; mediaType: LivePhotoArchiveHeaderV1["still"]["mediaType"]; bytes: Uint8Array},
  motion: {filename: string; mediaType: LivePhotoArchiveHeaderV1["motion"]["mediaType"]; bytes: Uint8Array},
) {
  await ready;
  const describe = (part: typeof still) => ({filename: part.filename, mediaType: part.mediaType, bytes: part.bytes.length, sha256: b64(sodium.crypto_hash_sha256(part.bytes))});
  const json = new TextEncoder().encode(JSON.stringify(header({version: 1, still: describe(still), motion: describe(motion)})));
  const size = MAGIC.length + 4 + json.length + still.bytes.length + motion.bytes.length;
  if (json.length > MAX_HEADER || size > CAMERA_ORIGINAL_LIMIT) throw new Error("LIVE_PHOTO_TOO_LARGE");
  const result = new Uint8Array(size);
  result.set(MAGIC);
  new DataView(result.buffer).setUint32(MAGIC.length, json.length, false);
  result.set(json, MAGIC.length + 4);
  result.set(still.bytes, MAGIC.length + 4 + json.length);
  result.set(motion.bytes, MAGIC.length + 4 + json.length + still.bytes.length);
  return result;
}
export async function decodeLivePhoto(bytes: Uint8Array) {
  await ready;
  if (bytes.length > CAMERA_ORIGINAL_LIMIT || bytes.length < MAGIC.length + 4 || !MAGIC.every((value, index) => bytes[index] === value)) throw new Error("INVALID_LIVE_PHOTO");
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.length, false);
  const offset = MAGIC.length + 4 + count;
  if (!count || count > MAX_HEADER || offset > bytes.length) throw new Error("INVALID_LIVE_PHOTO");
  const metadata = header(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(MAGIC.length + 4, offset))));
  if (offset + metadata.still.bytes + metadata.motion.bytes !== bytes.length) throw new Error("INVALID_LIVE_PHOTO");
  const still = bytes.subarray(offset, offset + metadata.still.bytes), motion = bytes.subarray(offset + metadata.still.bytes);
  if (b64(sodium.crypto_hash_sha256(still)) !== metadata.still.sha256 || b64(sodium.crypto_hash_sha256(motion)) !== metadata.motion.sha256) throw new Error("LIVE_PHOTO_DIGEST_MISMATCH");
  return {metadata, still, motion};
}
