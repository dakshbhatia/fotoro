import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import type {MediaBinding, PhotoManifestV1, RepresentationV1} from "@fotoro/contracts";
import {b64, encryptMedia, ready, sodium, unb64, wrapKey} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {clearAccount, put} from "../src/exchange/cache";
import {collect, digest, photoBytes, source, type Photo} from "../src/library/catalog";
import {cameraOriginalFiles} from "../src/media/camera-original";
import {ShareSelection} from "../src/exchange/sharing";
import {OriginalShareAttempt, prepareSavedOriginals, savedOriginalSelectionCurrent, type ShareEnvironment} from "../src/library/system-share";

const photo = (id: string, owner = "owner"): Photo => ({manifest: {photoId: id, ownerAccountId: owner, representations: []} as unknown as PhotoManifestV1,
  metadata: {version: 1, filename: id + ".png", mediaType: "image/png", sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalBytes: 1,
    originalSha256: id, representationKeys: {}}, metadataKey: new Uint8Array(32)});
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};

test("selected Saved originals prepare without export and a fresh click immediately shares the exact complete batch", async () => {
  const photos = [photo("a"), photo("b")], selected = new Set(["a", "b"]), snapshot = new ShareSelection(photos), reads: string[] = [], buffers: Uint8Array[] = [];
  const current = () => snapshot.current && savedOriginalSelectionCurrent(snapshot.photos, photos, selected, "owner");
  const files = await prepareSavedOriginals(snapshot.photos, new AbortController().signal, current, async (value, kind) => {
    reads.push(value.manifest.photoId); assert.equal(kind, "original");
    const bytes = new TextEncoder().encode("exact " + value.manifest.photoId); buffers.push(bytes); return bytes;
  });
  assert.deepEqual(reads, ["a", "b"]); assert.deepEqual(files.map(file => [file.name, file.type]), [["a.png", "image/png"], ["b.png", "image/png"]]);
  assert.deepEqual(await Promise.all(files.map(file => file.text())), ["exact a", "exact b"]);
  assert.ok(buffers.every(bytes => bytes.every(value => value === 0)));
  let calls = 0;
  const attempt = new OriginalShareAttempt(), finish = deferred<void>();
  const environment: ShareEnvironment = {canShare: () => true, share: data => {calls++; assert.deepEqual(data.files, files); return finish.promise;}, download: () => assert.fail("System sharing must not download")};
  const started = attempt.runFiles(files, current, environment);
  assert.equal(calls, 1, "Native Share is invoked before the click yields");
  assert.equal(await attempt.runFiles(files, current, environment), "busy");
  finish.resolve(); assert.equal(await started, "shared"); assert.equal(calls, 1); snapshot.dispose();
});

test("selection, account and source changes cancel a delayed preparation before another original or export is prepared", async () => {
  for (const change of ["selection", "account", "source", "abort"]) {
    const photos = [photo("a"), photo("b")], selected = new Set(["a", "b"]), controller = new AbortController(), delayed = deferred<Uint8Array>();
    let account = "owner", catalog = photos, reads = 0, exports = 0;
    const pending = prepareSavedOriginals(photos, controller.signal, () => savedOriginalSelectionCurrent(photos, catalog, selected, account), async () => {reads++; return delayed.promise;}, () => {exports++; return [];});
    const rejected = assert.rejects(pending, {name: "AbortError"});
    if (change === "selection") selected.delete("b");
    if (change === "account") account = "another";
    if (change === "source") catalog = [{...photos[0], metadata: {...photos[0].metadata, originalSha256: "replacement"}}, photos[1]];
    if (change === "abort") controller.abort();
    const bytes = new Uint8Array([1, 2, 3]); delayed.resolve(bytes); await rejected;
    assert.equal(reads, 1, change); assert.equal(exports, 0, change); assert.deepEqual(bytes, new Uint8Array(3));
  }
});

test("awaited Live Photo resource extraction rechecks cancellation before publishing any prepared files", async () => {
  const bytes = new Uint8Array([1, 2]), extracting = deferred<File[]>(), began = deferred<void>(), controller = new AbortController();
  const pending = prepareSavedOriginals([photo("live")], controller.signal, () => true, async () => bytes, () => {began.resolve(); return extracting.promise;});
  const rejected = assert.rejects(pending, {name: "AbortError"}); await began.promise; controller.abort();
  extracting.resolve([new File(["still"], "still.heic"), new File(["motion"], "motion.mov")]); await rejected;
  assert.deepEqual(bytes, new Uint8Array(2));
});

test("Saved source checks allow label edits but reject foreign, received, withdrawn, replacement and changed selections", () => {
  const original = photo("a"), selected = new Set(["a"]), same = structuredClone(original);
  const current = (catalog: Photo[], ids = selected, account = "owner") => savedOriginalSelectionCurrent([original], catalog, ids, account);
  assert.equal(current([same]), true);
  assert.equal(current([{...same, annotations: {version: 1, supplied: {labels: ["Family"], favorite: true}} as Photo["annotations"]}]), true);
  assert.equal(current([{...same, grantId: "received"}]), false);
  assert.equal(current([]), false); assert.equal(current([photo("a", "other")]), false);
  assert.equal(current([{...same, metadata: {...same.metadata, originalSha256: "replacement"}}]), false);
  assert.equal(current([same], new Set(["a", "b"])), false); assert.equal(current([same], new Set(["b"])), false);
  assert.equal(current([same], selected, "new-account"), false);
});

test("batch cancellation preserves a fresh Share retry and never automatically starts downloads", async () => {
  const files = [new File(["a"], "a.png"), new File(["b"], "b.mov")], attempt = new OriginalShareAttempt(); let calls = 0;
  const environment: ShareEnvironment = {canShare: () => true, share: async () => {calls++; throw new DOMException("Cancelled", "AbortError");}, download: () => assert.fail("Cancellation cannot download")};
  assert.equal(await attempt.runFiles(files, () => true, environment), "cancelled");
  assert.equal(attempt.pending, false);
  assert.equal(await attempt.runFiles(files, () => true, {...environment, share: async data => {calls++; assert.deepEqual(data.files, files);}}), "shared");
  assert.equal(calls, 2);
});

test("unsupported batch Share dispatches exact files, while source withdrawal stops subsequent downloads", async () => {
  const files = [new File(["a"], "a.png"), new File(["b"], "b.mov")], attempt = new OriginalShareAttempt(), downloads: File[] = []; let current = true;
  await assert.rejects(attempt.runFiles(files, () => current, {canShare: () => false, download: file => {downloads.push(file); current = false;}}), /SOURCE_UNAVAILABLE/);
  assert.deepEqual(downloads, [files[0]]); assert.equal(attempt.pending, false);
  current = true; downloads.length = 0;
  assert.equal(await attempt.runFiles(files, () => current, {canShare: () => false, download: file => downloads.push(file)}), "downloaded");
  assert.deepEqual(downloads, files);
});

test("real cached encrypted originals must all pass decryption and digest verification before batch export", async () => {
  await ready;
  const secret = accounts.testSecrets[0], card = accounts.accounts[0], fetch = globalThis.fetch;
  configureVault({version: 1, accountCard: card, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  const session = await unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
  const owned: Photo[] = [];
  globalThis.fetch = (async () => assert.fail("The verified original is cached; preparation must not invent another source")) as typeof fetch;
  try {
    for (const name of ["first", "second"]) {
      const bytes = new TextEncoder().encode("encrypted exact " + name), id = crypto.randomUUID(), key = sodium.randombytes_buf(32);
      const binding: MediaBinding = {version: 1, photoId: id, representationId: crypto.randomUUID(), kind: "original"};
      const cipher = await collect(encryptMedia(source(bytes), key, binding));
      const rep: RepresentationV1 = {binding, objectId: crypto.randomUUID(), header: b64(cipher.subarray(0, 24)), ciphertextBytes: cipher.length, ciphertextSha256: digest(cipher)};
      await put("read", card.accountId + ":" + rep.objectId, cipher);
      owned.push({...photo(id, card.accountId), manifest: {...photo(id, card.accountId).manifest, version: 1, representations: [rep], metadataRepresentation: rep,
        ownerWrappedMetadataKey: wrapKey(key, session.vaultKey)}, metadata: {...photo(id).metadata, filename: name + ".png", originalBytes: bytes.length,
          originalSha256: digest(bytes), representationKeys: {[binding.representationId]: b64(key)}}});
    }
    const selected = new Set(owned.map(value => value.manifest.photoId));
    const current = () => savedOriginalSelectionCurrent(owned, owned, selected, card.accountId);
    const files = await prepareSavedOriginals(owned, new AbortController().signal, current, photoBytes, (bytes, value) => cameraOriginalFiles(bytes, value.metadata));
    assert.deepEqual(await Promise.all(files.map(file => file.text())), ["encrypted exact first", "encrypted exact second"]);
    let exported = 0;
    const poisoned = [owned[0], {...owned[1], metadata: {...owned[1].metadata, originalSha256: owned[0].metadata.originalSha256}}];
    await assert.rejects(prepareSavedOriginals(poisoned, new AbortController().signal, () => true, photoBytes, (bytes, value) => {
      exported++; return cameraOriginalFiles(bytes, value.metadata);
    }), /ORIGINAL_DIGEST_MISMATCH/);
    assert.equal(exported, 1, "The first prepared file stays private when a later original fails verification");
    const attempt = new OriginalShareAttempt();
    await assert.rejects(attempt.runFiles(files, () => false, {canShare: () => assert.fail("Locked batches cannot ask the platform to Share"), download: () => assert.fail("Locked batches cannot download")}), /SOURCE_UNAVAILABLE/);
  } finally {globalThis.fetch = fetch; lockVault(); await clearAccount(card.accountId);}
});
