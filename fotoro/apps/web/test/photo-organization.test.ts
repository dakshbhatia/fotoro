import {groupPhotoPlaces} from "../src/local/places";
import {currentSearchRecords} from "../src/library/search";
import test from "node:test";
import assert from "node:assert/strict";
import {photoName, isPhotoScreenshot, isPhotoTrashed, withPhotoOrganization, suggestedPhotoName, validPhotoName, inOrganizationScope, renamedPhotoFile} from "@fotoro/contracts/organization";
import {mergeAnnotationFacts} from "../src/exchange/annotations";
import {cleanupCandidates, CleanupAnalyzer} from "../src/local/auto-picks";
import {PhotoSearchIndex} from "../src/local/search";
import {inBrowseRange} from "../src/local/consumer-range";
import type {LocalPhoto} from "../src/local/resources";
import {localPhotoNameAnalysis, savedPhotoNameAnalysis} from "../src/library/photo-name-analysis";
import type {Photo} from "../src/library/catalog";
const digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const original = {filename: "IMG_0001.JPG", digest, date: "2018-02-03T23:50:00Z", dateSource: "photos", labels: ["BTS", "Family  trip"], location: {name: "Seoul"}};
test("suggested names use recorded evidence and the same suffix for hex or wire digest", () => {
  const expected = "2018-02-03_Seoul_BTS_Family-trip_0000000000.jpg";
  assert.equal(suggestedPhotoName(original), expected);
  assert.equal(suggestedPhotoName({...original, digest: "00".repeat(32)}), expected);
  assert.equal(suggestedPhotoName({...original, dateSource: "selected"}).startsWith("2018"), false);
  assert.equal(suggestedPhotoName({...original, screenshot: true}).includes("Screenshot"), true);
});
test("suggested names avoid repeated place/tag words and always provide an applicable safe name", () => {
  const name = suggestedPhotoName({...original, labels: ["seoul", "", "BTS", "BTS", "Family"]});
  assert.equal(name, "2018-02-03_Seoul_BTS_Family_0000000000.jpg");
  const reserved = suggestedPhotoName({filename: "IMG.JPG", labels: ["CON"]});
  assert.equal(reserved, "Photo_CON.jpg"); assert.equal(validPhotoName(reserved), true);
  assert.equal(suggestedPhotoName({filename: "IMG.JPG", date: "garbage", dateSource: "photos"}), "Photo.jpg");
});
test("name previews use completed analysis when no supplied tags describe the photo", () => {
  const source = {filename: "IMG.JPG", digest: "00".repeat(32)};
  const ocr = {processor: "vision-text-v1", confidence: 0.94, text: "9:41\nALFRED COFFEE\nOrder 123456\nTotal $12.50"};
  const visual = {processor: "vision-image-classification-r1-v1", labels: [{label: "dog", identifier: "dog", confidence: 0.92}]};
  assert.equal(suggestedPhotoName({...source, analysis: {visual}}), "dog_0000000000.jpg");
  assert.equal(suggestedPhotoName({...source, screenshot: true, analysis: {ocr, visual}}), "Screenshot_ALFRED-COFFEE_0000000000.jpg");
  assert.equal(suggestedPhotoName({...source, analysis: {ocr}}), "ALFRED-COFFEE_0000000000.jpg");
  assert.equal(suggestedPhotoName({...source, labels: ["My exact title"], analysis: {ocr, visual}}), "My-exact-title_0000000000.jpg");
  assert.equal(suggestedPhotoName({...source, screenshot: true, analysis: {visual}}), "Screenshot_0000000000.jpg");
});
test("name previews fall back instead of turning uncertain text or unsupported scenes into names", () => {
  const source = {filename: "IMG.JPG"};
  for (const ocr of [
    {processor: "vision-text-v1", confidence: 0.4, text: "Wrong title"},
    {processor: "unknown-model", confidence: 1, text: "Wrong title"},
    {processor: "vision-text-v1", confidence: NaN, text: "Wrong title"},
    {processor: "vision-text-v1", confidence: 0.9, text: "9:41\nuser@example.com\nhttps://example.com\nOrder 123456\nTotal $12.50"},
  ]) assert.equal(suggestedPhotoName({...source, analysis: {ocr}}), "Photo.jpg");
  const visual = {processor: "vision-image-classification-r1-v1", labels: [{label: "Person name", identifier: "dog", confidence: 0.99}]};
  assert.equal(suggestedPhotoName({...source, analysis: {visual}}), "Photo.jpg");
});
test("name analysis respects local source withdrawal, revisions and signed Saved identity", () => {
  const ocr = {photoID: "public-photo", revision: digest, status: "complete" as const,
    processor: "vision-text-v1", confidence: 0.94, text: "ALFRED COFFEE"};
  const source = {id: "public-photo", filename: "IMG.JPG", digest, ocr};
  const name = (photo: typeof source) => suggestedPhotoName({...photo, analysis: localPhotoNameAnalysis(photo)});
  assert.equal(name(source), "ALFRED-COFFEE_0000000000.jpg");
  for (const photo of [{...source, current: () => false}, {...source, digest: "changed"},
    {...source, ocr: {...ocr, photoID: "other"}}, {...source, ocr: {...ocr, status: "failed" as const}}]) {
    assert.equal(localPhotoNameAnalysis(photo)?.ocr, undefined);
  }
  const saved = {manifest: {photoId: "public-photo"}, metadata: {originalSha256: digest},
    annotations: {version: 1, photoId: "public-photo", originalSha256: digest, ocr}} as Photo;
  assert.equal(suggestedPhotoName({filename: "IMG.JPG", digest, analysis: savedPhotoNameAnalysis(saved)}), "ALFRED-COFFEE_0000000000.jpg");
  assert.equal(savedPhotoNameAnalysis({...saved, annotations: {...saved.annotations!, photoId: "other"}}), undefined);
  assert.equal(savedPhotoNameAnalysis({...saved, annotations: {...saved.annotations!, originalSha256: "changed"}}), undefined);
  const applied = withPhotoOrganization(saved.annotations!, {name: "ALFRED-COFFEE_0000000000.jpg"});
  assert.equal(photoName(applied, "IMG.JPG"), "ALFRED-COFFEE_0000000000.jpg");
  assert.equal(saved.annotations!.facts, undefined, "A suggestion never renames its source");
});
test("organization records preserve original words and restore without destroying other metadata", async () => {
  const base = {facts: ["My EXACT words", "fotoro.future.v2:keep"], labels: ["BTS"], caption: "My caption"};
  const changed = withPhotoOrganization(base, {name: "BTS at Grandma’s.jpg", trash: true, screenshot: true});
  assert.equal(photoName(changed, original.filename), "BTS at Grandma’s.jpg");
  assert.equal(isPhotoTrashed(changed), true); assert.equal(isPhotoScreenshot(changed), true);
  const restored = withPhotoOrganization(changed, {trash: false});
  assert.equal(isPhotoTrashed(restored), false); assert.equal(photoName(restored, original.filename), "BTS at Grandma’s.jpg");
  assert.deepEqual(restored.labels, base.labels); assert.equal(restored.caption, base.caption);
  assert.deepEqual(restored.facts.slice(0, 2), base.facts);
  assert.equal(photoName(withPhotoOrganization(restored, {name: null}), original.filename), original.filename);
  const file = new File([new Uint8Array([0, 1, 255])], "IMG_0001.JPG", {type: "image/jpeg"});
  const renamed = renamedPhotoFile(file, "BTS at Grandma’s.jpg");
  assert.equal(renamed.name, "BTS at Grandma’s.jpg"); assert.deepEqual(await renamed.arrayBuffer(), await file.arrayBuffer());
});
test("names reject unsafe paths and capacity overflow without trimming existing facts", () => {
  for (const name of ["../a.jpg", "a/b.jpg", "a\\b.jpg", "CON.jpg", "a?.jpg", " a.jpg", "a.jpg.", "a\u0000.jpg", "a".repeat(161)]) {
    assert.equal(validPhotoName(name), false, name); assert.throws(() => withPhotoOrganization({}, {name}));
  }
  assert.throws(() => withPhotoOrganization({facts: Array.from({length: 64}, (_, i) => "fact " + i)}, {trash: true}));
  assert.equal(photoName({facts: ["fotoro.name.v1:one.jpg", "fotoro.name.v1:two.jpg"]}, "original.jpg"), "original.jpg");
});
test("two-device changes merge independent name/Trash/screenshot families and review competing names", () => {
  const base = {facts: ["Exact fact"]};
  const local = withPhotoOrganization(base, {name: "my name.jpg"});
  const remote = withPhotoOrganization(base, {trash: true, screenshot: true});
  const merge = mergeAnnotationFacts(base.facts, local.facts, remote.facts);
  assert.equal(merge.conflict, false); assert.equal(photoName({facts: merge.value}, "original.jpg"), "my name.jpg");
  assert.equal(isPhotoTrashed({facts: merge.value}), true); assert.equal(isPhotoScreenshot({facts: merge.value}), true);
  const other = withPhotoOrganization(base, {name: "other name.jpg"});
  assert.equal(mergeAnnotationFacts(base.facts, local.facts, other.facts).conflict, true);
  assert.equal(photoName({facts: mergeAnnotationFacts(base.facts, local.facts, other.facts, "remote").value}, "old.jpg"), "other name.jpg");
});
test("screenshot evidence is source-bound, overrideable, and independent from file dimensions", () => {
  const capture = {facts: ["fotoro.capture.v1:source:" + digest, 'fotoro.capture.v1:item:{"k":"subtypes","p":"photos","v":"screenshot"}']};
  assert.equal(isPhotoScreenshot({...capture, digest}), true);
  assert.equal(isPhotoScreenshot({...capture, digest: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}), false);
  assert.equal(isPhotoScreenshot(withPhotoOrganization({...capture, digest}, {screenshot: false})), false);
  assert.equal(isPhotoScreenshot({filename: "screenshot-looking.png"}), false);
});
test("All preserves existing scope while Photos and Screenshots partition current screenshot evidence", () => {
  const capture = ["fotoro.capture.v1:source:" + digest, 'fotoro.capture.v1:item:{"k":"subtypes","p":"photos","v":"screenshot"}'];
  const unknown: LocalPhoto = {id: "unknown", filename: "Screenshot-looking.png", date: original.date, dateSource: "selected", digest};
  const screenshot: LocalPhoto = {...unknown, id: "screen", facts: capture};
  const corrected = withPhotoOrganization({...screenshot, id: "corrected"}, {screenshot: false});
  const marked = withPhotoOrganization({...unknown, id: "marked"}, {screenshot: true});
  const mismatched = {...screenshot, id: "mismatched", digest: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"};
  const trashed = withPhotoOrganization({...screenshot, id: "trashed"}, {trash: true});
  const values = [unknown, screenshot, corrected, marked, mismatched, trashed];
  const ids = (scope: "photos" | "photosOnly" | "screenshots" | "trash") => values.filter(photo => inOrganizationScope(photo, scope)).map(photo => photo.id);
  assert.deepEqual(ids("photos"), ["unknown", "screen", "corrected", "marked", "mismatched"]);
  assert.deepEqual(values.filter(photo => inOrganizationScope(photo)).map(photo => photo.id), ids("photos"));
  assert.deepEqual(ids("photosOnly"), ["unknown", "corrected", "mismatched"]);
  assert.deepEqual(ids("screenshots"), ["screen", "marked"]);
  assert.deepEqual(ids("trash"), ["trashed"]);
  assert.equal(inBrowseRange({...corrected, favorite: true}, false, true, Date.now(), "photosOnly"), true);
  assert.equal(inBrowseRange({...marked, favorite: true}, false, true, Date.now(), "photosOnly"), false);
  const restored = withPhotoOrganization(trashed, {trash: false, screenshot: false});
  assert.equal(inOrganizationScope(restored, "photosOnly"), true);
});
test("Trash is excluded from default browsing/search eligibility and remains restorable", () => {
  const photo: LocalPhoto = {id: "a", filename: "IMG.JPG", date: original.date, dateSource: "photos", digest};
  const named = withPhotoOrganization(photo, {name: "BTS Seoul.jpg"});
  const trash = withPhotoOrganization(named, {trash: true});
  assert.equal(inBrowseRange(trash, false, false), false);
  assert.equal(inBrowseRange(trash, false, false, Date.now(), "trash"), true);
  assert.equal(inOrganizationScope(named, "trash"), false);
  const restored = withPhotoOrganization(trash, {trash: false});
  assert.equal(inBrowseRange(restored, false, false), true);
  assert.deepEqual(new PhotoSearchIndex([restored]).search("Seoul").photoIds, ["a"]);
});
test("cleanup protects screenshots and favorites from flat-preview heuristics, leaves unknown unjudged, and retains one identical original", () => {
  const make = (id: string): LocalPhoto => ({id, filename: id + ".jpg", date: original.date, dateSource: "photos", digest: id});
  const photos = [make("blank"), withPhotoOrganization(make("screen"), {screenshot: true}), {...make("favorite"), favorite: true}, make("unknown"), {...make("duplicate"), digest: "blank"}];
  const flat = {hash: 0n, luminance: 1, contrast: 0, sharpness: 0, color: [255, 255, 255] as [number, number, number]};
  const result = cleanupCandidates(photos, new Map(photos.filter(photo => photo.id !== "unknown").map(photo => [photo.id, flat])));
  assert.equal(result.unassessed, 1); assert.equal(result.reasons.has("screen"), false); assert.equal(result.reasons.has("favorite"), false);
  assert.equal(result.reasons.has("unknown"), false); assert.match(result.reasons.get("duplicate")!.join(" "), /Identical original/);
  assert.equal(result.reasons.get("blank")!.some(reason => reason.includes("Identical")), false);
  assert.equal(photos.some(isPhotoTrashed), false);
});
test("duplicate cleanup retains a favorite even when another copy arrives first", () => {
  const ordinary = {id: "ordinary", ...original};
  const favorite = {...ordinary, id: "favorite", favorite: true};
  const result = cleanupCandidates([ordinary, favorite], new Map());
  assert.deepEqual([...result.reasons.keys()], ["ordinary"]);
  assert.deepEqual(result.reasons.get("ordinary"), ["Identical original · keep another copy"]);
  assert.equal(result.unassessed, 2);
  assert.deepEqual([...cleanupCandidates([favorite, ordinary], new Map()).reasons.keys()], ["ordinary"]);
});
test("cleanup reuses measured previews without losing hints after a metadata edit", async () => {
  const photo = {id: "flat", ...original, digest: "flat", file: new File(["flat"], "flat.jpg")};
  const analyzer = new CleanupAnalyzer();
  let reads = 0;
  const load = async () => {reads++; return {hash: 0n, luminance: 1, contrast: 0, sharpness: 0, color: [255, 255, 255] as [number, number, number]};};
  assert.deepEqual((await analyzer.run([photo], load, () => {}))!.reasons.get(photo.id), ["Possibly too dark or bright"]);
  const named = withPhotoOrganization(photo, {name: "Chosen name.jpg"});
  assert.deepEqual((await analyzer.run([named], load, () => {}))!.reasons.get(photo.id), ["Possibly too dark or bright"]);
  assert.equal(reads, 1);
  assert.equal((await analyzer.run([{...named, favorite: true}], load, () => {}))!.reasons.size, 0);
  assert.equal(reads, 1);
  analyzer.clear();
});

test("pending Trash, Restore, names and screenshot edits override the previous cached index immediately", () => {
  const cached = [{id: "a", ...original}, {id: "unloaded", ...original}];
  const trash = withPhotoOrganization(cached[0], {trash: true, name: "BTS.jpg", screenshot: true});
  const current = currentSearchRecords(cached, [trash]);
  assert.equal(current.length, 2);
  assert.equal(inBrowseRange(current[0], false, false), false);
  assert.equal(inBrowseRange(current[0], false, false, Date.now(), "trash"), true);
  assert.equal(photoName(current[0], "IMG.jpg"), "BTS.jpg");
  assert.equal(isPhotoScreenshot(current[0]), true);
  const restored = currentSearchRecords(current, [withPhotoOrganization(trash, {trash: false})]);
  assert.equal(inBrowseRange(restored[0], false, false), true);
  assert.strictEqual(restored[1], cached[1]);
});
test("long Unicode evidence preserves a stable filename identity suffix within filesystem limits", () => {
  const name = suggestedPhotoName({...original, location: {name: "東京".repeat(150)}});
  assert.equal(validPhotoName(name), true);
  assert.match(name, /_0000000000\.jpg$/);
  assert.ok(new TextEncoder().encode(name).length <= 240);
});

test("Places excludes Fotoro Trash and restores the same recorded location", () => {
  const photo = {id: "located", ...original, location: {latitude: 37.5, longitude: 127, source: "photos" as const, name: "Seoul"}};
  const trashed = withPhotoOrganization(photo, {trash: true});
  assert.deepEqual(groupPhotoPlaces([trashed]), []);
  assert.equal(groupPhotoPlaces([withPhotoOrganization(trashed, {trash: false})])[0].visits[0].photos[0].id, photo.id);
});
