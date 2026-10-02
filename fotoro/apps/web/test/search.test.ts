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
  assert.equal(Object.values(index.feedback().meanings)[0].length, 1);
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
test("a stable displayed photo does not reorder Next/Previous navigation", () => {
  const index = new PhotoSearchIndex([photo("a", "a.jpg", ["Ronald"]), photo("b", "b.jpg", ["Ronald"]), photo("c", "c.jpg", ["Ronald"])]);
  const first = index.search("R", { now });
  const displayed = { ...first, photoId: "b" };
  const extended = index.search("Ro", { now, previous: displayed });
  assert.equal(extended.photoId, "b");
  assert.deepEqual(extended.photoIds, ["a", "b", "c"]);
  assert.equal(extended.photoIds[extended.photoIds.indexOf(extended.photoId!) + 1], "c");
});
test("an incompatible accepted completion releases to a supported longer word", () => {
  const index = new PhotoSearchIndex([photo("short", "a.jpg", ["Ron"]), photo("long", "b.jpg", ["Ronald"])]);
  const committed = index.search("Ron", { now }).meaning!.id;
  assert.equal(index.search("Rona", { now, committedMeaning: committed }).photoId, "long");
});
test("the 200-result cap cannot evict an eligible stable preview during prefix extension", () => {
  const old = photo("old", "a.jpg", ["Ronald"]);
  const previous = new PhotoSearchIndex([old]).search("R", { now });
  const index = new PhotoSearchIndex([old, ...Array.from({ length: 220 }, (_, n) => photo("new" + n, "b.jpg", ["Ronald"], "2026-09-30T00:00:00Z"))]);
  const result = index.search("Ro", { now, previous });
  assert.equal(result.photoId, "old");
  assert.equal(result.photoIds.length, 200);
  assert.ok(result.photoIds.includes("old"));
});
test("accepted meanings do not leak between explicit search scopes", () => {
  const index = new PhotoSearchIndex([photo("ra", "a.jpg", ["Ronald"]), photo("sa", "b.jpg", ["Rosa"]), photo("rb", "c.jpg", ["Ronald"]), photo("sb", "d.jpg", ["Rosa"])]);
  const rosa = index.search("Rosa", { now }).meaning!.id;
  index.acceptMeaning(rosa, "session", now, "scope-a");
  assert.equal(index.search("R", { now, scope: "scope-a", allowedIds: new Set(["ra", "sa"]) }).photoId, "sa");
  assert.equal(index.search("R", { now, scope: "scope-b", allowedIds: new Set(["rb", "sb"]) }).photoId, "rb");
});
test("successful OCR retrieves a neutral filename with text provenance", () => {
  const receipt = { ...photo("receipt", "neutral-a.png"), ocr: { photoID: "receipt", revision: "receipt", processor: "fixture-v1", status: "complete" as const, text: "RECEIPT INVOICE 4826", confidence: .94 } };
  const result = new PhotoSearchIndex([receipt]).search("Recei", { now });
  assert.equal(result.photoId, "receipt"); assert.equal(result.meaning?.kind, "ocr");
});
test("failed or stale OCR cannot supply a searchable name", () => {
  const base = { ...photo("receipt", "neutral.png"), ocr: { photoID: "receipt", revision: "old", processor: "fixture-v1", status: "complete" as const, text: "Ronald", confidence: .94 } };
  assert.equal(new PhotoSearchIndex([base]).search("Ron", { now }).photoId, undefined);
  assert.equal(new PhotoSearchIndex([{ ...base, ocr: { ...base.ocr, revision: "receipt", status: "failed" as const } }]).search("Ron", { now }).photoId, undefined);
});
test("keywords and captions outrank filename/OCR mentions within one text meaning", () => {
  const photos = [photo("filename", "Rome.jpg", [], "2026-10-01T00:00:00Z"), { ...photo("caption", "a.jpg"), caption: "Rome" }, { ...photo("keyword", "b.jpg"), keywords: ["Rome"] }];
  const result = new PhotoSearchIndex(photos).search("Rome", { now });
  assert.equal(result.photoId, "keyword"); assert.equal(result.meaning?.kind, "keyword");
  assert.equal(result.meanings.length, 1);
  assert.equal(result.meaning?.evidence["filename"], "filename");
});
test("a favorite helps only among equally supported photos", () => {
  const index = new PhotoSearchIndex([{ ...photo("old", "a.jpg", ["Ronald"]), favorite: true }, photo("new", "b.jpg", ["Ronald"], "2026-09-30T00:00:00Z")]);
  assert.equal(index.search("Ron", { now }).photoId, "old");
});
test("a newer same-id revision removes obsolete searchable labels", () => {
  const index = new PhotoSearchIndex([photo("same", "a.jpg", ["Ronald"]), photo("same", "a.jpg", ["Rome"])]);
  assert.equal(index.search("Ron", { now }).photoId, undefined);
  assert.equal(index.search("Rom", { now }).photoId, "same");
});
test("a phrase prefix retrieves adjacent OCR words without joining unrelated fields", () => {
  const ocr = { photoID: "doc", revision: "doc", processor: "fixture-v1", status: "complete" as const, text: "BOARDING PASS FLIGHT BOSTON", confidence: .94 };
  const index = new PhotoSearchIndex([{ ...photo("doc", "neutral.png"), ocr }, { ...photo("spread", "Boarding.jpg"), caption: "pass" }]);
  for (const query of ["Boarding p", "Boarding pass", "pass fl"]) {
    const result = index.search(query, { now });
    assert.equal(result.photoId, "doc");
    assert.equal(result.meaning?.evidence.doc, "ocr");
    assert.ok(!result.photoIds.includes("spread"));
  }
});
test("phrase completions can be accepted, confirmed and pinned with truthful source evidence", () => {
  const photos = ["a", "b"].map(id => ({ ...photo(id, "neutral.png"), caption: "Boarding pass to Boston" }));
  const index = new PhotoSearchIndex(photos);
  const result = index.search("boarding p", { now });
  assert.equal(result.meaning?.term, "Boarding pass");
  const meaning = result.meaning!.id;
  index.acceptMeaning(meaning, "accept", now);
  index.choosePhoto(meaning, "b", "use", now, true);
  const reopened = new PhotoSearchIndex(photos, index.feedback()).search("boarding pa", { now, committedMeaning: meaning });
  assert.equal(reopened.photoId, "b");
  assert.equal(reopened.meaning?.evidence.b, "caption");
});
test("literal noisy filenames remain explicitly retrievable without generic autocomplete noise", () => {
  const index = new PhotoSearchIndex([photo("img", "IMG_1234.jpg"), photo("digits", "4826.png")]);
  assert.equal(index.search("img", { now }).photoId, undefined);
  assert.equal(index.search("jpg", { now }).photoId, undefined);
  assert.equal(index.search("IMG_1234.jpg", { now }).photoId, "img");
  assert.equal(index.search("IMG_123", { now }).photoId, "img");
  assert.equal(index.search("4826", { now }).photoId, "digits");
});
test("broad-prefix ranking reads capture dates and photo history at most once per eligible photo", () => {
  const photos = Array.from({ length: 200 }, (_, i) => photo("photo-" + i.toString().padStart(3, "0"), "IMG_" + i + ".jpg", ["Receipt"], new Date(now - ((i * 7919) % 365) * 86400000).toISOString()));
  const index = new PhotoSearchIndex(photos), historyKey = JSON.stringify(["local:all", "label:receipt"]);
  const parse = Date.parse, stringify = JSON.stringify;
  let dates = 0, photoHistory = 0;
  Date.parse = value => { dates++; return parse(value); };
  JSON.stringify = (value, replacer, space) => {
    if (Array.isArray(value) && value.length === 2 && value[0] === historyKey) photoHistory++;
    return stringify(value, replacer, space);
  };
  try {
    const result = index.search("Re", { now });
    assert.equal(result.photoId, "photo-000");
    assert.equal(result.photoIds.length, 200);
    assert.ok(dates <= photos.length && photoHistory <= photos.length, `${dates} capture-date parses and ${photoHistory} photo-history keys for ${photos.length} eligible photos`);
  } finally { Date.parse = parse; JSON.stringify = stringify; }
});
