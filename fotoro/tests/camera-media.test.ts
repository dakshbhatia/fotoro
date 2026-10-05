import test from "node:test";
import assert from "node:assert/strict";
import {encodeLivePhoto, decodeLivePhoto, ready, b64, sodium, encryptMedia, decryptMedia} from "../packages/crypto/src/index.js";
import {acceptedPhotoManifestKind, photoManifestKind, LIVE_PHOTO_TYPE} from "../packages/contracts/src/camera-media.js";
import {validateWire} from "../packages/contracts/src/validate.js";

const still = {filename: "IMG_1234.HEIC", mediaType: "image/heic" as const, bytes: new Uint8Array([1, 2, 3, 4])};
const motion = {filename: "IMG_1234.MOV", mediaType: "video/quicktime" as const, bytes: new Uint8Array([5, 6, 7, 8, 9])};
async function collect(parts: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of parts) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {output.set(chunk, offset); offset += chunk.length;}
  return output;
}
async function* source(bytes: Uint8Array) {yield bytes;}

test("Live original survives the existing encrypted original pipeline with both exact resources", async () => {
  await ready;
  const archive = await encodeLivePhoto(still, motion), key = sodium.randombytes_buf(32);
  const binding = {version: 1 as const, photoId: crypto.randomUUID(), representationId: crypto.randomUUID(), kind: "original" as const};
  const cipher = await collect(encryptMedia(source(archive), key, binding));
  const restored = await collect(decryptMedia(source(cipher), key, binding));
  assert.deepEqual(restored, archive);
  const pair = await decodeLivePhoto(restored);
  assert.equal(pair.metadata.still.filename, still.filename);
  assert.equal(pair.metadata.motion.filename, motion.filename);
  assert.deepEqual(pair.still, still.bytes);
  assert.deepEqual(pair.motion, motion.bytes);
  assert.equal(pair.metadata.motion.sha256, b64(sodium.crypto_hash_sha256(motion.bytes)));
});
test("Live parser rejects incomplete, corrupted, oversized-header and trailing originals", async () => {
  const archive = await encodeLivePhoto(still, motion);
  await assert.rejects(decodeLivePhoto(archive.subarray(0, archive.length - 1)), /INVALID_LIVE_PHOTO/);
  const corrupt = new Uint8Array(archive); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(decodeLivePhoto(corrupt), /DIGEST_MISMATCH/);
  const trailing = new Uint8Array(archive.length + 1); trailing.set(archive);
  await assert.rejects(decodeLivePhoto(trailing), /INVALID_LIVE_PHOTO/);
  const hugeHeader = new Uint8Array(archive); new DataView(hugeHeader.buffer).setUint32(11, 0xffffffff);
  await assert.rejects(decodeLivePhoto(hugeHeader), /INVALID_LIVE_PHOTO/);
  await assert.rejects(encodeLivePhoto({...still, filename: "../IMG.HEIC"}, motion));
  await assert.rejects(encodeLivePhoto({...still, filename: `${"é".repeat(126)}.HEIC`}, motion), /INVALID_LIVE_PHOTO/);
  await assert.rejects(encodeLivePhoto(still, {...motion, mediaType: "image/jpeg"}));
});
test("extended media metadata retains image wire compatibility and distinguishes authenticated manifest kinds", () => {
  const metadata = {version: 1, filename: "IMG.MOV", mediaType: "video/quicktime", sourceDate: "2026-10-01T00:00:00Z", dateSource: "photos", originalBytes: 12, originalSha256: "A".repeat(43), representationKeys: {}};
  validateWire("PhotoMetadataV1", metadata);
  validateWire("PhotoMetadataV1", {...metadata, mediaType: LIVE_PHOTO_TYPE});
  assert.equal(photoManifestKind({mediaType: "image/jpeg"}), "photo-manifest");
  assert.equal(photoManifestKind({mediaType: "video/quicktime"}), "photo-media-manifest-v1");
  assert.equal(photoManifestKind({mediaType: LIVE_PHOTO_TYPE}), "photo-media-manifest-v1");
  assert.throws(() => acceptedPhotoManifestKind("unverified-media"));
  assert.throws(() => validateWire("PhotoMetadataV1", {...metadata, mediaType: "video/avi"}));
  assert.throws(() => validateWire("PhotoMetadataV1", {...metadata, originalBytes: 50 * 1024 * 1024 + 1}));
});
