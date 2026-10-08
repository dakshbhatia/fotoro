import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64, signPayload, utf8 } from "@fotoro/crypto";
import { configureVault, unlockVault, lockVault, encryptPrivate, decryptPrivate, requireVault } from "../src/vault/vault";
import { all, clearAccount, get } from "../src/exchange/cache";
import { applyChanges } from "../src/library/catalog";
import * as annotations from "../src/exchange/annotations";
import {VISUAL_PROCESSOR} from "@fotoro/contracts/visual";
import {annotationObservation, withPhotoObservation} from "@fotoro/contracts/intelligence";
import {peopleNames, factsWithPeople} from "@fotoro/contracts/people";
import {annotationLocation, withAnnotationLocation} from "@fotoro/contracts/location";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const photoId = "33333333-3333-4333-8333-333333333333";
const originalSha256 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const localProcessor = "tesseract.js-7.0.0/eng-1.0.0/lstm-orientation-v2";
const identity = { ownerAccountId: owner, photoId, originalSha256 };
async function open(accountId = owner) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
function signed(revision: number, fields: object, signedOwner = owner, boundPhoto = photoId) {
  return signPayload("photo-annotations", signedOwner, utf8({version: 1, photoId: boundPhoto, revision, encrypted: encryptPrivate({version: 1, photoId: boundPhoto, originalSha256, ...fields})}), requireVault().signingSecretKey);
}
const reply = (value: unknown) => new Response(JSON.stringify(value), {status: 200});
async function clean() {await clearAccount(owner); await clearAccount(other); lockVault();}

test("local locations save only through encrypted facts and inferred Timeline cannot replace factual GPS", async () => {
  await open(); const old = globalThis.fetch;
  globalThis.fetch = (async () => {throw Error("Queue must stay offline");}) as any;
  try {
    const location = {latitude: 41.9028, longitude: 12.4964, source: "exif" as const};
    const local = {id: "local", digest: originalSha256, filename: "sample.jpg", date: "2026-10-01T12:00:00Z", dateSource: "exif" as const, facts: ["My exact fact"], location};
    await annotations.queueLocalAnnotations(identity, local);
    const value = (await annotations.readAnnotations(identity))!.value;
    assert.deepEqual(annotationLocation(value), location);
    assert.equal(Object.hasOwn(value, "location"), false);
    assert.equal(value.facts?.[0], "My exact fact");
    assert.doesNotMatch(JSON.stringify(await all("settings")), /41\.9028|fotoro\.location/);
    await annotations.queueAnnotations(identity, withAnnotationLocation({facts: ["Updated fact"]}, {...location, source: "google-timeline"}));
    const updated = (await annotations.readAnnotations(identity))!.value;
    assert.deepEqual(annotationLocation(updated), location); assert.equal(updated.facts?.[0], "Updated fact");
  } finally {globalThis.fetch = old; await clean();}
});

test("a serialized location write preserves supplied facts queued after the rendered snapshot", async () => {
  const session = await open();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  try {
    await annotations.cacheAnnotations(signed(1, {facts: ["old fact"], labels: ["My EXACT label"]}), photoId);
    const held = annotations.serializeAnnotationWrites(session, () => barrier);
    const newest = ["Newest supplied fact", "A note about fotoro.location.v1: stays mine"];
    const editing = annotations.queueAnnotations(identity, {facts: newest}, session);
    const location = {latitude: 40.75, longitude: -73.98, source: "google-timeline" as const, name: "New York"};
    const locating = annotations.queuePhotoLocation(identity, location, session);
    release(); await held; await editing;
    assert.equal(await locating, true);
    const value = (await annotations.readAnnotations(identity, session))!.value;
    assert.deepEqual(value.facts?.slice(0, 2), newest);
    assert.deepEqual(value.labels, ["My EXACT label"]);
    assert.deepEqual(annotationLocation(value), location);
    assert.equal(Object.hasOwn(value, "location"), false);
  } finally {release?.(); await clean();}
});

test("interleaved factual GPS rejects estimated acknowledgement and identical location retries remain exact", async () => {
  const session = await open();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  try {
    const held = annotations.serializeAnnotationWrites(session, () => barrier);
    const factual = {latitude: 41.9028, longitude: 12.4964, source: "exif" as const};
    const editing = annotations.queueAnnotations(identity, withAnnotationLocation({facts: ["Latest fact"]}, factual), session);
    const locating = annotations.queuePhotoLocation(identity, {...factual, source: "google-timeline"}, session);
    release(); await held; await editing;
    assert.equal(await locating, false);
    const before = (await annotations.pendingAnnotations(session))[0];
    assert.deepEqual(annotationLocation((await annotations.readAnnotations(identity, session))!.value), factual);
    assert.equal(await annotations.queuePhotoLocation(identity, factual, session), true);
    assert.deepEqual((await annotations.pendingAnnotations(session))[0].signed, before.signed);
    assert.equal(await annotations.queuePhotoLocation(identity, {...factual, source: "photos"}, session), false);
    assert.equal((await annotations.readAnnotations(identity, session))?.value.facts?.[0], "Latest fact");
  } finally {release?.(); await clean();}
});

test("location acknowledgement compares scalar values regardless of native or importer key order", async () => {
  const session = await open();
  try {
    const proposal = {name: "My EXACT place", latitude: 41.9028, longitude: 12.4964, source: "google-timeline" as const, accuracyMeters: 12.5};
    assert.equal(await annotations.queuePhotoLocation(identity, proposal, session), true);
    const before = (await annotations.pendingAnnotations(session))[0];
    const reordered = {accuracyMeters: 12.5, longitude: 12.4964, source: "google-timeline" as const, name: "My EXACT place", latitude: 41.9028};
    assert.equal(await annotations.queuePhotoLocation(identity, reordered, session), true);
    assert.deepEqual((await annotations.pendingAnnotations(session))[0].signed, before.signed);
    assert.deepEqual(annotationLocation((await annotations.readAnnotations(identity, session))!.value), proposal);
    assert.equal(await annotations.queuePhotoLocation(identity, {...reordered, accuracyMeters: 12.6}, session), false);
  } finally {await clean();}
});

test("location fact capacity failure preserves the pending retry and releases serialization", async () => {
  const session = await open();
  try {
    await annotations.queueAnnotations(identity, {facts: Array(63).fill("My supplied fact")}, session);
    const before = (await annotations.pendingAnnotations(session))[0];
    await assert.rejects(annotations.queuePhotoLocation(identity, {latitude: 0, longitude: 0, source: "google-timeline", name: "Place"}, session), /capacity|64/i);
    assert.deepEqual((await annotations.pendingAnnotations(session))[0].signed, before.signed);
    assert.equal(await annotations.queueAnnotations(identity, {favorite: true}, session), true);
    assert.deepEqual((await annotations.readAnnotations(identity, session))?.value.facts, Array(63).fill("My supplied fact"));
  } finally {await clean();}
});

test("a location write waiting behind serialization cannot enter a newly opened account", async () => {
  const session = await open();
  let release!: () => void, began!: () => void;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const entered = new Promise<void>(resolve => {began = resolve;});
  const held = annotations.serializeAnnotationWrites(session, async () => {began(); await barrier;});
  const locating = annotations.queuePhotoLocation(identity, {latitude: 0, longitude: 0, source: "google-timeline"}, session);
  const rejected = assert.rejects(locating, /VAULT_LOCKED/);
  try {
    await entered; lockVault(); await open(other); release(); await held; await rejected;
    assert.equal((await annotations.pendingAnnotations()).length, 0);
  } finally {release?.(); await clean();}
});

test("a matching local location without supplied facts preserves newer account facts across later label edits", async () => {
  const session = await open();
  try {
    await annotations.queueAnnotations(identity, {facts: ["Account-only supplied fact"], favorite: true}, session);
    const location = {latitude: 40.75, longitude: -73.98, source: "google-timeline" as const};
    const local = {id: "local", digest: originalSha256, filename: "sample.jpg", date: "2026-10-01T12:00:00Z", dateSource: "photos" as const, labels: ["local"], location};
    assert.equal(await annotations.queueLocalAnnotations(identity, local, session), true);
    let value = (await annotations.readAnnotations(identity, session))!.value;
    assert.equal(value.facts?.[0], "Account-only supplied fact"); assert.deepEqual(annotationLocation(value), location);
    await annotations.queueAnnotations(identity, {facts: withAnnotationLocation({facts: ["Newest account fact"]}, location).facts}, session);
    assert.equal(await annotations.queueLocalAnnotations(identity, {...local, labels: ["Changed local label"]}, session, false), true);
    value = (await annotations.readAnnotations(identity, session))!.value;
    assert.equal(value.facts?.[0], "Newest account fact"); assert.deepEqual(value.labels, ["Changed local label"]);
    assert.deepEqual(annotationLocation(value), location); assert.equal(value.favorite, true);
  } finally {await clean();}
});

test("explicit local fact edits retain factual GPS when the local source proposes an estimate", async () => {
  const session = await open();
  try {
    const gps = {latitude: 41.9028, longitude: 12.4964, source: "photos" as const};
    await annotations.queueAnnotations(identity, withAnnotationLocation({facts: ["Old supplied fact"]}, gps), session);
    await annotations.queueLocalAnnotations(identity, {id: "local", digest: originalSha256, filename: "sample.jpg", date: "2026-10-01T12:00:00Z", dateSource: "photos", facts: ["Exact changed fact"], location: {...gps, source: "google-timeline"}}, session);
    const value = (await annotations.readAnnotations(identity, session))!.value;
    assert.equal(value.facts?.[0], "Exact changed fact"); assert.deepEqual(annotationLocation(value), gps);
  } finally {await clean();}
});

test("verified annotations reject a different owner, signed kind, photo identity, or original digest", async () => {
  await open();
  try {
    assert.deepEqual(annotations.verifyAnnotations(signed(1, {labels: ["family"]}), identity).value.labels, ["family"]);
    assert.throws(() => annotations.verifyAnnotations(signed(1, {}, other), identity), /IDENTITY/);
    assert.throws(() => annotations.verifyAnnotations({...signed(1, {}), kind: "photo-manifest"}, identity), /IDENTITY/);
    assert.throws(() => annotations.verifyAnnotations(signed(1, {}, owner, crypto.randomUUID()), identity), /BINDING/);
    assert.throws(() => annotations.verifyAnnotations(signed(1, {originalSha256: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}), identity), /DIGEST/);
  } finally {await clean();}
});

test("queued labels are encrypted at rest, searchable before sending, and isolated by account", async () => {
  await open();
  const old = globalThis.fetch;
  globalThis.fetch = (async () => {throw new Error("must not fetch while queueing");}) as any;
  try {
    await annotations.queueAnnotations(identity, {labels: ["home"]});
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["home"]);
    const rows = await all("settings");
    assert.doesNotMatch(JSON.stringify(rows), /home/);
    lockVault(); await open(other);
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    await assert.rejects(annotations.readAnnotations(identity), /IDENTITY/);
  } finally {globalThis.fetch = old; await clean();}
});

test("a network failure retains the exact signed retry and a successful retry removes it", async () => {
  await open(); const old = globalThis.fetch;
  try {
    await annotations.queueAnnotations(identity, {labels: ["receipt"]});
    const pending = await annotations.pendingAnnotations();
    globalThis.fetch = (async () => {throw new Error("offline");}) as any;
    await assert.rejects(annotations.flushAnnotations(), /offline/);
    assert.deepEqual((await annotations.pendingAnnotations())[0].signed, pending[0].signed);
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => reply(JSON.parse(init.body as string))) as any;
    await annotations.flushAnnotations();
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["receipt"]);
  } finally {globalThis.fetch = old; await clean();}
});

test("same-field revision conflicts retain both versions until the user chooses", async () => {
  await open(); const old = globalThis.fetch;
  try {
    await annotations.cacheAnnotations(signed(1, {labels: ["old"]}), photoId);
    await annotations.queueAnnotations(identity, {labels: ["mine"]});
    const remote = signed(2, {labels: ["theirs"]});
    let writes = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (init.method === "PUT") {writes++; return new Response(JSON.stringify({code: "VERSION_CONFLICT", retryable: false}), {status: 409});}
      return reply({version: 1, annotations: remote});
    }) as any;
    await annotations.flushAnnotations();
    assert.equal(writes, 1);
    const pending = (await annotations.pendingAnnotations())[0];
    assert.equal(pending.conflict, true);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["mine"]);
    await annotations.resolveAnnotationConflict(photoId, "remote");
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["theirs"]);
  } finally {globalThis.fetch = old; await clean();}
});

test("safe rebase preserves remote OCR when only labels changed locally", async () => {
  await open(); const old = globalThis.fetch;
  try {
    await annotations.cacheAnnotations(signed(1, {labels: ["old"]}), photoId);
    await annotations.queueAnnotations(identity, {labels: ["mine"]});
    const ocr = {text: "Invoice total", confidence: 0.9, processor: "test"};
    const visual = {processor: VISUAL_PROCESSOR, labels: [{label: "beach", identifier: "beach", confidence: 0.9}]};
    const remote = signed(2, {labels: ["old"], ocr, visual});
    let writes = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (init.method !== "PUT") return reply({version: 1, annotations: remote});
      if (++writes === 1) return new Response(JSON.stringify({code: "VERSION_CONFLICT", retryable: false}), {status: 409});
      const value = annotations.verifyAnnotations(JSON.parse(init.body as string), identity);
      assert.equal(value.revision, 3);
      assert.deepEqual(value.value.labels, ["mine"]);
      assert.deepEqual(value.value.ocr, ocr);
      assert.equal(value.value.visual, undefined, "Reader-first rollout keeps released writes compatible with installed readers");
      return reply(JSON.parse(init.body as string));
    }) as any;
    await annotations.flushAnnotations();
    assert.equal(writes, 2);
    assert.equal((await annotations.pendingAnnotations()).length, 0);
  } finally {globalThis.fetch = old; await clean();}
});

test("delayed annotation upload cannot publish into a new account after lock", async () => {
  await open(); const old = globalThis.fetch;
  let receive!: (value: Response) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => {began = resolve;});
  try {
    await annotations.queueAnnotations(identity, {labels: ["mine"]});
    const payload = (await annotations.pendingAnnotations())[0].signed;
    globalThis.fetch = (async () => {began(); return new Promise<Response>(resolve => {receive = resolve;});}) as any;
    const upload = annotations.flushAnnotations();
    const rejected = assert.rejects(upload, /VAULT_LOCKED/);
    await started; lockVault(); await open(other); receive(reply(payload)); await rejected;
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    assert.equal(await get("settings", other + ":annotation:" + photoId), undefined);
    lockVault(); await open(); assert.equal((await annotations.pendingAnnotations()).length, 1);
  } finally {globalThis.fetch = old; await clean();}
});

test("annotation changes hydrate verified cache and cursor together", async () => {
  const session = await open();
  try {
    await applyChanges({version: 1, changes: [{cursor: "1", entity: "annotation", entityId: photoId, deleted: false, payload: signed(1, {labels: ["trip"]})}], nextCursor: "bmV4dA", hasMore: false} as any, session);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["trip"]);
    assert.equal(decryptPrivate(await get("settings", owner + ":cursor") as any), "bmV4dA");
  } finally {await clean();}
});

test("local OCR and labels only bind to the matching immutable original", async () => {
  await open();
  try {
    const local = {id: "local", digest: originalSha256, filename: "sample.jpg", date: "2026-10-01T12:00:00Z", dateSource: "selected" as const, labels: ["home"], ocr: {photoID: "local", revision: originalSha256, processor: localProcessor, status: "complete" as const, text: "Invoice", confidence: 0.8}};
    assert.equal(await annotations.queueLocalAnnotations({...identity, originalSha256: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}, local), false);
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    assert.equal(await annotations.queueLocalAnnotations(identity, local), true);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.ocr, {processor: localProcessor, text: "Invoice", confidence: 0.8});
    assert.equal(await annotations.queueLocalAnnotations(identity, local), false);
    assert.equal(await annotations.queueLocalAnnotations(identity, {...local, labels: ["changed"]}), true);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["changed"]);
  } finally {await clean();}
});

test("an edit made during upload survives the first acknowledgement without a false conflict", async () => {
  await open(); const old = globalThis.fetch;
  let receive!: (value: Response) => void, begin!: () => void;
  const started = new Promise<void>(resolve => {begin = resolve;});
  try {
    await annotations.queueAnnotations(identity, {labels: ["first"]});
    const first = (await annotations.pendingAnnotations())[0].signed;
    let writes = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (++writes === 1) {begin(); return new Promise<Response>(resolve => {receive = resolve;});}
      const outgoing = JSON.parse(init.body as string);
      const value = annotations.verifyAnnotations(outgoing, identity);
      assert.equal(value.revision, 2);
      assert.deepEqual(value.value.labels, ["latest"]);
      return reply(outgoing);
    }) as any;
    const flushing = annotations.flushAnnotations();
    await started; await annotations.queueAnnotations(identity, {labels: ["latest"]}); receive(reply(first));
    await flushing;
    assert.equal(writes, 2);
    assert.equal((await annotations.pendingAnnotations()).length, 0);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["latest"]);
  } finally {globalThis.fetch = old; await clean();}
});

test("identical signed annotation receipts may reorder JSON fields without becoming a revision conflict", async () => {
  await open();
  try {
    const original = signed(1, {labels: ["home"]});
    await annotations.cacheAnnotations(original, photoId);
    await annotations.cacheAnnotations({signature: original.signature, body: original.body, accountId: original.accountId, kind: original.kind, version: original.version}, photoId);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["home"]);
  } finally {await clean();}
});

test("invalid annotation pages cannot advance the cursor or publish a partial valid update", async () => {
  const session = await open();
  try {
    const valid = signed(1, {labels: ["home"]});
    const invalid = {...signed(1, {labels: ["tampered"]}), signature: "A".repeat(86)};
    await assert.rejects(applyChanges({version: 1, changes: [{cursor: "1", entity: "annotation", entityId: photoId, deleted: false, payload: valid}, {cursor: "2", entity: "annotation", entityId: photoId, deleted: false, payload: invalid}], nextCursor: "new-cursor", hasMore: false}, session), /SIGNATURE/);
    assert.equal(await get("settings", owner + ":cursor"), undefined);
    assert.equal(await annotations.readAnnotations(identity), undefined);
  } finally {await clean();}
});

test("a local snapshot detects later removals without replacing cloud fields it has not changed", async () => {
  await open();
  try {
    const local = {id: "local", digest: originalSha256, filename: "sample.jpg", date: "2026-10-01T12:00:00Z", dateSource: "selected" as const, labels: ["home"]};
    await annotations.queueLocalAnnotations(identity, local);
    await annotations.cacheAnnotations(signed(1, {labels: ["home"], caption: "remote caption"}), photoId);
    await annotations.resolveAnnotationConflict(photoId, "remote");
    assert.equal(await annotations.queueLocalAnnotations(identity, local, requireVault(), false), false);
    await annotations.queueLocalAnnotations(identity, {...local, labels: []}, requireVault(), false);
    const value = (await annotations.readAnnotations(identity))?.value;
    assert.deepEqual(value?.labels, []);
    assert.equal(value?.caption, "remote caption");
  } finally {await clean();}
});

test("hex digests retained by local search bind to base64url original digests in account sync", async () => {
  await open();
  try {
    const hex = "00".repeat(32);
    const local = {id: hex, digest: hex, filename: "local.png", date: "2026-10-01T12:00:00Z", dateSource: "selected" as const, labels: ["family"], ocr: {photoID: hex, revision: hex, status: "complete" as const, processor: localProcessor, text: "Photo text", confidence: 0.8}};
    assert.equal(await annotations.queueLocalAnnotations(identity, local), true);
    const value = (await annotations.readAnnotations(identity))?.value;
    assert.deepEqual(value?.labels, ["family"]);
    assert.equal(value?.ocr?.text, "Photo text");
    assert.equal(local.digest, hex);
  } finally {await clean();}
});


test("an obsolete local OCR processor or source revision cannot enter account annotations", async () => {
  await open();
  try {
    const source = {id: "local", digest: originalSha256, filename: "local.png", date: "2026-10-01T12:00:00Z", dateSource: "selected" as const, labels: ["family"]};
    await annotations.queueLocalAnnotations(identity, {...source, ocr: {photoID: "local", revision: originalSha256, status: "complete", processor: "obsolete", text: "Outdated words", confidence: 0.8}});
    assert.equal((await annotations.readAnnotations(identity))?.value.ocr, undefined);
    await annotations.queueLocalAnnotations(identity, {...source, ocr: {photoID: "local", revision: "wrong-original", status: "complete", processor: localProcessor, text: "Unrelated words", confidence: 0.8}});
    assert.equal((await annotations.readAnnotations(identity))?.value.ocr, undefined);
  } finally {await clean();}
});

test("a delayed changes page cannot roll annotation cache back after a concurrent flush receipt", async () => {
  const session = await open();
  const originalGet = IDBObjectStore.prototype.get;
  let release!: () => void, began!: () => void;
  const paused = new Promise<void>(resolve => {began = resolve;});
  try {
    await annotations.cacheAnnotations(signed(1, {labels: ["old"]}), photoId);
    const oldPayload = (await annotations.readAnnotations(identity))!.signed;
    let pauseNext = true;
    IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
      const request = originalGet.call(this, key);
      if (this.name !== "settings" || key !== owner + ":annotation:" + photoId || !pauseNext) return request;
      pauseNext = false;
      return new Proxy(request, {
        get(target, field) {return Reflect.get(target, field, target);},
        set(target, field, value) {
          if (field === "onsuccess") {target.onsuccess = () => {began(); release = () => value.call(target);}; return true;}
          return Reflect.set(target, field, value, target);
        },
      });
    };
    const page = applyChanges({version: 1, changes: [{cursor: "1", entity: "annotation", entityId: photoId, deleted: false, payload: oldPayload}], nextCursor: "next", hasMore: false}, session);
    await paused;
    const receipt = annotations.cacheAnnotations(signed(2, {labels: ["new"]}), photoId, session);
    await Promise.race([receipt, new Promise(resolve => setTimeout(resolve, 15))]);
    release(); await Promise.all([page, receipt]);
    assert.equal((await annotations.readAnnotations(identity))?.revision, 2);
    assert.deepEqual((await annotations.readAnnotations(identity))?.value.labels, ["new"]);
  } finally {IDBObjectStore.prototype.get = originalGet; await clean();}
});

test("multiple annotation changes in one page keep the highest revision even when ordered newest first", async () => {
  const session = await open();
  try {
    await applyChanges({version: 1, changes: [{cursor: "2", entity: "annotation", entityId: photoId, deleted: false, payload: signed(2, {labels: ["new"]})}, {cursor: "1", entity: "annotation", entityId: photoId, deleted: false, payload: signed(1, {labels: ["old"]})}], nextCursor: "next", hasMore: false}, session);
    assert.equal((await annotations.readAnnotations(identity))?.revision, 2);
  } finally {await clean();}
});

test("People and cloud observations serialize into latest encrypted facts without changing captions or OCR", async () => {
  await open();
  try {
    const session = requireVault();
    const observation = {version: 1 as const, photoId, sourceRevision: originalSha256, processor: "gemini-3.8-flash" as const, observedAt: "2026-10-06T12:00:00.000Z", observations: {objects: ["red bicycle"], scene: ["park"], visibleText: "Cafe", uncertainty: ["possibly evening"]}};
    await annotations.queueAnnotations(identity, {facts: ["Exact supplied fact"], caption: "my caption", ocr: {processor: localProcessor, text: "LOCAL OCR", confidence: .8}}, session);
    const naming = annotations.queuePhotoPeople(identity, [{personId: crypto.randomUUID(), name: "Ronald", box: [100, 100, 1000, 1000]}], session);
    const observing = annotations.queuePhotoObservation(identity, observation, session);
    await Promise.all([naming, observing]);
    const value = (await annotations.readAnnotations(identity, session))!.value;
    assert.equal(value.facts?.[0], "Exact supplied fact");
    assert.deepEqual(peopleNames(value.facts, originalSha256), ["Ronald"]);
    assert.deepEqual(annotationObservation(value, observation), observation);
    assert.equal(value.caption, "my caption"); assert.equal(value.ocr?.text, "LOCAL OCR");
    await assert.rejects(annotations.queuePhotoObservation(identity, {...observation, sourceRevision: "wrong"}, session), /source changed/);
    assert.deepEqual((await annotations.readAnnotations(identity, session))!.value, value);
  } finally {await clean();}
});
test("saving selected local observations and names rebinds only matching original evidence", async () => {
  await open();
  try {
    const digest = "00".repeat(32), id = digest;
    const observation = {version: 1 as const, photoId: id, sourceRevision: digest, processor: "gemini-3.8-flash" as const, observedAt: "2026-10-06T12:00:00.000Z", observations: {objects: ["bicycle"], scene: [], visibleText: "", uncertainty: []}};
    const facts = factsWithPeople(withPhotoObservation({facts: ["Mine"]}, observation).facts, digest, [{personId: crypto.randomUUID(), name: "Maya", box: [0, 0, 1000, 1000]}]);
    await annotations.queueLocalAnnotations(identity, {id, digest, facts, filename: "photo.jpg", date: "2026-10-06T12:00:00Z", dateSource: "selected"});
    const value = (await annotations.readAnnotations(identity))!.value;
    assert.deepEqual(annotationObservation(value, {photoId, sourceRevision: originalSha256}), {...observation, photoId, sourceRevision: originalSha256});
    assert.deepEqual(peopleNames(value.facts, originalSha256), ["Maya"]);
  } finally {await clean();}
});

test("local cloud and People deltas preserve newer account categories and supplied facts; explicit removals affect only their category", async () => {
  await open();
  try {
    const session = requireVault();
    const local = {id:"local",digest:originalSha256,filename:"sample.jpg",date:"2026-10-06T12:00:00Z",dateSource:"selected" as const};
    const observation = {version:1 as const,photoId:local.id,sourceRevision:local.digest,processor:"gemini-3.8-flash" as const,observedAt:"2026-10-06T12:00:00.000Z",observations:{objects:["dog"],scene:[],visibleText:"",uncertainty:[]}};
    const accountObservation = {...observation,photoId,observations:{...observation.observations,objects:["cat"]}};
    const gps = {latitude:41.9,longitude:12.49,source:"exif" as const};
    const originalName = {personId:crypto.randomUUID(),name:"Maya",box:[0,0,1000,1000] as [number,number,number,number]};
    const changedName = {...originalName,name:"Ronald"};
    await annotations.queueLocalAnnotations(identity,local,session);
    await annotations.queueAnnotations(identity,{facts:withAnnotationLocation({facts:["Newest account supplied fact"]},gps).facts,caption:"My caption"},session);
    await annotations.queuePhotoPeople(identity,[originalName],session);
    let localFacts = withPhotoObservation({facts:[] as string[]},observation).facts;
    await annotations.queueLocalAnnotations(identity,{...local,facts:localFacts},session,false);
    let value = (await annotations.readAnnotations(identity,session))!.value;
    assert.equal(value.facts?.[0],"Newest account supplied fact"); assert.deepEqual(annotationLocation(value),gps);
    assert.deepEqual(peopleNames(value.facts,originalSha256),["Maya"]);
    assert.deepEqual(annotationObservation(value,{photoId,sourceRevision:originalSha256}),{...observation,photoId});
    await annotations.queuePhotoObservation(identity,accountObservation,session);
    localFacts = factsWithPeople(localFacts,local.digest,[changedName]);
    await annotations.queueLocalAnnotations(identity,{...local,facts:localFacts},session,false);
    value = (await annotations.readAnnotations(identity,session))!.value;
    assert.deepEqual(peopleNames(value.facts,originalSha256),["Ronald"]);
    assert.deepEqual(annotationObservation(value,{photoId,sourceRevision:originalSha256}),accountObservation);
    assert.equal(value.facts?.[0],"Newest account supplied fact"); assert.equal(value.caption,"My caption"); assert.deepEqual(annotationLocation(value),gps);
    localFacts = factsWithPeople(localFacts,local.digest,[]);
    await annotations.queueLocalAnnotations(identity,{...local,facts:localFacts},session,false);
    value = (await annotations.readAnnotations(identity,session))!.value;
    assert.deepEqual(peopleNames(value.facts,originalSha256),[]); assert.deepEqual(annotationObservation(value,{photoId,sourceRevision:originalSha256}),accountObservation);
    localFacts = withPhotoObservation({facts:localFacts},undefined).facts;
    await annotations.queueLocalAnnotations(identity,{...local,facts:localFacts},session,false);
    value = (await annotations.readAnnotations(identity,session))!.value;
    assert.equal(annotationObservation(value,{photoId,sourceRevision:originalSha256}),undefined);
    assert.equal(value.facts?.[0],"Newest account supplied fact"); assert.deepEqual(annotationLocation(value),gps);
  } finally {await clean();}
});


test("facts merge categories independently, preserving deletions and conservative conflicts", () => {
  const people = "fotoro:people-source:v1:base", location = "fotoro.location.v1:base";
  const base = ["supplied", people, location];
  const remote = ["supplied", people, "fotoro.location.v1:remote", "fotoro.capture.v1:new"];
  const independent = annotations.mergeAnnotationFacts(base, ["supplied", location], remote);
  assert.equal(independent.conflict, false);
  assert.deepEqual(independent.value, ["supplied", "fotoro.location.v1:remote", "fotoro.capture.v1:new"]);
  const collision = annotations.mergeAnnotationFacts(base, ["supplied", "fotoro:people-source:v1:mine", location], ["remote supplied", "fotoro:people-source:v1:theirs", "fotoro.location.v1:remote"]);
  assert.equal(collision.conflict, true);
  assert.deepEqual(collision.value, ["remote supplied", "fotoro:people-source:v1:mine", "fotoro.location.v1:remote"]);
  assert.equal(annotations.mergeAnnotationFacts(["unknown"], [], ["changed unknown"]).conflict, true);
});

test("encrypted revision rebase and local conflict choice retain unrelated remote fact categories", async () => {
  for (const collision of [false, true]) {
    await open(); const old = globalThis.fetch;
    try {
      const baseFacts = ["supplied", "fotoro:people-source:v1:base", "fotoro.location.v1:base"];
      await annotations.cacheAnnotations(signed(1, {facts: baseFacts}), photoId);
      await annotations.queueAnnotations(identity, {facts: ["supplied", "fotoro:people-source:v1:mine", "fotoro.location.v1:base"]});
      const remoteFacts = ["supplied", collision ? "fotoro:people-source:v1:theirs" : "fotoro:people-source:v1:base", "fotoro.location.v1:remote"];
      const remote = signed(2, {facts: remoteFacts});
      let writes = 0;
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        if (init.method !== "PUT") return reply({version: 1, annotations: remote});
        if (++writes === 1) return new Response(JSON.stringify({code: "VERSION_CONFLICT", retryable: false}), {status: 409});
        const outgoing = JSON.parse(init.body as string);
        assert.deepEqual(annotations.verifyAnnotations(outgoing, identity).value.facts, ["supplied", "fotoro:people-source:v1:mine", "fotoro.location.v1:remote"]);
        return reply(outgoing);
      }) as any;
      await annotations.flushAnnotations();
      if (collision) {
        assert.equal((await annotations.pendingAnnotations())[0].conflict, true);
        await annotations.resolveAnnotationConflict(photoId, "local");
        await annotations.flushAnnotations();
      }
      assert.equal(writes, 2);
      assert.equal((await annotations.pendingAnnotations()).length, 0);
    } finally {globalThis.fetch = old; await clean();}
  }
});

test("remote conflict choice keeps independent local fact edits and explicit deletion", async () => {
  for (const removeLocation of [false, true]) {
    await open(); const old = globalThis.fetch;
    try {
      await annotations.cacheAnnotations(signed(1, {facts: ["base supplied", "fotoro.location.v1:base"]}), photoId);
      await annotations.queueAnnotations(identity, {facts: ["mine supplied", ...(removeLocation ? [] : ["fotoro.location.v1:mine"])]});
      const remote = signed(2, {facts: ["remote supplied", "fotoro.location.v1:base", "fotoro:people-source:v1:remote"]});
      globalThis.fetch = (async (_url: unknown, init: RequestInit) => init.method === "PUT"
        ? new Response(JSON.stringify({code: "VERSION_CONFLICT", retryable: false}), {status: 409})
        : reply({version: 1, annotations: remote})) as any;
      await annotations.flushAnnotations();
      assert.equal((await annotations.pendingAnnotations())[0].conflict, true);
      await annotations.resolveAnnotationConflict(photoId, "remote");
      const pending = (await annotations.pendingAnnotations())[0];
      assert.ok(pending, "Independent local category remains queued");
      assert.equal(pending.conflict, false);
      assert.deepEqual((await annotations.readAnnotations(identity))?.value.facts, ["remote supplied", "fotoro:people-source:v1:remote", ...(removeLocation ? [] : ["fotoro.location.v1:mine"])]);
      assert.equal(annotations.verifyAnnotations(pending.signed, identity).revision, 3);
    } finally {globalThis.fetch = old; await clean();}
  }
});

test("remote conflict choice preserves independent non-facts field edits", async () => {
  await open(); const old = globalThis.fetch;
  try {
    await annotations.cacheAnnotations(signed(1, {caption: "base", keywords: ["base keyword"]}), photoId);
    await annotations.queueAnnotations(identity, {caption: "mine", keywords: []});
    const remote = signed(2, {caption: "remote", keywords: ["base keyword"], favorite: true});
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => init.method === "PUT"
      ? new Response(JSON.stringify({code: "VERSION_CONFLICT", retryable: false}), {status: 409})
      : reply({version: 1, annotations: remote})) as any;
    await annotations.flushAnnotations();
    await annotations.resolveAnnotationConflict(photoId, "remote");
    const value = (await annotations.readAnnotations(identity))!.value;
    assert.equal(value.caption, "remote");
    assert.deepEqual(value.keywords, []);
    assert.equal(value.favorite, true);
    assert.equal((await annotations.pendingAnnotations()).length, 1);
  } finally {globalThis.fetch = old; await clean();}
});
