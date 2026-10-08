import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, signPayload, unb64, utf8} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault, encryptPrivate} from "../src/vault/vault";
import {all, clearAccount} from "../src/exchange/cache";
import {cacheAnnotations, queueAnnotations, readAnnotations} from "../src/exchange/annotations";
import {annotationCaptureMetadata} from "@fotoro/contracts/capture-metadata";
test("encrypted annotation edits preserve native capture and unknown future facts without expanding the wire", async () => {
  await ready;
  const card = {...accounts.accounts[0], accountId: "11111111-1111-4111-8111-111111111111"}, secret = accounts.testSecrets[0], photoId = "a1672cf8-cc9b-44a5-9992-5508a40b36bc", originalSha256 = "A".repeat(43);
  const facts = ["My exact fact", "fotoro.capture.v1:source:" + originalSha256,
    'fotoro.capture.v1:item:{"k":"cameraModel","p":"original","v":"Public Camera"}', "fotoro.capture.v2:opaque future value"];
  const originalFetch = globalThis.fetch;
  configureVault({version: 1, accountCard: card, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  const session = await unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
  globalThis.fetch = (async () => {throw new Error("Annotation edits must remain offline");}) as any;
  try {
    const identity = {ownerAccountId: card.accountId, photoId, originalSha256};
    await cacheAnnotations(signPayload("photo-annotations", card.accountId, utf8({version: 1, photoId, revision: 1,
      encrypted: encryptPrivate({version: 1, photoId, originalSha256, facts, caption: "My exact caption"})}), session.signingSecretKey), photoId);
    assert.equal(await queueAnnotations(identity, {labels: ["My exact label"], favorite: true}, session), true);
    const value = (await readAnnotations(identity, session))!.value;
    assert.deepEqual(value.facts, facts);
    assert.equal(value.caption, "My exact caption");
    assert.deepEqual(value.labels, ["My exact label"]);
    assert.equal(annotationCaptureMetadata(value, originalSha256)?.items[0].v, "Public Camera");
    assert.equal(Object.hasOwn(value, "captureMetadata"), false);
    assert.doesNotMatch(JSON.stringify(await all("settings")), /Public Camera|fotoro\.capture|My exact caption/);
  } finally {globalThis.fetch = originalFetch; await clearAccount(card.accountId); lockVault();}
});
