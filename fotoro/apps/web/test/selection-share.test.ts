import test from "node:test";
import assert from "node:assert/strict";
import {shareSelectedOriginals} from "../src/local/selection-share";
import {captureGroup} from "../src/local/capture-groups";
import type {LocalPhoto} from "../src/local/resources";
import {availablePhotoSelection, ownedPhotoForLocal, selectedOwnedPhotos, reconcileSavedSelection} from "../src/local/selection";
import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import type {Photo} from "../src/library/catalog";

const photo = (id: string): LocalPhoto => ({id, filename: id + ".png", date: "2026-10-01", dateSource: "selected", file: new File([id], id + ".png")});
test("selection Share dispatches the exact chosen originals before leaving the user gesture", async () => {
  const selected = [photo("a"), photo("c")];
  let dispatched = false;
  const result = shareSelectedOriginals(selected, () => true, {canShare: () => true, share: async data => {
    dispatched = true;
    assert.deepEqual(data.files, selected.map(value => value.file));
    assert.equal(data.files![0], selected[0].file);
  }, download: () => assert.fail("Native sharing does not download copies")});
  assert.equal(dispatched, true);
  assert.equal(await result, "shared");
});
test("cancelled selection Share remains silent and cannot fall back to downloads", async () => {
  assert.equal(await shareSelectedOriginals([photo("a")], () => true, {canShare: () => true, share: async () => {throw new DOMException("Cancelled", "AbortError");}, download: () => assert.fail("Cancelled")}), "cancelled");
});
test("retained previews and revoked sources cannot substitute for chosen originals", async () => {
  const environment = {canShare: () => assert.fail("Not authorized"), share: async () => assert.fail("Not authorized"), download: () => assert.fail("Not authorized")};
  await assert.rejects(shareSelectedOriginals([{...photo("a"), file: undefined, preview: new Blob(["preview"])}], () => true, environment), /Reselect/);
  await assert.rejects(shareSelectedOriginals([photo("a")], () => false, environment), /Reselect/);
});
test("fallback stops dispatching originals if the chosen source is withdrawn", async () => {
  let current = true;
  const downloaded: File[] = [], selected = [photo("a"), photo("b")];
  await assert.rejects(shareSelectedOriginals(selected, () => current, {canShare: () => false, download: file => {downloaded.push(file); current = false;}}), /changed/);
  assert.deepEqual(downloaded, [selected[0].file]);
});
test("capture groups use real capture evidence and local calendar boundaries", () => {
  const now = new Date(2026, 9, 3, 12);
  assert.equal(captureGroup({date: new Date(2026, 9, 3, 1).toISOString(), dateSource: "exif"}, now).heading, "Today");
  assert.equal(captureGroup({date: new Date(2026, 9, 2, 23).toISOString(), dateSource: "exif"}, now).heading, "Yesterday");
  assert.deepEqual(captureGroup({date: now.toISOString(), dateSource: "selected"}, now), {key: "undated", heading: "Capture date unavailable"});
  for (const dateSource of ["exif", "photos"] as const) assert.deepEqual(captureGroup({date: "not a date", dateSource}, now), {key: "undated", heading: "Capture date unavailable"});
});

test("Find selects only current owned saved sources and drops withdrawn, received, or switched-account records", () => {
  const token = {}, own = {manifest:{photoId:"a",ownerAccountId:"owner"}} as Photo;
  const other = {manifest:{photoId:"b",ownerAccountId:"other"}} as Photo;
  const received = {manifest:{photoId:"c",ownerAccountId:"owner"},grantId:"grant"} as Photo;
  const snapshot = {accountId:"owner",token,current:()=>true,photos:[own,other,received],preview:async()=>new Blob()} satisfies OwnedPhotoSnapshot;
  const ids = new Set(["a","b","c","withdrawn"]);
  assert.deepEqual(selectedOwnedPhotos(snapshot,token,ids),[own]);
  assert.equal(selectedOwnedPhotos({...snapshot,current:()=>false},token,ids).length,0);
  assert.equal(selectedOwnedPhotos({...snapshot,token:{}},token,ids).length,0);
  assert.equal(selectedOwnedPhotos({...snapshot,photos:[]},token,ids).length,0);
  assert.equal(selectedOwnedPhotos({...snapshot,accountId:"new-account"},token,ids).length,0);
  assert.equal(selectedOwnedPhotos(null,token,ids).length,0);
});

test("local corrections resolve the verified original digest, never equal filenames or retained previews", () => {
  const local = {...photo("00".repeat(32)),digest:"00".repeat(32)};
  const record = (id: string, digest: string, owner = "owner", grantId?: string) => ({manifest:{photoId:id,ownerAccountId:owner},metadata:{filename:local.filename,sourceDate:local.date,dateSource:"import",originalSha256:digest},grantId} as Photo);
  const unrelated = record("same-name","B".repeat(43)), match = record("actual","A".repeat(43)), received = record("received","A".repeat(43),"owner","grant"), other = record("other","A".repeat(43),"other");
  const snapshot = {accountId:"owner",token:{},current:()=>true,photos:[received,other,unrelated,match],preview:async()=>new Blob()} satisfies OwnedPhotoSnapshot;
  assert.equal(ownedPhotoForLocal(snapshot,local),match);
  assert.equal(ownedPhotoForLocal(snapshot,{...local,digest:undefined}),undefined);
  assert.equal(ownedPhotoForLocal(snapshot,{...local,file:undefined}),undefined);
  assert.equal(ownedPhotoForLocal({...snapshot,current:()=>false},local),undefined);
  assert.equal(ownedPhotoForLocal({...snapshot,photos:[unrelated,received,other]},local),undefined);
});

test("a selected saved photo keeps one selection when its identical local original is imported", () => {
  const token = {}, local = {...photo("local"), digest: "00".repeat(32)};
  const saved = {manifest: {photoId: "saved", ownerAccountId: "owner"}, metadata: {filename: "original.png", sourceDate: local.date, dateSource: "import", originalSha256: "A".repeat(43)}} as Photo;
  const snapshot = {accountId: "owner", token, current: () => true, photos: [saved], preview: async () => new Blob()} satisfies OwnedPhotoSnapshot;
  const ids = new Set(["saved"]), before = reconcileSavedSelection(snapshot, token, ids, []);
  assert.deepEqual([...before.savedIDs], ["saved"]); assert.equal(before.localIDs.size, 0);
  const imported = reconcileSavedSelection(snapshot, token, ids, [local]);
  assert.equal(imported.savedIDs.size, 0); assert.deepEqual([...imported.localIDs], [local.id]);
  const selected = new Set(["manual", ...imported.localIDs]);
  const files: File[] = [];
  const pending = shareSelectedOriginals([local].filter(photo => selected.has(photo.id)), () => true,
    {canShare: () => false, download: file => {files.push(file);}});
  assert.deepEqual(files, [local.file], "The original is exported exactly once");
  assert.deepEqual([...selected], ["manual", "local"]); assert.deepEqual([...ids], ["saved"], "Reconciliation does not mutate the original selection");
  return pending;
});

test("photo availability pruning retains a choice queued after the import render", () => {
  const manual = photo("manual"), imported = photo("imported"), photos = [manual, imported];
  const renderedSelection = new Set([manual.id]);
  const queuedSelection = new Set([...renderedSelection, imported.id]);
  const pruned = availablePhotoSelection(queuedSelection, photos);
  assert.deepEqual([...pruned], ["manual", "imported"], "Pruning uses current choices, not the earlier render's IDs");
  assert.equal(pruned, queuedSelection, "An unchanged choice must not enqueue another state update");
  assert.deepEqual([...availablePhotoSelection(pruned, [manual])], ["manual"], "Removing a source still removes its choice");
  assert.deepEqual([...availablePhotoSelection(pruned, [manual, {...imported, current: () => false}])], ["manual"]);
});

test("saved selection cannot transfer after account loss, source withdrawal, or a digest mismatch", () => {
  const token = {}, local = {...photo("local"), digest: "00".repeat(32)};
  const record = (id: string, digest = "A".repeat(43), owner = "owner", grantId?: string) => ({manifest: {photoId: id, ownerAccountId: owner},
    metadata: {filename: local.filename, sourceDate: local.date, dateSource: "import", originalSha256: digest}, grantId} as Photo);
  const own = record("own"), otherOriginal = record("distinct", "B".repeat(43));
  const snapshot = {accountId: "owner", token, current: () => true, photos: [own, otherOriginal, record("received", undefined, "owner", "grant"), record("other", undefined, "other")], preview: async () => new Blob()} satisfies OwnedPhotoSnapshot;
  const ids = new Set(["own", "distinct", "received", "other", "withdrawn"]);
  const current = reconcileSavedSelection(snapshot, token, ids, [local]);
  assert.deepEqual([...current.localIDs], ["local"]); assert.deepEqual([...current.savedIDs], ["distinct"]);
  for (const invalid of [null, {...snapshot, current: () => false}, {...snapshot, token: {}}, {...snapshot, accountId: "new-account"}, {...snapshot, photos: []}]) {
    const result = reconcileSavedSelection(invalid, token, ids, [local]);
    assert.equal(result.localIDs.size, 0); assert.equal(result.savedIDs.size, 0);
  }
  for (const unavailable of [{...local, current: () => false}, {...local, file: undefined, preview: new Blob(["preview"])}, {...local, digest: undefined}, {...local, digest: "11".repeat(32)}]) {
    const result = reconcileSavedSelection(snapshot, token, ids, [unavailable]);
    assert.equal(result.localIDs.size, 0); assert.deepEqual([...result.savedIDs], ["own", "distinct"]);
  }
});

test("Saved Photos capture dates group by day while imported selection dates remain undated", () => {
  const now = new Date(2026, 9, 3, 12);
  const stored = (id: string, sourceDate: string, dateSource: "photos" | "exif" | "import") => ({
    manifest: {photoId: id, ownerAccountId: "owner"},
    metadata: {filename: id + ".jpg", sourceDate, dateSource, originalSha256: id},
  }) as Photo;
  const captured = new Date(2026, 9, 3, 1).toISOString();
  const snapshot: OwnedPhotoSnapshot = {accountId: "owner", token: {}, current: () => true,
    photos: [stored("native-today", captured, "photos"), stored("native-yesterday", new Date(2026, 9, 2, 23).toISOString(), "photos"),
      stored("exif-today", captured, "exif"), stored("imported", captured, "import")], preview: async () => new Blob()};
  const records = savedSearchPhotos(snapshot, []);
  assert.equal(records[0].dateSource, "photos");
  assert.equal(captureGroup(records[0], now).heading, "Today");
  assert.equal(captureGroup(records[1], now).heading, "Yesterday");
  assert.deepEqual(captureGroup(records[0], now), captureGroup(records[2], now));
  assert.equal(records[3].dateSource, "selected");
  assert.deepEqual(captureGroup(records[3], now), {key: "undated", heading: "Capture date unavailable"});
});
