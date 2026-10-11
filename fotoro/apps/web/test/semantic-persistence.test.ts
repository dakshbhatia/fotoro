import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {get, all, clearAccount} from "../src/exchange/cache";
import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import type {Photo} from "../src/library/catalog";
import type {LocalPhoto} from "../src/local/resources";
import {LocalRetention} from "../src/local/retention";
import {emptyFeedback} from "../src/local/search";
import {DurableSemanticInference, clearSemanticInference, failedSemanticRecord, type SemanticInferenceRecord} from "../src/local/semantic-persistence";
import {SemanticFindSession} from "../src/local/semantic-find";
import {SEMANTIC_PROCESSOR} from "../src/local/semantic-config";

const vector = () => {const out = new Float32Array(512); out[0] = 1; return out;};
const photo = (): LocalPhoto => ({id: "exact-original", digest: "exact-digest", filename: "private-name.jpg", date: "2026-10-03", dateSource: "exif", width: 100, height: 100, labels: [], preview: new Blob(["private-preview"])});
const complete = (source: LocalPhoto): SemanticInferenceRecord => ({version: 1, id: source.id, digest: source.digest!, processor: SEMANTIC_PROCESSOR, state: "complete", vector: Array.from(vector())});
const retention = () => new LocalRetention({name: "semantic-test-" + crypto.randomUUID()});
class Worker {
  onmessage: ((event: MessageEvent) => void) | null = null; onerror = null; images = 0;
  postMessage(message: {kind: string; id: number}) {if (message.kind === "cancel") return; if (message.kind === "image") this.images++;
    queueMicrotask(() => this.onmessage?.({data: {id: message.id, vector: vector()}} as MessageEvent));}
  terminate() {}
}
const raster = () => ({loads: 0, async load(source: LocalPhoto) {this.loads++; return {blob: source.preview!} as any;}, clear() {}});

test("opt-in encrypted vectors survive a new session and retained metadata save, without decoding or image inference", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const firstWorker = new Worker(), firstRaster = raster(), store = new DurableSemanticInference(local, () => true);
  const first = new SemanticFindSession(() => firstWorker as any, firstRaster, 1000, store);
  await first.search([source], "fireworks", () => true, () => {}); first.clear();
  assert.equal(firstWorker.images, 1); assert.equal(firstRaster.loads, 1);
  await local.save([{...source, labels: ["new label"]}], emptyFeedback());
  const reopened = new LocalRetention({name: local.name}), secondWorker = new Worker(), secondRaster = raster();
  const second = new SemanticFindSession(() => secondWorker as any, secondRaster, 1000, new DurableSemanticInference(reopened, () => true));
  let found: ReadonlyMap<string, number> = new Map();
  assert.equal(await second.search([{...source, preview: new Blob(["fresh derivative"])}], "fireworks", () => true, scores => {found = scores;}), undefined);
  assert.equal(found.get(source.id), 1); assert.equal(secondWorker.images, 0); assert.equal(secondRaster.loads, 0);
  second.clear(); await local.clear();
});

test("off, changed digest/processor, withdrawal and clear cannot restore old inference", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  let enabled = false; const store = new DurableSemanticInference(local, () => enabled);
  await store.write(source, complete(source), () => true); enabled = true;
  assert.equal(await store.read(source, () => true), undefined);
  await store.write(source, complete(source), () => true);
  assert.equal((await store.read(source, () => true))?.state, "complete");
  assert.equal(await store.read({...source, digest: "changed"}, () => true), undefined);
  assert.equal(await new DurableSemanticInference(local, () => true, "new-processor").read(source, () => true), undefined);
  assert.equal(await store.read({...source, current: () => false}, () => true), undefined);
  assert.equal(await store.read(source, () => false), undefined);
  await new LocalRetention({name: local.name}).clear();
  assert.equal(await store.read(source, () => true), undefined);
  await store.write(source, complete(source), () => true);
  assert.equal(await store.read(source, () => true), undefined, "A cleared source cannot be recreated by old work");
});

test("persisted preview failure suppresses remount churn until retry is due, then success replaces the failure", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const store = new DurableSemanticInference(local, () => true);
  await store.write(source, failedSemanticRecord(source, "preview-failed"), () => true);
  const worker = new Worker(), resources = raster(), engine = new SemanticFindSession(() => worker as any, resources, 1000, store);
  assert.equal(await engine.search([source], "fireworks", () => true, () => {}), "missing-preview");
  assert.equal(resources.loads, 0); assert.equal(worker.images, 0);
  await store.write(source, failedSemanticRecord(source, "preview-failed", undefined, Date.now() - 6000), () => true);
  assert.equal(await engine.search([source], "fireworks", () => true, () => {}), undefined);
  assert.equal(worker.images, 1); assert.equal(resources.loads, 1);
  assert.equal((await store.read(source, () => true))?.state, "complete"); engine.clear(); await local.clear();
});

test("missing derivatives never consume cached vectors, load an original, or initialize the model", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const store = new DurableSemanticInference(local, () => true); await store.write(source, complete(source), () => true);
  const resources = raster(), engine = new SemanticFindSession(() => {throw new Error("must not initialize");}, resources, 1000, store);
  assert.equal(await engine.search([{...source, previewAvailable: false}], "fireworks", () => true, () => assert.fail("missing derivative cannot publish")), "missing-preview");
  assert.equal(resources.loads, 0); engine.clear(); await local.clear();
});
test("clear while encryption is delayed cannot recreate a retained inference row", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const store = new DurableSemanticInference(local, () => true), original = crypto.subtle.encrypt;
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => {began = resolve;}), gate = new Promise<void>(resolve => {release = resolve;});
  crypto.subtle.encrypt = (async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
    const result = await original.apply(crypto.subtle, args);
    if (new TextDecoder().decode((args[0] as AesGcmParams).additionalData) === "inference:" + source.id) {began(); await gate;}
    return result;
  }) as SubtleCrypto["encrypt"];
  try {
    const writing = store.write(source, complete(source), () => true); await started;
    await new LocalRetention({name: local.name}).clear(); release(); await writing;
    assert.equal(await store.read(source, () => true), undefined);
  } finally {release(); crypto.subtle.encrypt = original; await local.clear();}
});
test("an inference started before clear cannot persist into a newly retained copy of the same original", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const store = new DurableSemanticInference(local, () => true), worker = new Worker();
  let finish!: () => void, began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
  worker.postMessage = message => {
    if (message.kind === "cancel") return;
    const reply = () => worker.onmessage?.({data: {id: message.id, vector: vector()}} as MessageEvent);
    if (message.kind === "image") {finish = reply; began();} else queueMicrotask(reply);
  };
  const engine = new SemanticFindSession(() => worker as any, raster(), 1000, store);
  const searching = engine.search([source], "fireworks", () => true, () => {}); await started;
  await clearSemanticInference(); await local.clear(); await local.save([source], emptyFeedback());
  finish(); await searching;
  assert.equal(await store.read(source, () => true), undefined, "The old request's persistence lifetime was revoked");
  engine.clear(); await local.clear();
});
test("a changed digest or derivative during inference cannot bind an old vector to the replacement", async () => {
  const local = retention(), source = photo(); await local.save([source], emptyFeedback());
  const store = new DurableSemanticInference(local, () => true), worker = new Worker();
  let finish!: () => void, began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
  worker.postMessage = message => {
    if (message.kind === "cancel") return;
    const reply = () => worker.onmessage?.({data: {id: message.id, vector: vector()}} as MessageEvent);
    if (message.kind === "image") {finish = reply; began();} else queueMicrotask(reply);
  };
  const engine = new SemanticFindSession(() => worker as any, raster(), 1000, store);
  let scores: ReadonlyMap<string, number> = new Map();
  const searching = engine.search([source], "fireworks", () => true, value => {scores = value;}); await started;
  source.digest = "replacement"; source.preview = new Blob(["new derivative"]);
  await local.save([source], emptyFeedback()); finish(); await searching;
  assert.equal(scores.size, 0); assert.equal(await store.read(source, () => true), undefined);
  engine.clear(); await local.clear();
});
test("restoring durable vectors obeys the same 4096-vector memory bound and zeros an evicted vector", async () => {
  const worker = new Worker(), sources = Array.from({length: 4096}, (_, index) => ({...photo(), id: "warm-" + index, digest: "warm-" + index}));
  const extra = {...photo(), id: "restored", digest: "restored"};
  const persistence = {async read(source: LocalPhoto) {return source.id === extra.id ? complete(extra) : undefined;}, async write() {}};
  const engine = new SemanticFindSession(() => worker as any, raster(), 1000, persistence);
  await engine.search(sources, "fireworks", () => true, () => {});
  const first = (engine as any).vectors.get(sources[0].id).vector as Float32Array;
  await engine.search([...sources, extra], "fireworks", () => true, () => {});
  assert.equal((engine as any).vectors.size, 4096); assert.ok(first.every(value => value === 0));
  assert.equal(worker.images, 4096, "The restored vector requires no image inference"); engine.clear();
});

async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
test("Saved inference binds owner/vault/manifest/digest and remains ciphertext in the existing account cache", async () => {
  await ready; const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {configurable: true, value: new EventTarget()});
  const owner = accounts.accounts[0].accountId, other = accounts.accounts[1].accountId;
  try {
    lockVault(); await clearAccount(owner); await clearAccount(other); const session = await open(0);
    let available = true, optedIn = true;
    const original = {manifest: {version: 1, photoId: crypto.randomUUID(), ownerAccountId: owner, representations: []}, metadata: {filename: "private-saved.jpg", originalSha256: "A".repeat(43), sourceDate: "2026-10-03", dateSource: "exif", width: 100, height: 100}} as unknown as Photo;
    const snapshot: OwnedPhotoSnapshot = {accountId: owner, token: session, photos: [original], current: () => available, preview: async () => new Blob()};
    const source = savedSearchPhotos(snapshot, [])[0], store = new DurableSemanticInference(retention(), () => optedIn);
    await store.write(source, complete(source), () => true);
    const key = `${owner}:semantic:${original.manifest.photoId}`, raw = await get<any>("settings", key);
    assert.equal(raw.version, 1); assert.equal(typeof raw.ciphertext, "string");
    assert.ok(!JSON.stringify(raw).includes("private-saved")); assert.ok(!JSON.stringify(raw).includes("vector"));
    assert.equal((await new DurableSemanticInference(retention(), () => true).read(source, () => true))?.state, "complete");
    assert.equal(await store.read({...source}, () => true), undefined, "An arbitrary saved ID cannot forge the verified source binding");
    optedIn = false; assert.equal(await store.read(source, () => true), undefined); optedIn = true;
    available = false; assert.equal(await store.read(source, () => true), undefined); available = true;
    original.manifest.representations.push({binding: {kind: "preview"}} as any);
    assert.equal(await store.read(savedSearchPhotos(snapshot, [])[0], () => true), undefined, "A new derivative revision cannot adopt an old vector");
    lockVault(); assert.equal(await store.read(source, () => true), undefined);
    await open(1); assert.equal(await store.read(source, () => true), undefined);
    assert.equal((await all("settings", other + ":semantic:")).length, 0);
    await clearAccount(owner); snapshot.token = await open(0);
    assert.equal(await store.read(savedSearchPhotos(snapshot, [])[0], () => true), undefined);
    const fresh = savedSearchPhotos(snapshot, [])[0]; await store.write(fresh, complete(fresh), () => true);
    assert.equal((await all("settings", owner + ":semantic:")).length, 1);
    await clearSemanticInference(); assert.equal((await all("settings", owner + ":semantic:")).length, 0);
    await store.write(fresh, complete(fresh), () => true); optedIn = false; await clearSemanticInference();
    assert.equal((await all("settings", owner + ":semantic:")).length, 0, "Opt-out removes encrypted Saved inference too");
  } finally {lockVault(); await clearAccount(owner); await clearAccount(other); if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");}
});
