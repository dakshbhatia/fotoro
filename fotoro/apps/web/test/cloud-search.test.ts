import test from "node:test";
import assert from "node:assert/strict";
import { PhotoSearchIndex } from "../src/local/search";
import { cloudSearchRecords } from "../src/library/search";
import type { Photo } from "../src/library/catalog";
const digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const photo = {manifest: {photoId: "cloud-id", ownerAccountId: "owner"}, metadata: {filename: "IMG_001.jpg", sourceDate: "2026-10-01T12:00:00Z", dateSource: "exif", originalSha256: digest}, annotations: {version: 1, photoId: "cloud-id", originalSha256: digest, labels: ["Family dinner"], ocr: {text: "Invoice number 1234", confidence: 0.9, processor: "native-vision-v1"}}} as Photo;
test("cloud labels and verified OCR use the local search index without rewriting stored original identity", () => {
  const index = new PhotoSearchIndex(cloudSearchRecords([photo]));
  assert.deepEqual(index.search("family").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("invoice number").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("1234").photoIds, ["cloud-id"]);
  assert.equal(photo.annotations?.ocr?.processor, "native-vision-v1");
});
test("cloud search excludes annotations from another digest or photo and never reads them from received photos", () => {
  for (const invalid of [{...photo, annotations: {...photo.annotations!, originalSha256: "different"}}, {...photo, annotations: {...photo.annotations!, photoId: "other-id"}}, {...photo, grantId: "received"}]) {
    const index = new PhotoSearchIndex(cloudSearchRecords([invalid]));
    assert.equal(index.search("family").photoIds.length, 0);
    assert.equal(index.search("invoice").photoIds.length, 0);
    assert.deepEqual(index.search("IMG_001").photoIds, ["cloud-id"]);
  }
});
