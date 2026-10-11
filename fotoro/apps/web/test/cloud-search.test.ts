import test from "node:test";
import assert from "node:assert/strict";
import { PhotoSearchIndex } from "../src/local/search";
import { cloudSearchRecords } from "../src/library/search";
import {savedSearchPhotos, savedMetadataRecords, accountSearchResult, accountSearchResultAsync, SavedMetadataProjection} from "../src/library/consumer-search";
import type { Photo } from "../src/library/catalog";
import {withAnnotationLocation} from "@fotoro/contracts/location";
const digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const photo = {manifest: {photoId: "cloud-id", ownerAccountId: "owner"}, metadata: {filename: "IMG_001.jpg", sourceDate: "2026-10-01T12:00:00Z", dateSource: "exif", originalSha256: digest}, annotations: {version: 1, photoId: "cloud-id", originalSha256: digest, labels: ["Family dinner"], ocr: {text: "Invoice number 1234", confidence: 0.9, processor: "native-vision-v1"}}} as Photo;
test("saved private locations restore names and GPS search while machine facts stay hidden", () => {
  const location = {latitude: 41.9028, longitude: 12.4964, source: "photos" as const, name: "Villa Borghese"};
  const located = {...photo, annotations: withAnnotationLocation(photo.annotations!, location)};
  const record = cloudSearchRecords([located])[0];
  assert.deepEqual(record.location, location);
  const index = new PhotoSearchIndex([record]);
  assert.deepEqual(index.search("villa borg").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("gps").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("fotoro.location").photoIds, []);
  assert.deepEqual(index.search("latitude").photoIds, []);
  for (const invalid of [{...located, grantId: "received"}, {...located, annotations: {...located.annotations, originalSha256: "other"}}])
    assert.equal(cloudSearchRecords([invalid])[0].location, undefined);
});
test("cloud labels and verified OCR use the local search index without rewriting stored original identity", () => {
  const index = new PhotoSearchIndex(cloudSearchRecords([photo]));
  assert.deepEqual(index.search("family").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("invoice number").photoIds, ["cloud-id"]);
  assert.deepEqual(index.search("1234").photoIds, ["cloud-id"]);
  assert.equal(photo.annotations?.ocr?.processor, "native-vision-v1");
});

test("consumer Saved OCR is rebound to the display ID while original account identity and revision remain intact", () => {
  const snapshot = {accountId:"owner",token:{},current:()=>true,photos:[photo],preview:async()=>new Blob()};
  const original = structuredClone(photo.annotations);
  const saved = savedSearchPhotos(snapshot,[])[0];
  assert.equal(saved.id,"saved:cloud-id"); assert.equal(saved.ocr?.photoID,saved.id); assert.equal(saved.ocr?.revision,digest);
  assert.deepEqual(new PhotoSearchIndex([saved]).search("invoice number").photoIds,[saved.id]);
  const local = {id:"local-digest-id",digest,filename:"IMG_001.jpg",date:"2026-10-01",dateSource:"selected" as const,file:new File(["public fixture"],"IMG_001.jpg")};
  const reopened = savedSearchPhotos(snapshot,[local])[0];
  assert.equal(reopened.id,local.id); assert.equal(reopened.ocr?.photoID,local.id);
  assert.deepEqual(new PhotoSearchIndex([reopened]).search("invoice").photoIds,[local.id]);
  assert.deepEqual(photo.annotations,original);
  assert.equal(photo.annotations?.photoId,"cloud-id"); assert.equal(photo.annotations?.originalSha256,digest);
  assert.deepEqual(new PhotoSearchIndex([{...reopened,digest:"replacement"}]).search("invoice").photoIds,[]);
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

test("asynchronous account index preserves literal, OCR, GPS and capture-date evidence and can be cancelled between work slices", async () => {
  const records = cloudSearchRecords([datedPhoto("b", "photos"), datedPhoto("a", "exif", 3, 10)]);
  records[0].location = {latitude: 41.9, longitude: 12.5, source: "photos", name: "Villa Borghese"};
  const sync = new PhotoSearchIndex(records);
  const asyncIndex = await PhotoSearchIndex.build(records, new AbortController().signal, () => true);
  for (const query of ["family", "invoice number", "1234", "GPS", "villa borg", "family today", "today"])
    assert.deepEqual(asyncIndex.search(query, {now}), sync.search(query, {now}));
  const many = Array.from({length: 2000}, (_, n) => ({...records[0], id: "photo-" + n}));
  const controller = new AbortController();
  const pending = PhotoSearchIndex.build(many, controller.signal, () => true);
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
  await assert.rejects(PhotoSearchIndex.build(records, new AbortController().signal, () => true, 64), /CACHED_SEARCH_BUDGET/);
  asyncIndex.dispose(); assert.deepEqual(asyncIndex.search("family").photoIds, []);
});


test("the shared account index returns unloaded Saved display IDs and joins an exact local digest without broadening allowed sources", async () => {
  const records = cloudSearchRecords([photo]), shared = await PhotoSearchIndex.build(records, new AbortController().signal, () => true);
  const saved = savedMetadataRecords(records, []);
  const savedIDs = new Map([[records[0].id, saved[0].id]]);
  assert.deepEqual(accountSearchResult(shared.search.bind(shared), records, savedIDs, "invoice", {allowedIds: new Set([saved[0].id])}).photoIds, ["saved:cloud-id"]);
  const local = {id: "chosen-local", digest, filename: "IMG_001.jpg", date: photo.metadata.sourceDate, dateSource: "selected" as const, file: new File(["public fixture"], "IMG_001.jpg")};
  const joined = savedMetadataRecords(records, [local]), ids = new Map([[records[0].id, joined[0].id]]);
  assert.equal(joined[0].ocr?.photoID, local.id);
  assert.deepEqual(accountSearchResult(shared.search.bind(shared), records, ids, "invoice", {allowedIds: new Set([local.id])}).photoIds, [local.id]);
  assert.deepEqual(accountSearchResult(shared.search.bind(shared), records, ids, "invoice", {allowedIds: new Set(["saved:cloud-id"])}).photoIds, []);
  shared.dispose();
});


test("account metadata projection stays stable across local evidence/progress updates and withdraws on source changes", () => {
  const records = cloudSearchRecords([photo]), projection = new SavedMetadataProjection();
  const file = new File(["public fixture"], "IMG_001.jpg");
  const local = {id: "local", digest, filename: "IMG_001.jpg", date: "2026-10-01", dateSource: "selected" as const, file};
  const first = projection.read(records, [local]);
  const evidenceUpdate = {...local, labels: ["reviewed"], ocr: {photoID: "local", revision: digest, status: "complete" as const, text: "new local OCR", confidence: 1, processor: "test"}};
  assert.equal(projection.read(records, [evidenceUpdate]), first, "Local OCR/Picks presentation updates cannot reproject the entire account");
  const moved = projection.read(records, [{...local, id: "replacement"}]); assert.notEqual(moved, first); assert.equal(moved[0].id, "replacement");
  assert.notEqual(projection.read([...records], [local]), first);
  assert.deepEqual(projection.read(undefined, [local]), []);
});

test("large cached queries yield through broad candidate ranking and cancel replaced queries", async () => {
  const rows = Array.from({length: 20_000}, (_, i) => ({id: "account-" + i, filename: "IMG_" + i + ".jpg", date: "2026-10-01T12:00:00Z", dateSource: "exif" as const, labels: ["Family holiday " + i]}));
  const index = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true);
  const options = {scope: "account:fixture", now: Date.parse("2026-10-11T12:00:00Z")};
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 0);
  try {
    const result = await index.searchAsync("family", options);
    assert.ok(beats > 1, "broad candidate collection and ranking must let timers run");
    assert.deepEqual(result, index.search("family", options));
    let generation = 1, published: string[] = [];
    const old = index.searchAsync("family", options, undefined, () => generation === 1).then(value => published.push(value.query));
    setTimeout(() => {generation = 2;}, 0);
    await assert.rejects(old, error => error instanceof DOMException && error.name === "AbortError");
    const replacement = await index.searchAsync("IMG_19999", options, undefined, () => generation === 2);
    published.push(replacement.query);
    assert.deepEqual(published, ["IMG_19999"]);
    assert.deepEqual(replacement.photoIds, ["account-19999"]);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(index.searchAsync("family", options, controller.signal), error => error instanceof DOMException && error.name === "AbortError");
  } finally {clearInterval(heartbeat); index.dispose();}
});

test("source withdrawal during yielded ranking cannot publish stale account evidence", async () => {
  let admitted = true, lastSourceChecks = 0;
  const rows = Array.from({length: 20_000}, (_, i) => ({id: "source-" + i, filename: "photo.jpg", date: "2026-10-01T12:00:00Z", labels: ["Family"], current: () => {
    // The last source's second check ends pre-rank validation. Withdraw while ranking yields.
    if (i === 19_999 && ++lastSourceChecks === 2) setTimeout(() => {admitted = false;}, 0);
    return i !== 0 || admitted;
  }}));
  const index = await PhotoSearchIndex.build(rows, new AbortController().signal, () => true);
  let published = false;
  const pending = index.searchAsync("family").then(() => {published = true;});
  await assert.rejects(pending, /CACHED_SEARCH_SOURCE_CHANGED/);
  assert.equal(published, false);
  const fresh = await index.searchAsync("family");
  assert.equal(fresh.meaning?.photoIds.includes("source-0"), false);
  assert.equal(fresh.meaning?.photoIds.length, 19_999);
  assert.equal(fresh.current?.(), true);
  index.dispose();
  assert.equal(fresh.current?.(), false, "a result publication fence follows shared index disposal");
});


test("account display mapping revalidates exact evidence after yielding", async () => {
  let admitted = true;
  const records = Array.from({length: 20_000}, (_, i) => ({id: "mapping-" + i, filename: "photo.jpg", date: "2026-10-01", labels: ["Family"], current: () => admitted}));
  const index = await PhotoSearchIndex.build(records, new AbortController().signal, () => true);
  const search: PhotoSearchIndex["searchAsync"] = async (...args) => {
    const result = await index.searchAsync(...args);
    setTimeout(() => {admitted = false;}, 0);
    return result;
  };
  await assert.rejects(accountSearchResultAsync(search, records, new Map(), "family", {}, new AbortController().signal, () => true), /CACHED_SEARCH_SOURCE_CHANGED/);
  index.dispose();
});
