import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, sodium, unb64, b64, encryptMedia, signPayload, utf8, wrapKey} from "@fotoro/crypto";
import type {MediaBinding, PhotoManifestV1, RepresentationV1, SignedPayloadV1, WrappedKeyV1} from "@fotoro/contracts";
import {configureVault, unlockVault, lockVault, encryptPrivate, decryptPrivate} from "../src/vault/vault";
import {atomic, clearAccount, get} from "../src/exchange/cache";
import {cacheOwnedPhotoDetails, collect, digest, source as chunks} from "../src/library/catalog";
import {queueAnnotations, readAnnotations, pendingAnnotations} from "../src/exchange/annotations";

const owner = "11111111-1111-4111-8111-111111111111";
async function setup() {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId: owner}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  const session = await unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
  await clearAccount(owner);
  const photoId = crypto.randomUUID(), key = sodium.randombytes_buf(32);
  async function rep(kind: MediaBinding["kind"]): Promise<RepresentationV1> {
    const binding: MediaBinding = {version: 1, photoId, representationId: crypto.randomUUID(), kind};
    const bytes = await collect(encryptMedia(chunks(utf8("public fixture")), key, binding));
    return {binding, objectId: crypto.randomUUID(), ciphertextBytes: bytes.length, ciphertextSha256: digest(bytes), header: b64(bytes.subarray(0, 24))};
  }
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: owner, representations: [await rep("original")], metadataRepresentation: await rep("metadata"), ownerWrappedMetadataKey: wrapKey(key, session.vaultKey)};
  key.fill(0);
  const identity = {ownerAccountId: owner, photoId, originalSha256: digest(utf8("public original"))};
  const source = {...identity, manifest};
  const signedManifest = (value = manifest, kind = "photo-manifest", accountId = owner) => signPayload(kind, accountId, utf8(value), session.signingSecretKey);
  const annotation = (revision = 1, caption = "remote public caption", originalSha256 = identity.originalSha256) => signPayload("photo-annotations", owner, utf8({version: 1, photoId, revision, encrypted: encryptPrivate({version: 1, photoId, originalSha256, caption})}), session.signingSecretKey);
  const oldFetch = globalThis.fetch, calls: string[] = [];
  let signed = signedManifest(), annotations: SignedPayloadV1 | null = annotation(), intercept: (() => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); calls.push(path);
    assert.equal(init?.method, "GET");
    assert.ok(path === `/v1/photos/${photoId}/manifest` || path === `/v1/photos/${photoId}/annotations`, "Only this photo's two signed records may be fetched");
    if (path.endsWith("/annotations")) intercept?.();
    return new Response(JSON.stringify(path.endsWith("/manifest") ? signed : {version: 1, annotations}));
  }) as typeof fetch;
  return {source, identity, signedManifest, annotation, calls,
    manifest: (value: SignedPayloadV1) => {signed = value;}, annotations: (value: SignedPayloadV1 | null) => {annotations = value;}, intercept: (value: () => void) => {intercept = value;},
    async clean() {globalThis.fetch = oldFetch; lockVault(); await clearAccount(owner);}};
}

test("one owned source reads only two signed records, preserves queued edits and rejects revision rollback", async () => {
  const f = await setup();
  try {
    await queueAnnotations(f.identity, {caption: "my queued exact caption"});
    const before = await pendingAnnotations();
    await cacheOwnedPhotoDetails(f.source);
    assert.equal(f.calls.length, 2);
    assert.equal((await readAnnotations(f.identity))?.value.caption, "my queued exact caption");
    assert.deepEqual(await pendingAnnotations(), before);
    assert.deepEqual(decryptPrivate(await get<WrappedKeyV1>("catalog", owner + ":" + f.identity.photoId) as WrappedKeyV1), f.signedManifest());
    assert.equal(await get("settings", owner + ":cursor"), undefined);
    const latest = f.annotation(2, "new remote caption");
    f.annotations(latest); await cacheOwnedPhotoDetails(f.source);
    f.annotations(f.annotation(1)); await cacheOwnedPhotoDetails(f.source);
    const stored = decryptPrivate<SignedPayloadV1>(await get<WrappedKeyV1>("settings", owner + ":annotation:" + f.identity.photoId) as WrappedKeyV1);
    assert.deepEqual(stored, latest);
    assert.deepEqual(await pendingAnnotations(), before);
  } finally {await f.clean();}
});

test("owned details reject owner, ID, kind, immutable source and annotation digest mismatches before cache writes", async () => {
  const f = await setup();
  try {
    await assert.rejects(cacheOwnedPhotoDetails({...f.source, ownerAccountId: accounts.accounts[1].accountId}), /CATALOG_BINDING_MISMATCH/);
    assert.equal(f.calls.length, 0);
    for (const signed of [f.signedManifest(f.source.manifest, "photo-manifest", accounts.accounts[1].accountId), f.signedManifest({...f.source.manifest, photoId: crypto.randomUUID()}), f.signedManifest(f.source.manifest, "photo-annotations"), f.signedManifest({...f.source.manifest, ownerWrappedMetadataKey: {...f.source.manifest.ownerWrappedMetadataKey, nonce: b64(sodium.randombytes_buf(24))}})]) {
      f.manifest(signed); await assert.rejects(cacheOwnedPhotoDetails(f.source));
      assert.equal(await get("catalog", owner + ":" + f.identity.photoId), undefined);
    }
    f.manifest(f.signedManifest()); f.annotations(f.annotation(1, "wrong source", digest(utf8("other public source"))));
    await assert.rejects(cacheOwnedPhotoDetails(f.source), /ANNOTATION_ORIGINAL_DIGEST_MISMATCH/);
    assert.equal(await get("catalog", owner + ":" + f.identity.photoId), undefined);
    assert.equal(await get("settings", owner + ":annotation:" + f.identity.photoId), undefined);
  } finally {await f.clean();}
});

test("owned reads fail closed on cancellation, vault lock, origin change and selected source change", async () => {
  for (const kind of ["abort", "lock", "origin", "source"] as const) {
    const f = await setup(), controller = new AbortController(), originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    if (kind === "origin") Object.defineProperty(globalThis, "location", {value: {origin: "https://public.example"}, configurable: true});
    try {
      f.intercept(() => {
        if (kind === "abort") controller.abort();
        if (kind === "lock") lockVault();
        if (kind === "origin") Object.defineProperty(globalThis, "location", {value: {origin: "https://other.example"}, configurable: true});
        if (kind === "source") f.source.originalSha256 = digest(utf8("changed public source"));
      });
      await assert.rejects(cacheOwnedPhotoDetails(f.source, controller.signal));
      assert.equal(await get("catalog", owner + ":" + f.identity.photoId), undefined);
      assert.equal(await get("settings", owner + ":annotation:" + f.identity.photoId), undefined);
    } finally {
      if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation); else delete (globalThis as any).location;
      await f.clean();
    }
  }
});

test("owned detail refresh cannot replace an existing manifest or same-revision annotation", async () => {
  const f = await setup();
  try {
    await cacheOwnedPhotoDetails(f.source);
    const key = owner + ":" + f.identity.photoId, previous = await get("catalog", key);
    f.annotations(f.annotation(1, "conflicting remote caption"));
    await assert.rejects(cacheOwnedPhotoDetails(f.source), /ANNOTATION_REVISION_MISMATCH/);
    assert.deepEqual(await get("catalog", key), previous);
    f.annotations(null);
    await atomic([{store: "catalog", key, value: encryptPrivate(f.signedManifest({...f.source.manifest, ownerWrappedMetadataKey: {...f.source.manifest.ownerWrappedMetadataKey, nonce: b64(sodium.randombytes_buf(24))}}))}]);
    await assert.rejects(cacheOwnedPhotoDetails(f.source), /CATALOG_SOURCE_CHANGED/);
  } finally {await f.clean();}
});
