import test from "node:test";
import assert from "node:assert/strict";
import {parseNaturalDateQuery} from "../src/local/natural-date";
import {PhotoSearchIndex, type SearchPhoto} from "../src/local/search";
import {cloudSearchRecords} from "../src/library/search";
import type {Photo} from "../src/library/catalog";

const date = (year: number, month: number, day: number, hour = 0) => new Date(year, month - 1, day, hour).getTime();
const now = date(2026, 10, 2, 12);
const photo = (id: string, captured = date(2026, 10, 2, 10), extra: Partial<SearchPhoto> = {}): SearchPhoto => ({id, filename: "IMG_001.jpg", date: new Date(captured).toISOString(), dateSource: "exif", ...extra});

test("relative date phrases use full local calendar periods with an exclusive end", () => {
  for (const [query, from, until] of [
    ["today", date(2026, 10, 2), date(2026, 10, 3)],
    ["yesterday", date(2026, 10, 1), date(2026, 10, 2)],
    ["this week", date(2026, 9, 28), date(2026, 10, 5)],
    ["last week", date(2026, 9, 21), date(2026, 9, 28)],
    ["this month", date(2026, 10, 1), date(2026, 11, 1)],
    ["last month", date(2026, 9, 1), date(2026, 10, 1)],
    ["this year", date(2026, 1, 1), date(2027, 1, 1)],
    ["last year", date(2025, 1, 1), date(2026, 1, 1)],
  ] as const) {
    assert.deepEqual(parseNaturalDateQuery(query, {now, firstWeekday: 1}), {text: "", phrase: query, from, until}, query);
  }
  assert.equal(parseNaturalDateQuery("last week", {now, firstWeekday: 0}).from, date(2026, 9, 20));
});

test("calendar days handle daylight saving without fixed twenty-four-hour subtraction", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const parsed = parseNaturalDateQuery("yesterday", {now: date(2026, 3, 9, 12)});
    assert.equal(parsed.from, date(2026, 3, 8));
    assert.equal(parsed.until, date(2026, 3, 9));
    assert.equal(parsed.until! - parsed.from!, 23 * 3600000);
    assert.equal(parseNaturalDateQuery("yesterday", {now: date(2026, 11, 2, 12)}).until! - date(2026, 11, 1), 25 * 3600000);
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("strict ISO and English month periods work alone or before and after evidence words", () => {
  for (const query of ["2026-10-02", "October 2, 2026", "photos on October 2 2026"]) {
    assert.deepEqual(parseNaturalDateQuery(query, {now}), {text: "", phrase: query === "photos on October 2 2026" ? "october 2 2026" : query.toLowerCase(), from: date(2026, 10, 2), until: date(2026, 10, 3)});
  }
  for (const query of ["beach September 2026", "September 2026 beach", "beach in 2026-09", "2026-09 beach"]) {
    const parsed = parseNaturalDateQuery(query, {now});
    assert.equal(parsed.text, "beach", query);
    assert.equal(parsed.from, date(2026, 9, 1), query);
    assert.equal(parsed.until, date(2026, 10, 1), query);
  }
  assert.equal(parseNaturalDateQuery("2026", {now}).until, date(2027, 1, 1));
  assert.equal(parseNaturalDateQuery("photos of beach from last month", {now}).text, "beach");
  assert.equal(parseNaturalDateQuery("last month photos of beach", {now}).text, "beach");
});

test("invalid and ambiguous dates stay text instead of falling back to a whole year", () => {
  for (const query of ["2026-02-30", "2026-13", "2026-1", "2026-10-0", "February 30 2026", "February 30 2026 beach", "beach February 30 2026", "10/2/2026", "last summer", "from 2026-10-02 to 2026-09-01", "September 2026-13", "1899", "2201"]) {
    assert.equal(parseNaturalDateQuery(query, {now}).phrase, undefined, query);
  }
  assert.equal(parseNaturalDateQuery("2024-02-29", {now}).until, date(2024, 3, 1));
  assert.equal(parseNaturalDateQuery("2025-02-29", {now}).phrase, undefined);
});

test("before, after, since and inclusive ISO ranges preserve exact calendar boundaries", () => {
  for (const query of ["beach before 2026-10-02", "before 2026-10-02 beach"]) {
    const parsed = parseNaturalDateQuery(query, {now});
    assert.equal(parsed.text, "beach"); assert.equal(parsed.until, date(2026, 10, 2)); assert.equal(parsed.from, undefined);
  }
  assert.equal(parseNaturalDateQuery("beach after 2026-10-02", {now}).from, date(2026, 10, 3));
  assert.equal(parseNaturalDateQuery("since 2026-10-02 beach", {now}).from, date(2026, 10, 2));
  for (const query of ["beach from 2026-09-01 to 2026-09-30", "from 2026-09 through 2026-09 beach"]) {
    const parsed = parseNaturalDateQuery(query, {now});
    assert.equal(parsed.text, "beach"); assert.equal(parsed.from, date(2026, 9, 1)); assert.equal(parsed.until, date(2026, 10, 1));
  }
});

test("date-only search excludes supplied selection dates, missing dates and period boundaries", () => {
  const index = new PhotoSearchIndex([
    photo("first", date(2026, 10, 2)), photo("last", date(2026, 10, 3) - 1),
    photo("next", date(2026, 10, 3)), photo("previous", date(2026, 10, 2) - 1),
    photo("selected", date(2026, 10, 2), {dateSource: "selected"}), photo("invalid", now, {date: "not-a-date"}),
  ]);
  const result = index.search("today", {now});
  assert.deepEqual(new Set(result.photoIds), new Set(["first", "last"]));
  assert.equal(result.meaning?.kind, "date");
  assert.deepEqual(result.meaning?.evidence, {first: "date", last: "date"});
  assert.deepEqual(index.search("today", {now, allowedIds: new Set(["first", "selected"])}).photoIds, ["first"]);
});

test("compound dates require independent existing text evidence inside the period", () => {
  const index = new PhotoSearchIndex([
    photo("label", date(2026, 9, 12), {labels: ["Beach"]}),
    photo("caption", date(2026, 9, 13), {caption: "A beach visit"}),
    photo("filename", date(2026, 9, 14), {filename: "beach.jpg"}),
    photo("ocr", date(2026, 9, 15), {ocr: {photoID: "ocr", revision: "ocr", processor: "fixture", status: "complete", text: "Beach hotel", confidence: .9}}),
    photo("old", date(2026, 8, 12), {labels: ["Beach"]}),
    photo("selected", date(2026, 9, 12), {dateSource: "selected", labels: ["Beach"]}),
    photo("unknown", date(2026, 9, 12)),
  ]);
  const label = index.search("beach last month", {now});
  assert.equal(label.photoId, "label"); assert.equal(label.meaning?.kind, "label");
  assert.equal(label.meaning?.evidence.label, "label");
  const textual = label.meanings.find(meaning => meaning.kind === "caption")!;
  assert.deepEqual(new Set(textual.photoIds), new Set(["caption", "filename", "ocr"]));
  assert.deepEqual(textual.evidence, {caption: "caption", filename: "filename", ocr: "ocr"});
  assert.deepEqual(index.search("last month beach", {now}).photoIds, ["label"]);
  assert.equal(index.search("Ronald last month", {now}).photoId, undefined);
  assert.equal(index.search("beach yesterday", {now}).photoId, undefined);
  assert.equal(index.search("a beach last month", {now}).meaning?.evidence.caption, "caption");
});

test("compound OCR still excludes stale or failed source evidence", () => {
  const good = photo("good", date(2026, 9, 10), {ocr: {photoID: "good", revision: "good", processor: "fixture", status: "complete", text: "Boarding pass", confidence: .9}});
  const stale = photo("stale", date(2026, 9, 10), {ocr: {...good.ocr!, photoID: "stale"}});
  const failed = photo("failed", date(2026, 9, 10), {ocr: {...good.ocr!, photoID: "failed", revision: "failed", status: "failed"}});
  assert.deepEqual(new PhotoSearchIndex([good, stale, failed]).search("boarding p last month", {now}).photoIds, ["good"]);
});

test("date preferences and pins cannot cross periods or bypass permissions", () => {
  const photos = [photo("a", date(2026, 10, 2, 10), {labels: ["Beach"]}), photo("b", date(2026, 10, 2, 11), {labels: ["Beach"]}), photo("outside", date(2026, 10, 1, 12), {labels: ["Beach"]})];
  const index = new PhotoSearchIndex(photos), today = index.search("today", {now});
  index.choosePhoto(today.meaning!.id, "outside", "bad", now, true);
  assert.deepEqual(index.feedback().pins, {});
  index.choosePhoto(today.meaning!.id, "a", "pin", now, true);
  assert.equal(index.search("today", {now}).photoId, "a");
  assert.equal(index.search("today", {now, allowedIds: new Set(["b", "outside"])}).photoId, "b");
  const beach = index.search("beach today", {now});
  index.choosePhoto(beach.meaning!.id, "a", "scene", now, true);
  assert.equal(index.search("beach today", {now}).photoId, "a");
  assert.equal(index.search("beach yesterday", {now, previous: beach}).photoId, "outside");
  assert.notEqual(index.search("today", {now: date(2026, 10, 3, 12)}).meaning?.id, today.meaning!.id);
  assert.equal(new PhotoSearchIndex(photos, index.feedback()).search("beach today", {now}).photoId, "a");
});

test("same-period text continuation retains an eligible preview and changed dates release it", () => {
  const index = new PhotoSearchIndex([photo("a", date(2026, 10, 2, 10), {labels: ["Beach"]}), photo("b", date(2026, 10, 2, 11), {labels: ["Beach"]}), photo("y", date(2026, 10, 1), {labels: ["Beach"]})]);
  const first = {...index.search("be today", {now}), photoId: "a"};
  assert.equal(index.search("bea today", {now, previous: first}).photoId, "a");
  assert.equal(index.search("bea yesterday", {now, previous: first}).photoId, "y");
});

test("saved photo dates use the same search grammar and exclude import and Photos selection dates", () => {
  const stored = (id: string, dateSource: "exif" | "photos" | "import"): Photo => ({manifest: {photoId: id}, metadata: {filename: "IMG_001.jpg", sourceDate: new Date(date(2026, 9, 12)).toISOString(), dateSource, originalSha256: "digest"}, annotations: {version: 1, photoId: id, originalSha256: "digest", labels: ["Beach"]}} as Photo);
  const index = new PhotoSearchIndex(cloudSearchRecords([stored("verified", "exif"), stored("photos", "photos"), stored("imported", "import")]));
  assert.deepEqual(index.search("last month", {now}).photoIds, ["verified"]);
  assert.deepEqual(index.search("beach last month", {now}).photoIds, ["verified"]);
  assert.equal(index.search("beach", {now}).photoIds.length, 3);
});

test("invalid numeric dates do not accidentally complete a longer OCR date", () => {
  const doc = photo("doc", now, {ocr: {photoID: "doc", revision: "doc", processor: "fixture", status: "complete", text: "2026 02 30 invoice", confidence: .9}});
  assert.equal(new PhotoSearchIndex([doc]).search("2026-02-3", {now}).photoId, undefined);
  assert.equal(new PhotoSearchIndex([doc]).search("2026-02-30", {now}).meaning?.evidence.doc, "ocr");
});
