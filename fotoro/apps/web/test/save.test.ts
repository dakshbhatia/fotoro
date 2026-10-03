import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64, signPayload, utf8 } from "@fotoro/crypto";
import {
  configureVault,
  unlockVault,
  encryptPrivate,
  lockVault,
} from "../src/vault/vault";
import { put } from "../src/exchange/cache";
import { saveReceivedPhoto } from "../src/exchange/Exchange";
test("ambiguous save retries exact operation and recipient record; expired failure stays explicit", async () => {
  await ready;
  const account = accounts.accounts[1],
    secret = accounts.testSecrets[1];
  configureVault({
    version: 1,
    accountCard: account,
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: secret.encryptedBundle,
      },
    ],
  } as any);
  const vault = await unlockVault({ kind: "recovery", secret: unb64(secret.recoverySecret) });
  const changes = (await import("../../../fixtures/changes-v1.json")).default;
  const manifest = JSON.parse(new TextDecoder().decode(unb64(changes.changes[0].payload.body)));
  manifest.photoId = crypto.randomUUID();
  manifest.ownerAccountId = account.accountId;
  const request = {
    version: 1,
    expectedGrantVersion: 1,
    save: {
      version: 1,
      operationId: crypto.randomUUID(),
      photoId: manifest.photoId,
      sourceGrantId: crypto.randomUUID(),
      sourcePhotoId: changes.changes[0].entityId,
      manifest,
      signedPayload: signPayload("photo-manifest", account.accountId, utf8(manifest), vault.signingSecretKey),
    },
  };
  const key =
    account.accountId +
    ":" +
    request.save.sourceGrantId +
    ":" +
    request.save.sourcePhotoId;
  await put("saves", key, encryptPrivate(request));
  const old = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_input: any, init: any) => {
    bodies.push(init.body);
    return new Response(
      JSON.stringify({
        version: 1,
        code: "GRANT_INACTIVE",
        retryable: false,
        requestId: crypto.randomUUID(),
      }),
      { status: 403 },
    );
  }) as any;
  try {
    await assert.rejects(
      saveReceivedPhoto(request.save.sourceGrantId, request.save.sourcePhotoId),
      /GRANT_INACTIVE/,
    );
    await assert.rejects(
      saveReceivedPhoto(request.save.sourceGrantId, request.save.sourcePhotoId),
      /GRANT_INACTIVE/,
    );
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(JSON.parse(bodies[0]), request);
  } finally {
    globalThis.fetch = old;
    lockVault();
  }
});
test("successful save retry returns a single stable recipient record", async () => {
  await ready;
  const account = accounts.accounts[1],
    secret = accounts.testSecrets[1];
  configureVault({
    version: 1,
    accountCard: account,
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: secret.encryptedBundle,
      },
    ],
  } as any);
  const v = await unlockVault({
    kind: "recovery",
    secret: unb64(secret.recoverySecret),
  });
  const changes = (await import("../../../fixtures/changes-v1.json")).default;
  const cryptoModule = await import("@fotoro/crypto");
  const manifest = JSON.parse(
    new TextDecoder().decode(unb64(changes.changes[0].payload.body)),
  );
  manifest.photoId = crypto.randomUUID();
  manifest.ownerAccountId = account.accountId;
  const save = {
    version: 1,
    operationId: crypto.randomUUID(),
    photoId: manifest.photoId,
    sourceGrantId: crypto.randomUUID(),
    sourcePhotoId: changes.changes[0].entityId,
    manifest,
    signedPayload: cryptoModule.signPayload(
      "photo-manifest",
      account.accountId,
      cryptoModule.utf8(manifest),
      v.signingSecretKey,
    ),
  };
  const request = { version: 1, expectedGrantVersion: 1, save };
  await put(
    "saves",
    account.accountId + ":" + save.sourceGrantId + ":" + save.sourcePhotoId,
    encryptPrivate(request),
  );
  const records = new Map<string, unknown>();
  const old = globalThis.fetch;
  globalThis.fetch = (async (_input: any, init: any) => {
    const { save } = JSON.parse(init.body);
    if (!records.has(save.operationId)) records.set(save.operationId, save);
    return new Response(JSON.stringify(records.get(save.operationId)), {
      status: 200,
    });
  }) as any;
  try {
    const first = await saveReceivedPhoto(
        save.sourceGrantId,
        save.sourcePhotoId,
      ),
      second = await saveReceivedPhoto(save.sourceGrantId, save.sourcePhotoId);
    assert.equal(records.size, 1);
    assert.equal(first.photoId, second.photoId);
    assert.equal(first.operationId, second.operationId);
  } finally {
    globalThis.fetch = old;
    lockVault();
  }
});
