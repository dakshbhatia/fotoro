import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { ready, unb64, wrapKey, b64 } from "@fotoro/crypto";
import accounts from "../../../fixtures/accounts.json";
import { atomic, get, put, cacheCipher, clearAccount } from "../src/exchange/cache";
import { validateSource, sourceMatches, stageImport, pendingImports, resumePendingImports, type PendingImport } from "../src/exchange/journal";
import { digest } from "../src/library/catalog";
import {configureVault, unlockVault, lockVault, requireVault, encryptPrivate} from "../src/vault/vault";
import {readAnnotations, queueAnnotations} from "../src/exchange/annotations";
import {annotationLocation} from "@fotoro/contracts/location";

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
    () => validateSource({ type: "image/gif", size: 1 }),
    /JPEG_PNG_AND_HEIC/,
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

test("committing a GPS original queues account-private location without placing it in the photo manifest", async () => {
  const old = globalThis.fetch; await open();
  try {
    const bytes = new Uint8Array(64), pending = reselect(bytes);
    const location = {latitude: 41.9028, longitude: 12.4964, source: "exif" as const};
    pending.location = location;
    pending.parts = (["original", "metadata"] as const).map(kind => {
      const uploadId = crypto.randomUUID(), representationId = crypto.randomUUID();
      return {binding: {version: 1 as const, photoId: pending.photoId, representationId, kind}, header: b64(bytes.subarray(0, 24)),
        ciphertextBytes: 64, ciphertextSha256: digest(bytes), uploadOperation: crypto.randomUUID(),
        reservation: {version: 1 as const, uploadId, photoId: pending.photoId, representationId, stagingUrl: "https://fotoro.cloud/fixture", expiresAt: "2099-01-01T00:00:00Z"},
        commit: {version: 1 as const, uploadId, objectId: crypto.randomUUID(), ciphertextBytes: 64, ciphertextSha256: digest(bytes)}};
    });
    await put("journal", owner + ":" + pending.operationId, encryptPrivate(pending));
    const identity = {ownerAccountId: owner, photoId: pending.photoId, originalSha256: pending.sourceDigest};
    await queueAnnotations(identity, {facts: ["Previously supplied fact"]});
    globalThis.fetch = (async (path, init) => {
      assert.equal(path, "/v1/photos");
      const manifest = new TextDecoder().decode(unb64(JSON.parse(init!.body as string).body));
      assert.doesNotMatch(manifest, /latitude|41\.9028|fotoro\.location/);
      await queueAnnotations(identity, {facts: ["Newest supplied fact"]});
      return new Response(manifest);
    }) as typeof fetch;
    await resumePendingImports();
    assert.equal((await pendingImports())[0].state, "committed");
    const value = (await readAnnotations(identity))?.value;
    assert.deepEqual(value && annotationLocation(value), location);
    assert.equal(value?.facts?.[0], "Newest supplied fact");
  } finally {globalThis.fetch = old; lockVault(); await clearAccount(owner);}
});

function uploadedPending(bytes: Uint8Array): PendingImport {
  const pending = reselect(bytes);
  pending.parts = (["original", "metadata"] as const).map(kind => {
    const uploadId = crypto.randomUUID(), representationId = crypto.randomUUID();
    return {binding: {version: 1 as const, photoId: pending.photoId, representationId, kind}, header: b64(bytes.subarray(0, 24)),
      ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes), uploadOperation: crypto.randomUUID(),
      reservation: {version: 1 as const, uploadId, photoId: pending.photoId, representationId, stagingUrl: "https://fotoro.cloud/v1/uploads/" + uploadId + "/staging?cap=public-fixture", expiresAt: "2099-01-01T00:00:00Z"},
      commit: {version: 1 as const, uploadId, objectId: crypto.randomUUID(), ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes)}};
  });
  return pending;
}

test("chosen Trip save replays a partial commit with exact IDs and leaves unrelated journal entries unsent", async () => {
  const old = globalThis.fetch; await clearAccount(owner); await open();
  try {
    const {TripImportChoice, saveTripFiles} = await import("../src/albums/import");
    const bytesA = new Uint8Array(64).fill(1), bytesB = new Uint8Array(64).fill(2);
    const files = [new File([bytesA], "chosen-a.jpg"), new File([bytesB], "chosen-b.jpg")];
    const chosen = [uploadedPending(bytesA), uploadedPending(bytesB)], unrelated = uploadedPending(new Uint8Array(64).fill(3));
    unrelated.state = "queued";
    await put("journal", owner + ":" + unrelated.operationId, encryptPrivate(unrelated));
    const publications: string[] = []; let failB = true, stages = 0;
    globalThis.fetch = (async (path, init) => {
      assert.equal(path, "/v1/photos", "Already uploaded originals must reuse verified commit receipts");
      const manifest = new TextDecoder().decode(unb64(JSON.parse(init!.body as string).body)), id = JSON.parse(manifest).photoId;
      assert.notEqual(id, unrelated.photoId, "Adding to a Trip does not authorize an unrelated queued original");
      publications.push(id);
      if (id === chosen[1].photoId && failB) return new Response(JSON.stringify({code: "HTTP_503"}), {status: 503});
      return new Response(manifest);
    }) as typeof fetch;
    await resumePendingImports(undefined, undefined, []); assert.deepEqual(publications, []);
    const choice = new TripImportChoice(files, () => true), options = {
      signal: new AbortController().signal, current: () => true,
      stage: async (file: File) => {
        assert.equal(file, files[stages]); const pending = chosen[stages++];
        await put("journal", owner + ":" + pending.operationId, encryptPrivate(pending));
        return {photoId: pending.photoId, sourceDigest: pending.sourceDigest};
      },
      drain: async (ids: readonly string[]) => resumePendingImports(undefined, undefined, [...ids, ...ids]),
      unresolved: async (ids: readonly string[]) => {const records = await pendingImports(); return ids.some(id => !records.some(item => item.photoId === id && item.state === "committed"));},
      load: async (ids: readonly string[]) => {const records = await pendingImports(); return ids.map(id => {const pending = records.find(item => item.photoId === id)!; assert.equal(pending.state, "committed"); return {manifest: pending.manifest!, metadata: {originalSha256: pending.sourceDigest}} as import("../src/library/catalog").Photo;});},
    };
    await assert.rejects(saveTripFiles(choice, options), /TRIP_SAVE_INCOMPLETE/);
    const partial = await pendingImports();
    assert.equal(partial.find(item => item.photoId === chosen[0].photoId)?.state, "committed");
    assert.equal(partial.find(item => item.photoId === chosen[1].photoId)?.state, "failed");
    failB = false;
    const saved = await saveTripFiles(choice, options);
    assert.deepEqual(saved.map(photo => photo.manifest.photoId), chosen.map(item => item.photoId));
    assert.equal(stages, 2, "Retry must not reimport either chosen original");
    assert.deepEqual(publications, [chosen[0].photoId, chosen[1].photoId, chosen[1].photoId]);
    assert.equal((await pendingImports()).find(item => item.photoId === unrelated.photoId)?.state, "queued", "Unrelated queued journal entry remains untouched");
    choice.cancel();
  } finally {globalThis.fetch = old; lockVault(); await clearAccount(owner);}
});

test("withdrawing a chosen import during multipart upload stops before commit or photo publication", async () => {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  await clearAccount(owner); await open();
  try {
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
    const bytes = new Uint8Array(64), pending = uploadedPending(bytes);
    pending.parts[0].commit = undefined;
    await atomic([{store: "staging", key: pending.stagingKeys[0], value: bytes}, {store: "journal", key: owner + ":" + pending.operationId, value: encryptPrivate(pending)}]);
    let current = true, puts = 0, commits = 0;
    globalThis.fetch = (async (path, init) => {
      if (String(path).endsWith("/commit")) {
        commits++; assert.equal(commits, 1, "Only the prior incomplete commit probe may run");
        return new Response(JSON.stringify({code: "UPLOAD_INCOMPLETE"}), {status: 409});
      }
      assert.equal(init?.method, "PUT"); puts++; current = false;
      return new Response(null, {status: 200});
    }) as typeof fetch;
    await assert.rejects(resumePendingImports(undefined, undefined, [pending.photoId], () => current), {name: "AbortError"});
    assert.equal(puts, 1); assert.equal(commits, 1);
    const retained = (await pendingImports())[0];
    assert.notEqual(retained.state, "committed"); assert.equal(retained.parts[0].commit, undefined);
    assert.deepEqual(await get("staging", pending.stagingKeys[0]), bytes, "Encrypted staging survives cancellation for Saved recovery");
  } finally {globalThis.fetch = oldFetch; Object.defineProperty(globalThis, "location", {configurable: true, value: oldLocation}); lockVault(); await clearAccount(owner);}
});

for (const phase of ["invalid receipt", "uploaded part"] as const) {
  test(`withdrawing a chosen import during ${phase} journal persistence stops the next commit`, async () => {
    const oldFetch = globalThis.fetch, oldLocation = globalThis.location, originalPut = IDBObjectStore.prototype.put;
    await clearAccount(owner); await open();
    try {
      Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
      const bytes = new Uint8Array(64), pending = uploadedPending(bytes);
      if (phase === "invalid receipt") pending.parts[0].commit!.ciphertextSha256 = digest(new Uint8Array([1]));
      else pending.parts[0].commit = undefined;
      await atomic([{store: "staging", key: pending.stagingKeys[0], value: bytes}, {store: "journal", key: owner + ":" + pending.operationId, value: encryptPrivate(pending)}]);
      let current = true, armed = phase === "invalid receipt", writes = 0, commits = 0, uploads = 0;
      IDBObjectStore.prototype.put = function (value: any, key?: IDBValidKey) {
        const request = originalPut.call(this, value, key);
        if (this.name === "journal" && armed) request.addEventListener("success", () => {writes++; current = false;});
        return request;
      } as any;
      globalThis.fetch = (async (path, init) => {
        if (String(path).endsWith("/commit")) {
          commits++; assert.equal(phase, "uploaded part", "A withdrawn receipt repair cannot start a commit probe");
          assert.equal(commits, 1, "Only the prior incomplete commit probe may run");
          return new Response(JSON.stringify({code: "UPLOAD_INCOMPLETE"}), {status: 409});
        }
        assert.equal(init?.method, "PUT"); uploads++; armed = true;
        return new Response(null, {status: 200});
      }) as typeof fetch;
      await assert.rejects(resumePendingImports(undefined, undefined, [pending.photoId], () => current), {name: "AbortError"});
      assert.equal(writes, 1); assert.equal(commits, phase === "uploaded part" ? 1 : 0);
      assert.equal(uploads, phase === "uploaded part" ? 1 : 0);
      assert.notEqual((await pendingImports())[0].state, "committed");
      assert.deepEqual(await get("staging", pending.stagingKeys[0]), bytes);
    } finally {
      IDBObjectStore.prototype.put = originalPut; globalThis.fetch = oldFetch;
      Object.defineProperty(globalThis, "location", {configurable: true, value: oldLocation});
      lockVault(); await clearAccount(owner);
    }
  });
}
