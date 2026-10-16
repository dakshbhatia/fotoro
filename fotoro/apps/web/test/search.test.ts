import test from "node:test";
import {withPhotoObservation} from "@fotoro/contracts/intelligence";
import {factsWithPeople} from "@fotoro/contracts/people";
import {withPhotoOrganization} from "@fotoro/contracts/organization";
import assert from "node:assert/strict";
import { PhotoSearchIndex, type SearchPhoto } from "../src/local/search";

const now = Date.parse("2026-10-01T12:00:00Z");
const photo = (id: string, filename: string, labels: string[] = [], date = "2020-01-01T00:00:00Z"): SearchPhoto =>
  ({ id, filename, labels, date, dateSource: "exif" });

test("uncommitted prefixes retrieve every completion while accepted meanings narrow", () => {
  const rows = ["harbor", "harvest", "hat", "hatch", "hate", "haven", "hazel", "haze"].map((caption, i) => ({...photo(String(i), "IMG.jpg"), caption}));
  rows.push({...photo("both", "IMG.jpg"), caption: "harbor haze"});
  const index = new PhotoSearchIndex(rows), result = index.search("ha", {now});
  assert.deepEqual(new Set(result.photoIds), new Set(["0", "1", "2", "3", "4", "5", "6", "7", "both"]));
  assert.equal(result.meanings.length, 6, "Suggestion limits must not limit supported photos");
  assert.equal(result.totalMatches, 9);
  assert.equal(result.matches?.["7"].term, "haze");
  assert.equal(result.matches?.["7"].evidence, "caption");
  const narrowed = index.search("ha", {now, committedMeaning: "text:haze"});
  assert.deepEqual(new Set(narrowed.photoIds), new Set(["7", "both"]));
  assert.equal(narrowed.totalMatches, 2);
  assert.equal(narrowed.meaning?.id, "text:haze");
});

test("bounded results retain the exact supported total after deduplication and scope", () => {
  const rows = Array.from({length: 205}, (_, i) => ({...photo(String(i), "IMG.jpg", ["Harbor"]), caption: "harbor"}));
  const index = new PhotoSearchIndex(rows), result = index.search("harbor", {now});
  assert.equal(result.photoIds.length, 200);
  assert.equal(result.totalMatches, 205);
  assert.equal(result.truncated, true);
  const scoped = index.search("harbor", {now, allowedIds: new Set(["0", "204"])});
  assert.equal(scoped.totalMatches, 2);
  assert.equal(scoped.truncated, false);
});

test("union results fence completions beyond the suggestion limit and release withdrawn hits", async () => {
  let visible = true;
  const rows = ["harbor", "harvest", "hat", "hatch", "hate", "haven", "hazel", "haze"].map((caption, i) => ({...photo(String(i), "IMG.jpg"), caption, current: () => i !== 7 || visible}));
  const index = new PhotoSearchIndex(rows), result = await index.searchAsync("ha", {now});
  assert.equal(result.photoIds.includes("7"), true);
  visible = false;
  assert.equal(result.current?.(), false);
  const next = await index.searchAsync("ha", {now, previous: {...result, photoId: "7"}});
  assert.equal(next.photoIds.includes("7"), false);
  assert.equal(next.totalMatches, 7);
});

test("union browsing keeps a supported later completion stable and its feedback scoped to that meaning", () => {
  const index = new PhotoSearchIndex([photo("a", "IMG.jpg", ["Harbor"]), photo("b", "IMG.jpg", ["Haze"]), photo("c", "IMG.jpg", ["Haze"])]);
  const previous = {...index.search("h", {now}), photoId: "c"};
  const result = index.search("ha", {now, previous});
  assert.equal(result.photoId, "c");
  assert.deepEqual(result.photoIds, ["a", "b", "c"]);
  index.choosePhoto(result.matches!.c.meaningId, "c", "choose-haze", now, true, result.scope);
  assert.equal(index.search("ha", {now, committedMeaning: "label:haze"}).photoId, "c");
  assert.equal(index.search("ha", {now, committedMeaning: "label:harbor"}).photoId, "a");
});

test("words inside supplied facts remain findable through batched ingestion and corrected successors", async () => {
  const rehearsal = {...photo("rehearsal", "neutral-a.png"), facts: ["Backstage rehearsal", "fotoro.trash.v1:false"]};
  const other = {...photo("other", "neutral-b.png"), facts: ["Frontstage show"]};
  const rows = [rehearsal, other];
  const sync = new PhotoSearchIndex(rows);
  const first = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true);
  let successor: PhotoSearchIndex | undefined;
  try {
    for (const index of [sync, first]) {
      const result = await index.searchAsync("rehearsal", {now});
      assert.equal(result.photoId, rehearsal.id);
      assert.equal(result.meaning?.evidence[rehearsal.id], "fact");
      assert.equal(index.search("trash", {now}).photoId, undefined, "Reserved organization syntax cannot become a supplied word");
    }
    successor = await PhotoSearchIndex.build([{...rehearsal, facts: ["Audience concert"]}, other], new AbortController().signal, () => true,
      undefined, {index: first, unchanged: new Set([other.id])});
    assert.equal(successor.search("rehearsal", {now}).photoId, undefined);
    assert.equal(successor.search("concert", {now}).photoId, rehearsal.id);
    assert.equal(successor.search("show", {now}).photoId, other.id);
    assert.equal(first.search("rehearsal", {now}).photoId, rehearsal.id, "A corrected successor cannot mutate the preceding index");
    assert.deepEqual(rows[0].facts, ["Backstage rehearsal", "fotoro.trash.v1:false"]);
  } finally {sync.dispose(); first.dispose(); successor?.dispose();}
});

test("successor indexes tokenize only changed receipts while keeping predecessor postings and new source fences independent", async () => {
  const rows = Array.from({length: 1000}, (_, n) => ({...photo(String(n), "neutral.jpg"), caption: "Indexed caption " + n}));
  const match = String.prototype.match;
  let tokenizations = 0;
  String.prototype.match = function (expression: any): any {
    if (expression instanceof RegExp && expression.source === "[\\p{L}\\p{N}]+" && String(this).startsWith("Indexed caption")) tokenizations++;
    return match.call(this, expression);
  };
  let prior: PhotoSearchIndex | undefined, next: PhotoSearchIndex | undefined;
  try {
    prior = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true);
    assert.equal(tokenizations, 2000);
    tokenizations = 0;
    let visible = true;
    const replacement = {...rows[0], caption: "Indexed caption replacement", current: () => visible};
    const added = {...rows[0], id: "added", caption: "Indexed caption appended"};
    const kept = rows.slice(1, -1).map(row => ({...row, current: () => visible}));
    next = await PhotoSearchIndex.build([replacement, ...kept, added], new AbortController().signal, () => true,
      undefined, {index: prior, unchanged: new Set(kept.map(row => row.id))});
    assert.equal(tokenizations, 4, "Only replacement and append tokenize; the 998 verified receipts reuse their postings");
    assert.deepEqual(next.search("replacement").photoIds, ["0"]);
    assert.deepEqual(prior.search("replacement").photoIds, [], "Successor merges cannot mutate predecessor dictionary or phrase contributions");
    assert.ok(!next.search("Indexed caption").photoIds.includes("999"), "Removed receipts are not retained");
    const published = await next.searchAsync("Indexed caption 10");
    assert.ok(published.photoIds.includes("10"));
    visible = false;
    assert.equal(published.current?.(), false, "Reused postings bind to the successor's source closures");
    assert.deepEqual(next.search("caption").photoIds, ["added"]);
    assert.ok(prior.search("caption").photoIds.includes("10"));
    visible = true;
    const controller = new AbortController(); let checks = 0;
    await assert.rejects(PhotoSearchIndex.build(rows, controller.signal, () => {if (++checks === 30) controller.abort(); return true;},
      undefined, {index: next, unchanged: new Set(rows.map(row => row.id))}), {name: "AbortError"});
    assert.ok(next.search("replacement").photoIds.includes("0"), "An aborted successor cannot dispose shared predecessor postings");
    await assert.rejects(PhotoSearchIndex.build(rows, new AbortController().signal, () => true, 1,
      {index: next, unchanged: new Set(rows.map(row => row.id))}), /CACHED_SEARCH_BUDGET/);
  } finally {String.prototype.match = match; prior?.dispose(); next?.dispose();}
});

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
  const index = new PhotoSearchIndex([photo("one", "IMG_1234-fixture.jpg", [], new Date(2020, 0, 1, 12).toISOString())]);
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
test("nonadjacent OCR words retrieve the same document without joining fields or prefixing receipt numbers", () => {
  const text = (id: string, value: string) => ({...photo(id, "neutral.png"), ocr: {photoID: id, revision: id, processor: "fixture-v1", status: "complete" as const, text: value, confidence: .94}});
  const index = new PhotoSearchIndex([text("receipt", "ALFRED COFFEE\nOrder lunch\nInvoice 4826"),
    {...text("spread", "Invoice 4826"), caption: "Alfred"}, text("different-number", "ALFRED COFFEE\nInvoice 48260")]);
  for (const query of ["alfred 4826", "4826 alfred", "coffee order invo"]) {
    const result = index.search(query, {now});
    assert.equal(result.photoId, "receipt", query);
    assert.equal(result.meaning?.kind, "ocr");
    assert.ok(!result.photoIds.includes("spread"));
  }
  assert.deepEqual(index.search("alfred 482", {now}).photoIds, []);
});
test("word conjunctions retain scoped feedback, verified incremental postings and withdrawal fences", async () => {
  let visible = true;
  const rows = ["a", "b"].map(id => ({...photo(id, "neutral.png"), caption: "Boarding pass to Boston", current: () => visible}));
  const index = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true);
  const first = index.search("Boston boarding", {now, allowedIds: new Set(["a", "b"])});
  assert.equal(first.photoIds.length, 2);
  index.choosePhoto(first.meaning!.id, "b", "pin-conjunction", now, true);
  assert.equal(new PhotoSearchIndex(rows, index.feedback()).search("Boston boarding", {now}).photoId, "b");
  const reused = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true, undefined,
    {index, unchanged: new Set(["a", "b"])});
  assert.deepEqual(reused.search("Boston boarding", {now, allowedIds: new Set(["a"])}).photoIds, ["a"]);
  const result = await reused.searchAsync("Boston boarding", {now});
  visible = false;
  assert.equal(result.current?.(), false);
  assert.deepEqual(reused.search("Boston boarding", {now}).photoIds, []);
  index.dispose(); reused.dispose();
});
test("conjunction feedback validates the selected photo despite a direct phrase outside the date or allowed scope", () => {
  const rows = ["a", "b"].map(id => ({...photo(id, "neutral.png", [], "2026-09-15T12:00:00Z"), caption: "Seattle boarding pass"}));
  const index = new PhotoSearchIndex([...rows, {...photo("outside", "neutral.png", [], "2026-10-01T10:00:00Z"), caption: "Seattle pass"}]);
  for (const [query, options] of [
    ["Seattle pass last month", {scope: "dated"}],
    ["Seattle pass", {scope: "allowed", allowedIds: new Set(["a", "b"])}],
  ] as const) {
    const result = index.search(query, {now, ...options});
    assert.equal(result.meaning?.id.includes("fulltext:seattle pass"), true);
    index.choosePhoto(result.meaning!.id, "b", options.scope, now, true, options.scope);
    assert.equal(index.search(query, {now, ...options}).photoId, "b", query);
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
test("renaming keeps the original camera identifier searchable without restoring old custom names", async () => {
  let current = true;
  const original = {...photo("renamed", "IMG_4826.jpg"), current: () => current};
  const renamed = withPhotoOrganization(original, {name: "Boston boarding pass.jpg"});
  const first = await PhotoSearchIndex.build([renamed], new AbortController().signal, () => true);
  let reset: PhotoSearchIndex | undefined;
  try {
    for (const query of ["IMG_4826.jpg", "IMG_482", "4826", "Boston boarding pass.jpg", "Boston"]) {
      const result = await first.searchAsync(query, {now});
      assert.deepEqual(result.photoIds, [original.id], query);
      assert.equal(result.meaning?.evidence[original.id], "filename");
    }
    assert.deepEqual(first.search("img", {now}).photoIds, [], "Camera noise stays out of autocomplete");
    const identifier = first.search("IMG_4826.jpg", {now}).meaning!;
    first.choosePhoto(identifier.id, original.id, "public-choice", now, true);
    assert.equal(new PhotoSearchIndex([renamed], first.feedback()).search("IMG_4826.jpg", {now}).photoId, original.id);
    const published = await first.searchAsync("IMG_4826.jpg", {now});
    current = false;
    assert.equal(published.current?.(), false, "An original-name alias cannot outlive its source");
    assert.deepEqual(first.search("IMG_4826.jpg", {now}).photoIds, []);
    current = true;
    reset = await PhotoSearchIndex.build([withPhotoOrganization(renamed, {name: null})], new AbortController().signal, () => true,
      undefined, {index: first, unchanged: new Set()});
    assert.deepEqual(reset.search("IMG_4826.jpg", {now}).photoIds, [original.id]);
    assert.deepEqual(reset.search("Boston", {now}).photoIds, [], "Reset removes the former custom-name evidence");
  } finally {first.dispose(); reset?.dispose();}
});
test("a current filename ranks before an original-name alias while both remain reachable", () => {
  const alias = withPhotoOrganization(photo("alias", "Boarding-pass.jpg", [], "2026-09-30T00:00:00Z"), {name: "Journey.jpg"});
  const current = photo("current", "Boarding-pass.jpg", [], "2020-01-01T00:00:00Z");
  const index = new PhotoSearchIndex([alias, current]);
  for (const query of ["Boarding", "Boarding pass", "Boarding-pass.jpg"]) {
    const result = index.search(query, {now});
    assert.deepEqual(result.photoIds, [current.id, alias.id], query);
  }
  assert.deepEqual(index.search("Boarding", {now, allowedIds: new Set([alias.id])}).photoIds, [alias.id]);
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

test("source-bound People and observations use the existing search without exposing reserved payloads or uncertainty", () => {
  const digest = "a".repeat(64), observation = {version: 1 as const, photoId: "original", sourceRevision: digest, processor: "gemini-3.8-flash" as const, observedAt: "2026-10-06T12:00:00.000Z", observations: {objects: ["red bicycle"], scene: ["green park"], visibleText: "Cafe", uncertainty: ["moonlight"]}};
  const facts = factsWithPeople(withPhotoObservation({facts: ["My exact fact"]}, observation).facts, digest, [{personId: crypto.randomUUID(), name: "Ronald", box: [0, 0, 1000, 1000]}]);
  const source = {...photo("saved:original", "IMG_0001.jpg"), observationPhotoId: "original", digest, facts};
  const index = new PhotoSearchIndex([source]);
  assert.equal(index.search("Ron",{now}).meaning?.evidence[source.id],"person");
  assert.equal(index.search("bicycle",{now}).meaning?.evidence[source.id],"observation");
  assert.equal(index.search("My exact fact",{now}).meaning?.evidence[source.id],"fact");
  for (const query of ["bicycle", "Cafe", "Ron", "My exact fact"]) assert.equal(index.search(query, {now}).photoId, source.id);
  for (const query of ["moonlight", "fotoro.ai", "gemini", digest]) assert.equal(index.search(query, {now}).photoId, undefined);
  const stale = new PhotoSearchIndex([{...source, digest: "b".repeat(64)}]);
  for (const query of ["bicycle", "Cafe", "Ron"]) assert.equal(stale.search(query, {now}).photoId, undefined);
});

test("async local hits and empty results expire when their index is disposed", async () => {
  for (const query of ["harbor", "absent"]) {
    const index = new PhotoSearchIndex([{...photo("local", "IMG.jpg"), caption: "harbor"}]);
    const result = await index.searchAsync(query);
    assert.deepEqual(result.photoIds, query === "harbor" ? ["local"] : []);
    assert.equal(result.current?.(), true);
    index.dispose();
    assert.equal(result.current?.(), false, `Disposed index must withdraw ${query} results`);
    await assert.rejects(index.searchAsync(query), /CACHED_SEARCH_SOURCE_CHANGED/);
  }
});
