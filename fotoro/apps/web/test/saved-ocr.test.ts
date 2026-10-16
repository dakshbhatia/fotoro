import test from "node:test";
import assert from "node:assert/strict";
import type {Photo} from "../src/library/catalog";
import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import {LocalOcrQueue, type OcrResult} from "../src/local/ocr";
import {savedTextCandidates, readSavedPhotoText} from "../src/local/saved-ocr";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {SavedTextCheck} from "../src/local/SavedTextCheck";

function fixture(count = 1) {
  let available = true, reads = 0;
  const photos = Array.from({length: count}, (_, i) => ({manifest: {photoId: String(i), ownerAccountId: "owner", representations: [{binding: {kind: "preview"}}]}, metadata: {filename: "fixture.png", sourceDate: "2026-10-10T12:00:00Z", dateSource: "exif", originalSha256: "digest-" + i}} as Photo));
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer); view.setUint32(16,100); view.setUint32(20,100);
  const snapshot: OwnedPhotoSnapshot = {accountId: "owner", token: {}, photos, current: () => available,
    preview: async () => {reads++; return new Blob([bytes], {type: "image/png"});}};
  return {photos, snapshot, adapted: () => savedSearchPhotos(snapshot, []), reads: () => reads, withdraw: () => {available = false;}};
}
const queue = (recognize = async () => ({data: {text: "Public fixture text", confidence: 90}})) => new LocalOcrQueue({origin: "http://localhost", createWorker: async () => ({recognize, terminate: async () => {}})});

test("explicit Saved text checks admit only 25 owned missing-text previews from the supplied scope", async () => {
  const f = fixture(35);
  f.photos[0].grantId = "received";
  f.photos[1].manifest.ownerAccountId = "foreign";
  f.photos[2].manifest.representations = [];
  f.photos[3].annotations = {version: 1, photoId: "3", originalSha256: "digest-3", ocr: {text: "Existing native text", confidence: .8, processor: "vision-text-v1"}};
  f.photos[4].annotations = {version: 1, photoId: "4", originalSha256: "digest-4", facts: ["fotoro.trash.v1:true"]};
  const scope = f.adapted(), written = new Map<string, string>(), progress: number[] = [];
  assert.equal(savedTextCandidates(f.snapshot, scope).length, 25);
  const result = await readSavedPhotoText(f.snapshot, scope, {current: () => true, signal: new AbortController().signal, queue: queue(),
    write: async (photo, value) => {written.set(photo.manifest.photoId, value.text); return true;}, onProgress: value => progress.push(value.checked)});
  assert.equal(result.kept, 25); assert.equal(result.failed, 0); assert.equal(f.reads(), 25);
  assert.deepEqual([...written.keys()], Array.from({length: 25}, (_, i) => String(i + 5)));
  assert.equal(written.get("5"), "Public fixture text"); assert.equal(progress.at(-1), 25);
});

test("withdrawal after recognition starts suppresses Saved text and later previews", async () => {
  const f = fixture(2), controller = new AbortController();
  let began!: () => void, complete!: (value: {data: {text: string; confidence: number}}) => void;
  const started = new Promise<void>(resolve => {began = resolve;}), held = new Promise<{data: {text: string; confidence: number}}>(resolve => {complete = resolve;});
  const written: OcrResult[] = [];
  const run = readSavedPhotoText(f.snapshot, f.adapted(), {current: () => true, signal: controller.signal,
    queue: queue(async () => {began(); return held;}), write: async (_, value) => {written.push(value); return true;}});
  await started; f.withdraw(); controller.abort(); complete({data: {text: "Obsolete", confidence: 99}});
  const result = await run;
  assert.equal(result.cancelled, true); assert.equal(f.reads(), 1); assert.deepEqual(written, []);
});

test("a failed Saved preview remains eligible for a later explicit retry", async () => {
  const f = fixture(); let fail = true;
  const preview = f.snapshot.preview; f.snapshot.preview = async photo => {if (fail) throw new Error("unavailable"); return preview(photo);};
  const run = () => readSavedPhotoText(f.snapshot, f.adapted(), {current: () => true, signal: new AbortController().signal, queue: queue(), write: async () => true});
  assert.equal((await run()).failed, 1); fail = false;
  assert.equal((await run()).kept, 1);
});

test("opening text checks does not revalidate every source when the loaded photos already have OCR", () => {
  const f = fixture(2000);
  for (const photo of f.photos) photo.annotations = {version: 1, photoId: photo.manifest.photoId,
    originalSha256: photo.metadata.originalSha256, ocr: {text: "Already read", confidence: .9, processor: "vision-text-v1"}};
  const scope = f.adapted(); let sourceReads = 0;
  f.snapshot.sourceCurrent = () => {sourceReads++; return true;};
  assert.deepEqual(savedTextCandidates(f.snapshot, scope), []);
  assert.equal(sourceReads, 0, "Completed text needs no source admission or repeated catalog membership scans");
});

test("Saved text controls require existing OCR consent and expose encrypted pending Save changes", () => {
  const f = fixture();
  f.snapshot.checkText = async () => {throw new Error("Rendering cannot start analysis");};
  const props = {snapshot: f.snapshot, photos: f.adapted(), consent: false, active: true, scope: "public-scope", onSync() {},
    changes: {token: f.snapshot.token, accountId: "owner", current: () => true, pending: [{photoId: "0", originalSha256: "digest-0", conflict: false}], busy: false, error: "", save: async () => true, review() {}}};
  const blocked = renderToStaticMarkup(createElement(SavedTextCheck, props));
  assert.match(blocked, /<button disabled="">Check Saved photo text/);
  assert.match(blocked, /Save changes<\/button>/); assert.match(blocked, /pending on this device/);
  const enabled = renderToStaticMarkup(createElement(SavedTextCheck, {...props, consent: true}));
  assert.match(enabled, /<button>Check Saved photo text/); assert.equal(f.reads(), 0);
});
