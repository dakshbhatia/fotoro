import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { LocalRetention } from "../src/local/retention";
import { localPhoto } from "../src/local/resources";
import { emptyFeedback } from "../src/local/search";
const fixture = () => ({ id: "sha-photo", digest: "sha-photo", filename: "private-name.jpg", labels: ["Ronald"], date: "2026-09-01T00:00:00Z", dateSource: "exif" as const, width: 640, height: 480, originalSize: 1234, preview: new Blob(["bounded jpeg"], { type: "image/jpeg" }) });
const store = (budget?: number) => new LocalRetention({ name: "test-search-" + crypto.randomUUID(), budget });

test("capture verification survives retention without inventing it for legacy dates", async () => {
  const saved=store();
  await saved.save([{...fixture(),captureVerified:true as const},{...fixture(),id:"legacy"}],emptyFeedback());
  const loaded=await saved.load();
  assert.equal(loaded.photos.find(photo=>photo.id==="sha-photo")?.captureVerified,true);
  assert.equal(loaded.photos.find(photo=>photo.id==="legacy")?.captureVerified,undefined);
  await saved.clear();
});

test("reopening restores labels and preview but never the original File", async () => {
  const saved = store();
  const photo = { ...fixture(), file: new File(["original secret"], "private-name.jpg") };
  await saved.save([photo], emptyFeedback());
  const loaded = await saved.load();
  assert.equal(loaded.enabled, true);
  assert.deepEqual(loaded.photos[0].labels, ["Ronald"]);
  assert.equal(await (await loaded.photos[0].previewLoader!()).text(), "bounded jpeg");
  assert.equal(loaded.photos[0].file, undefined);
  await saved.clear();
  assert.equal((await saved.load()).enabled, false);
});
test("account-derived scene fields and scope callbacks never enter local browser retention", async () => {
  const saved = store();
  await saved.save([{...fixture(), visual: {photoID: "sha-photo", revision: "sha-photo", status: "complete" as const,
    processor: "vision-image-classification-r1-v1", labels: [{label: "beach", identifier: "beach", confidence: 0.9}]}, current: () => true}], emptyFeedback());
  const loaded = await saved.load();
  assert.equal(loaded.photos[0].visual, undefined);
  assert.equal(loaded.photos[0].current, undefined);
  assert.deepEqual(loaded.photos[0].labels, ["Ronald"]);
  await saved.clear();
});
test("encrypted bytes do not contain searchable metadata and keys cannot be exported", async () => {
  const saved = store();
  await saved.save([fixture()], emptyFeedback());
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(saved.name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const read = (key: string) => new Promise<any>(resolve => { const req = db.transaction("data").objectStore("data").get(key); req.onsuccess = () => resolve(req.result); });
  const raw = await read("photo:sha-photo"), key = await read("key");
  assert.equal(new TextDecoder().decode(raw.meta.data).includes("Ronald"), false);
  assert.equal(new TextDecoder().decode(raw.meta.data).includes("private-name"), false);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  db.close();
  await saved.clear();
});
test("preview budget eviction preserves labels and the remaining previews", async () => {
  const saved = store(12);
  await saved.save([fixture(), { ...fixture(), id: "second", digest: "second", labels: ["Rome"] }], emptyFeedback());
  const loaded = await saved.load();
  assert.equal(loaded.photos.length, 2);
  assert.equal(loaded.photos.filter(photo => photo.previewAvailable).length, 1);
  assert.deepEqual(loaded.photos.find(photo => photo.id === "sha-photo")?.labels, ["Ronald"]);
  await saved.clear();
});
test("Clear racing an asynchronous save removes records and key", async () => {
  const saved = store();
  const pending = saved.save([fixture()], emptyFeedback());
  await saved.clear();
  await pending;
  assert.equal((await saved.load()).enabled, false);
  assert.equal((await saved.load()).photos.length, 0);
});
test("an authenticated corrupt record is skipped with partial coverage reported", async () => {
  const saved = store();
  await saved.save([fixture()], emptyFeedback());
  const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open(saved.name); req.onsuccess = () => resolve(req.result); });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("data", "readwrite"), object = tx.objectStore("data"), req = object.get("photo:sha-photo");
    req.onsuccess = () => { const raw = req.result; new Uint8Array(raw.meta.data)[0] ^= 1; object.put(raw, "photo:sha-photo"); };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
  const loaded = await saved.load();
  assert.equal(loaded.photos.length, 0);
  assert.equal(loaded.skipped, 1);
  await saved.clear();
});
test("failed serialization cannot erase a previously saved search", async () => {
  const saved = store();
  await saved.save([fixture()], emptyFeedback());
  const feedback: any = emptyFeedback(); feedback.meanings.self = feedback;
  await assert.rejects(saved.save([fixture()], feedback));
  assert.equal((await saved.load()).photos[0].filename, "private-name.jpg");
  await saved.clear();
});
test("content identity reconnects originals and does not trust filenames", async () => {
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(bytes.buffer); view.setUint32(16,640); view.setUint32(20,480);
  const a = await localPhoto(new File([bytes], "a.png", { type: "image/png" }));
  const b = await localPhoto(new File([bytes], "renamed.png", { type: "image/png" }));
  bytes[23] ^= 1;
  const c = await localPhoto(new File([bytes], "a.png", { type: "image/png" }));
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
});
test("clearing in another instance fences a save paused before its final transaction", async () => {
  const a = store(), b = new LocalRetention({ name: a.name });
  let entered = false, resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  class PausedPreview extends Blob { async arrayBuffer() { entered = true; await pause; return super.arrayBuffer(); } }
  const pending = a.save([{ ...fixture(), preview: new PausedPreview(["bounded jpeg"], { type: "image/jpeg" }) }], emptyFeedback());
  while (!entered) await new Promise(resolve => setTimeout(resolve, 0));
  await b.clear(); resume(); await pending;
  assert.equal((await b.load()).enabled, false);
  assert.equal((await b.load()).photos.length, 0);
});
test("a corrupt optional preview cannot erase valid durable labels", async () => {
  const saved = store(); await saved.save([fixture()], emptyFeedback());
  const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open(saved.name); req.onsuccess = () => resolve(req.result); });
  const separate = db.objectStoreNames.contains("previews");
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(separate ? "previews" : "data", "readwrite"), object = tx.objectStore(separate ? "previews" : "data"), req = object.get(separate ? "sha-photo" : "photo:sha-photo");
    req.onsuccess = () => { const raw = req.result, envelope = separate ? raw : raw.preview; new Uint8Array(envelope.data)[0] ^= 1; object.put(raw, separate ? "sha-photo" : "photo:sha-photo"); };
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  db.close();
  const loaded = await saved.load();
  assert.deepEqual(loaded.photos[0]?.labels, ["Ronald"]);
  await assert.rejects(loaded.photos[0].previewLoader!());
  assert.deepEqual((await saved.load()).photos[0]?.labels, ["Ronald"]);
  await saved.clear();
});
test("metadata hydration leaves preview bytes lazy and metadata-only saves preserve them", async () => {
  const saved = store(); await saved.save([fixture()], emptyFeedback());
  const loaded = await saved.load();
  assert.equal(loaded.photos[0].preview, undefined);
  assert.equal(typeof loaded.photos[0].previewLoader, "function");
  await saved.save(loaded.photos.map(photo => ({ ...photo, labels: ["Ronald", "Portrait"] })), emptyFeedback());
  const again = await saved.load();
  assert.equal(await (await again.photos[0].previewLoader!()).text(), "bounded jpeg");
  assert.deepEqual(again.photos[0].labels, ["Ronald", "Portrait"]);
  await saved.clear();
});
test("a previously queued save cannot adopt a newer clear epoch", async () => {
  const a = store(), b = new LocalRetention({ name: a.name });
  let entered = false, resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  class PausedPreview extends Blob { async arrayBuffer() { entered = true; await pause; return super.arrayBuffer(); } }
  const first = a.save([{ ...fixture(), preview: new PausedPreview(["bounded jpeg"], { type: "image/jpeg" }) }], emptyFeedback());
  while (!entered) await new Promise(resolve => setTimeout(resolve, 0));
  const queued = a.save([fixture()], emptyFeedback());
  await b.clear(); resume(); await first; await queued;
  assert.equal((await b.load()).enabled, false);
});
test("derived OCR and supplied metadata restore encrypted alongside labels", async () => {
  const saved = store();
  const ocr = { photoID: "sha-photo", revision: "sha-photo", processor: "fixture-v1", status: "complete" as const, text: "INVOICE 4826", confidence: .94 };
  await saved.save([{ ...fixture(), ocr, caption: "Rome", keywords: ["Trip"], facts: ["41.9028,12.4964"], favorite: true }], emptyFeedback());
  const restored = (await saved.load()).photos[0];
  assert.deepEqual(restored.ocr, ocr); assert.equal(restored.caption, "Rome"); assert.deepEqual(restored.keywords, ["Trip"]); assert.equal(restored.favorite, true);
  await saved.clear();
});
test("a serial preview provider prepares each new original once and reuses retained bytes", async () => {
  const saved = store();
  const source = { ...fixture(), preview: undefined, file: new File(["original"], "private.jpg") };
  let reads = 0;
  const provider = async () => { reads++; return fixture().preview; };
  assert.equal(await saved.save([source], emptyFeedback(), () => true, provider), true);
  assert.equal(await saved.save([{ ...source, labels: ["Ronald", "Portrait"] }], emptyFeedback(), () => true, provider), true);
  assert.equal(reads, 1);
  const restored = (await saved.load()).photos[0];
  assert.equal(await (await restored.previewLoader!()).text(), "bounded jpeg");
  assert.deepEqual(saved.previewCoverage, { count: 1, bytes: 12 });
  await saved.clear();
});
test("stale derived OCR is discarded without losing the user's durable labels", async () => {
  const saved = store();
  const ocr = { photoID: "sha-photo", revision: "obsolete", processor: "fixture-v1", status: "complete" as const, text: "OLD INVOICE", confidence: .94 };
  await saved.save([{ ...fixture(), ocr }], emptyFeedback());
  const restored = (await saved.load()).photos[0];
  assert.deepEqual(restored.labels, ["Ronald"]);
  assert.equal(restored.ocr, undefined);
  assert.equal(await (await restored.previewLoader!()).text(), "bounded jpeg");
  await saved.clear();
});
test("a failed retained preview stays unavailable instead of being revived from cached coverage", async () => {
  const saved = store();
  await saved.save([fixture()], emptyFeedback());
  const restored = (await saved.load()).photos[0];
  await saved.save([{ ...restored, previewAvailable: false }], emptyFeedback());
  const again = (await saved.load()).photos[0];
  assert.equal(again.previewAvailable, false);
  assert.deepEqual(again.labels, ["Ronald"]);
  assert.deepEqual(saved.previewCoverage, { count: 0, bytes: 0 });
  await assert.rejects(again.previewLoader!());
  await saved.clear();
});
