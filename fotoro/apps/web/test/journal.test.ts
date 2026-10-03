import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { ready, unb64, wrapKey, b64 } from "@fotoro/crypto";
import accounts from "../../../fixtures/accounts.json";
import { atomic, get, put, cacheCipher, clearAccount } from "../src/exchange/cache";
import { validateSource, sourceMatches, stageImport, pendingImports, resumePendingImports, type PendingImport } from "../src/exchange/journal";
import { digest } from "../src/library/catalog";
import {configureVault, unlockVault, lockVault, requireVault, encryptPrivate} from "../src/vault/vault";

const owner = "55555555-5555-4555-8555-555555555555", other = "66666666-6666-4666-8666-666666666666";
async function open(accountId = owner) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
function reselect(bytes: Uint8Array): PendingImport {
  const session = requireVault(), operationId = crypto.randomUUID();
  return {operationId, photoId: crypto.randomUUID(), stagingKeys: [session.accountId + ":" + operationId + ":" + crypto.randomUUID()], sourceFilename: "public-fixture.jpg", sourceDigest: digest(bytes), state: "failed", parts: [], wrapped: wrapKey(new Uint8Array(32), session.vaultKey)};
}
test("original format and size boundary are explicit", () => {
  assert.throws(
    () => validateSource({ type: "image/heic", size: 1 }),
    /JPEG_AND_PNG/,
  );
  assert.throws(
    () => validateSource({ type: "image/png", size: 50 * 1024 * 1024 + 1 }),
    /50_MIB/,
  );
  validateSource({ type: "image/jpeg", size: 50 * 1024 * 1024 });
});
test("read eviction does not remove uncommitted staging or change journal state", async () => {
  await put("staging", "test:pending", new Uint8Array([1]));
  await put("journal", "test:op", { state: "queued" });
  await cacheCipher("old", new Uint8Array(60 * 1024 * 1024));
  await cacheCipher("new", new Uint8Array(60 * 1024 * 1024));
  assert.equal(await get("read", "old"), undefined);
  assert.deepEqual(await get("staging", "test:pending"), new Uint8Array([1]));
  assert.deepEqual(await get("journal", "test:op"), { state: "queued" });
});
test("source re-selection matches actual digest rather than filename", async () => {
  await ready;
  const original = new File([new Uint8Array([1, 2, 3])], "same.jpg", {
    type: "image/jpeg",
  });
  const pending = { sourceDigest: digest(new Uint8Array([1, 2, 3])) } as any;
  assert.equal(await sourceMatches(original, pending), true);
  assert.equal(
    await sourceMatches(new File([new Uint8Array([4])], "same.jpg"), pending),
    false,
  );
});
test("a delayed original reselection cannot resume into a newly opened account", async () => {
  await open();
  const bytes = new Uint8Array([255, 216, 1]), pending = reselect(bytes), file = new File([bytes], "public-fixture.jpg", {type: "image/jpeg"});
  let release!: (value: ArrayBuffer) => void, began!: () => void, reads = 0;
  const started = new Promise<void>(resolve => {began = resolve;});
  file.arrayBuffer = async () => {reads++; if (reads > 1) return bytes.buffer; began(); return new Promise(resolve => {release = resolve;});};
  await put("staging", pending.stagingKeys[0], bytes);
  const preparing = stageImport(file, pending), rejected = assert.rejects(preparing, /VAULT_LOCKED/);
  try {
    await started; const newer = await open(other); release(bytes.buffer); await rejected;
    assert.equal(reads, 1, "The withdrawn account's original must not be prepared again");
    assert.equal(requireVault(), newer);
    assert.deepEqual(await get("staging", pending.stagingKeys[0]), bytes);
    assert.equal(await get("journal", other + ":" + pending.operationId), undefined);
  } finally {lockVault(); await clearAccount(owner); await clearAccount(other);}
});
test("reselection cannot delete staging owned by another account or another import", async () => {
  await open();
  const bytes = new Uint8Array([255, 216, 1]), pending = reselect(bytes), file = new File([bytes], "public-fixture.jpg", {type: "image/jpeg"});
  let reads = 0; file.arrayBuffer = async () => {reads++; return bytes.buffer;};
  try {
    for (const key of [other + ":" + pending.operationId + ":old", owner + ":" + crypto.randomUUID() + ":old"]) {
      await put("staging", key, bytes);
      await assert.rejects(stageImport(file, {...pending, stagingKeys: [key]}), /RESELECT_ACCOUNT_MISMATCH/);
      assert.deepEqual(await get("staging", key), bytes);
    }
    assert.equal(reads, 0);
  } finally {lockVault(); await clearAccount(owner); await clearAccount(other);}
});
test("a rejected upload commit cannot poison the durable retry with an unverified receipt", async () => {
  const oldFetch = globalThis.fetch;
  try {
    for (const alteration of ["digest", "length", "uploadId"]) {
      await clearAccount(owner); await open();
      const bytes = new Uint8Array(64), pending = reselect(bytes), uploadId = crypto.randomUUID(), objectId = crypto.randomUUID();
      const part = (kind: "original" | "metadata", id: string) => {
        const representationId = crypto.randomUUID();
        return {binding: {version: 1 as const, photoId: pending.photoId, representationId, kind}, header: b64(bytes.subarray(0, 24)), ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes), uploadOperation: crypto.randomUUID(), reservation: {version: 1 as const, uploadId: id, photoId: pending.photoId, representationId, stagingUrl: "https://fotoro.cloud/v1/uploads/" + id + "/staging?cap=public-fixture", expiresAt: new Date(Date.now() + 60_000).toISOString()}};
      };
      const original = part("original", uploadId), metadata = part("metadata", crypto.randomUUID());
      const valid = {version: 1, uploadId, objectId, ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes)};
      pending.parts = [original, {...metadata, commit: {...valid, uploadId: metadata.reservation.uploadId, objectId: crypto.randomUUID()}}];
      await atomic([{store: "staging", key: pending.stagingKeys[0], value: bytes}, {store: "journal", key: owner + ":" + pending.operationId, value: encryptPrivate(pending)}]);
      let commits = 0, photos = 0;
      globalThis.fetch = (async (path, init) => {
        if (String(path).endsWith("/commit")) {
          assert.equal(path, "/v1/uploads/" + uploadId + "/commit"); commits++;
          const receipt = commits > 1 ? valid : {...valid, ...(alteration === "digest" ? {ciphertextSha256: "A".repeat(43)} : alteration === "length" ? {ciphertextBytes: bytes.length + 1} : {uploadId: crypto.randomUUID()})};
          return new Response(JSON.stringify(receipt));
        }
        assert.equal(path, "/v1/photos"); photos++;
        return new Response(new TextDecoder().decode(unb64(JSON.parse(init!.body as string).body)));
      }) as typeof fetch;
      await resumePendingImports();
      const failed = (await pendingImports())[0];
      assert.equal(failed.state, "failed", alteration); assert.equal(failed.parts[0].commit, undefined, alteration); assert.equal(photos, 0, alteration);
      await resumePendingImports();
      assert.equal(commits, 2, alteration); assert.equal(photos, 1, alteration);
      assert.equal((await pendingImports())[0].state, "committed", alteration);
      assert.equal(await get("staging", pending.stagingKeys[0]), undefined, alteration);
    }
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(owner);}
});
test("failed structured-clone staging writes abort atomically", async () => {
  await assert.rejects(
    atomic([
      { store: "staging", key: "partial", value: new Uint8Array([1]) },
      { store: "journal", key: "invalid", value: () => 0 },
    ]),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await get("staging", "partial"), undefined);
});
test("quota failure cannot persist partial staging or a complete journal", async () => {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
    if (this.name === "journal")
      throw new DOMException("quota", "QuotaExceededError");
    return original.call(this, value, key);
  } as any;
  try {
    await assert.rejects(
      atomic([
        { store: "staging", key: "quota-part", value: new Uint8Array([1]) },
        { store: "journal", key: "quota-op", value: { state: "committed" } },
      ]),
      /quota/,
    );
    assert.equal(await get("staging", "quota-part"), undefined);
    assert.equal(await get("journal", "quota-op"), undefined);
  } finally {
    IDBObjectStore.prototype.put = original;
  }
});
