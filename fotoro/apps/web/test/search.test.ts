import test from "node:test";
import assert from "node:assert/strict";
import { PhotoSearchIndex, type SearchPhoto } from "../src/local/search";

const now = Date.parse("2026-10-01T12:00:00Z");
const photo = (id: string, filename: string, labels: string[] = [], date = "2020-01-01T00:00:00Z"): SearchPhoto =>
  ({ id, filename, labels, date, dateSource: "exif" });

test("a supplied name beats a newer filename mention and exposes its provenance", () => {
  const index = new PhotoSearchIndex([photo("portrait", "IMG_1234.jpg", ["Ronald"]), photo("mention", "Ronald-receipt.jpg", [], "2026-10-01T00:00:00Z")]);
  const result = index.search("Ron", { now });
  assert.equal(result.photoId, "portrait");
  assert.equal(result.meaning?.kind, "label");
  assert.equal(result.meaning?.term, "Ronald");
  assert.ok(result.meanings.some(m => m.kind === "filename" && m.term.toLowerCase() === "ronald"));
});
test("prefix continuation excludes unrelated meanings and stale winners", () => {
  const index = new PhotoSearchIndex([photo("ron", "a.jpg", ["Ronald"]), photo("rome", "b.jpg", ["Rome"]), photo("rosa", "c.jpg", ["Rosa"])]);
  const first = index.search("R", { now });
  assert.equal(first.meanings.length, 3);
  assert.equal(index.search("Ron", { now, previous: first }).photoId, "ron");
  assert.equal(index.search("Rom", { now, previous: first }).photoId, "rome");
  assert.equal(index.search("Rox", { now, previous: first }).photoId, undefined);
});
test("normalization matches accents while preserving the supplied word", () => {
  const result = new PhotoSearchIndex([photo("r", "a.jpg", ["Rónald"])]).search("RON", { now });
  assert.equal(result.meaning?.term, "Rónald");
});
test("longer prefixes find terms outside the previously shown six", () => {
  const index = new PhotoSearchIndex(Array.from({ length: 10 }, (_, n) => photo(String(n), "a.jpg", [`Robert${n}`])).concat(photo("rare", "b.jpg", ["Rozanna"])));
  const previous = index.search("R", { now });
  assert.equal(previous.meanings.length, 6);
  assert.equal(index.search("Roz", { now, previous }).photoId, "rare");
});
test("scope filtering happens before completion limits and photo preferences", () => {
  const index = new PhotoSearchIndex([photo("ron", "a.jpg", ["Ronald"]), photo("rome", "b.jpg", ["Rome"])]);
  assert.equal(index.search("R", { now, allowedIds: new Set(["rome"]) }).photoId, "rome");
  assert.equal(index.search("R", { now, allowedIds: new Set() }).photoId, undefined);
});
test("filename noise does not become a predictive meaning and dates still search", () => {
  const index = new PhotoSearchIndex([photo("one", "IMG_1234-fixture.jpg")]);
  assert.equal(index.search("img", { now }).photoId, undefined);
  assert.equal(index.search("jpg", { now }).photoId, undefined);
  assert.equal(index.search("2020-01", { now }).photoId, "one");
});
test("inspection creates no feedback; accepted meanings and explicit choices learn separately", () => {
  const photos = [photo("ron", "a.jpg", ["Ronald"]), photo("rome", "b.jpg", ["Rome"])];
  const index = new PhotoSearchIndex(photos);
  const rome = index.search("Rome", { now }).meaning!;
  const before = index.feedback();
  index.search("R", { now });
  assert.deepEqual(index.feedback(), before);
  index.acceptMeaning(rome.id, "session", now);
  index.acceptMeaning(rome.id, "session", now + 1);
  assert.equal(index.search("R", { now }).photoId, "rome");
  assert.equal(index.feedback().meanings[rome.id].length, 1);
  assert.deepEqual(index.feedback().photos, {});
  assert.equal(new PhotoSearchIndex(photos, index.feedback()).search("R", { now }).photoId, "rome");
});
test("old feedback decays and cannot keep an incompatible chosen photo eligible", () => {
  const index = new PhotoSearchIndex([photo("ron", "a.jpg", ["Ronald"]), photo("rome", "b.jpg", ["Rome"])]);
  const rome = index.search("Rome", { now }).meaning!;
  index.acceptMeaning(rome.id, "old", now - 365 * 86400000);
  const ron = index.search("Ronald", { now }).meaning!;
  index.acceptMeaning(ron.id, "new", now);
  assert.equal(index.search("R", { now }).photoId, "ron");
  index.choosePhoto(rome.id, "rome", "choice", now, true);
  assert.equal(index.search("Ron", { now }).photoId, "ron");
});
test("an explicit representative persists but is removed by scope", () => {
  const photos = [photo("old", "a.jpg", ["Ronald"]), photo("new", "b.jpg", ["Ronald"], "2026-09-30T00:00:00Z")];
  const index = new PhotoSearchIndex(photos);
  const meaning = index.search("Ron", { now }).meaning!;
  assert.equal(index.search("Ron", { now }).photoId, "new");
  index.choosePhoto(meaning.id, "old", "choice", now, true);
  assert.equal(new PhotoSearchIndex(photos, index.feedback()).search("Ron", { now }).photoId, "old");
  assert.equal(index.search("Ron", { now, allowedIds: new Set(["new"]) }).photoId, "new");
});
test("same-meaning prefix extension stays steady and ordering is deterministic", () => {
  const photos = [photo("b", "b.jpg", ["Ronald"]), photo("a", "a.jpg", ["Ronald"])];
  const index = new PhotoSearchIndex(photos);
  const first = index.search("R", { now });
  assert.equal(first.photoId, "a");
  assert.equal(index.search("Ro", { now, previous: first }).photoId, "a");
  assert.equal(new PhotoSearchIndex([...photos].reverse()).search("R", { now }).photoId, "a");
});
