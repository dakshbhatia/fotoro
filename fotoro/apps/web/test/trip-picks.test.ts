import test from "node:test";
import assert from "node:assert/strict";
import type {Photo} from "../src/library/catalog";
import {TRIP_PICK_LIMIT, tripPickPhotos} from "../src/albums/trip-picks";
import {recommendPhotos, type PhotoSignals} from "../src/local/auto-picks";

function photo(id: string, kind = "image/jpeg", capture = true): Photo {
  return {manifest: {photoId: id, ownerAccountId: "owner", representations: [
    {binding: {kind: "original"}, ciphertextBytes: 1000000},
    {binding: {kind: "thumbnail"}, ciphertextBytes: 500},
  ]}, metadata: {originalSha256: id.padEnd(43, "_"), originalBytes: 4000, mediaType: kind,
    filename: id + ".jpg", sourceDate: "2026-10-01T12:00:00Z", dateSource: capture ? "photos" : "import"}} as Photo;
}
function access() {
  const controller = new AbortController(), reads: string[] = [], buffers: Uint8Array[] = [];
  const value = {signal: controller.signal, current: () => !controller.signal.aborted,
    bytes: async (_photo: Photo, kind: string) => {
      reads.push(kind); const bytes = new Uint8Array([1, 2, 3]); buffers.push(bytes); return bytes;
    }};
  return {value, controller, reads, buffers};
}

test("Trip best shots scopes and dedupes before pixels, caps at 200, and never reads originals", async () => {
  const a = access(), source = Array.from({length: TRIP_PICK_LIMIT + 5}, (_, i) => photo(String(i)));
  const duplicate = {...source[0], manifest: {...source[0].manifest, photoId: "copy"}};
  const videos = [photo("movie", "video/mp4"), photo("live", "application/vnd.fotoro.live-photo")];
  const candidates = tripPickPhotos([...videos, ...source, duplicate], a.value);
  assert.equal(candidates.length, 200); assert.equal(candidates[0].id, "live");
  assert.equal(candidates.some(value => value.id === "movie" || value.id === "copy"), false);
  assert.equal(a.reads.length, 0, "Metadata filtering precedes all pixel work");
  const blob = await candidates[0].previewLoader!();
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(a.reads, ["thumbnail"]); assert.deepEqual([...a.buffers[0]], [0, 0, 0]);
  a.controller.abort();
  await assert.rejects(candidates[0].previewLoader!(), {name: "AbortError"});
  assert.deepEqual(a.reads, ["thumbnail"]);
  assert.equal(tripPickPhotos(source, a.value).length, 0);
});

test("Missing or oversized Trip previews stay unassessed without falling back to originals", async () => {
  const a = access(), missing = photo("missing"), oversized = photo("oversized");
  missing.manifest.representations = missing.manifest.representations.slice(0, 1);
  oversized.manifest.representations[1].ciphertextBytes = 4 * 1024 * 1024 + 1;
  for (const candidate of tripPickPhotos([missing, oversized], a.value)) {
    assert.equal(candidate.previewAvailable, false);
    await assert.rejects(candidate.previewLoader!(), {name: "AbortError"});
  }
  assert.deepEqual(a.reads, []);
});

test("Trip Photos capture dates support burst review; import timestamps do not become capture evidence", () => {
  const a = access(), first = photo("first"), second = photo("second");
  second.metadata.sourceDate = "2026-10-01T12:00:20Z";
  const measured: PhotoSignals = {hash: 0n, sharpness: .2, luminance: .5, contrast: .15, color: [120, 120, 120]};
  const candidates = tripPickPhotos([first, second], a.value).map(value => ({...value, width: 1200, height: 800}));
  const signals = new Map(candidates.map(value => [value.id, measured]));
  assert.equal(recommendPhotos(candidates, signals).groupCount, 1);
  first.metadata.dateSource = "import"; second.metadata.dateSource = "import";
  const imported = tripPickPhotos([first, second], a.value).map(value => ({...value, width: 1200, height: 800}));
  assert.equal(imported[0].captureVerified, undefined);
  assert.equal(imported[0].dateSource, "selected");
  assert.equal(recommendPhotos(imported, signals).groupCount, 2);
});

test("A revoked Trip clears a late derivative before any review output", async () => {
  const a = access();
  a.value.bytes = async (_photo, kind) => {a.reads.push(kind); const bytes = new Uint8Array([1, 2, 3]); a.buffers.push(bytes); a.controller.abort(); return bytes;};
  const [candidate] = tripPickPhotos([photo("late")], a.value);
  await assert.rejects(candidate.previewLoader!(), {name: "AbortError"});
  assert.deepEqual([...a.buffers[0]], [0, 0, 0]);
});
