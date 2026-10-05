import test from "node:test";
import assert from "node:assert/strict";
import {mergeConsumerSearchPhotos as merge} from "../src/library/consumer-search";
import {savedSearchPhotos, combineConsumerSearch, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import {PhotoSearchIndex} from "../src/local/search";
import type {LocalPhoto} from "../src/local/resources";
import type {Photo} from "../src/library/catalog";
import {withAnnotationLocation} from "@fotoro/contracts/location";

test("combined canvas keeps local objects and source order when saved originals overlap", () => {
  const a = {id: "a", source: "local"}, b = {id: "b", source: "local"};
  const duplicate = {id: "a", source: "saved"}, c = {id: "c", source: "saved"};
  const sameSavedID = {id: "c", source: "another saved record"};
  const local = [a, b], saved = [duplicate, c, sameSavedID];
  const result = merge(local, saved);
  assert.deepEqual(result, [a, b, c, sameSavedID]);
  assert.equal(result[0], a);
  assert.equal(result[2], c);
  assert.deepEqual(local, [a, b]);
  assert.deepEqual(saved, [duplicate, c, sameSavedID]);
  assert.deepEqual(merge([], saved), saved);
  assert.deepEqual(merge(local, []), local);
});

test("combining large local and saved libraries uses a linear identity-read budget", () => {
  const count = 2000;
  let identityReads = 0;
  const records = (prefix: string) => Array.from({length: count}, (_, index) => ({
    get id() {identityReads++; return prefix + index;},
  }));
  const result = merge(records("local:"), records("saved:"));
  assert.equal(result.length, count * 2);
  assert.ok(identityReads <= count * 4, `${identityReads} identity reads exceed the linear budget`);
});

function matchingCapture() {
  const now = new Date(2026, 9, 3, 12).getTime(), captured = new Date(2026, 9, 3, 9).toISOString();
  const local: LocalPhoto = {id: "00".repeat(32), digest: "00".repeat(32), file: new File(["public original"], "same.png"),
    filename: "same.png", date: new Date(2026, 9, 4, 9).toISOString(), dateSource: "selected", labels: ["Exact local label"], favorite: false};
  const saved = {manifest: {photoId: "saved-id", ownerAccountId: "owner"}, metadata: {filename: "same.png", sourceDate: captured,
    dateSource: "photos", originalSha256: "A".repeat(43)}, annotations: {version: 1, photoId: "saved-id", originalSha256: "A".repeat(43),
    labels: ["Different saved label"], favorite: true}} as Photo;
  let current = true;
  const snapshot: OwnedPhotoSnapshot = {accountId: "owner", token: {}, current: () => current, photos: [saved], preview: async () => new Blob()};
  return {now, captured, local, saved, snapshot, invalidate: () => {current = false;}};
}

test("matching saved capture evidence reaches search details without replacing local originals or edits", () => {
  const {now, captured, local, snapshot} = matchingCapture(), before = {...local, labels: [...local.labels!]};
  const saved = savedSearchPhotos(snapshot, [local]);
  const result = combineConsumerSearch(new PhotoSearchIndex([local]).search("today", {now}), new PhotoSearchIndex(saved).search("today", {now}));
  assert.deepEqual(result.photoIds, [local.id]);
  const displayed = merge([local], saved), details = displayed.find(photo => photo.id === result.photoId)!;
  assert.equal(details.dateSource, "photos");
  assert.equal(details.date, captured);
  assert.equal(details.id, local.id);
  assert.equal(details.file, local.file);
  assert.equal(details.favorite, false);
  assert.equal(details.labels, local.labels);
  assert.equal(details.previewLoader, undefined, "The local original remains the displayed source");
  assert.notEqual(details, local, "Account capture evidence stays in a transient copy");
  assert.deepEqual(local, before, "The record retained by LocalTrial keeps its selection date and local edits");
});

test("lock or stale snapshot removes saved date evidence even from a previously adapted array", () => {
  const {now, local, snapshot, invalidate} = matchingCapture(), saved = savedSearchPhotos(snapshot, [local]);
  assert.equal(merge([local], saved)[0].dateSource, "photos");
  invalidate();
  assert.deepEqual(savedSearchPhotos(snapshot, [local]), []);
  const displayed = merge([local], saved);
  assert.equal(displayed[0], local);
  assert.equal(displayed[0].dateSource, "selected");
  assert.deepEqual(new PhotoSearchIndex(displayed).search("today", {now}).photoIds, []);
});

test("capture overlay rejects changed files, digests, invalid dates and unverified same-ID records", () => {
  const {local, saved, snapshot} = matchingCapture(), adapted = savedSearchPhotos(snapshot, [local]);
  for (const changed of [{...local, digest: "11".repeat(32)}, {...local, file: new File(["replacement"], local.filename)},
    {...local, file: undefined}, {...local, dateSource: "exif" as const}]) {
    assert.equal(merge([changed], adapted)[0], changed);
  }
  for (const metadata of [{...saved.metadata, sourceDate: "not-a-date"}, {...saved.metadata, dateSource: "import" as const}]) {
    assert.equal(merge([local], savedSearchPhotos({...snapshot, photos: [{...saved, metadata}]}, [local]))[0], local);
  }
  assert.equal(merge([local], [{...local, dateSource: "photos", date: saved.metadata.sourceDate}])[0], local);
});

test("matching saved location fills a selected original independently of date promotion and disappears on lock", () => {
  const {local, saved, snapshot, invalidate} = matchingCapture();
  const location = {latitude: 41.9028, longitude: 12.4964, source: "google-timeline" as const, name: "Rome"};
  const source = {...local, dateSource: "exif" as const};
  snapshot.photos = [{...saved, annotations: withAnnotationLocation(saved.annotations!, location)}];
  const adapted = savedSearchPhotos(snapshot, [source]);
  const displayed = merge([source], adapted)[0];
  assert.deepEqual(displayed.location, location);
  assert.equal(displayed.date, source.date);
  assert.equal(source.location, undefined);
  const gps = {...source, location: {...location, source: "exif" as const}};
  assert.equal(merge([gps], adapted)[0].location, gps.location);
  assert.equal(merge([{...source, file: new File(["changed"], "same.png")}], adapted)[0].location, undefined);
  const index = new PhotoSearchIndex([displayed]);
  assert.deepEqual(index.search("gps").photoIds, [source.id]);
  invalidate(); assert.equal(merge([source], adapted)[0], source);
  assert.deepEqual(index.search("gps").photoIds, [], "An already built location index cannot retain withdrawn account evidence");
});
