import test from "node:test";
import assert from "node:assert/strict";
import {mergeConsumerSearchPhotos as merge} from "../src/library/consumer-search";
import {SavedSearchProjection, savedSearchPhotos, combineConsumerSearch, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import {SemanticFindSession} from "../src/local/semantic-find";
import {PhotoSearchIndex} from "../src/local/search";
import type {LocalPhoto} from "../src/local/resources";
import type {Photo} from "../src/library/catalog";
import {withAnnotationLocation} from "@fotoro/contracts/location";
import {browseFavoritePhotoIDs} from "../src/local/consumer-range";

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

test("a pending local Unfavorite cannot reappear through the overlapping Saved metadata scope", () => {
  const {local, snapshot} = matchingCapture();
  const saved = savedSearchPhotos(snapshot, [local]);
  assert.equal(saved[0].favorite, true);
  assert.deepEqual([...browseFavoritePhotoIDs(saved, merge([local], saved))], []);
  const favorite = {...local, favorite: true};
  assert.deepEqual([...browseFavoritePhotoIDs(saved, merge([favorite], saved))], [local.id]);
});

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
test("saved original availability survives annotation-only catalog replacement but ends when its source is unavailable",()=>{
 const {snapshot,invalidate}=matchingCapture();let sourceAvailable=true;
 snapshot.sourceCurrent=()=>sourceAvailable;
 const adapted=savedSearchPhotos(snapshot,[])[0];assert.equal(adapted.current?.(),true);
 invalidate();assert.equal(snapshot.current(),false);assert.equal(adapted.current?.(),true);
 assert.deepEqual(savedSearchPhotos(snapshot,[]),[],"A stale snapshot still cannot create new search projections");
 sourceAvailable=false;assert.equal(adapted.current?.(),false);
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

test("local-only startup and a locked Saved library keep stable empty search inputs", () => {
  const projection = new SavedSearchProjection(), initial = projection.read(null, []);
  assert.equal(projection.read(null, []), initial);
  const {snapshot, invalidate} = matchingCapture();
  assert.equal(projection.read(snapshot, []).length, 1);
  invalidate();
  const locked = projection.read(snapshot, []);
  assert.deepEqual(locked, []);
  assert.equal(projection.read(snapshot, []), locked);
  assert.equal(projection.read(null, []), locked);
});

test("Saved search and People sources survive Save availability and coverage updates", async () => {
  const {snapshot} = matchingCapture(), projection = new SavedSearchProjection();
  let release!: () => void, reads = 0;
  const held = new Promise<void>(resolve => {release = resolve;});
  snapshot.preview = async () => {reads++; await held; return new Blob();};
  const initial = projection.read(snapshot, []), preview = initial[0].previewLoader;
  const inFlight = preview!();
  const updating = {...snapshot, selectionReady: false, coverage: {loaded: 1, cachedTotal: 101, hasMore: true, hasMoreChanges: true}};
  const continued = projection.read(updating, []);
  assert.equal(continued, initial, "Sync status must not replace the semantic hook's photo input");
  assert.equal(continued[0].previewLoader, preview, "An in-flight preview and People scan keep the exact source identity");
  assert.equal(projection.read({...updating, selectionReady: true}, []), initial);
  release(); assert.equal(await inFlight instanceof Blob, true); assert.equal(reads, 1, "A held preview completes across sync status changes without being requested again");
});

test("Saved search projection withdraws old sources and rebuilds only for actual source/local changes", () => {
  const {snapshot, local, invalidate} = matchingCapture(), projection = new SavedSearchProjection();
  const initial = projection.read(snapshot, []);
  const changed = {...snapshot, photos: [{...snapshot.photos[0], metadata: {...snapshot.photos[0].metadata, filename: "edited.png"}}]};
  assert.notEqual(projection.read(changed, []), initial);
  assert.notEqual(projection.read({...snapshot, token: {}}, []), initial, "A new vault lifetime cannot reuse the projection");
  assert.deepEqual(projection.read({...snapshot, accountId: "other-owner"}, []), [], "Account identity remains part of admission");
  assert.equal(projection.read(changed, [local])[0].id, local.id, "An exact local original can change the projection's identity");
  invalidate();
  assert.deepEqual(projection.read(snapshot, []), []);
  assert.equal(initial[0].current?.(), false, "Stabilizing inputs must never revive a withdrawn account source");
});

test("held semantic inference finishes once while Saved sync availability changes", async () => {
  const {snapshot} = matchingCapture(), projection = new SavedSearchProjection();
  let latest = projection.read(snapshot, []), release!: () => void, started!: () => void, images = 0, publications = 0;
  const held = new Promise<void>(resolve => {started = resolve;});
  const vector = new Float32Array(512); vector[0] = 1;
  const worker = {onmessage: null as Worker["onmessage"], onerror: null as Worker["onerror"], terminate() {},
    postMessage(message: {id: number; kind: string}) {
      const reply = () => this.onmessage?.call(this as unknown as Worker, {data: {id: message.id, vector}} as MessageEvent);
      if (message.kind === "text") queueMicrotask(reply);
      else if (message.kind === "image") {images++; release = reply; started();}
    }};
  const engine = new SemanticFindSession(() => worker as unknown as Worker,
    {load: async () => ({blob: new Blob(), url: "", bytes: 1, decoded: 1, width: 1, height: 1, used: 0}), clear() {}});
  try {
    const input = latest;
    const searching = engine.search(input, "fireworks", () => latest === input, scores => {publications++; assert.equal(scores.size, 1);});
    await held;
    latest = projection.read({...snapshot, selectionReady: false}, []);
    latest = projection.read({...snapshot, selectionReady: true}, []);
    release(); await searching;
    assert.equal(images, 1); assert.equal(publications, 1, "Progress-only snapshots cannot invalidate a held semantic result");
  } finally {engine.clear();}
});
