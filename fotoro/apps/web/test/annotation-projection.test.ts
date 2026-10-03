import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {all, clearAccount} from "../src/exchange/cache";
import {queueAnnotations, pendingAnnotations} from "../src/exchange/annotations";
import {projectLocalAnnotations} from "../src/library/annotation-projection";
import type {Photo} from "../src/library/catalog";

const owner = "71111111-1111-4111-8111-111111111111", other = "72222222-2222-4222-8222-222222222222";
const photoId = "73333333-3333-4333-8333-333333333333", digest = "A".repeat(43);
const identity = {ownerAccountId: owner, photoId, originalSha256: digest};
async function open(accountId = owner) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1,
    wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
function photo(): Photo {
  return {manifest: {photoId, ownerAccountId: owner, metadataRepresentation: {objectId: "not-cached"}},
    metadata: {originalSha256: digest}, metadataKey: new Uint8Array(32)} as Photo;
}
async function scoped(run: () => Promise<void>) {
  const fetch = globalThis.fetch;
  await clearAccount(owner); await clearAccount(other);
  try {await run();} finally {globalThis.fetch = fetch; lockVault(); await clearAccount(owner); await clearAccount(other);}
}

test("favorite and label projection preserves other annotations without fetching uncached metadata", async () => scoped(async () => {
  const session = await open(), source = photo();
  let requests = 0;
  globalThis.fetch = (async () => {requests++; throw new Error("Annotation edits must stay local");}) as typeof fetch;
  const supplied = {labels: ["Exact supplied label"], caption: "Exact caption", keywords: ["invoice"], facts: ["paper"],
    favorite: false, ocr: {text: "Original words", confidence: .8, processor: "native-vision-v1"}};
  await queueAnnotations(identity, supplied, session);
  await Promise.all([queueAnnotations(identity, {favorite: true}, session), queueAnnotations(identity, {labels: []}, session)]);
  const [projected] = await projectLocalAnnotations([source], session);
  assert.deepEqual(projected.annotations, {version: 1, photoId, originalSha256: digest, ...supplied, labels: [], favorite: true});
  assert.equal(projected.manifest, source.manifest);
  assert.equal(projected.metadata, source.metadata);
  assert.equal(projected.metadataKey, source.metadataKey);
  assert.equal(source.annotations, undefined, "Projection does not mutate a captured source");
  assert.equal((await pendingAnnotations(session)).length, 1, "Edits remain pending for explicit Save changes");
  assert.equal((await all("read")).length, 0, "Missing representation bytes do not trigger hydration");
  assert.equal(requests, 0);
}));

test("annotation projection rejects received, other-owner and mismatched original sources", async () => scoped(async () => {
  const session = await open(), source = photo();
  globalThis.fetch = (async () => {throw new Error("No source rejection may fetch");}) as typeof fetch;
  await queueAnnotations(identity, {favorite: true}, session);
  await assert.rejects(projectLocalAnnotations([{...source, grantId: "received"}], session), /IDENTITY/);
  await assert.rejects(projectLocalAnnotations([{...source, manifest: {...source.manifest, ownerAccountId: other}}], session), /IDENTITY/);
  await assert.rejects(projectLocalAnnotations([{...source, metadata: {...source.metadata, originalSha256: "B".repeat(43)}}], session), /DIGEST/);
  assert.equal((await pendingAnnotations(session)).length, 1);
}));

test("an account switch during local annotation reads rejects the old projection", async () => scoped(async () => {
  const session = await open();
  await queueAnnotations(identity, {labels: ["Old account"]}, session);
  const projecting = projectLocalAnnotations([photo()], session);
  const rejected = assert.rejects(projecting, /VAULT_LOCKED/);
  lockVault();
  const replacement = await open(other);
  await rejected;
  assert.deepEqual(await pendingAnnotations(replacement), []);
}));
