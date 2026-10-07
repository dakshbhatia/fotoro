import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, sodium, unb64, b64, encryptMedia, signPayload, utf8, wrapKey} from "@fotoro/crypto";
import type {MediaBinding, PhotoManifestV1, PhotoMetadataV1, RepresentationV1, SignedPayloadV1} from "@fotoro/contracts";
import {configureVault, unlockVault, lockVault, encryptPrivate, type UnlockedVault} from "../src/vault/vault";
import {atomic, clearAccount, put} from "../src/exchange/cache";
import {cachedCatalog, collect, digest, source} from "../src/library/catalog";
import {cachedSync, readableSyncError} from "../src/exchange/sync";

async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
async function fixture(session: UnlockedVault, objects: Map<string, Uint8Array>, filename = "public-photo.jpg", photoId = crypto.randomUUID(), padding = 0) {
  const representation = async (kind: MediaBinding["kind"], plain: Uint8Array, key: Uint8Array): Promise<RepresentationV1> => {
    const binding: MediaBinding = {version: 1, photoId, representationId: crypto.randomUUID(), kind};
    const bytes = await collect(encryptMedia(source(plain), key, binding)), objectId = crypto.randomUUID(); objects.set(objectId, bytes);
    return {binding, objectId, ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes), header: b64(bytes.subarray(0, 24))};
  };
  const originalKey = sodium.randombytes_buf(32), metadataKey = sodium.randombytes_buf(32), publicBytes = utf8("public fixture bytes");
  const original = await representation("original", publicBytes, originalKey);
  const metadata: PhotoMetadataV1 = {version: 1, filename, mediaType: "image/jpeg", sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalBytes: publicBytes.length, originalSha256: digest(publicBytes), representationKeys: {[original.binding.representationId]: b64(originalKey)}};
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: session.accountId, representations: [original], metadataRepresentation: await representation("metadata", utf8(metadata), metadataKey), ownerWrappedMetadataKey: wrapKey(metadataKey, session.vaultKey)};
  const signed = signPayload("photo-manifest", session.accountId, new TextEncoder().encode(" ".repeat(padding) + JSON.stringify(manifest)), session.signingSecretKey);
  await put("catalog", session.accountId + ":" + photoId, encryptPrivate(signed));
  originalKey.fill(0); metadataKey.fill(0);
  return {manifest, signed, metadata};
}
function spies() {
  const names = ["crypto_secretbox_open_easy", "crypto_sign_verify_detached", "crypto_secretstream_xchacha20poly1305_pull"] as const;
  const originals = names.map(name => sodium[name]);
  const counts = Object.fromEntries(names.map(name => [name, 0])) as Record<typeof names[number], number>;
  names.forEach((name, index) => {(sodium as any)[name] = (...args: any[]) => {counts[name]++; return (originals[index] as any)(...args);};});
  return {counts, reset() {names.forEach(name => {counts[name] = 0;});}, restore() {names.forEach((name, index) => {(sodium as any)[name] = originals[index];});}};
}

test("unchanged recent-window refresh reuses verified catalog and metadata crypto while annotations stay fresh and retryable", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const item = await fixture(session, objects);
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {requests++; const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; const bytes = objects.get(id); assert.ok(bytes); return new Response(new Uint8Array(bytes));}) as typeof fetch;
  const instrumentation = spies();
  try {
    const [first] = (await cachedSync(session)).photos;
    assert.ok(instrumentation.counts.crypto_secretbox_open_easy > 0);
    assert.ok(instrumentation.counts.crypto_sign_verify_detached > 0);
    assert.ok(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull > 0);
    assert.equal(requests, 1);
    instrumentation.reset();
    const [second] = (await cachedSync(session)).photos;
    assert.equal(second.metadata.filename, item.metadata.filename);
    assert.equal(requests, 1);
    assert.deepEqual(instrumentation.counts, {crypto_secretbox_open_easy: 0, crypto_sign_verify_detached: 0, crypto_secretstream_xchacha20poly1305_pull: 0});
    assert.deepEqual(first.metadataKey, second.metadataKey);
    first.metadataKey.fill(0);
    assert.ok(second.metadataKey.some(byte => byte !== 0), "Gallery-held keys are independent of cache and previous consumers");

    const annotationKey = session.accountId + ":annotation:" + item.manifest.photoId;
    const annotation = (caption: string): SignedPayloadV1 => signPayload("photo-annotations", session.accountId, utf8({version: 1, photoId: item.manifest.photoId, revision: 1, encrypted: encryptPrivate({version: 1, photoId: item.manifest.photoId, originalSha256: item.metadata.originalSha256, caption})}), session.signingSecretKey);
    await put("settings", annotationKey, encryptPrivate(annotation("public caption")));
    assert.equal((await cachedCatalog())[0].annotations?.caption, "public caption");
    await put("settings", annotationKey, encryptPrivate({invalid: true}));
    await assert.rejects(cachedCatalog());
    await put("settings", annotationKey, encryptPrivate(annotation("updated public caption")));
    assert.equal((await cachedCatalog())[0].annotations?.caption, "updated public caption");
    await atomic([{store: "settings", key: annotationKey}]);
    assert.equal((await cachedCatalog())[0].annotations, undefined);
    assert.equal(requests, 1, "Annotation updates and failures cannot refetch or replace unchanged metadata");
  } finally {instrumentation.restore(); globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("changed wrapped manifests reverify and revisit metadata; a fresh same-account vault and account switch invalidate reuse", async () => {
  await ready; const oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  const session = await open(0); await clearAccount(session.accountId);
  const first = await fixture(session, objects);
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {requests++; const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; const bytes = objects.get(id); assert.ok(bytes); return new Response(new Uint8Array(bytes));}) as typeof fetch;
  const instrumentation = spies();
  try {
    await cachedCatalog();
    await put("catalog", session.accountId + ":" + first.manifest.photoId, encryptPrivate(first.signed));
    instrumentation.reset(); await cachedCatalog();
    assert.ok(instrumentation.counts.crypto_secretbox_open_easy > 0);
    assert.ok(instrumentation.counts.crypto_sign_verify_detached > 0, "Even an equivalent newly wrapped record must be verified");
    assert.equal(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull, 0);
    const changed = await fixture(session, objects, "new-public-photo.jpg", first.manifest.photoId);
    instrumentation.reset(); const [updated] = await cachedCatalog();
    assert.equal(updated.metadata.filename, changed.metadata.filename);
    assert.ok(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull > 0);
    assert.equal(requests, 2);
    lockVault(); const renewed = await open(0); assert.notEqual(renewed, session);
    instrumentation.reset(); await cachedCatalog();
    assert.ok(instrumentation.counts.crypto_sign_verify_detached > 0);
    assert.ok(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull > 0, "A same-account fresh unlock must rebuild its scoped plaintext cache");
    const other = await open(1); await clearAccount(other.accountId);
    const theirs = await fixture(other, objects, "other-account.jpg");
    assert.deepEqual((await cachedCatalog()).map(photo => photo.manifest.photoId), [theirs.manifest.photoId]);
    await open(0); instrumentation.reset();
    assert.equal((await cachedCatalog())[0].metadata.filename, "new-public-photo.jpg");
    assert.ok(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull > 0);
  } finally {instrumentation.restore(); globalThis.fetch = oldFetch; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
});

test("a blocked local cache upgrade has an actionable retry message", () => {
  assert.equal(readableSyncError(new Error("CACHE_UPDATE_REQUIRES_RELOAD")), "Close other Fotoro tabs, then try again here.");
});

test("bounded hydration evicts metadata without damaging current gallery keys or hiding older history", {timeout: 15000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  try {
    for (let n = 0; n < 64; n++) await fixture(session, objects, "public-" + n + ".jpg", crypto.randomUUID(), 65536);
    globalThis.fetch = (async (input: string | URL | Request) => {const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; const bytes = objects.get(id); assert.ok(bytes); return new Response(new Uint8Array(bytes));}) as typeof fetch;
    const allPhotos = await cachedCatalog();
    assert.equal(allPhotos.length, 64, "A bounded in-memory cache must still return the complete stored catalog");
    assert.ok(allPhotos.every(photo => photo.metadataKey.some(byte => byte !== 0)), "Eviction cannot zero keys published to current consumers");
    const instrumentation = spies();
    try {
      const refreshed = await cachedCatalog();
      assert.equal(refreshed.length, 64);
      assert.ok(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull > 0, "A catalog larger than the metadata budget must revisit evicted metadata");
      assert.ok(refreshed.every(photo => photo.metadataKey.some(byte => byte !== 0)));
    } finally {instrumentation.restore();}
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("a catalog source replaced during metadata await cannot publish or seed a stale cache", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const item = await fixture(session, objects);
  let release!: (response: Response) => void, entered!: () => void;
  const began = new Promise<void>(resolve => {entered = resolve;});
  globalThis.fetch = (async () => {entered(); return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
  try {
    const pending = cachedCatalog(); const rejected = assert.rejects(pending, /CATALOG_SOURCE_CHANGED/);
    await began;
    const changed = await fixture(session, objects, "fresh-public-photo.jpg", item.manifest.photoId);
    release(new Response(new Uint8Array(objects.get(item.manifest.metadataRepresentation.objectId)!)));
    await rejected;
    globalThis.fetch = (async (input: string | URL | Request) => {const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; return new Response(new Uint8Array(objects.get(id)!));}) as typeof fetch;
    assert.equal((await cachedCatalog())[0].metadata.filename, changed.metadata.filename);
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});
