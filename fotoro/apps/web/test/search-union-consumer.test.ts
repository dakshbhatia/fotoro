import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {PhotoSearchIndex, searchPhotoMeaning} from "../src/local/search";
import {LocalSearch, SearchMatchDetails} from "../src/local/LocalSearch";
import {LocalResources, type LocalPhoto} from "../src/local/resources";
import {accountSearchResult, accountSearchResultAsync, combineConsumerSearch, savedSearchHydrationIDs} from "../src/library/consumer-search";
import {addSemanticMatches} from "../src/local/semantic-find";
import {metadataBackgroundPhotoIDs} from "../src/local/metadata-work";
import {shortlistSearchResult} from "../src/local/find-best-shots";
import {peopleFilteredResult, peopleMetadataMatches} from "../src/people/filter";

const photo = (id: string, caption: string): LocalPhoto => ({id, filename: "IMG.jpg", date: "2020-01-01", dateSource: "exif", caption});

test("consumer composition retains different completions, deduplicates totals and preserves receipts", async () => {
  const local = new PhotoSearchIndex([photo("shared", "harbor"), photo("local", "hat")]).search("ha");
  const rows = [photo("cloud", "haze"), photo("duplicate", "harbor")], index = new PhotoSearchIndex(rows);
  const ids = new Map([["cloud", "saved:cloud"], ["duplicate", "shared"]]);
  const sync = accountSearchResult(index.search.bind(index), rows, ids, "ha", {});
  const async = await accountSearchResultAsync(index.searchAsync.bind(index), rows, ids, "ha", {}, new AbortController().signal, () => true);
  for (const saved of [sync, async]) {
    const result = combineConsumerSearch(local, saved);
    assert.deepEqual(new Set(result.photoIds), new Set(["shared", "local", "saved:cloud"]));
    assert.equal(result.totalMatches, 3);
    assert.equal(searchPhotoMeaning(result, "saved:cloud")?.id, "text:haze");
    assert.equal(searchPhotoMeaning(result, "saved:cloud")?.evidence["saved:cloud"], "caption");
    assert.equal(combineConsumerSearch(local, saved, "text:haze").totalMatches, 1);
  }
});

test("consumer unions stay bounded and count overlap beyond both display windows", () => {
  const rows = Array.from({length: 205}, (_, i) => photo(String(i), "harbor"));
  const local = new PhotoSearchIndex(rows).search("harbor");
  const saved = new PhotoSearchIndex([...rows.slice(100), photo("extra", "harbor")]).search("harbor");
  const result = combineConsumerSearch(local, saved);
  assert.equal(result.photoIds.length, 200);
  assert.equal(result.totalMatches, 206);
  assert.equal(result.truncated, true);
});

test("the search surface reports its shown window and details describe the displayed completion", () => {
  const photos = Array.from({length: 205}, (_, i) => photo(String(i), "harbor"));
  const result = new PhotoSearchIndex(photos).search("harbor");
  const markup = renderToStaticMarkup(createElement(LocalSearch, {photos, result, resources: new LocalResources(), coverage: "205 photos", onAccept() {}, onNavigate() {}, onOpen() {}, onConfirm() {}, onPin() {}, onFailure() {}}));
  assert.match(markup, /200 of 205 matches/);
  const alternatives = [photo("a", "harbor"), photo("b", "haze")];
  const union = new PhotoSearchIndex(alternatives).search("ha");
  const details = renderToStaticMarkup(createElement(SearchMatchDetails, {photo: alternatives[1], meaning: searchPhotoMeaning(union, "b")!, coverage: "2 photos", canCorrect: true, onAccept() {}, onConfirm() {}, onPin() {}}));
  assert.match(details, /Caption · haze/);
  assert.doesNotMatch(details, /harbor/);
});

test("visual additions keep direct receipts and truthful bounded totals", () => {
  const base = new PhotoSearchIndex(Array.from({length: 205}, (_, i) => photo(String(i), "harbor"))).search("harbor");
  const result = addSemanticMatches(base, new Map([["204", 0.99], ["visual", 0.99]]), new Set(["204", "visual"]));
  assert.equal(result.photoIds.length, 200);
  assert.equal(result.totalMatches, 206);
  assert.equal(result.matches?.["204"].evidence, "caption");
  assert.equal(result.matches?.visual.evidence, "visual");
});

test("metadata work covers every supported completion and a shortlist reports only its own subset", () => {
  const rows = [photo("a", "harbor"), photo("b", "haze"), photo("unrelated", "mountain")];
  const result = new PhotoSearchIndex(rows).search("ha");
  assert.deepEqual(metadataBackgroundPhotoIDs(result, new Set(["a", "b", "unrelated"])), new Set(["a", "b"]));
  const shortlist = shortlistSearchResult(result, {ids: new Set(["b"])} as Parameters<typeof shortlistSearchResult>[1]);
  assert.equal(shortlist.totalMatches, 1);
  assert.equal(shortlist.truncated, false);
  assert.deepEqual(Object.keys(shortlist.matches!), ["b"]);
});

test("account aliases deduplicate the supported total before display", () => {
  const rows = [photo("a", "harbor"), photo("b", "haze")], index = new PhotoSearchIndex(rows);
  const result = accountSearchResult(index.search.bind(index), rows, new Map([["a", "shared"], ["b", "shared"]]), "ha", {});
  assert.equal(result.totalMatches, 1);
  assert.deepEqual(result.photoIds, ["shared"]);
});

test("an overlapping local hit cannot erase the explicitly accepted Saved support receipt", () => {
  const local = new PhotoSearchIndex([photo("shared", "harbor")]).search("ha", {committedMeaning: "text:haze"});
  const saved = new PhotoSearchIndex([photo("shared", "haze")]).search("ha", {committedMeaning: "text:haze"});
  const result = combineConsumerSearch(local, saved, "text:haze");
  assert.equal(result.meaning?.id, "text:haze");
  assert.equal(result.matches?.shared.meaningId, "text:haze");
  assert.deepEqual(result.photoIds, ["shared"]);
});

test("People consumers preserve union support and restrict receipts and counts to permitted photos", () => {
  const result = new PhotoSearchIndex([photo("a", "harbor"), photo("b", "haze")]).search("ha");
  assert.deepEqual(peopleMetadataMatches(result, [result]), new Set(["a", "b"]));
  const filtered = peopleFilteredResult(result, new Set(["b"]));
  assert.deepEqual(filtered.photoIds, ["b"]);
  assert.equal(filtered.totalMatches, 1);
  assert.deepEqual(Object.keys(filtered.matches!), ["b"]);
  assert.equal(searchPhotoMeaning(filtered)?.id, "text:haze");
});

test("the visual display budget does not masquerade as the total number of supported scores", () => {
  const base = new PhotoSearchIndex([]).search("harbor");
  const scores = new Map(Array.from({length: 205}, (_, i) => [String(i), 0.99]));
  const result = addSemanticMatches(base, scores, new Set(scores.keys()));
  assert.equal(result.photoIds.length, 100, "Keep the existing visual display budget");
  assert.equal(result.totalMatches, 205);
  assert.equal(result.truncated, true);
});

test("the final scoped union hydrates every displayed Saved photo after two originals alias one local digest", async () => {
  const digest = "a".repeat(64);
  const rows = Array.from({length: 203}, (_, i) => ({...photo(`photo-${String(i).padStart(3, "0")}`, "harbor"), digest: i < 2 ? digest : String(i)}));
  const ids = new Map(rows.map(row => [row.id, row.digest === digest ? "local-original" : "saved:" + row.id]));
  const allowedIds = new Set([...ids.values()].filter(id => id !== "saved:photo-202"));
  const index = new PhotoSearchIndex(rows), local = new PhotoSearchIndex([{...photo("local-original", "harbor"), digest}]).search("ha");
  const sync = accountSearchResult(index.search.bind(index), rows, ids, "ha", {allowedIds});
  const async = await accountSearchResultAsync(index.searchAsync.bind(index), rows, ids, "ha", {allowedIds}, new AbortController().signal, () => true);
  for (const saved of [sync, async]) {
    assert.equal(saved.photoIds.length, 199, "The mapped engine window loses one duplicate alias");
    const result = combineConsumerSearch(local, saved);
    assert.equal(result.photoIds.length, 200);
    assert.equal(result.photoIds.includes("saved:photo-200"), true, "Composition fills the hole from supported off-window receipts");
    const hydrationIDs = savedSearchHydrationIDs(result.photoIds, rows, ids);
    assert.ok(hydrationIDs.length <= 200);
    const hydrated = new Set(hydrationIDs.map(id => ids.get(id)));
    for (const id of result.photoIds.filter(id => id.startsWith("saved:"))) assert.equal(hydrated.has(id), true, `${id} must be requested before readiness can clear`);
    assert.equal(hydrated.has("saved:photo-202"), false, "The current allowed scope cannot be widened during hydration");
  }
});
