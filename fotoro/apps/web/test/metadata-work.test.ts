import test from "node:test";
import assert from "node:assert/strict";
import {metadataDatePhotoIDs, metadataBackgroundPhotoIDs} from "../src/local/metadata-work";
import {inRecentSelectedRange} from "../src/local/consumer-range";
import {PhotoSearchIndex} from "../src/local/search";
import {PickAnalyzer} from "../src/local/auto-picks";
import {LocalOcrQueue, OCR_PROCESSOR, currentOcrSource} from "../src/local/ocr";
import {availablePhotoSelection} from "../src/local/selection";
import type {LocalPhoto} from "../src/local/resources";
const photo = (id: string, date: string, labels: string[] = []): LocalPhoto => ({id, digest: "a".repeat(64), filename: `${id}.jpg`, date, dateSource: "exif", labels, file: new File([id], `${id}.jpg`)});
const now = Date.parse("2026-10-01T12:00:00Z");

test("automatic Picks and opted-in OCR read only current date/place metadata candidates, while hidden original choices survive", async () => {
  const photos = [...Array.from({length: 19997}, (_, index) => photo(`old-${index}`, "2018-05-01T12:00:00Z", ["Paris"])), photo("paris", "2026-10-01T12:00:00Z", ["Paris"]), photo("rome", "2026-10-01T12:00:00Z", ["Rome"]), {...photo("withdrawn", "2026-10-01T12:00:00Z", ["Paris"]), current: () => false}];
  const allowed = new Set(photos.filter(value => inRecentSelectedRange(value, now)).map(value => value.id));
  const scope = metadataDatePhotoIDs(photos, "Paris", allowed), result = new PhotoSearchIndex(photos).search("Paris", {now, allowedIds: scope});
  const ids = metadataBackgroundPhotoIDs(result, scope), work = photos.filter(value => ids.has(value.id));
  assert.deepEqual(work.map(value => value.id), ["paris"]);
  let measurements = 0; const analyzer = new PickAnalyzer();
  await analyzer.run(work, async () => {measurements++; return {hash: 0n, luminance: .5, contrast: .15, sharpness: .12, color: [120, 120, 120]};});
  assert.equal(measurements, 1); analyzer.clear();
  let previews = 0, recognitions = 0;
  const queue = new LocalOcrQueue({origin: "http://localhost", createWorker: async () => ({recognize: async () => {recognitions++; return {data: {text: "Public fixture", confidence: 90}};}, terminate: async () => {}})});
  const completed = await Promise.all(work.map(value => queue.recognize(value.id, value.digest!, async () => {
    previews++; const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); new DataView(bytes.buffer).setUint32(16, 100); new DataView(bytes.buffer).setUint32(20, 100);
    return {blob: new Blob([bytes], {type: "image/png"}), width: 100, height: 100};
  }, () => currentOcrSource(value, work))));
  await queue.cancel(); assert.equal(previews, 1); assert.equal(recognitions, 1); assert.equal(completed[0]?.photoID, "paris");
  assert.deepEqual([...availablePhotoSelection(new Set(["old-1", "paris"]), photos)], ["old-1", "paris"]);
});

test("explicit historical date queries keep new background work in their requested period even when the text is not yet indexed", () => {
  const old = photo("old", "2018-05-01T12:00:00Z"), recent = photo("recent", "2026-10-01T12:00:00Z"), undated = {...old, id: "undated", dateSource: "selected" as const};
  const photos = [old, recent, undated], scope = metadataDatePhotoIDs(photos, "receipt in 2018", new Set(photos.map(value => value.id)));
  const result = new PhotoSearchIndex(photos).search("receipt in 2018", {now, allowedIds: scope});
  assert.equal(result.photoIds.length, 0); assert.deepEqual([...metadataBackgroundPhotoIDs(result, scope)], ["old"]);
});

test("one stored OCR match cannot stop reading other still-unread candidates in the current metadata scope", () => {
  const read = {...photo("read", "2026-10-01T12:00:00Z"), ocr: {photoID: "read", revision: "a".repeat(64), processor: OCR_PROCESSOR, status: "complete" as const, text: "receipt", confidence: .9}};
  const unread = photo("unread", "2026-10-01T12:00:00Z"), scope = new Set([read.id, unread.id]);
  const result = new PhotoSearchIndex([read, unread]).search("receipt", {now, allowedIds: scope});
  assert.deepEqual(result.photoIds, ["read"]); assert.deepEqual([...metadataBackgroundPhotoIDs(result, scope)], ["read", "unread"]);
});
