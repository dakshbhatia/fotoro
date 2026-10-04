import test from "node:test";
import assert from "node:assert/strict";
import {ready, b64, sodium, encodeLivePhoto} from "@fotoro/crypto";
import {cameraOriginalFiles, readCameraPlayback} from "../src/media/camera-original";
import type {Photo} from "../src/library/catalog";

async function photo() {
  await ready;
  const still = new Uint8Array([1, 2, 3]), movie = new Uint8Array([4, 5, 6, 7]);
  const bytes = await encodeLivePhoto({filename: "pair.HEIC", mediaType: "image/heic", bytes: still}, {filename: "pair.MOV", mediaType: "video/quicktime", bytes: movie});
  const source = {manifest: {photoId: crypto.randomUUID()}, metadata: {version: 1, filename: "pair.fotoro-live", mediaType: "application/vnd.fotoro.live-photo", dateSource: "photos", sourceDate: "2026-10-01T00:00:00Z", originalBytes: bytes.length, originalSha256: b64(sodium.crypto_hash_sha256(bytes)), representationKeys: {}}} as Photo;
  return {source, bytes, still, movie};
}
test("Live export exposes both unchanged originals, not the JPEG poster", async () => {
  const {source, bytes, still, movie} = await photo();
  const files = await cameraOriginalFiles(bytes, source.metadata);
  assert.deepEqual(files.map(file => [file.name, file.type]), [["pair.HEIC", "image/heic"], ["pair.MOV", "video/quicktime"]]);
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), still);
  assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), movie);
  await assert.rejects(cameraOriginalFiles(bytes, {...source.metadata, originalSha256: "A".repeat(43)}), /DIGEST_MISMATCH/);
});
test("explicit Live playback reads only verified original motion and clears decrypted bytes", async () => {
  const {source, bytes, movie} = await photo();
  let reads = 0;
  const blob = await readCameraPlayback(source, new AbortController().signal, () => true, async (_photo, kind) => {reads++; assert.equal(kind, "original"); return bytes;});
  assert.equal(reads, 1); assert.equal(blob?.type, "video/quicktime");
  assert.deepEqual(new Uint8Array(await blob!.arrayBuffer()), movie);
  assert.ok(bytes.every(value => value === 0));
});
test("cancelled or replaced playback does not expose bytes or start a successor read", async () => {
  for (const abort of [true, false]) {
    const {source, bytes} = await photo();
    const controller = new AbortController(); let current = true;
    const blob = await readCameraPlayback(source, controller.signal, () => current, async () => {
      if (abort) controller.abort(); else current = false;
      return bytes;
    });
    assert.equal(blob, undefined); assert.ok(bytes.every(value => value === 0));
  }
  const {source} = await photo(); let reads = 0;
  assert.equal(await readCameraPlayback(source, new AbortController().signal, () => false, async () => {reads++; return new Uint8Array();}), undefined);
  assert.equal(reads, 0);
});
