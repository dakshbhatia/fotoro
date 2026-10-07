import test from "node:test";
import assert from "node:assert/strict";
import {factsWithPeople} from "@fotoro/contracts/people";
import {peopleReviewPlan} from "../src/people/review-plan";
import {peopleMetadataMatches, peopleReviewPhotos} from "../src/people/filter";
import {scanPeoplePhotos} from "../src/people/scan";
import {PhotoSearchIndex} from "../src/local/search";
import {combineConsumerSearch} from "../src/library/consumer-search";
import {inRecentSelectedRange, recentBrowseActive} from "../src/local/consumer-range";
import type {LocalPhoto} from "../src/local/resources";
import {LocalResources} from "../src/local/resources";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {People} from "../src/people/People";
const digest = "a".repeat(64), personId = "11111111-1111-4111-8111-111111111111";
const photo = (id: string, date = "2026-10-01T12:00:00Z", place = "Paris"): LocalPhoto => ({id, digest, filename: `${id}.jpg`, date, dateSource: "exif", labels: [place]});

test("date and place metadata restrict a 20,000-photo library before any face preview or inference", async () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const photos = [...Array.from({length: 19997}, (_, index) => photo(`old-${index}`, "2018-05-01T12:00:00Z")), photo("recent-paris"), photo("recent-rome", undefined, "Rome"), photo("recent-withdrawn")];
  photos.at(-1)!.current = () => false;
  const allowedIds = new Set(photos.filter(value => inRecentSelectedRange(value, now)).map(value => value.id));
  const result = new PhotoSearchIndex(photos).search("Paris", {now, allowedIds});
  const eligibleIDs = peopleMetadataMatches(result), plan = peopleReviewPlan(photos, {eligibleIDs});
  assert.deepEqual(plan.pending.map(value => value.id), ["recent-paris"]);
  let previews = 0, analyses = 0;
  const scanned = await scanPeoplePhotos(plan.pending, new AbortController().signal, {current: value => value.current?.() !== false && eligibleIDs.has(value.id), preview: async () => {previews++; return new Blob();}, analyze: async () => {analyses++; return [];}, progress() {}});
  assert.equal(previews, 1); assert.equal(analyses, 1); assert.equal(scanned.sources.size, 1);
  assert.equal(recentBrowseActive(true, "Paris in 2018"), false);
  const historical = new PhotoSearchIndex(photos).search("Paris in 2018", {now});
  assert.equal(peopleReviewPlan(photos, {eligibleIDs: peopleMetadataMatches(historical)}).pending.length, 19997);
});

test("metadata scope includes every eligible hit beyond lexical display caps in mixed local and Saved libraries", () => {
  const local = new PhotoSearchIndex(Array.from({length: 250}, (_, index) => photo(`local-${index}`))).search("Paris");
  const saved = new PhotoSearchIndex(Array.from({length: 250}, (_, index) => photo(`saved:${index}`))).search("Paris");
  const combined = combineConsumerSearch(local, saved);
  assert.equal(combined.photoIds.length, 400);
  assert.equal(peopleMetadataMatches(combined, [local, saved]).size, 500);
});

test("reviewed names and matching session sources are reused without treating stale or unreviewed photos as assessed", () => {
  const named = photo("named"); named.facts = factsWithPeople([], digest, [{personId, name: "Alex", box: [0, 0, 1000, 1000]}]);
  const cached = photo("cached"), changed = {...photo("changed"), digest: "b".repeat(64)}, staleName = {...named, id: "stale-name", digest: "b".repeat(64)};
  const fresh = photo("fresh"), withdrawn = {...photo("withdrawn"), current: () => false}, outside = photo("outside");
  const photos = [named, cached, changed, staleName, fresh, withdrawn, outside];
  const eligibleIDs = new Set(photos.filter(value => value !== outside).map(value => value.id));
  const scanned = new Map([[cached.id, cached], [changed.id, photo("changed")]]);
  const plan = peopleReviewPlan(photos, {eligibleIDs, scanned});
  assert.deepEqual(plan.reused.map(value => value.id), ["named", "cached"]);
  assert.deepEqual(plan.pending.map(value => value.id), ["changed", "stale-name", "fresh"]);
  assert.deepEqual(peopleReviewPlan(photos, {eligibleIDs, scanned, reassess: true}).pending.map(value => value.id), ["named", "changed", "stale-name", "fresh"]);
  const selectedIDs = new Set([named.id, fresh.id, outside.id, withdrawn.id]);
  assert.deepEqual(peopleReviewPhotos(photos, true, selectedIDs, eligibleIDs).map(value => value.id), ["named", "fresh"]);
  assert.deepEqual(peopleReviewPlan(photos, {eligibleIDs, selectedIDs, selectedOnly: true, scanned}).pending.map(value => value.id), ["fresh"]);
});

test("explicit batches stop at 500 and the next batch reuses current results, advances new photos, and leaves failures retryable", async () => {
  const photos = Array.from({length: 1201}, (_, index) => photo(String(index)));
  const eligibleIDs = new Set(photos.map(value => value.id));
  const first = peopleReviewPlan(photos, {eligibleIDs});
  assert.equal(first.batch.length, 500); assert.equal(first.remaining, 701);
  let calls = 0;
  const scanned = await scanPeoplePhotos(first.batch, new AbortController().signal, {current: () => true, preview: async value => {if (value.id === "0") throw new Error("Unreadable"); return new Blob();}, analyze: async () => {calls++; return [];}, progress() {}});
  assert.equal(calls, 499); assert.equal(scanned.skipped, 1);
  const attempted = new Map(first.batch.map(value => [value.id, value]));
  const second = peopleReviewPlan(photos, {eligibleIDs, scanned: scanned.sources, attempted});
  assert.equal(second.reused.length, 499); assert.equal(second.batch.length, 500); assert.equal(second.remaining, 202);
  assert.equal(second.batch[0].id, "500"); assert.equal(second.pending.at(-1)!.id, "0");
  const completeSources = new Map(photos.slice(1).map(value => [value.id, value]));
  const retry = peopleReviewPlan(photos, {eligibleIDs, scanned: completeSources, attempted});
  assert.deepEqual(retry.batch.map(value => value.id), ["0"]); assert.equal(retry.remaining, 0);
  const changed = {...photos[1], digest: "b".repeat(64)};
  assert.equal(peopleReviewPlan([changed], {eligibleIDs, scanned: completeSources}).batch[0], changed);
});

test("reviewed historical names remain available before model work while analysis controls state the restricted scope", () => {
  const old = photo("old", "2018-05-01T12:00:00Z"); old.facts = factsWithPeople([], digest, [{personId, name: "Alex", box: [0, 0, 1000, 1000]}]);
  const recent = photo("recent");
  const markup = renderToStaticMarkup(createElement(People, {photos: [old, recent], eligibleIDs: new Set([recent.id]), scopeLabel: "Last 30 days and current filters", resources: new LocalResources(), onClose() {}, onOpen() {}, onFind() {}, onExpand() {}}));
  assert.match(markup, /Reviewed people/); assert.match(markup, /Alex/);
  assert.match(markup, /Last 30 days and current filters/); assert.match(markup, /1 available photo/);
  assert.match(markup, /Face analysis covers only this scope/); assert.match(markup, /Include older photos/);
  assert.match(markup, /Reassess reviewed photos in this scope/); assert.doesNotMatch(markup, /All available photos/);
});
