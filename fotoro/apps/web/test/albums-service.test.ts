import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import type {MediaBinding, PhotoManifestV1, RepresentationV1} from "@fotoro/contracts";
import {ready, b64, unb64, sodium, utf8, wrapKey, encryptMedia, signPayload, encodeLivePhoto} from "@fotoro/crypto";
import {makeAlbumDefinition, makeAlbumPhoto, verifyAlbumAction, verifyAlbumPhoto} from "@fotoro/crypto/albums";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition, validateAlbumAppend, type AlbumOverviewV1} from "@fotoro/contracts/albums";
import {configureVault, unlockVault, lockVault, requireVault} from "../src/vault/vault";
import {clearAccount, all} from "../src/exchange/cache";
import {pinCard} from "../src/exchange/share-service";
import {collect, source, digest, type Photo} from "../src/library/catalog";
import {AlbumAccess, createAlbum, albumOwnedSelection, albumCapabilities, albumOriginalFiles, type AlbumCreationDraft} from "../src/albums/service";
import {searchAlbumPhotos} from "../src/albums/search";
import {ShareSelection} from "../src/exchange/sharing";
import {chosenAlbumPhotos} from "../src/local/selection";
import type {OwnedPhotoSnapshot} from "../src/library/consumer-search";
await ready;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
async function open(index = 0) {
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]});
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
async function scoped(fn: () => Promise<void>) {
  const previous = globalThis.fetch;
  for (const card of accounts.accounts) await clearAccount(card.accountId);
  try {await fn();} finally {globalThis.fetch = previous; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
}
async function fixture() {
  const owner = await open(), key = sodium.randombytes_buf(32), photoId = crypto.randomUUID(), mediaKey = sodium.randombytes_buf(32);
  const objects = new Map<string, Uint8Array>(), original = utf8("exact album original");
  const representation = async (kind: MediaBinding["kind"], bytes: Uint8Array, key: Uint8Array): Promise<RepresentationV1> => {
    const binding = {version: 1 as const, photoId, representationId: crypto.randomUUID(), kind};
    const ciphertext = await collect(encryptMedia(source(bytes), key, binding)), objectId = crypto.randomUUID(); objects.set(objectId, ciphertext);
    return {binding, objectId, header: b64(ciphertext.subarray(0, 24)), ciphertextBytes: ciphertext.length, ciphertextSha256: digest(ciphertext)};
  };
  const originalRep = await representation("original", original, mediaKey), thumbnail = await representation("thumbnail", utf8("album thumbnail"), mediaKey);
  const metadata = {version: 1 as const, filename: "Paris-2021.png", mediaType: "image/png" as const, sourceDate: "2021-10-01T12:00:00Z", dateSource: "photos" as const, originalBytes: original.length, originalSha256: digest(original), representationKeys: {[originalRep.binding.representationId]: b64(mediaKey), [thumbnail.binding.representationId]: b64(mediaKey)}};
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: owner.accountId, representations: [originalRep, thumbnail], metadataRepresentation: await representation("metadata", utf8(metadata), key), ownerWrappedMetadataKey: wrapKey(key, owner.vaultKey)};
  const signed = signPayload("photo-manifest", owner.accountId, utf8(manifest), owner.signingSecretKey);
  const made = makeAlbumDefinition({albumId: crypto.randomUUID(), title: "Family album", createdAt: "2026-10-07T12:00:00.000Z", ownerCard: owner.card, members: accounts.accounts, signingSecretKey: owner.signingSecretKey});
  const entry = makeAlbumPhoto({definition: made.definition, manifest: signed, metadataKey: key, albumKey: made.albumKey, signingSecretKey: owner.signingSecretKey}); made.albumKey.fill(0);
  return {owner, made, signed, entry, objects, original, photo: {manifest, metadata, metadataKey: key} as Photo};
}
const overview = (fixture: Awaited<ReturnType<typeof fixture>>, membership: "accepted" | "invited" = "accepted"): AlbumOverviewV1 => ({definition: fixture.made.signed, membership, endedAt: null, photoCount: 1});

test("create includes the owner and exact accepted roster, encrypts the supplied title, and never adds photos implicitly", () => scoped(async () => {
  const session = await open(); await pinCard(accounts.accounts[1]); let calls = 0;
  globalThis.fetch = async (path, init) => {
    assert.equal(path, "/v1/albums"); calls++; const request = JSON.parse(String(init?.body));
    const definition = readAlbumSignedBody(request.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition);
    assert.deepEqual(definition.members.map(member => member.card.accountId).sort(), accounts.accounts.map(card => card.accountId).sort());
    assert.equal(String(init?.body).includes("Family travel"), false);
    const sorted = JSON.parse(JSON.stringify({definition: request.definition, membership: "accepted", endedAt: null, photoCount: 0}, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
    return response(sorted);
  };
  const result = await createAlbum("Family travel", [accounts.accounts[1]], {}); assert.equal(result.membership, "accepted"); assert.equal(calls, 1);
  assert.equal(requireVault(), session);
}));

test("creation retry preserves the original album ID and signed roster after a lost response", () => scoped(async () => {
  await open(); await pinCard(accounts.accounts[1]); const draft: AlbumCreationDraft = {}; let prior: unknown, calls = 0;
  globalThis.fetch = async (_path, init) => {const request = JSON.parse(String(init?.body)); if (prior) assert.deepEqual(request, prior); else prior = request; if (++calls === 1) throw new TypeError("Response lost after creation"); return response({definition: request.definition, membership: "accepted", endedAt: null, photoCount: 0});};
  await assert.rejects(createAlbum("Family", [accounts.accounts[1]], {}, draft), /Response lost/); assert.ok(draft.signed);
  const result = await createAlbum("Family", [accounts.accounts[1]], {}, draft); assert.equal(result.membership, "accepted"); assert.equal(draft.signed, undefined); assert.equal(calls, 2);
}));

test("a recipient must explicitly accept before reading, reads authenticated originals, and inherits no private annotations", () => scoped(async () => {
  const data = await fixture(); await open(1); await pinCard(data.owner.card);
  let accepted = false, objectsRead = 0;
  globalThis.fetch = async (path, init) => {
    if (String(path).endsWith("/accept")) {const request = JSON.parse(String(init?.body)); verifyAlbumAction({signedDefinition: data.made.signed, trustedOwner: data.owner.card, signed: request.action, action: "accept"}); accepted = true; return response(overview(data));}
    if (!accepted) return response({code: "ALBUM_INACTIVE"}, 403);
    if (String(path).endsWith("/access")) return response(overview(data));
    if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
    objectsRead++; return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
  };
  const invited = await AlbumAccess.open(overview(data, "invited"), {}); assert.equal(objectsRead, 0);
  const active = await invited.accept(); assert.equal(active.membership, "accepted");
  const [photo] = await invited.loadPhotos(); assert.equal(photo.annotations, undefined); assert.equal(photo.grantId, undefined);
  assert.equal(photo.metadata.filename, data.photo.metadata.filename);
  assert.deepEqual(await invited.bytes(photo, "original", new AbortController().signal), data.original);
  const files = await albumOriginalFiles(invited, photo, new AbortController().signal); assert.equal(files[0].name, photo.metadata.filename); assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), data.original);
  const key = photo.metadataKey; invited.dispose(); assert.ok(key.every(byte => byte === 0)); assert.equal(invited.signal.aborted, true);
  await assert.rejects(invited.bytes(photo, "original", new AbortController().signal), {name: "AbortError"});
}));

test("ended membership rejects even cached media and immediately wipes published photo keys", () => scoped(async () => {
  const data = await fixture(); let ended = false, objectReads = 0;
  globalThis.fetch = async path => {
    if (String(path).startsWith("/v1/albums/")) {
      if (ended) return response({code: "ALBUM_INACTIVE"}, 403);
      if (String(path).endsWith("/access")) return response(overview(data));
      return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
    }
    objectReads++; return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(overview(data), {}), [photo] = await access.loadPhotos();
  await access.bytes(photo, "thumbnail", new AbortController().signal); const previousReads = objectReads;
  ended = true; await assert.rejects(access.bytes(photo, "thumbnail", new AbortController().signal), /ALBUM_INACTIVE/);
  assert.equal(objectReads, previousReads); assert.ok(photo.metadataKey.every(byte => byte === 0)); assert.equal(access.current(), false); assert.equal(access.signal.aborted, true);
}));

test("an accepted-member cookie swap fails the captured account header before cached pixels can publish", () => scoped(async () => {
  const data = await fixture(); let mismatched = false, reads = 0;
  globalThis.fetch = async (path, init) => {
    assert.equal(new Headers(init?.headers).get("X-Fotoro-Account-Id"), data.owner.accountId);
    if (mismatched) return response({code: "ACCOUNT_MISMATCH"}, 403);
    if (String(path).startsWith("/v1/albums/")) return response(String(path).endsWith("/access") ? overview(data) : {...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
    reads++; return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(overview(data), {}), [photo] = await access.loadPhotos();
  await access.bytes(photo, "thumbnail", new AbortController().signal); const previousReads = reads;
  mismatched = true; await assert.rejects(access.bytes(photo, "thumbnail", new AbortController().signal), /ACCOUNT_MISMATCH/);
  assert.equal(reads, previousReads); assert.equal(access.signal.aborted, true); assert.ok(photo.metadataKey.every(byte => byte === 0));
}));

test("access ending during an original read cannot return plaintext, and missing derivatives do not fetch originals", () => scoped(async () => {
  const data = await fixture(); let ended = false;
  globalThis.fetch = async path => {
    if (String(path).startsWith("/v1/albums/")) {
      if (ended) return response({code: "ALBUM_INACTIVE"}, 403);
      return response(String(path).endsWith("/access") ? overview(data) : {...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
    }
    if (String(path).endsWith(data.photo.manifest.representations[0].objectId)) ended = true;
    return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(overview(data), {}), [photo] = await access.loadPhotos();
  await assert.rejects(access.bytes(photo, "preview", new AbortController().signal), /PREVIEW_UNAVAILABLE/); assert.equal(ended, false);
  await assert.rejects(access.bytes(photo, "original", new AbortController().signal), /ALBUM_INACTIVE/); assert.ok(photo.metadataKey.every(byte => byte === 0));
}));

test("append retries retain exact encrypted signed entries and re-adding an existing contribution is a no-op", () => scoped(async () => {
  const data = await fixture(); let stored: ReturnType<typeof validateAlbumAppend> | undefined, attempts = 0, published = false;
  const canonicalManifest = JSON.parse(JSON.stringify(data.photo.manifest, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
  data.signed = signPayload("photo-manifest", data.owner.accountId, utf8(canonicalManifest), data.owner.signingSecretKey);
  globalThis.fetch = async (path, init) => {
    if (String(path).endsWith("/manifest")) return response(data.signed);
    const active = {...overview(data), photoCount: published ? 1 : 0};
    if (String(path).endsWith("/access")) return response(active);
    if (String(path).endsWith("/photos")) {
      const request = validateAlbumAppend(JSON.parse(String(init?.body))); attempts++;
      assert.deepEqual(request.manifests, [data.signed], "Use the native-compatible original signed bytes without re-encoding");
      if (stored) assert.deepEqual(request, stored); else stored = request;
      const verified = verifyAlbumPhoto({definition: data.made.definition, entry: request.entries[0], manifest: request.manifests[0]}); assert.equal(verified.photo.photoId, data.photo.manifest.photoId);
      if (attempts === 1) throw new TypeError("Response lost before commit");
      published = true; return response({version: 1, albumId: data.made.definition.albumId, operationId: request.operationId, added: 1, photoCount: 1});
    }
    return response({...active, version: 1, entries: published ? stored!.entries : [], manifests: published ? stored!.manifests : [], nextCursor: null, hasMore: false});
  };
  const access = await AlbumAccess.open({...overview(data), photoCount: 0}, {}), snapshot = new ShareSelection([data.photo]);
  await assert.rejects(access.add(snapshot.photos, () => [data.photo]), /Response lost/);
  assert.equal(await access.add(snapshot.photos, () => [data.photo]), 1); assert.equal(attempts, 2);
  assert.equal(await access.add(snapshot.photos, () => [data.photo]), 0); assert.equal(attempts, 2);
  const rows = await all("saves"); assert.equal(rows.length, 1); assert.equal(JSON.stringify(rows).includes(data.photo.metadata.filename), false); assert.equal(JSON.stringify(rows).includes(data.photo.manifest.photoId), false);
  access.dispose(); snapshot.dispose(); assert.ok(data.photo.metadataKey.some(byte => byte !== 0), "Closing album selection preserves the catalog key");
}));

test("selection fences exclude received, withdrawn, replaced originals and duplicates but allow annotation-only projections", () => scoped(async () => {
  const data = await fixture(), snapshot = new ShareSelection([data.photo]);
  assert.equal(albumOwnedSelection(snapshot.photos, data.owner, [{...data.photo, annotations: {version: 1, photoId: data.photo.manifest.photoId, originalSha256: data.photo.metadata.originalSha256, labels: ["private"]}}]).length, 1);
  for (const latest of [[], [{...data.photo, grantId: crypto.randomUUID()}], [{...data.photo, metadata: {...data.photo.metadata, originalSha256: b64(new Uint8Array(32))}}]]) assert.throws(() => albumOwnedSelection(snapshot.photos, data.owner, latest), /SELECTION_CHANGED/);
  assert.throws(() => albumOwnedSelection([data.photo, data.photo], data.owner, [data.photo]), /SELECTION_CHANGED/);
  const local = {id: "local", filename: "Paris.png", date: data.photo.metadata.sourceDate, dateSource: "selected" as const, digest: Buffer.from(data.photo.metadata.originalSha256, "base64url").toString("hex"), file: new File(["source"], "Paris.png")};
  const owned = {accountId: data.owner.accountId, token: {}, photos: [data.photo], current: () => true, preview: async () => new Blob()} satisfies OwnedPhotoSnapshot;
  assert.deepEqual(chosenAlbumPhotos(owned, [local], [data.photo]), {photos: [data.photo], needsSave: 0});
  assert.equal(chosenAlbumPhotos(owned, [{...local, digest: "00".repeat(32)}], []).needsSave, 1);
  assert.equal(chosenAlbumPhotos({...owned, current: () => false}, [local], [data.photo]).photos.length, 0);
  snapshot.dispose();
}));

test("album search uses only verified filename/capture dates, includes matches beyond200, and excludes private People/location/text", async () => {
  const photos = Array.from({length: 250}, (_, n) => ({manifest: {photoId: String(n)}, metadata: {filename: `Paris-trip-${n}.jpg`, originalSha256: "hash", sourceDate: "2021-10-01T12:00:00Z", dateSource: "photos"}, annotations: {labels: ["Private place"], caption: "secret family", facts: ["private face"]}} as Photo));
  assert.equal(searchAlbumPhotos(photos, "Paris", () => true).length, 250);
  assert.equal(searchAlbumPhotos(photos, "2021", () => true).length, 250);
  for (const query of ["secret", "Private place", "family", "private face"]) assert.equal(searchAlbumPhotos(photos, query, () => true).length, 0);
  assert.equal(searchAlbumPhotos(photos, "", () => false).length, 0);
  assert.equal(searchAlbumPhotos([{...photos[0], metadata: {...photos[0].metadata, dateSource: "import"}}], "2021", () => true).length, 0);
});

test("album Live original export preserves still and motion files and rechecks access after decoding", async () => {
  const still = new Uint8Array([1, 2, 3]), motion = new Uint8Array([4, 5, 6, 7]);
  const packed = await encodeLivePhoto({filename: "pair.HEIC", mediaType: "image/heic", bytes: still}, {filename: "pair.MOV", mediaType: "video/quicktime", bytes: motion});
  const source = {metadata: {filename: "pair.jpg", mediaType: "application/vnd.fotoro.live-photo", originalBytes: packed.length, originalSha256: digest(packed)}} as Photo;
  let checked = 0; const received = packed.slice();
  const access = {bytes: async () => received, assertAccess: async () => {checked++;}} as unknown as AlbumAccess;
  const files = await albumOriginalFiles(access, source, new AbortController().signal);
  assert.deepEqual(files.map(file => [file.name, file.type]), [["pair.HEIC", "image/heic"], ["pair.MOV", "video/quicktime"]]);
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), still); assert.deepEqual(new Uint8Array(await files[1].arrayBuffer()), motion);
  assert.equal(checked, 1); assert.ok(received.every(byte => byte === 0));
  const late = packed.slice(), revoked = {bytes: async () => late, assertAccess: async () => {throw new Error("ALBUM_INACTIVE");}} as unknown as AlbumAccess;
  await assert.rejects(albumOriginalFiles(revoked, source, new AbortController().signal), /ALBUM_INACTIVE/); assert.ok(late.every(byte => byte === 0));
});

test("capabilities and album sessions cannot publish after account/scope change", () => scoped(async () => {
  const data = await fixture(); let current = true;
  globalThis.fetch = async () => {current = false; return response({version: 1, albumsVersion: 1, maxMembers: 12, maxPhotos: 1000, pageSize: 100});};
  await assert.rejects(albumCapabilities({current: () => current}), {name: "AbortError"});
  current = true; const access = await AlbumAccess.open(overview(data), {current: () => current});
  await open(1); assert.equal(access.current(), false); assert.equal(access.signal.aborted, true);
}));
