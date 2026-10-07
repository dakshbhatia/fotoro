import test from "node:test";
import assert from "node:assert/strict";
import {photoCell, sortTablePhotos} from "../src/local/photo-table";
import type {LocalPhoto} from "../src/local/resources";
const photo = (id: string, values: Partial<LocalPhoto> = {}): LocalPhoto => ({id, filename: `${id}.jpg`, date: "2026-10-01T12:00:00Z", dateSource: "exif", ...values});
test("table never presents selection timestamps as capture dates and sorts unavailable dates last both ways", () => {
  const recent = photo("recent", {date: "2026-10-05T12:00:00Z"}), older = photo("older"), unknown = photo("unknown", {dateSource: "selected", date: "2026-10-06T12:00:00Z"});
  const input = [unknown, recent, older];
  assert.equal(photoCell(unknown, "date"), "Unavailable");
  assert.deepEqual(sortTablePhotos(input, {column: "date", descending: false}).map(photo => photo.id), ["older", "recent", "unknown"]);
  assert.deepEqual(sortTablePhotos(input, {column: "date", descending: true}).map(photo => photo.id), ["recent", "older", "unknown"]);
  assert.deepEqual(input, [unknown, recent, older]);
});
test("table uses observed dimensions, location, labels and original availability", () => {
  const original = photo("local", {file: new File(["original"], "local.jpg", {type: "image/jpeg"}), width: 4000, height: 3000, labels: ["Family"], location: {latitude: 1.25, longitude: 2.5, source: "exif"}});
  assert.equal(photoCell(original, "dimensions"), "4000 × 3000");
  assert.equal(photoCell(original, "location"), "1.2500, 2.5000");
  assert.equal(photoCell(original, "tags"), "Family");
  assert.equal(photoCell(original, "availability"), "Original on device");
  assert.equal(photoCell(photo("preview", {preview: new Blob(["preview"])}), "availability"), "Preview only");
  assert.equal(photoCell(photo("missing", {previewAvailable: false}), "availability"), "Reselect original");
  assert.equal(photoCell(photo("unknown"), "dimensions"), "Unavailable");
});
