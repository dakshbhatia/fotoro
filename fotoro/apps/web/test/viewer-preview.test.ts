import test from "node:test";
import assert from "node:assert/strict";
import {failedViewerPreview, readViewerPreview, viewerPreviewSource} from "../src/library/viewer-preview";
import type {Photo} from "../src/library/catalog";

const photo = (objectId = "preview-a"): Photo => ({manifest: {ownerAccountId: "owner", photoId: "same",
  metadataRepresentation: {binding: {kind: "metadata", representationId: "metadata-a"}, objectId: "metadata-a", ciphertextSha256: "metadata-digest"}, representations: [
  {binding: {kind: "preview", representationId: objectId}, objectId, ciphertextSha256: objectId + "-digest"},
]}, metadata: {originalSha256: "original"}, annotations: {labels: ["trip"]}} as Photo);

test("viewer preview identity survives label edits but changes for replacement pixels, account and received access", () => {
  const source = photo(), key = viewerPreviewSource(source);
  assert.equal(viewerPreviewSource({...source, annotations: {labels: ["family"], favorite: true} as Photo["annotations"]}), key);
  assert.notEqual(viewerPreviewSource(photo("preview-b")), key);
  assert.notEqual(viewerPreviewSource({...source, manifest: {...source.manifest, ownerAccountId: "other"}}), key);
  assert.notEqual(viewerPreviewSource({...source, metadata: {...source.metadata, originalSha256: "replacement"}}), key);
  assert.notEqual(viewerPreviewSource({...source, grantId: "received"}), key);
  assert.notEqual(viewerPreviewSource({...source, manifest: {...source.manifest, metadataRepresentation: {
    ...source.manifest.metadataRepresentation, ciphertextSha256: "replacement-metadata",
  }}}), key);
});

test("image decode failure offers retry only for the current ready source and URL", () => {
  const ready = {source: "current", state: "ready" as const, url: "blob:current"};
  assert.deepEqual(failedViewerPreview(ready, "current", "blob:current"), {source: "current", state: "failed", url: undefined});
  assert.equal(failedViewerPreview(ready, "old", "blob:old"), ready);
  assert.equal(failedViewerPreview(ready, "current", "blob:old"), ready);
  const loading = {source: "current", state: "loading" as const};
  assert.equal(failedViewerPreview(loading, "current", "blob:current"), loading);
});

test("preview read forwards cancellation, copies verified bytes into its URL and wipes decrypted bytes", async () => {
  const controller = new AbortController(), bytes = new Uint8Array([1, 2, 3]);
  let displayed: Uint8Array | undefined;
  const source = photo();
  const result = await readViewerPreview(source, controller.signal, () => true, async (value, kind, signal) => {
    assert.equal(value, source); assert.equal(kind, "preview"); assert.equal(signal, controller.signal); return bytes;
  }, (key, value, type, decodedBytes) => {
    assert.equal(key, "viewer-preview:" + viewerPreviewSource(source));
    assert.equal(type, "image/jpeg"); assert.equal(decodedBytes, 1600 * 1600 * 4);
    displayed = new Uint8Array(value); return "blob:preview";
  });
  assert.equal(result, "blob:preview"); assert.deepEqual(displayed, new Uint8Array([1, 2, 3]));
  assert.deepEqual(bytes, new Uint8Array(3));
});

test("an unavailable preview retries the same photo after connectivity recovers", async () => {
  const source = photo(), controller = new AbortController();
  let online = false, reads = 0;
  const read = async () => {reads++; if (!online) throw new Error("Offline"); return new Uint8Array([9]);};
  await assert.rejects(readViewerPreview(source, controller.signal, () => true, read, () => "blob:ready"), /Offline/);
  online = true;
  assert.equal(await readViewerPreview(source, controller.signal, () => true, read, () => "blob:ready"), "blob:ready");
  assert.equal(reads, 2);
});

test("abort, lock and same-ID source replacement discard and wipe a late preview before URL publication", async () => {
  for (const withdrawal of ["abort", "lock", "replacement"]) {
    const source = photo(), controller = new AbortController(), bytes = new Uint8Array([7, 8]);
    let currentSession = true, currentSource = viewerPreviewSource(source), published = 0, release!: (value: Uint8Array) => void;
    const pending = readViewerPreview(source, controller.signal,
      () => currentSession && currentSource === viewerPreviewSource(source),
      () => new Promise(resolve => {release = resolve;}),
      () => {published++; return "blob:stale";});
    if (withdrawal === "abort") controller.abort();
    if (withdrawal === "lock") currentSession = false;
    if (withdrawal === "replacement") currentSource = viewerPreviewSource(photo("preview-b"));
    release(bytes);
    assert.equal(await pending, undefined, withdrawal); assert.equal(published, 0, withdrawal);
    assert.deepEqual(bytes, new Uint8Array(2), withdrawal);
  }
});

test("withdrawn reads do not start, and URL construction failures still wipe decrypted bytes", async () => {
  const controller = new AbortController(); let reads = 0;
  assert.equal(await readViewerPreview(photo(), controller.signal, () => false, async () => {reads++; return new Uint8Array([1]);}), undefined);
  assert.equal(reads, 0);
  const bytes = new Uint8Array([4, 5]);
  await assert.rejects(readViewerPreview(photo(), controller.signal, () => true, async () => bytes, () => {throw new Error("URL unavailable");}), /URL unavailable/);
  assert.deepEqual(bytes, new Uint8Array(2));
});
