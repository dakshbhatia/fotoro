import test from "node:test";
import assert from "node:assert/strict";
import {PickAnalyzer, recommendPhotos, type PhotoSignals} from "../src/local/auto-picks";
import {findMatchPhotos, runCurrentFindReview, shortlistSearchResult} from "../src/local/find-best-shots";
import {PhotoSearchIndex} from "../src/local/search";
import {LocalResources, type LocalPhoto} from "../src/local/resources";
import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import type {Photo} from "../src/library/catalog";
import {setFlagsFromString} from "node:v8";
import {runInNewContext} from "node:vm";

const photo = (id: string, label = "trip", date = "2026-09-01T12:00:00Z"): LocalPhoto => ({id, filename: id + ".png", digest: id,
  date, dateSource: "exif", captureVerified: true, width: 800, height: 600, labels: [label], file: new File([id], id + ".png")});
const signal = (sharpness = .1): PhotoSignals => ({hash: 0n, luminance: .5, contrast: .15, sharpness, color: [120, 120, 120]});

test("a date-and-label Find chooses highlights within its matches without inheriting home selection", () => {
  const matches = [photo("soft", "trip"), photo("clear", "trip", "2026-09-01T12:02:00Z"), photo("middle", "trip", "2026-09-01T12:04:00Z")];
  const outside = Array.from({length: 100}, (_, i) => ({...photo("other" + i, "other", "2026-09-01T12:00:00Z"), favorite: true}));
  const photos = [...matches, ...outside], sources = [...photos], selected = new Set(["soft", "other1"]);
  const result = new PhotoSearchIndex(photos).search("trip September 2026");
  const signals = new Map(photos.map(value => [value.id, signal(value.id === "clear" ? .4 : .01)]));
  assert.equal([...recommendPhotos(photos, signals).ids].some(id => result.photoIds.includes(id)), false);
  const subset = findMatchPhotos(photos, result), shortlist = recommendPhotos(subset, signals);
  assert.deepEqual(subset.map(value => value.id).sort(), ["clear", "middle", "soft"]);
  assert.deepEqual([...shortlist.ids], ["clear"]);
  assert.deepEqual(shortlistSearchResult(result, shortlist).photoIds, ["clear"]);
  assert.deepEqual(photos, sources); assert.deepEqual([...selected], ["soft", "other1"]);
});

test("Find quality never adds a nonmatch and leaves the all-matches order and preferred photo intact", () => {
  const photos = [photo("a"), photo("b"), photo("unrelated", "other")], result = new PhotoSearchIndex(photos).search("trip");
  const before = structuredClone(result), shortlist = recommendPhotos(photos, new Map(photos.map(value => [value.id, signal(.1)])));
  shortlist.ids = new Set(["unrelated", "b"]);
  assert.deepEqual(shortlistSearchResult(result, shortlist).photoIds, ["b"]);
  assert.equal(shortlistSearchResult(result).photoId, undefined);
  assert.deepEqual(result, before);
  assert.equal(findMatchPhotos(photos, {...result, photoIds: ["a", "a", "withdrawn"]}).length, 1);
});

test("verified similar-shot groups are anchored within the matched subset and do not chain past thirty seconds", () => {
  const photos = [photo("soft", "trip", "2026-09-01T12:00:00Z"), photo("clear", "trip", "2026-09-01T12:00:30Z"), photo("later", "trip", "2026-09-01T12:00:31Z"),
    {...photo("outside", "other", "2026-09-01T12:00:25Z"), favorite: true}];
  const result = new PhotoSearchIndex(photos).search("trip"), subset = findMatchPhotos(photos, result);
  const review = recommendPhotos(subset, new Map(photos.map(value => [value.id, signal(value.id === "clear" ? .4 : .01)])));
  assert.equal(review.groupCount, 2); assert.equal(review.duplicateCount, 1);
  assert.deepEqual([...review.ids], ["clear"]);
  assert.deepEqual(review.reasons.get("clear"), ["Moment highlight", "Representative of 2 similar photos"]);
  const unverified = subset.map(value => ({...value, captureVerified: undefined}));
  assert.equal(recommendPhotos(unverified, new Map(unverified.map(value => [value.id, signal()]))).groupCount, 3);
});

test("verified saved captures can group from measured preview proportions without treating supplied dates as captures", () => {
  const photos = [photo("a"), photo("b", "trip", "2026-09-01T12:00:01Z")].map(value => ({...value, width: undefined, height: undefined}));
  const signals = new Map(photos.map(value => [value.id, {...signal(), width: 400, height: 300}]));
  assert.equal(recommendPhotos(photos, signals).groupCount, 1);
  signals.set("b", {...signal(), width: 300, height: 400});
  assert.equal(recommendPhotos(photos, signals).groupCount, 2);
  assert.equal(recommendPhotos(photos.map(value => ({...value, dateSource: "selected"})), signals).groupCount, 2);
});

test("query, source or account withdrawal prevents delayed quality publication, and cancellation stops remaining loads", async () => {
  for (const withdrawal of ["query", "file", "revision", "account", "lock", "cancel"]) {
    const analyzer = new PickAnalyzer(); let current = true, reads = 0, progress = 0;
    let release!: (value: PhotoSignals) => void;
    const pending = runCurrentFindReview(analyzer, [photo("a"), photo("b")], async () => {reads++; return new Promise(resolve => {release = resolve;});}, () => current, () => {progress++;});
    await Promise.resolve(); current = false; analyzer.clear(); release(signal());
    assert.equal(await pending, undefined, withdrawal); assert.equal(reads, 1); assert.equal(progress, 0);
  }
  let read = false;
  assert.equal(await runCurrentFindReview(new PickAnalyzer(), [photo("a")], async () => {read = true; return signal();}, () => false), undefined);
  assert.equal(read, false);
});

test("quality cache reloads a same-ID changed File, preview loader or digest revision", async () => {
  const analyzer = new PickAnalyzer(), first = photo("same"); let reads = 0;
  const load = async () => {reads++; return signal();};
  await analyzer.run([first], load); await analyzer.run([{...first, favorite: true}], load); assert.equal(reads, 1);
  await analyzer.run([{...first, digest: "replacement"}], load); assert.equal(reads, 2);
  await analyzer.run([{...first, file: new File(["replacement"], first.filename)}], load); assert.equal(reads, 3);
  const preview = {...first, file: undefined, previewLoader: async () => new Blob(["preview"])};
  await analyzer.run([preview], load); await analyzer.run([{...preview, previewLoader: async () => new Blob(["new preview"])}], load);
  assert.equal(reads, 5);
});

test("only current owned saved previews enter Find review and Lock revokes an in-flight preview", async () => {
  const saved = (id: string, owner = "owner", grantId?: string) => ({manifest: {photoId: id, ownerAccountId: owner}, grantId,
    metadata: {filename: id + ".png", originalSha256: id, sourceDate: "2026-09-01T12:00:00Z", dateSource: "exif"}} as Photo);
  let current = true, release!: (value: Blob) => void;
  const snapshot: OwnedPhotoSnapshot = {accountId: "owner", token: {}, photos: [saved("mine"), saved("foreign", "other"), saved("received", "owner", "grant")],
    current: () => current, preview: () => new Promise(resolve => {release = resolve;})};
  const records = savedSearchPhotos(snapshot, []); assert.deepEqual(records.map(value => value.id), ["saved:mine"]);
  assert.equal(records[0].captureVerified, true);
  const pending = records[0].previewLoader!(); current = false; release(new Blob(["public preview"]));
  await assert.rejects(pending, /locked/); assert.deepEqual(savedSearchPhotos(snapshot, []), []);
});

test("preview cache revokes a same-ID replacement and fences a prior decode rather than returning stale pixels", async () => {
  const previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  let reads = 0, drawn = "", release: (() => void) | undefined;
  globalThis.createImageBitmap = (async (blob: Blob, options: ImageBitmapOptions) => {
    reads++; const marker = await blob.text(); if (marker === "late") await new Promise<void>(resolve => {release = resolve;});
    return {width: options.resizeWidth, height: options.resizeHeight, marker, close() {}};
  }) as any;
  globalThis.document = {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage(bitmap: any) {drawn = bitmap.marker;}}),
    toBlob: (done: (value: Blob) => void) => done(new Blob([drawn]))})} as any;
  const resources = new LocalResources(), source = {...photo("same"), file: new File(["old"], "same.png")};
  try {
    const first = await resources.load(source, "preview"); assert.equal(await first.blob.text(), "old");
    const replacement = {...source, file: new File(["new"], "same.png")};
    const next = await resources.load(replacement, "preview"); assert.equal(await next.blob.text(), "new"); assert.notEqual(first.url, next.url);
    await resources.load({...replacement, digest: "different-revision"}, "preview"); assert.equal(reads, 3);
    const late = resources.load({...source, file: new File(["late"], "same.png")}, "preview");
    const rejected = assert.rejects(late, /cleared/);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const latest = resources.load({...source, file: new File(["latest"], "same.png")}, "preview"); release();
    await rejected; assert.equal(await (await latest).blob.text(), "latest");
    await assert.rejects(resources.load({...source, previewAvailable: false}, "preview"), /unavailable/);
  } finally {resources.clear(); globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument;}
});

test("bounded raster eviction does not keep decrypted preview source blobs alive", async () => {
  const previousBitmap = globalThis.createImageBitmap, previousDocument = globalThis.document;
  globalThis.createImageBitmap = (async (_blob: Blob, options: ImageBitmapOptions) => ({width: options.resizeWidth, height: options.resizeHeight, close() {}})) as any;
  globalThis.document = {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage() {}}),
    toBlob: (done: (value: Blob) => void) => done(new Blob(["synthetic raster"]))})} as any;
  setFlagsFromString("--expose_gc");
  const collect = runInNewContext("gc") as () => void;
  setFlagsFromString("--no-expose_gc");
  const resources = new LocalResources(), sources: WeakRef<Blob>[] = [];
  async function loadPreview(index: number) {
    const preview = new Blob([new Uint8Array(1024 * 1024)]);
    sources.push(new WeakRef(preview));
    await resources.load({id: "saved:" + index, filename: "public.png", date: "2026-09-01", dateSource: "selected", preview, width: 1600, height: 1600}, "preview");
  }
  try {
    for (let index = 0; index < 12; index++) await loadPreview(index);
    assert.ok(resources.decodedBytes <= 24 * 1024 * 1024);
    for (let iteration = 0; iteration < 3; iteration++) {
      await new Promise(resolve => setImmediate(resolve)); collect();
    }
    assert.equal(sources[0].deref(), undefined, "An evicted decrypted source must be collectable while the review resource cache remains open");
    assert.ok(sources.slice(0, 10).every(reference => !reference.deref()), "Eviction must not leave an unbounded source-blob history");
  } finally {resources.clear(); globalThis.createImageBitmap = previousBitmap; globalThis.document = previousDocument;}
});
