import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import type {MediaBinding, PhotoManifestV1, RepresentationV1} from "@fotoro/contracts";
import {ready, b64, unb64, sodium, utf8, wrapKey, encryptMedia, signPayload, encodeLivePhoto} from "@fotoro/crypto";
import {makeAlbumDefinition, openAlbumDefinition, makeAlbumPhoto, verifyAlbumAction, verifyAlbumPhoto} from "@fotoro/crypto/albums";
import {ALBUM_DEFINITION_KIND, readAlbumSignedBody, validateAlbumDefinition, validateAlbumAppend, type AlbumOverviewV1} from "@fotoro/contracts/albums";
import {configureVault, unlockVault, lockVault, requireVault} from "../src/vault/vault";
import {clearAccount, all} from "../src/exchange/cache";
import {pinCard} from "../src/exchange/share-service";
import {collect, source, digest, type Photo} from "../src/library/catalog";
import {AlbumAccess, createAlbum, albumOwnedSelection, albumCapabilities, albumOriginalFiles, downloadAlbumOriginal, type AlbumCreationDraft} from "../src/albums/service";
import {searchAlbumPhotos} from "../src/albums/search";
import {ShareSelection} from "../src/exchange/sharing";
import {PendingAlbumContribution} from "../src/albums/pending-contribution";
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
  const [photo] = (await invited.loadPhotoPage()).photos; assert.equal(photo.annotations, undefined); assert.equal(photo.grantId, undefined);
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
  const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
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
  const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
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
  const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
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
  const choice = new PendingAlbumContribution([data.photo], () => access.current());
  let retained: readonly Photo[] = [];
  const add = (photos: readonly Photo[]) => {retained = photos; return access.add(photos, () => [data.photo]);};
  await assert.rejects(choice.add(add), /Response lost/);
  assert.equal(choice.current, true, "Failed trip add keeps exactly the already-Saved choice for explicit retry");
  assert.ok(retained[0].metadataKey.some(byte => byte !== 0));
  assert.equal(await choice.add(add), 1); assert.equal(attempts, 2);
  assert.equal(choice.current, false); assert.ok(retained[0].metadataKey.every(byte => byte === 0), "Successful retry clears its copied metadata key");
  assert.equal(await access.add(snapshot.photos, () => [data.photo]), 0); assert.equal(attempts, 2);
  const rows = await all("saves"); assert.equal(rows.length, 1); assert.equal(JSON.stringify(rows).includes(data.photo.metadata.filename), false); assert.equal(JSON.stringify(rows).includes(data.photo.manifest.photoId), false);
  access.dispose(); snapshot.dispose(); assert.ok(data.photo.metadataKey.some(byte => byte !== 0), "Closing album selection preserves the catalog key");
}));

test("chosen contributions retry transient access reads before and after commit without duplicate additions", () => scoped(async () => {
  for (const phase of [1, 2, 3]) {
    const data = await fixture(); let accessReads = 0, writes = 0, failing = true, published = false;
    let stored: ReturnType<typeof validateAlbumAppend> | undefined;
    globalThis.fetch = async (path, init) => {
      const url = String(path), active = {...overview(data), photoCount: published ? 1 : 0};
      if (url.endsWith("/access")) {
        if (failing && ++accessReads === phase) {
          if (phase === 1) throw new TypeError("Network interrupted");
          return response({}, 503);
        }
        return response(active);
      }
      if (url.endsWith("/manifest")) return response(data.signed);
      if (url.endsWith("/photos")) {
        writes++; const request = validateAlbumAppend(JSON.parse(String(init?.body)));
        if (stored) assert.deepEqual(request, stored); else stored = request;
        published = true;
        return response({version: 1, albumId: data.made.definition.albumId, operationId: request.operationId, added: 1, photoCount: 1});
      }
      return response({...active, version: 1, entries: published ? stored!.entries : [], manifests: published ? stored!.manifests : [], nextCursor: null, hasMore: false});
    };
    const access = await AlbumAccess.open({...overview(data), photoCount: 0}, {});
    const choice = new PendingAlbumContribution([data.photo], () => access.current());
    let retained: readonly Photo[] = [];
    const add = (photos: readonly Photo[]) => {retained = photos; return access.add(photos, () => [data.photo]);};
    await assert.rejects(choice.add(add));
    assert.equal(access.current(), true); assert.equal(choice.current, true);
    assert.ok(retained[0].metadataKey.some(byte => byte !== 0));
    assert.equal(writes, phase === 3 ? 1 : 0, "No contribution passes an unsuccessful fresh access check");
    failing = false;
    assert.equal(await choice.add(add), phase === 3 ? 0 : 1);
    assert.equal(writes, 1, "An already committed addition is not sent again");
    assert.equal(choice.current, false); assert.ok(retained[0].metadataKey.every(byte => byte === 0));
    assert.ok(data.photo.metadataKey.some(byte => byte !== 0)); access.dispose();
  }
}));

test("direct contribution denials and invalid receipts cancel the chosen retry and its copied keys", () => scoped(async () => {
  for (const failure of ["denied", "malformed", "binding"] as const) {
    const data = await fixture();
    globalThis.fetch = async (path, init) => {
      const url = String(path), active = {...overview(data), photoCount: 0};
      if (url.endsWith("/access")) return response(active);
      if (url.endsWith("/manifest")) return response(data.signed);
      if (url.endsWith("/photos")) {
        if (failure === "denied") return response({code: "ALBUM_INACTIVE", retryable: true}, 403);
        if (failure === "malformed") return response({added: 1});
        const request = validateAlbumAppend(JSON.parse(String(init?.body)));
        return response({version: 1, albumId: crypto.randomUUID(), operationId: request.operationId, added: 1, photoCount: 1});
      }
      return response({...active, version: 1, entries: [], manifests: [], nextCursor: null, hasMore: false});
    };
    const access = await AlbumAccess.open({...overview(data), photoCount: 0}, {});
    const choice = new PendingAlbumContribution([data.photo], () => access.current());
    let retained: readonly Photo[] = [];
    await assert.rejects(choice.add(photos => {retained = photos; return access.add(photos, () => [data.photo]);}));
    assert.equal(access.current(), false); assert.equal(choice.current, false);
    assert.ok(retained[0].metadataKey.every(byte => byte === 0));
    assert.ok(data.photo.metadataKey.some(byte => byte !== 0));
  }
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


test("album first page returns without fetching its continuation", () => scoped(async () => {
  const data = await fixture(); let detailReads = 0, accessReads = 0;
  globalThis.fetch = async path => {
    const url = String(path);
    if (url.endsWith("/access")) {accessReads++; return response({...overview(data), photoCount: 2});}
    if (url.startsWith("/v1/albums/")) {detailReads++; return response({...overview(data), photoCount: 2, version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: "next_1", hasMore: true});}
    return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(overview(data), {}), first = await access.loadPhotoPage();
  assert.equal(detailReads, 1); assert.equal(first.photos.length, 1); assert.equal(first.nextCursor, "next_1"); assert.equal(first.photoCount, 2); assert.equal(accessReads, 2);
  await assert.rejects(access.loadPhotoPage(first.nextCursor), /ALBUM_(DUPLICATE_PHOTO|PAGE_MISMATCH)/);
  assert.ok(first.photos[0].metadataKey.every(byte => byte === 0)); assert.equal(access.current(), false);
}));

async function albumPages(count = 6) {
  const data = await fixture(), items = [data];
  const opened = openAlbumDefinition({signed: data.made.signed, trustedOwner: data.owner.card, recipientCard: data.owner.card, recipientSecretKey: data.owner.boxSecretKey, expectedAlbumId: data.made.definition.albumId});
  try {
    for (let n = 1; n < count; n++) {
      const item = await fixture();
      item.entry = makeAlbumPhoto({definition: data.made.definition, manifest: item.signed, metadataKey: item.photo.metadataKey, albumKey: opened.albumKey, signingSecretKey: item.owner.signingSecretKey});
      for (const [id, bytes] of item.objects) data.objects.set(id, bytes);
      items.push(item);
    }
  } finally {opened.albumKey.fill(0);}
  const active = {...overview(data), photoCount: count};
  const page = (indices: number[], nextCursor: string | null) => ({...active, version: 1, entries: indices.map(n => items[n].entry), manifests: indices.map(n => items[n].signed), nextCursor, hasMore: nextCursor !== null});
  return {data, items, active, page};
}

test("album pages bound metadata concurrency at four, preserve order and refresh without erasing displayed keys", () => scoped(async () => {
  const {data, items, active, page} = await albumPages(); let inFlight = 0, peak = 0; const details: string[] = [];
  globalThis.fetch = async path => {
    const url = String(path);
    if (url.endsWith("/access")) return response(active);
    if (url.startsWith("/v1/albums/")) {details.push(url); return response(url.includes("?") ? page([5], null) : page([0, 1, 2, 3, 4], "next_1"));}
    peak = Math.max(peak, ++inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
    return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage(), second = await access.loadPhotoPage(first.nextCursor);
  assert.equal(peak, 4); assert.deepEqual([...first.photos, ...second.photos].map(photo => photo.manifest.photoId), items.map(item => item.photo.manifest.photoId));
  assert.ok(details[1].endsWith("?cursor=next_1")); assert.equal(second.nextCursor, undefined); assert.equal(second.hasMore, false);
  const refreshed = await access.loadPhotoPage(); assert.equal(refreshed.photos.length, 5); assert.ok(first.photos[0].metadataKey.some(byte => byte !== 0));
  access.dispose(); for (const photo of [...first.photos, ...second.photos, ...refreshed.photos]) assert.ok(photo.metadataKey.every(byte => byte === 0));
}));

test("album pages reject unexpected, repeated, empty continuations and malformed manifest pairings", () => scoped(async () => {
  for (const bad of ["unexpected", "repeated", "empty", "malformed", "manifest", "signature"]) {
    const {data, active, page} = await albumPages(2);
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return response(active);
      if (url.startsWith("/v1/albums/")) return response(!url.includes("?") ? page([0], "next_1") : bad === "malformed" ? {...page([1], null), manifests: []} : bad === "manifest" ? {...page([1], null), manifests: [data.signed]} : bad === "signature" ? {...page([1], null), entries: [{...page([1], null).entries[0], signature: b64(new Uint8Array(64))}]} : page(bad === "empty" ? [] : [1], "next_1"));
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage();
    await assert.rejects(access.loadPhotoPage(bad === "unexpected" ? "wrong" : first.nextCursor));
    assert.equal(access.current(), false); assert.ok(first.photos[0].metadataKey.every(byte => byte === 0));
  }
}));

test("metadata page publication is fenced against revocation, cancellation, lock and account changes", () => scoped(async () => {
  for (const change of ["revoked", "cancelled", "locked", "account"]) {
    const {data, active, page} = await albumPages(2); const controller = new AbortController(); let changed = false;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return changed && change === "revoked" ? response({code: "ALBUM_INACTIVE"}, 403) : response(active);
      if (url.startsWith("/v1/albums/")) return response(page([0, 1], null));
      if (!changed) {
        changed = true;
        if (change === "cancelled") controller.abort();
        if (change === "locked") lockVault();
        if (change === "account") await open(1);
      }
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(active, {signal: controller.signal});
    await assert.rejects(access.loadPhotoPage()); assert.equal(access.current(), false); assert.equal(access.signal.aborted, true);
  }
}));

test("overlapping album page requests cannot corrupt the active traversal", () => scoped(async () => {
  const {data, active, page} = await albumPages(2);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => {release = resolve;}), reading = new Promise<void>(resolve => {started = resolve;});
  globalThis.fetch = async path => {
    const url = String(path);
    if (url.endsWith("/access")) return response(active);
    if (url.startsWith("/v1/albums/")) return response(url.includes("?") ? page([1], null) : page([0], "next_1"));
    started(); await waiting;
    return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(active, {}), firstRequest = access.loadPhotoPage();
  await reading; await assert.rejects(access.loadPhotoPage(), /ALBUM_PAGE_LOADING/);
  assert.equal(access.current(), true); release();
  const first = await firstRequest, second = await access.loadPhotoPage(first.nextCursor);
  assert.equal(first.photos.length, 1); assert.equal(second.photos.length, 1); assert.equal(second.hasMore, false);
  assert.ok(first.photos[0].metadataKey.some(byte => byte !== 0)); access.dispose();
}));

test("concurrent access fences share a queued request, but later fences never join an older request", () => scoped(async () => {
  const data = await fixture(), access = await AlbumAccess.open(overview(data), {});
  let requests = 0, releaseFirst!: () => void, firstStarted!: () => void;
  const started = new Promise<void>(resolve => {firstStarted = resolve;});
  const released = new Promise<void>(resolve => {releaseFirst = resolve;});
  globalThis.fetch = async path => {
    assert.ok(String(path).endsWith("/access"));
    if (++requests === 1) {firstStarted(); await released;}
    return response(overview(data));
  };
  const first = Array.from({length: 12}, () => access.assertAccess());
  await started;
  const next = Array.from({length: 12}, () => access.assertAccess());
  assert.equal(requests, 1, "only one access request may run at a time");
  releaseFirst();
  await Promise.all([...first, ...next]);
  assert.equal(requests, 2, "the later cohort requires its own access request");
  access.dispose();
}));

test("a fence queued behind an in-flight check detects revocation instead of reusing its success", () => scoped(async () => {
  const data = await fixture(), access = await AlbumAccess.open(overview(data), {});
  let requests = 0, releaseFirst!: () => void, firstStarted!: () => void;
  const started = new Promise<void>(resolve => {firstStarted = resolve;});
  const released = new Promise<void>(resolve => {releaseFirst = resolve;});
  globalThis.fetch = async () => {
    if (++requests === 1) {firstStarted(); await released; return response(overview(data));}
    return response({code: "ALBUM_INACTIVE"}, 403);
  };
  const first = access.assertAccess(); await started;
  const next = access.assertAccess(), rejected = assert.rejects(next, /ALBUM_INACTIVE/);
  releaseFirst(); await first; await rejected;
  assert.equal(requests, 2); assert.equal(access.signal.aborted, true);
}));

test("disposal while an access check runs prevents both cohorts from publishing and skips queued network work", () => scoped(async () => {
  const data = await fixture(), access = await AlbumAccess.open(overview(data), {});
  let requests = 0, release!: () => void, requestStarted!: () => void;
  const started = new Promise<void>(resolve => {requestStarted = resolve;});
  const released = new Promise<void>(resolve => {release = resolve;});
  globalThis.fetch = async () => {requests++; requestStarted(); await released; return response(overview(data));};
  const first = access.assertAccess(); await started;
  const next = access.assertAccess();
  const results = Promise.allSettled([first, next]);
  access.dispose(); release();
  assert.ok((await results).every(result => result.status === "rejected"));
  assert.equal(requests, 1);
}));

test("raster revisits keep both access fences and same-source refresh preserves Photo identity and active URLs", () => scoped(async () => {
  const data = await fixture(), actualRevoke = URL.revokeObjectURL, revoked: string[] = []; let accessRequests = 0;
  URL.revokeObjectURL = url => {revoked.push(url); actualRevoke(url);};
  try {
    globalThis.fetch = async path => {
      if (String(path).endsWith("/access")) {accessRequests++; return response(overview(data));}
      if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
      return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
    const first = new AbortController(), url = await access.leaseRaster(photo, "thumbnail", first.signal);
    const refreshed = await AlbumAccess.open(overview(data), {}), page = await refreshed.loadPhotoPage();
    const temporary = page.photos[0], retained = access.adoptRefresh(refreshed, page.photos);
    assert.equal(retained[0], photo); assert.equal(access.signal.aborted, false); assert.equal(refreshed.signal.aborted, true);
    assert.ok(photo.metadataKey.some(value => value !== 0)); assert.ok(temporary.metadataKey.every(value => value === 0));
    assert.deepEqual(revoked, [], "verified unchanged source keeps its displayed URL alive");
    const prior = accessRequests, second = new AbortController();
    const nextURL = await access.leaseRaster(photo, "thumbnail", second.signal);
    assert.equal(accessRequests - prior, 2, "a cache hit checks membership before and after retrieval");
    first.abort(); assert.deepEqual(revoked, [url]);
    access.dispose(); assert.deepEqual(revoked, [url, nextURL]); second.abort();
    assert.equal(revoked.length, 2);
  } finally {URL.revokeObjectURL = actualRevoke;}
}));

test("a refreshed signed metadata revision replaces identity, wipes the old key and revokes its visible raster", () => scoped(async () => {
  const data = await fixture(), actualRevoke = URL.revokeObjectURL, revoked: string[] = [];
  URL.revokeObjectURL = url => {revoked.push(url); actualRevoke(url);};
  try {
    let entry = data.entry, signed = data.signed;
    globalThis.fetch = async path => {
      if (String(path).endsWith("/access")) return response(overview(data));
      if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [entry], manifests: [signed], nextCursor: null, hasMore: false});
      return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
    const lease = new AbortController(), url = await access.leaseRaster(photo, "thumbnail", lease.signal);
    const binding = {...photo.manifest.metadataRepresentation.binding, representationId: crypto.randomUUID()};
    const encrypted = await collect(encryptMedia(source(utf8({...photo.metadata, filename: "revised.jpg"})), data.photo.metadataKey, binding));
    const objectId = crypto.randomUUID(); data.objects.set(objectId, encrypted);
    const manifest = {...photo.manifest, metadataRepresentation: {binding, objectId, header: b64(encrypted.subarray(0, 24)), ciphertextBytes: encrypted.length, ciphertextSha256: digest(encrypted)}};
    signed = signPayload("photo-manifest", data.owner.accountId, utf8(manifest), data.owner.signingSecretKey);
    const opened = openAlbumDefinition({signed: data.made.signed, trustedOwner: data.owner.card, recipientCard: data.owner.card, recipientSecretKey: data.owner.boxSecretKey, expectedAlbumId: data.made.definition.albumId});
    try {entry = makeAlbumPhoto({definition: opened.definition, manifest: signed, metadataKey: data.photo.metadataKey, albumKey: opened.albumKey, signingSecretKey: data.owner.signingSecretKey});}
    finally {opened.albumKey.fill(0);}
    const refreshed = await AlbumAccess.open(overview(data), {}), page = await refreshed.loadPhotoPage();
    const [replacement] = access.adoptRefresh(refreshed, page.photos);
    assert.notEqual(replacement, photo); assert.equal(replacement.metadata.filename, "revised.jpg");
    assert.ok(photo.metadataKey.every(value => value === 0)); assert.deepEqual(revoked, [url]);
    await assert.rejects(access.leaseRaster(photo, "thumbnail", lease.signal), /ALBUM_PHOTO_CHANGED/);
    const next = new AbortController(); await access.leaseRaster(replacement, "thumbnail", next.signal);
    next.abort(); access.dispose();
  } finally {URL.revokeObjectURL = actualRevoke;}
}));

test("revocation after a cached raster read prevents publication and revokes existing leases", () => scoped(async () => {
  const data = await fixture(), actualRevoke = URL.revokeObjectURL, revoked: string[] = [];
  URL.revokeObjectURL = url => {revoked.push(url); actualRevoke(url);};
  try {
    let untilRevoked = Infinity;
    globalThis.fetch = async path => {
      if (String(path).endsWith("/access")) return --untilRevoked <= 0 ? response({code: "ALBUM_INACTIVE"}, 403) : response(overview(data));
      if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
      return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
    const lease = new AbortController(), url = await access.leaseRaster(photo, "thumbnail", lease.signal);
    untilRevoked = 2;
    await assert.rejects(access.leaseRaster(photo, "thumbnail", new AbortController().signal), /ALBUM_INACTIVE/);
    assert.deepEqual(revoked, [url]); assert.equal(access.signal.aborted, true);
    assert.ok(photo.metadataKey.every(value => value === 0));
  } finally {URL.revokeObjectURL = actualRevoke;}
}));

test("album raster cache cannot cross accounts or fall back from missing preview to an original", () => scoped(async () => {
  const data = await fixture(), actualRevoke = URL.revokeObjectURL, revoked: string[] = []; let reads = 0;
  URL.revokeObjectURL = url => {revoked.push(url); actualRevoke(url);};
  try {
    globalThis.fetch = async path => {
      if (String(path).endsWith("/access")) return response(overview(data));
      if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
      reads++; return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
    const beforeMissing = reads;
    await assert.rejects(access.leaseRaster(photo, "preview", new AbortController().signal), /PREVIEW_UNAVAILABLE/);
    assert.equal(reads, beforeMissing);
    const lease = new AbortController(), url = await access.leaseRaster(photo, "thumbnail", lease.signal);
    const beforeAccount = reads; await open(1);
    await assert.rejects(access.leaseRaster(photo, "thumbnail", new AbortController().signal));
    assert.equal(reads, beforeAccount); assert.deepEqual(revoked, [url]);
    assert.ok(photo.metadataKey.every(value => value === 0)); assert.equal(access.signal.aborted, true);
  } finally {URL.revokeObjectURL = actualRevoke;}
}));

test("closing the album scope immediately revokes displayed cache leases without another read", () => scoped(async () => {
  const data = await fixture(), actualRevoke = URL.revokeObjectURL, revoked: string[] = [];
  URL.revokeObjectURL = url => {revoked.push(url); actualRevoke(url);};
  try {
    globalThis.fetch = async path => {
      if (String(path).endsWith("/access")) return response(overview(data));
      if (String(path).startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
      return new Response(new Uint8Array(data.objects.get(String(path).split("/").at(-1)!)!));
    };
    const scope = new AbortController(), access = await AlbumAccess.open(overview(data), {signal: scope.signal});
    const [photo] = (await access.loadPhotoPage()).photos;
    const url = await access.leaseRaster(photo, "thumbnail", new AbortController().signal);
    scope.abort();
    assert.deepEqual(revoked, [url]); assert.equal(access.signal.aborted, true);
    assert.ok(photo.metadataKey.every(value => value === 0));
  } finally {URL.revokeObjectURL = actualRevoke;}
}));

test("search continuation retries transient metadata and fresh membership failures without losing verified photos", () => scoped(async () => {
  for (const failure of ["metadata-network", "metadata-http", "membership", "final-membership"] as const) {
    const {data, items, active, page} = await albumPages(3); let fail = false, accessReads = 0, failingAccessReads = 0;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) {accessReads++; if (fail && (failure === "membership" || failure === "final-membership" && ++failingAccessReads === 2)) return response({}, 503); return response(active);}
      if (url.startsWith("/v1/albums/")) return response(url.includes("?") ? page([1, 2], null) : page([0], "next_1"));
      const id = url.split("/").at(-1)!;
      assert.ok(items.some(item => item.photo.manifest.metadataRepresentation.objectId === id), "search fetches metadata only");
      if (fail && id === items[2].photo.manifest.metadataRepresentation.objectId) {
        if (failure === "metadata-network") throw new TypeError("network unavailable");
        if (failure === "metadata-http") return response({}, 503);
      }
      return new Response(new Uint8Array(data.objects.get(id)!));
    };
    const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage(); fail = true;
    await assert.rejects(access.loadPhotoPage(first.nextCursor, {preserveTransientFailure: true}));
    assert.equal(access.current(), true); assert.equal(access.signal.aborted, false);
    assert.ok(first.photos[0].metadataKey.some(byte => byte !== 0));
    const beforeRetry = accessReads; fail = false;
    const retried = await access.loadPhotoPage(first.nextCursor, {preserveTransientFailure: true});
    assert.equal(retried.hasMore, false); assert.equal(retried.photos.length, 2);
    assert.ok(accessReads >= beforeRetry + 2, "retry freshly fences metadata reads with membership checks");
    assert.deepEqual([...first.photos, ...retried.photos].map(photo => photo.manifest.photoId), items.map(item => item.photo.manifest.photoId)); access.dispose();
  }
}));

test("search continuation still clears access and old keys on revocation and corrupt metadata", () => scoped(async () => {
  for (const failure of ["revoked", "digest", "programmer"] as const) {
    const {data, active, page} = await albumPages(2); let fail = false;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return fail && failure === "revoked" ? response({code: "ALBUM_INACTIVE", retryable: true}, 403) : response(active);
      if (url.startsWith("/v1/albums/")) return response(url.includes("?") ? page([1], null) : page([0], "next_1"));
      if (fail && failure === "digest") return new Response(new Uint8Array([1, 2, 3]));
      const result = new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
      if (fail && failure === "programmer") Object.defineProperty(result, "arrayBuffer", {value: () => {throw new Error("unexpected decoder failure");}});
      return result;
    };
    const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage(); fail = true;
    await assert.rejects(access.loadPhotoPage(first.nextCursor, {preserveTransientFailure: true}));
    assert.equal(access.current(), false); assert.equal(access.signal.aborted, true);
    assert.ok(first.photos[0].metadataKey.every(byte => byte === 0));
  }
}));

test("ordinary paging retains strict disposal after transient metadata failure", () => scoped(async () => {
  const {data, active, page} = await albumPages(2); let fail = false;
  globalThis.fetch = async path => {
    const url = String(path);
    if (url.endsWith("/access")) return response(active);
    if (url.startsWith("/v1/albums/")) return response(url.includes("?") ? page([1], null) : page([0], "next_1"));
    return fail ? response({}, 503) : new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage(); fail = true;
  await assert.rejects(access.loadPhotoPage(first.nextCursor));
  assert.equal(access.current(), false); assert.ok(first.photos[0].metadataKey.every(byte => byte === 0));
}));

test("background overview retries temporary failures while confirmed denial wipes the displayed reader", () => scoped(async () => {
  for (const failure of ["transport", 408, 429, 503, 403] as const) {
    const data = await fixture(); let failing = false;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) {
        if (failing) {
          if (failure === "transport") throw new TypeError("Network interrupted");
          return response({code: "ALBUM_INACTIVE", retryable: true}, failure);
        }
        return response(overview(data));
      }
      if (url.startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], hasMore: false, nextCursor: null});
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), [photo] = (await access.loadPhotoPage()).photos;
    failing = true; await assert.rejects(access.refreshOverview());
    assert.equal(access.current(), failure !== 403);
    assert.equal(photo.metadataKey.some(byte => byte !== 0), failure !== 403);
    if (failure !== 403) {
      failing = false; assert.equal((await access.refreshOverview()).photoCount, 1);
      assert.deepEqual(await access.bytes(photo, "original", new AbortController().signal), data.original);
    }
    access.dispose();
  }
}));

test("search shared details retries fresh initial and final access fences without erasing photo keys", () => scoped(async () => {
  for (const phase of [1, 2]) {
    const data = await fixture(); let failing = false, factsAccessReads = 0;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return failing && ++factsAccessReads === phase ? response({}, 503) : response(overview(data));
      if (url.endsWith("/capabilities")) return response({version: 1, albumFactsVersion: 1});
      if (url.endsWith("/photo-facts")) return response({version: 1, facts: [], hasMore: false, nextCursor: null});
      if (url.startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], hasMore: false, nextCursor: null});
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), first = await access.loadPhotoPage(); failing = true;
    await assert.rejects(access.loadFacts({preserveTransientFailure: true}));
    assert.equal(access.current(), true); assert.ok(first.photos[0].metadataKey.some(byte => byte !== 0));
    failing = false; const facts = await access.loadFacts({preserveTransientFailure: true});
    assert.equal(facts.supported, true); assert.equal(facts.facts.size, 0); access.dispose();
  }
}));

test("a failed search metadata worker stops dispatching the rest of the page before retry", () => scoped(async () => {
  const {data, items, active, page} = await albumPages(10); let failing = false, reads = 0;
  globalThis.fetch = async path => {
    const url = String(path);
    if (url.endsWith("/access")) return response(active);
    if (url.startsWith("/v1/albums/")) return response(url.includes("?") ? page([1, 2, 3, 4, 5, 6, 7, 8, 9], null) : page([0], "next_1"));
    if (failing) {
      reads++;
      if (url.endsWith(items[1].photo.manifest.metadataRepresentation.objectId)) throw new TypeError("network unavailable");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
  };
  const access = await AlbumAccess.open(active, {}), first = await access.loadPhotoPage(); failing = true;
  await assert.rejects(access.loadPhotoPage(first.nextCursor, {preserveTransientFailure: true}));
  assert.ok(reads <= 4, "only already dispatched metadata reads may finish after failure");
  assert.equal(access.current(), true); assert.ok(first.photos[0].metadataKey.some(byte => byte !== 0));
  failing = false; const retry = await access.loadPhotoPage(first.nextCursor, {preserveTransientFailure: true});
  assert.equal(retry.photos.length, 9); access.dispose();
}));

test("direct shared details 401 and 403 immediately revoke access even when marked retryable", () => scoped(async () => {
  for (const status of [401, 403]) {
    const data = await fixture();
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return response(overview(data));
      if (url.endsWith("/capabilities")) return response({version: 1, albumFactsVersion: 1});
      if (url.endsWith("/photo-facts")) return response({code: "ALBUM_INACTIVE", retryable: true}, status);
      if (url.startsWith("/v1/albums/")) return response({...overview(data), version: 1, entries: [data.entry], manifests: [data.signed], hasMore: false, nextCursor: null});
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const access = await AlbumAccess.open(overview(data), {}), first = await access.loadPhotoPage();
    await assert.rejects(access.loadFacts({preserveTransientFailure: true}));
    assert.equal(access.current(), false); assert.equal(access.signal.aborted, true);
    assert.ok(first.photos[0].metadataKey.every(byte => byte === 0));
  }
}));

test("a transient refresh keeps the displayed reader usable and retries, while denied, trust, or corrupt refreshes revoke it", () => scoped(async () => {
  for (const failure of ["transient", "denied", "trust", "corrupt", "opening"] as const) {
    const data = await fixture();
    let failing = false;
    globalThis.fetch = async path => {
      const url = String(path);
      if (url.endsWith("/access")) return failing && failure === "trust" ? response({code: "ACCOUNT_KEYS_CHANGED_RENEW_TRUST"}, 409) : response(overview(data));
      if (url.startsWith("/v1/albums/")) {
        if (failing && ["transient", "denied"].includes(failure)) return response({}, failure === "transient" ? 503 : 403);
        return response({...overview(data), version: 1, entries: [failing && failure === "corrupt" ? {...data.entry, signature: "invalid"} : data.entry], manifests: [data.signed], nextCursor: null, hasMore: false});
      }
      return new Response(new Uint8Array(data.objects.get(url.split("/").at(-1)!)!));
    };
    const displayed = await AlbumAccess.open(overview(data), {}), [photo] = (await displayed.loadPhotoPage()).photos;
    if (failure === "opening") {
      const invalid = {...overview(data), definition: {...data.made.signed, signature: "invalid"}};
      const error = await AlbumAccess.open(invalid, {}).then(() => assert.fail("Opening must fail"), error => error);
      displayed.discardFailedRefresh(undefined, error);
      assert.equal(displayed.current(), false); assert.ok(photo.metadataKey.every(byte => byte === 0));
      continue;
    }
    const refreshed = await AlbumAccess.open(overview(data), {});
    failing = true;
    const error = await refreshed.loadPhotoPage().then(() => assert.fail("Refresh must fail"), error => error);
    displayed.discardFailedRefresh(refreshed, error);
    assert.equal(refreshed.signal.aborted, true, "The temporary reader always releases its keys");
    assert.equal(displayed.current(), failure === "transient");
    assert.equal(photo.metadataKey.some(byte => byte !== 0), failure === "transient");
    if (failure === "transient") {
      failing = false;
      assert.deepEqual(await displayed.bytes(photo, "original", new AbortController().signal), data.original, "Verified displayed originals remain usable after recovery");
      const retry = await AlbumAccess.open(overview(data), {}), page = await retry.loadPhotoPage();
      assert.equal(displayed.adoptRefresh(retry, page.photos)[0], photo, "Successful retry keeps the displayed source identity");
    }
    displayed.dispose();
  }
}));

test("one explicit original download waits for exact bytes and final membership, then publishes without a second gesture", async () => {
  const original = utf8("byte-identical family original"), bytes = original.slice();
  const photo = {metadata: {filename: "Family.png", mediaType: "image/png", originalBytes: bytes.length, originalSha256: digest(bytes)}} as Photo;
  let release!: (bytes: Uint8Array) => void, checked = 0;
  const access = {current: () => true, bytes: async () => new Promise<Uint8Array>(resolve => {release = resolve;}), assertAccess: async () => {checked++;}} as unknown as AlbumAccess;
  const published: File[] = [];
  const download = downloadAlbumOriginal(access, photo, new AbortController().signal, () => true, file => {published.push(file);});
  assert.equal(published.length, 0, "Preparing bytes never reports or starts a download early");
  release(bytes); await download;
  assert.equal(checked, 1); assert.equal(published.length, 1);
  assert.equal(published[0].name, "Family.png"); assert.equal(published[0].type, "image/png");
  assert.deepEqual(new Uint8Array(await published[0].arrayBuffer()), original);
  assert.ok(bytes.every(byte => byte === 0));
});

test("one-step original download publishes nothing after preview, account, or membership withdrawal", async () => {
  for (const withdrawal of ["preview", "abort", "access", "membership"] as const) {
    const bytes = utf8("exact original");
    const photo = {metadata: {filename: "Family.png", mediaType: "image/png", originalBytes: bytes.length, originalSha256: digest(bytes)}} as Photo;
    let release!: (bytes: Uint8Array) => void, current = true, allowed = true, published = 0;
    const controller = new AbortController();
    const access = {current: () => allowed, bytes: async () => new Promise<Uint8Array>(resolve => {release = resolve;}), assertAccess: async () => {if (withdrawal === "membership") throw new Error("ALBUM_ACCESS_ENDED");}} as unknown as AlbumAccess;
    const pending = downloadAlbumOriginal(access, photo, controller.signal, () => current, () => {published++;});
    if (withdrawal === "preview") current = false;
    if (withdrawal === "abort") controller.abort();
    if (withdrawal === "access") allowed = false;
    release(bytes);
    if (withdrawal === "membership" || withdrawal === "abort") await assert.rejects(pending);
    else await pending;
    assert.equal(published, 0); assert.ok(bytes.every(byte => byte === 0));
  }
});
