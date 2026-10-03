import test from "node:test";
import assert from "node:assert/strict";
import { PhotoSearchIndex } from "../src/local/search";
import { cloudSearchRecords } from "../src/library/search";
import {savedSearchPhotos} from "../src/library/consumer-search";
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

const now = new Date(2026, 9, 3, 12).getTime();
function datedPhoto(id: string, dateSource: "photos" | "exif" | "import", day = 3, hour = 9): Photo {
  return {...photo, manifest: {...photo.manifest, photoId: id},
    metadata: {...photo.metadata, dateSource, sourceDate: new Date(2026, 9, day, hour).toISOString()},
    annotations: {...photo.annotations!, photoId: id}};
}
test("native PhotoKit capture dates survive saved adapters and compose with supplied labels within allowed sources", () => {
  const native = datedPhoto("native", "photos"), exif = datedPhoto("exif", "exif", 3, 10), imported = datedPhoto("imported", "import");
  const records = cloudSearchRecords([native, exif, imported]);
  assert.deepEqual(records.map(record => record.dateSource), ["photos", "exif", "selected"]);
  assert.equal(native.metadata.dateSource, "photos", "The wire provenance remains unchanged");
  const adapted = savedSearchPhotos({accountId: "owner", token: {}, current: () => true, photos: [native], preview: async () => new Blob()}, []);
  assert.equal(adapted[0].dateSource, "photos");
  const index = new PhotoSearchIndex(records);
  assert.deepEqual(index.search("today", {now}).photoIds, ["exif", "native"]);
  const composed = index.search("family today", {now});
  assert.deepEqual(composed.photoIds, ["exif", "native"]);
  assert.equal(composed.meaning?.evidence.native, "label");
  assert.deepEqual(index.search("family today", {now, allowedIds: new Set(["native", "imported"])}).photoIds, ["native"]);
  assert.deepEqual(index.search("family", {now}).photoIds, ["exif", "native", "imported"], "Capture ranking must not prefer import time");
  const unsupported = {...native, annotations: {...native.annotations!, originalSha256: "different"}};
  assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([unsupported])).search("family today", {now}).photoIds, [], "A capture date cannot supply missing label evidence");
  assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([unsupported])).search("today", {now}).photoIds, ["native"]);
});

test("PhotoKit date pins stay within capture periods, permissions and source provenance", () => {
  const sources = [datedPhoto("native", "photos"), datedPhoto("exif", "exif", 3, 10), datedPhoto("imported", "import")];
  const scope = "account:owner", index = new PhotoSearchIndex(cloudSearchRecords(sources));
  const result = index.search("family today", {now, scope});
  index.choosePhoto(result.meaning!.id, "imported", "unsupported-import", now, true, scope);
  assert.deepEqual(index.feedback().pins, {});
  index.choosePhoto(result.meaning!.id, "native", "native-choice", now, true, scope);
  assert.equal(index.search("family today", {now, scope}).photoId, "native");
  assert.equal(index.search("family today", {now, scope, allowedIds: new Set(["exif"])}).photoId, "exif");
  assert.equal(index.search("family today", {now, scope: "account:other"}).photoId, "exif");
  for (const changed of [datedPhoto("native", "import"), datedPhoto("native", "photos", 2),
    {...sources[0], metadata: {...sources[0].metadata, sourceDate: "not-a-date"}}]) {
    const refreshed = new PhotoSearchIndex(cloudSearchRecords([changed, sources[1], sources[2]]), index.feedback());
    assert.deepEqual(refreshed.search("family today", {now, scope, previous: result}).photoIds, ["exif"]);
  }
});
