import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import cases from "../../../fixtures/search/cases.json";
import {ready, signPayload, unb64, utf8} from "@fotoro/crypto";
import {VISUAL_PROCESSOR, VISUAL_PUBLICATION_ENABLED, validatedVisualLabels} from "@fotoro/contracts/visual";
import {configureVault, unlockVault, lockVault, encryptPrivate, requireVault} from "../src/vault/vault";
import {cacheAnnotations, readAnnotations, verifyAnnotations, queueAnnotations, pendingAnnotations, flushAnnotations} from "../src/exchange/annotations";
import {clearAccount, put} from "../src/exchange/cache";
import {cloudSearchRecords} from "../src/library/search";
import {savedSearchPhotos} from "../src/library/consumer-search";
import {PhotoSearchIndex} from "../src/local/search";
import type {Photo} from "../src/library/catalog";

const owner = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";
const digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const identity = {ownerAccountId: owner, photoId, originalSha256: digest};
const visual = {processor: VISUAL_PROCESSOR, labels: [{label: "beach", identifier: "beach", confidence: 0.92}]};
async function open(accountId = owner) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
function signed(fields: object) {
  return signPayload("photo-annotations", owner, utf8({version: 1, photoId, revision: 1,
    encrypted: encryptPrivate({version: 1, photoId, originalSha256: digest, ...fields})}), requireVault().signingSecretKey);
}
function photo(annotations: Photo["annotations"]): Photo {
  return {manifest: {photoId, ownerAccountId: owner}, metadata: {filename: "IMG_001.jpg", sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalSha256: digest, originalBytes: 1}, annotations} as Photo;
}
async function clean() {await clearAccount(owner); lockVault();}

test("web and native share exact visual policy vectors without identity or substring guesses", () => {
  assert.equal(cases.visualPolicy.processor, VISUAL_PROCESSOR);
  assert.equal(cases.visualPolicy.publicationEnabled, VISUAL_PUBLICATION_ENABLED);
  for (const vector of cases.visualPolicy.cases) assert.deepEqual(validatedVisualLabels(vector), vector.expected, vector.name);
  for (const confidence of [NaN, Infinity, -Infinity]) assert.deepEqual(validatedVisualLabels({...visual, labels: [{...visual.labels[0], confidence}]}), []);
});

test("signed native scene sidecar restores fresh browser search, keeping supplied labels separate", async () => {
  await open();
  try {
    await cacheAnnotations(signed({labels: ["My exact family label"], visual}), photoId);
    lockVault(); await open();
    const restored = (await readAnnotations(identity))!.value;
    const source = photo(restored), index = new PhotoSearchIndex(cloudSearchRecords([source]));
    const result = index.search("beach");
    assert.deepEqual(result.photoIds, [photoId]);
    assert.equal(result.meaning?.kind, "visual");
    assert.equal(result.meaning?.id, "visual:beach");
    assert.deepEqual(restored.labels, ["My exact family label"]);
    assert.deepEqual(index.search("my exact family").photoIds, [photoId]);
    const supplied = new PhotoSearchIndex(cloudSearchRecords([photo({...restored, labels: ["beach"]})]));
    assert.equal(supplied.search("beach").meaning?.kind, "label");
    lockVault();
    assert.deepEqual(index.search("beach").photoIds, []);
    await open("22222222-2222-4222-8222-222222222222");
    assert.deepEqual(index.search("beach").photoIds, []);
  } finally {await clean();}
});

test("optional unsupported scenes preserve valid annotation and original identity but never fabricate matches", async () => {
  await open();
  try {
    for (const invalid of [null, "raw category", {processor: VISUAL_PROCESSOR, labels: [{}]},
      {...visual, extra: true}, {...visual, labels: [{...visual.labels[0], confidence: 2}]},
      {...visual, labels: Array(7).fill(visual.labels[0])}]) {
      const verified = verifyAnnotations(signed({labels: ["Keep me"], visual: invalid}), identity).value;
      assert.equal(verified.photoId, photoId); assert.equal(verified.originalSha256, digest);
      assert.deepEqual(verified.labels, ["Keep me"]); assert.equal(verified.visual, undefined);
      const index = new PhotoSearchIndex(cloudSearchRecords([photo(verified)]));
      assert.deepEqual(index.search("keep me").photoIds, [photoId]);
      assert.deepEqual(index.search("IMG_001").photoIds, [photoId]);
      assert.deepEqual(index.search("beach").photoIds, []);
    }
    for (const unsupported of [{...visual, processor: "future-model"}, {...visual, labels: []},
      {...visual, labels: [{label: "Ronald", identifier: "dog", confidence: 1}]}]) {
      const verified = verifyAnnotations(signed({visual: unsupported}), identity).value;
      assert.deepEqual(verified.visual, unsupported);
      assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([photo(verified)])).search("beach").photoIds, []);
      assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([photo(verified)])).search("Ronald").photoIds, []);
    }
    assert.equal(verifyAnnotations(signed({labels: ["old"]}), identity).value.visual, undefined);
    assert.throws(() => verifyAnnotations({...signed({visual: null}), signature: "A".repeat(86)}, identity));
    assert.throws(() => verifyAnnotations(signed({visual: null, originalSha256: "B".repeat(43)}), identity), /DIGEST/);
    assert.throws(() => verifyAnnotations(signed({visual: null, unknown: true}), identity));
  } finally {await clean();}
});

test("source withdrawal, original revision, foreign owner and received grants fence scene matches", async () => {
  await open();
  try {
    const value = verifyAnnotations(signed({visual}), identity).value;
    for (const mutate of [(p: Photo) => {p.metadata.originalSha256 = "B".repeat(43);},
      (p: Photo) => {p.annotations = undefined;}, (p: Photo) => {p.manifest.ownerAccountId = "foreign";},
      (p: Photo) => {p.grantId = "received";}]) {
      const source = photo(value), index = new PhotoSearchIndex(cloudSearchRecords([source]));
      assert.deepEqual(index.search("beach").photoIds, [photoId]);
      mutate(source);
      assert.deepEqual(index.search("beach").photoIds, []);
      assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([source])).search("beach").photoIds, []);
    }
    const wrongSource = photo({...value, photoId: crypto.randomUUID()});
    assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords([wrongSource])).search("beach").photoIds, []);
  } finally {await clean();}
});

test("Saved adapter rebinds scene identity to its local alias and obeys source scope without retaining fields", async () => {
  await open();
  try {
    let current = true;
    const source = photo(verifyAnnotations(signed({visual}), identity).value);
    const snapshot = {accountId: owner, token: {}, current: () => current, photos: [source], preview: async () => new Blob()};
    const local = {id: "local-alias", digest, file: new File(["public fixture"], "same.jpg"), filename: "same.jpg", date: source.metadata.sourceDate, dateSource: "selected" as const, originalSize: 1};
    const saved = savedSearchPhotos(snapshot, [local]);
    assert.equal(saved[0].visual?.photoID, "local-alias");
    assert.equal(saved[0].visual?.revision, digest);
    assert.equal((local as any).visual, undefined);
    const index = new PhotoSearchIndex(saved);
    assert.deepEqual(index.search("beach").photoIds, ["local-alias"]);
    assert.deepEqual(index.search("beach", {allowedIds: new Set()}).photoIds, []);
    current = false;
    assert.deepEqual(index.search("beach").photoIds, []);
    assert.deepEqual(savedSearchPhotos(snapshot, [local]), []);
  } finally {await clean();}
});

test("released manual writes remain old-reader compatible and future-field frozen retries stay local", async () => {
  await open(); const previousFetch = globalThis.fetch;
  try {
    assert.equal(VISUAL_PUBLICATION_ENABLED, false);
    assert.equal(await queueAnnotations(identity, {visual}), false);
    await queueAnnotations(identity, {labels: ["My exact label"], ocr: {text: "receipt", confidence: 0.9, processor: "vision-text-v1"}, visual});
    const queued = (await pendingAnnotations())[0];
    const update = JSON.parse(new TextDecoder().decode(unb64(queued.signed.body)));
    const raw = (await import("../src/vault/vault")).decryptPrivate<Record<string, unknown>>(update.encrypted);
    const installedAllowed = new Set(["version", "photoId", "originalSha256", "labels", "caption", "keywords", "facts", "favorite", "ocr"]);
    assert.equal(Object.keys(raw).every(key => installedAllowed.has(key)), true);
    assert.deepEqual(raw.labels, ["My exact label"]);
    assert.deepEqual(raw.ocr, {text: "receipt", confidence: 0.9, processor: "vision-text-v1"});
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => new Response(init.body as string, {status: 200})) as any;
    await flushAnnotations();
    const frozen = signed({labels: ["Future manual edit"], visual});
    await put("settings", owner + ":annotation-outbox:" + photoId, encryptPrivate({version: 1, photoId, originalSha256: digest,
      base: {version: 1, photoId, originalSha256: digest}, signed: frozen, patch: {labels: ["Future manual edit"]}, conflict: false}));
    let requests = 0;
    globalThis.fetch = (async () => {requests++; throw new Error("must not publish unsupported fields");}) as any;
    await flushAnnotations();
    assert.equal(requests, 0);
    assert.deepEqual((await pendingAnnotations())[0].signed, frozen);
  } finally {globalThis.fetch = previousFetch; await clean();}
});
