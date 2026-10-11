import {albumDetailsSelection, retainAlbumDetailsDraft} from "../src/albums/detail-selection";
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import type {PhotoManifestV1, RepresentationV1, MediaBinding, SignedPayloadV1} from "@fotoro/contracts";
import {ready, sodium, utf8, b64, unb64, encryptMedia, wrapKey, signPayload, verifyPayload} from "@fotoro/crypto";
import {makeAlbumDefinition, makeAlbumPhoto, verifyAlbumPhoto, verifyAlbumAction} from "@fotoro/crypto/albums";
import {makeAlbumPhotoFacts} from "@fotoro/crypto/album-photo-facts";
import {readAlbumPhotoFacts, validateAlbumPhotoFactsRequest} from "@fotoro/contracts/album-photo-facts";
import {validateAlbumAppend} from "@fotoro/contracts/albums";
import {factsWithPeople} from "@fotoro/contracts/people";
import {withAnnotationLocation} from "@fotoro/contracts/location";
import {configureVault, unlockVault, lockVault, requireVault} from "../src/vault/vault";
import {clearAccount} from "../src/exchange/cache";
import {pinCard, trustedCard} from "../src/exchange/share-service";
import {AlbumAccess} from "../src/albums/service";
import {AlbumActionQueue} from "../src/albums/action-queue";
import {loadAlbumSearchPages} from "../src/albums/search-loading";
import {joinAlbumInvitation} from "../src/albums/bootstrap";
import {collect, source, digest, type Photo} from "../src/library/catalog";
import {ownedAlbumDetails} from "../src/albums/details";
import {albumPhotoGroups, albumPreviewNavigation} from "../src/albums/browse";
import {albumPersonKey, albumReviewedPeople, searchAlbumPhotos} from "../src/albums/search";
import {tripPeopleLinks} from "../src/albums/people-links";
import type {OwnedPhotoSnapshot} from "../src/library/consumer-search";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]});
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
async function scoped(run: () => Promise<void>) {
  const original = globalThis.fetch; await ready;
  for (const card of accounts.accounts) await clearAccount(card.accountId);
  try {await run();} finally {globalThis.fetch = original; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
}
async function fixture(count = 1) {
  const objects = new Map<string, Uint8Array>(), original = utf8("public exact family original"), owner = await open(0);
  const made = makeAlbumDefinition({albumId: crypto.randomUUID(), title: "Family", createdAt: "2026-10-07T12:00:00.000Z", ownerCard: owner.card, members: accounts.accounts, signingSecretKey: owner.signingSecretKey});
  async function photo(index: number, name: string) {
    const session = await open(index), photoId = crypto.randomUUID(), metadataKey = sodium.randombytes_buf(32), mediaKey = sodium.randombytes_buf(32);
    const rep = async (kind: MediaBinding["kind"], bytes: Uint8Array, key: Uint8Array): Promise<RepresentationV1> => {
      const binding = {version: 1 as const, photoId, representationId: crypto.randomUUID(), kind}, encrypted = await collect(encryptMedia(source(bytes), key, binding)), objectId = crypto.randomUUID();
      objects.set(objectId, encrypted); return {binding, objectId, header: b64(encrypted.subarray(0, 24)), ciphertextBytes: encrypted.length, ciphertextSha256: digest(encrypted)};
    };
    const originalRep = await rep("original", original, mediaKey), thumbnail = await rep("thumbnail", utf8("public thumbnail"), mediaKey);
    const metadata = {version: 1 as const, filename: name, mediaType: "image/png" as const, sourceDate: "2021-10-01T12:00:00Z", dateSource: "photos" as const,
      originalBytes: original.length, originalSha256: digest(original), representationKeys: {[originalRep.binding.representationId]: b64(mediaKey), [thumbnail.binding.representationId]: b64(mediaKey)}};
    const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: session.accountId, representations: [originalRep, thumbnail], metadataRepresentation: await rep("metadata", utf8(metadata), metadataKey), ownerWrappedMetadataKey: wrapKey(metadataKey, session.vaultKey)};
    const signed = signPayload("photo-manifest", session.accountId, utf8(manifest), session.signingSecretKey), entry = makeAlbumPhoto({definition: made.definition, manifest: signed, metadataKey, albumKey: made.albumKey, signingSecretKey: session.signingSecretKey});
    return {photo: {manifest, metadata, metadataKey} as Photo, signed, entry};
  }
  const initial = [];
  for (let n = 0; n < count; n++) initial.push(await photo(0, "public-" + n + ".png"));
  const other = await photo(1, "public-copy.png"), entries = [...initial], facts = new Map<string, SignedPayloadV1>(), accepted = new Set([accounts.accounts[0].accountId]);
  const otherShared = makeAlbumPhotoFacts({signedDefinition: made.signed, trustedOwner: accounts.accounts[0], entry: other.entry, manifest: other.signed,
    originalSha256: other.photo.metadata.originalSha256, albumKey: made.albumKey, revision: 1, people: ["Dad"], signingSecretKey: requireVault().signingSecretKey});
  let ended = false, puts = 0, lists = 0, singleReads = 0, objectReads = 0, failNext = false, unsupported = false;
  const overview = () => ({definition: made.signed, membership: accepted.has(requireVault().accountId) ? "accepted" as const : "invited" as const, endedAt: ended ? "2026-10-08T12:00:00.000Z" : null, photoCount: entries.length});
  globalThis.fetch = async (input, init) => {
    const path = String(input), url = new URL(path, "https://public.test"), actor = new Headers(init?.headers).get("X-Fotoro-Account-Id")!;
    assert.equal(actor, requireVault().accountId);
    if (path === "/v1/albums") return response({version: 1, albums: [overview()]});
    if (path.endsWith("/accept")) {verifyAlbumAction({signedDefinition: made.signed, trustedOwner: accounts.accounts[0], signed: JSON.parse(String(init?.body)).action, action: "accept"}); accepted.add(actor); return response(overview());}
    if (ended || !accepted.has(actor)) return response({code: "ALBUM_INACTIVE"}, 403);
    if (path.endsWith("/end")) {verifyAlbumAction({signedDefinition: made.signed, trustedOwner: accounts.accounts[0], signed: JSON.parse(String(init?.body)).action, action: "end"}); ended = true; return response(overview());}
    if (path === "/v1/album-photo-facts/capabilities") return unsupported ? response({code: "NOT_FOUND"}, 404) : response({version: 1, albumFactsVersion: 1});
    if (url.pathname.endsWith("/photo-facts")) {
      lists++; if (failNext) {failNext = false; return response({code: "UNAVAILABLE", retryable: true}, 503);}
      const all = [...facts.values()], at = Number(url.searchParams.get("cursor") ?? 0), end = Math.min(at + 100, all.length);
      return response({version: 1, facts: all.slice(at, end), nextCursor: end < all.length ? String(end) : null, hasMore: end < all.length});
    }
    if (url.pathname.includes("/photo-facts/")) {
      const id = url.pathname.split("/").at(-1)!;
      if (init?.method === "PUT") {
        puts++; const request = validateAlbumPhotoFactsRequest(JSON.parse(String(init.body))), outer = readAlbumPhotoFacts(request.facts);
        assert.equal(outer.ownerAccountId, actor); assert.equal(outer.photoId, id); assert.equal(outer.definitionSignature, made.signed.signature);
        const card = accounts.accounts.find(card => card.accountId === actor)!; verifyPayload(request.facts, unb64(card.signingPublicKey));
        const prior = facts.get(id);
        if (prior && JSON.stringify(prior) === JSON.stringify(request.facts)) return response({version: 1, facts: prior});
        if (outer.revision !== (prior ? readAlbumPhotoFacts(prior).revision : 0) + 1) return response({code: "ALBUM_FACTS_CONFLICT"}, 409);
        facts.set(id, request.facts); return response({version: 1, facts: request.facts});
      }
      singleReads++; return response({version: 1, facts: facts.get(id) ?? null});
    }
    if (path.endsWith("/manifest")) return response(other.signed);
    if (path.endsWith("/photos")) {
      const request = validateAlbumAppend(JSON.parse(String(init?.body)));
      request.entries.forEach((entry, n) => {verifyAlbumPhoto({definition: made.definition, entry, manifest: request.manifests[n]}); entries.push({entry, signed: request.manifests[n], photo: other.photo});});
      return response({version: 1, albumId: made.definition.albumId, operationId: request.operationId, added: request.entries.length, photoCount: entries.length});
    }
    if (path.endsWith("/access")) return response(overview());
    if (path.startsWith("/v1/albums/")) {const at = Number(url.searchParams.get("cursor") ?? 0), page = entries.slice(at, at + 100), hasMore = at + page.length < entries.length; return response({...overview(), version: 1, entries: page.map(item => item.entry), manifests: page.map(item => item.signed), nextCursor: hasMore ? String(at + page.length) : null, hasMore});}
    objectReads++; const bytes = objects.get(path.split("/").at(-1)!); assert.ok(bytes); return new Response(new Uint8Array(bytes));
  };
  return {made, initial, other, otherShared, entries, facts, original, overview, counts: () => ({puts, lists, singleReads, objectReads}), fail() {failNext = true;}, legacy() {unsupported = true;}};
}
function reviewed(photo: Photo, session: ReturnType<typeof requireVault>, name: string, current = () => true) {
  photo.annotations = withAnnotationLocation({version: 1 as const, photoId: photo.manifest.photoId, originalSha256: photo.metadata.originalSha256,
    caption: "private caption", ocr: {text: "private OCR", confidence: 1, processor: "private"},
    facts: factsWithPeople([], photo.metadata.originalSha256, [{personId: crypto.randomUUID(), name, box: [0, 0, 1000, 1000]}])}, {latitude: 1.25, longitude: 103.8, source: "photos", name: "Public Grove"});
  const snapshot: OwnedPhotoSnapshot = {accountId: session.accountId, token: session, photos: [photo], current, sourceCurrent: () => current(), preview: async () => new Blob()};
  return ownedAlbumDetails(photo, snapshot)!;
}

test("A explicitly shares reviewed details; B accepts, finds People/place/time, contributes own copy and preserves both originals", () => scoped(async () => {
  const data = await fixture(); const a = await open(0), aAccess = await AlbumAccess.open(data.overview(), {}), [aPhoto] = (await aAccess.loadPhotoPage()).photos, sourceA = reviewed(data.initial[0].photo, a, "Mum");
  assert.equal((await aAccess.loadFacts()).facts.size, 0);
  await aAccess.shareDetails(aPhoto, sourceA, {people: false, location: false}, 1);
  const empty = await aAccess.loadFacts(); assert.equal(searchAlbumPhotos([aPhoto], "Mum", () => true, Date.now(), {facts: empty.facts}).length, 0);
  const shared = await aAccess.shareDetails(aPhoto, sourceA, {people: true, location: true}, 2);
  assert.deepEqual(shared.people, ["Mum"]); assert.equal(shared.location?.name, "Public Grove");
  const selected = albumDetailsSelection(sourceA, await aAccess.readFactsFor(aPhoto));
  assert.deepEqual(selected.people, ["Mum"]); assert.equal(selected.location, true);
  const retained = await aAccess.shareDetails(aPhoto, sourceA, selected, shared.revision + 1);
  assert.deepEqual(retained.people, shared.people); assert.deepEqual(retained.location, shared.location);
  assert.equal(JSON.stringify(shared).includes("private caption"), false); assert.equal(JSON.stringify(shared).includes("private OCR"), false);
  aAccess.dispose();
  const b = await open(1); await assert.rejects(trustedCard(accounts.accounts[0].accountId), /PIN_ACCOUNT_CARD/);
  const joined = await joinAlbumInvitation(data.overview(), {}, accounts.accounts[0]); assert.equal(joined.membership, "accepted");
  assert.deepEqual(await trustedCard(accounts.accounts[0].accountId), accounts.accounts[0]);
  let bAccess = await AlbumAccess.open(data.overview(), {}), bPhotos = (await bAccess.loadPhotoPage()).photos, bFacts = await bAccess.loadFacts();
  assert.equal(searchAlbumPhotos(bPhotos, "Grove 2021", () => bAccess.current(), Date.now(), {facts: bFacts.facts}).length, 1);
  assert.equal(searchAlbumPhotos(bPhotos, "Mum", () => bAccess.current(), Date.now(), {facts: bFacts.facts}).length, 1);
  assert.equal(await bAccess.add([data.other.photo], () => [data.other.photo]), 1); bAccess.dispose();
  bAccess = await AlbumAccess.open(data.overview(), {}); bPhotos = (await bAccess.loadPhotoPage()).photos;
  const bPhoto = bPhotos.find(photo => photo.manifest.ownerAccountId === b.accountId)!, sourceB = reviewed(data.other.photo, b, "Dad");
  await assert.rejects(bAccess.shareDetails(bPhotos.find(photo => photo !== bPhoto)!, sourceB, {people: true, location: false}, 1), /SELECTION_CHANGED/);
  await bAccess.shareDetails(bPhoto, sourceB, {people: true, location: false}, 1); bFacts = await bAccess.loadFacts();
  const tokens = new Set([albumPersonKey(accounts.accounts[0].accountId, "Mum"), albumPersonKey(b.accountId, "Dad")]);
  assert.deepEqual(searchAlbumPhotos(bPhotos, "", () => bAccess.current(), Date.now(), {facts: bFacts.facts, people: {ids: tokens, mode: "everyone"}}), [], "Names on different copies are not evidence of everyone in one photo");
  const any = searchAlbumPhotos(bPhotos, "2021", () => bAccess.current(), Date.now(), {facts: bFacts.facts, people: {ids: tokens, mode: "any"}, from: "2021-10-01", through: "2021-10-01"});
  const grouped = albumPhotoGroups(any); assert.equal(grouped.length, 1); assert.equal(grouped[0].copies.length, 2); assert.ok(grouped[0].copies.includes(bPhoto), "Own copy remains reachable for its editor");
  assert.equal(albumReviewedPeople(bPhotos, bFacts.facts, () => bAccess.current()).length, 2);
  for (const photo of bPhotos) assert.deepEqual(await bAccess.bytes(photo, "original", new AbortController().signal), data.original);
  const beforeConflict = data.counts().puts;
  await assert.rejects(bAccess.shareDetails(bPhoto, sourceB, {people: false, location: false}, 1), /CONFLICT/); assert.equal(data.counts().puts, beforeConflict + 1);
  await bAccess.shareDetails(bPhoto, sourceB, {people: false, location: false}, 2);
  assert.equal(searchAlbumPhotos(bPhotos, "Dad", () => bAccess.current(), Date.now(), {facts: (await bAccess.loadFacts()).facts}).length, 0);
  bAccess.dispose();
  await open(0); const ownerAgain = await AlbumAccess.open(data.overview(), {}); await ownerAgain.loadPhotoPage(); await ownerAgain.end();
  await open(1); const beforeRead = data.counts().objectReads;
  await assert.rejects(AlbumAccess.open(data.overview(), {}), /ACCESS_ENDED/); assert.equal(data.counts().objectReads, beforeRead);
}));

test("shared facts paging is bounded100, defers unmatched sources and distinguishes legacy, network and invalid signatures", () => scoped(async () => {
  const data = await fixture(101), a = await open(0);
  for (const item of data.initial) data.facts.set(item.photo.manifest.photoId, makeAlbumPhotoFacts({signedDefinition: data.made.signed, trustedOwner: a.card, entry: item.entry, manifest: item.signed,
    originalSha256: item.photo.metadata.originalSha256, albumKey: data.made.albumKey, revision: 1, people: ["Mum"], signingSecretKey: a.signingSecretKey}));
  const access = await AlbumAccess.open(data.overview(), {}), firstPage = await access.loadPhotoPage();
  assert.equal(firstPage.photos.length, 100); assert.equal(firstPage.hasMore, true);
  const lastPage = await access.loadPhotoPage(firstPage.nextCursor); assert.equal(lastPage.photos.length, 1); assert.equal(lastPage.hasMore, false);
  const before = data.counts(), loaded = await access.loadFacts(); assert.equal(loaded.facts.size, 101); assert.equal(loaded.unmatched, 0);
  assert.equal(data.counts().lists - before.lists, 2); assert.equal(data.counts().singleReads - before.singleReads, 0); assert.equal(data.counts().objectReads, before.objectReads);
  data.entries.push(data.other); data.facts.set(data.other.photo.manifest.photoId, data.otherShared);
  const partial = await access.loadFacts(); assert.equal(partial.facts.size, 101); assert.equal(partial.unmatched, 1, "New sidecars cannot publish before their immutable photo metadata is loaded");
  data.fail(); await assert.rejects(access.loadFacts(), /UNAVAILABLE/); assert.equal(access.current(), true);
  const first = data.facts.values().next().value!; data.facts.set(readAlbumPhotoFacts(first).photoId, {...first, signature: b64(new Uint8Array(64))});
  await assert.rejects(access.loadFacts()); assert.equal(access.current(), true);
  data.legacy(); assert.deepEqual(await access.loadFacts(), {supported: false, facts: new Map(), unmatched: 0}); access.dispose();
}));

test("whole-trip search finds a later-page person, place, date and filename using metadata alone", () => scoped(async () => {
  const data = await fixture(101), session = await open(0), last = data.initial[100];
  data.facts.set(last.photo.manifest.photoId, makeAlbumPhotoFacts({signedDefinition: data.made.signed, trustedOwner: session.card,
    entry: last.entry, manifest: last.signed, originalSha256: last.photo.metadata.originalSha256, albumKey: data.made.albumKey,
    revision: 1, people: ["Mum"], location: {latitude: 1.25, longitude: 103.8, source: "photos", name: "Public Grove"}, signingSecretKey: session.signingSecretKey}));
  const access = await AlbumAccess.open(data.overview(), {});
  let page = await access.loadPhotoPage(), photos = [...page.photos], facts = await access.loadFacts();
  const find = (query: string) => searchAlbumPhotos(photos, query, () => access.current(), Date.now(), {facts: facts.facts});
  assert.equal(find("Mum Grove October 2021").length, 0);
  const before = data.counts().objectReads;
  await loadAlbumSearchPages({queue: new AlbumActionQueue(() => access.current(), () => {}), current: () => access.current(), page: () => page, load: async cursor => {
    page = await access.loadPhotoPage(cursor); photos.push(...page.photos); facts = await access.loadFacts();
  }});
  assert.equal(page.hasMore, false);
  assert.deepEqual(find("Mum Grove October 2021").map(photo => photo.manifest.photoId), [last.photo.manifest.photoId]);
  assert.deepEqual(find("public 100").map(photo => photo.manifest.photoId), [last.photo.manifest.photoId]);
  assert.equal(data.counts().objectReads - before, 1, "Only the one remaining encrypted metadata object is fetched");
  access.dispose();
}));

test("late shared facts and changed owned annotations cannot publish across close/account/source changes", () => scoped(async () => {
  const data = await fixture(), a = await open(0), controller = new AbortController(), access = await AlbumAccess.open(data.overview(), {signal: controller.signal});
  const [photo] = (await access.loadPhotoPage()).photos, ownedSource = reviewed(data.initial[0].photo, a, "Mum");
  data.initial[0].photo.annotations = {...data.initial[0].photo.annotations!, caption: "new private revision"};
  const before = data.counts().puts;
  await assert.rejects(access.shareDetails(photo, ownedSource, {people: true, location: true}, 1), /SELECTION_CHANGED/); assert.equal(data.counts().puts, before);
  const originalFetch = globalThis.fetch; let release!: (value: Response) => void;
  globalThis.fetch = async (path, init) => String(path).endsWith("/photo-facts") ? new Promise<Response>(resolve => {release = resolve;}) : originalFetch(path, init);
  const loading = access.loadFacts(), rejected = assert.rejects(loading, /VAULT_LOCKED|aborted|closed|AbortError/i);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(); await open(1); release(response({version: 1, facts: [], nextCursor: null, hasMore: false})); await rejected;
  assert.equal(access.current(), false);
}));

test("new contributions retain unsaved shared-detail choices only for the unchanged admitted source", () => scoped(async () => {
  const data = await fixture(), session = await open(0), access = await AlbumAccess.open(data.overview(), {});
  const [photo] = (await access.loadPhotoPage()).photos, source = reviewed(data.initial[0].photo, session, "Mum");
  const latest = await access.shareDetails(photo, source, {people: true, location: false}, 1);
  const draft = {photo, source, revision: 2, people: ["Mum"], location: true, existing: true, unavailable: 0};
  data.entries.push(data.other);
  const refreshed = await AlbumAccess.open(data.overview(), {}), loaded = await refreshed.loadPhotoPage();
  const retained = access.adoptRefresh(refreshed, loaded.photos);
  assert.equal(retained.length, 2); assert.equal(retained[0], photo);
  assert.equal(retainAlbumDetailsDraft(draft, retained), draft, "Refresh must preserve the contributor's unsaved location choice");
  // Another device changes the shared revision while this draft is open.
  await access.shareDetails(photo, source, {people: false, location: false}, latest.revision + 1);
  await assert.rejects(access.shareDetails(photo, source, draft, draft.revision), /CONFLICT/, "Preserving the draft cannot bypass remote revision conflict checks");
  assert.equal(retainAlbumDetailsDraft(draft, retained.filter(item => item !== photo)), null);
  assert.equal(retainAlbumDetailsDraft(draft, [{...photo}]), null, "A replacement object cannot inherit choices even if its IDs match");
  data.initial[0].photo.annotations = {...data.initial[0].photo.annotations!, caption: "new private revision"};
  assert.equal(source.current(), false);
  assert.equal(retainAlbumDetailsDraft(draft, retained), null, "Changed private reviewed details require a fresh explicit review");
  access.dispose();
}));

test("equal shared names stay contributor-scoped, date constraints apply before grouping, and grouping preserves source distinctions", () => {
  const sha = b64(new Uint8Array(32)), photos = Array.from({length: 250}, (_, n) => ({manifest: {photoId: String(n), ownerAccountId: n % 2 ? "A" : "B"},
    metadata: {filename: "public.png", originalSha256: sha, originalBytes: 20, mediaType: "image/png", sourceDate: "2021-10-01T12:00:00Z", dateSource: "photos"}, annotations: {facts: ["private"]}} as Photo));
  const facts = new Map(photos.map(photo => [photo.manifest.photoId, {version: 1 as const, albumId: "album", photoId: photo.manifest.photoId, ownerAccountId: photo.manifest.ownerAccountId,
    definitionSignature: "signed", revision: 1, originalSha256: sha, people: ["Mum"], location: {latitude: 1, longitude: 2, source: "photos" as const, name: "Grove"}}]));
  const people = albumReviewedPeople(photos, facts, () => true); assert.equal(people.length, 2); assert.notEqual(people[0].id, people[1].id);
  assert.equal(searchAlbumPhotos(photos, "Grove 2021", () => true, Date.now(), {facts}).length, 250, "Shared search must not truncate eligible matches at200");
  const onlyA = searchAlbumPhotos(photos, "Mum", () => true, Date.now(), {facts, people: {ids: new Set([albumPersonKey("A", "Mum")]), mode: "any"}, from: "2021-10-01", through: "2021-10-01"});
  assert.equal(onlyA.length, 125); assert.ok(onlyA.every(photo => photo.manifest.ownerAccountId === "A"));
  const grouped = albumPhotoGroups(onlyA); assert.equal(grouped.length, 1); assert.equal(grouped[0].copies.length, 125);
  assert.equal(searchAlbumPhotos(photos, "Mum", () => true, Date.now(), {facts, from: "2021-10-02"}).length, 0);
  const imported = {...photos[0], metadata: {...photos[0].metadata, dateSource: "import" as const}};
  assert.equal(searchAlbumPhotos([imported], "2021", () => true, Date.now(), {facts}).length, 0);
  assert.equal(searchAlbumPhotos([imported], "", () => true, Date.now(), {facts, from: "2021-10-01"}).length, 0);
  const variants = [photos[0], {...photos[1], metadata: {...photos[1].metadata, originalBytes: 21}}, {...photos[2], metadata: {...photos[2].metadata, mediaType: "image/jpeg" as const}}, {...photos[3], metadata: {...photos[3].metadata, originalSha256: b64(new Uint8Array(32).fill(1))}}];
  assert.equal(albumPhotoGroups(variants).length, 4); assert.equal(albumPhotoGroups(photos, false).length, 250);
  assert.deepEqual(albumPhotoGroups(photos, true, () => false), []);
  const stale = new Map(facts); stale.set(photos[0].manifest.photoId, {...facts.get(photos[0].manifest.photoId)!, originalSha256: "changed"});
  assert.equal(searchAlbumPhotos([photos[0]], "Mum", () => true, Date.now(), {facts: stale}).length, 0);
  assert.equal(searchAlbumPhotos(photos, "private", () => true, Date.now(), {facts}).length, 0);
});

test("explicit Join verifies the reviewed sender and late cancellation cannot return accepted entry", () => scoped(async () => {
  const data = await fixture(); await open(1);
  await assert.rejects(joinAlbumInvitation(data.overview(), {}, accounts.accounts[1]));
  await assert.rejects(trustedCard(accounts.accounts[0].accountId), /PIN_ACCOUNT_CARD/);
  const originalFetch = globalThis.fetch; let active = true, release!: () => void;
  globalThis.fetch = async (path, init) => {
    if (String(path).endsWith("/accept")) {await new Promise<void>(resolve => {release = resolve;});}
    return originalFetch(path, init);
  };
  const joining = joinAlbumInvitation(data.overview(), {current: () => active}, accounts.accounts[0]), rejected = assert.rejects(joining, {name: "AbortError"});
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  active = false; release(); await rejected;
}));


test("family query ANDs shared name, place and natural capture month on the same contributed copy", () => {
  const sha = b64(new Uint8Array(32));
  const photo = (id: string, date = "2025-06-03T12:00:00Z", dateSource = "photos") => ({manifest: {photoId: id, ownerAccountId: "A"}, metadata: {filename: "public.jpg", originalSha256: sha, originalBytes: 20, mediaType: "image/jpeg", sourceDate: date, dateSource}, annotations: {facts: ["private London Mum"], caption: "private London Mum"}} as Photo);
  const rows = [photo("match"), photo("wrong-place"), photo("wrong-person"), photo("wrong-month", "2025-07-03T12:00:00Z"), photo("import", undefined, "import"), photo("unknown", undefined, "unknown"), photo("bad-date", "invalid")];
  const facts = new Map(rows.map(row => [row.manifest.photoId, {version: 1 as const, albumId: "album", photoId: row.manifest.photoId, ownerAccountId: "A", definitionSignature: "signed", revision: 1, originalSha256: sha, people: [row.manifest.photoId === "wrong-person" ? "Dad" : "Mum"], location: {latitude: 1, longitude: 2, source: "photos" as const, name: row.manifest.photoId === "wrong-place" ? "Paris" : "London"}}]));
  const find = (query: string) => searchAlbumPhotos(rows, query, () => true, Date.now(), {facts}).map(row => row.manifest.photoId);
  assert.deepEqual(find("Mum London June 2025"), ["match"]);
  assert.deepEqual(find("June 2025 Mum London"), ["match"]);
  assert.deepEqual(find("London Mum 2025-06"), ["match"]);
  assert.deepEqual(find("Mum London July 2025"), ["wrong-month"]);
  assert.deepEqual(find("Mum Lon"), ["match", "wrong-month", "import", "unknown", "bad-date"], "Only the last text token allows completion; undated queries do not invent a date requirement");
  assert.deepEqual(find("Mum private June 2025"), []);
  assert.deepEqual(searchAlbumPhotos(rows, "Mum London June 2025", () => false, Date.now(), {facts}), []);
  const stale = new Map(facts); stale.set("match", {...facts.get("match")!, originalSha256: "changed"});
  assert.deepEqual(searchAlbumPhotos(rows, "Mum London June 2025", () => true, Date.now(), {facts: stale}), []);
  assert.equal(albumPhotoGroups(searchAlbumPhotos(rows, "Mum London June 2025", () => true, Date.now(), {facts}))[0].copies.length, 1, "Other exact copies cannot supply missing query fields");
});

test("grouped trip preview follows matching tiles while contributor copies stay individually reachable", () => {
  const photo = (id: string, owner: string, digest: number) => ({manifest: {photoId: id, ownerAccountId: owner},
    metadata: {filename: id + ".jpg", originalSha256: b64(new Uint8Array(32).fill(digest)), originalBytes: 20,
      mediaType: "image/jpeg", sourceDate: "2025-06-03T12:00:00Z", dateSource: "photos"}} as Photo);
  const first = photo("first", "A", 1), firstCopy = photo("first-copy", "B", 1), second = photo("second", "A", 2), last = photo("last", "B", 3);
  const rows = [first, firstCopy, second, last];
  const facts = new Map(rows.map(row => [row.manifest.photoId, {version: 1 as const, albumId: "album", photoId: row.manifest.photoId,
    ownerAccountId: row.manifest.ownerAccountId, definitionSignature: "signed", revision: 1,
    originalSha256: row.metadata.originalSha256, people: row === first ? ["Dad"] : ["Mum"]}]));
  const grouped = albumPhotoGroups(searchAlbumPhotos(rows, "", () => true, Date.now(), {facts}));
  const openedCopy = albumPreviewNavigation(grouped, firstCopy);
  assert.equal(openedCopy.index, 0); assert.equal(openedCopy.count, 3);
  assert.equal(openedCopy.previous, undefined); assert.equal(openedCopy.next, second);
  assert.deepEqual(openedCopy.copies, [first, firstCopy], "The owner-specific original and details remain reachable");
  const middle = albumPreviewNavigation(grouped, openedCopy.next!);
  assert.equal(middle.previous, first); assert.equal(middle.next, last);
  assert.equal(albumPreviewNavigation(grouped, last).next, undefined);
  const matching = albumPhotoGroups(searchAlbumPhotos(rows, "Mum", () => true, Date.now(), {facts}));
  assert.equal(albumPreviewNavigation(matching, firstCopy).next, second);
  assert.deepEqual(albumPreviewNavigation(matching, firstCopy).copies, [firstCopy], "Copies that do not satisfy the search never supply fields or navigation");
  const outside = albumPreviewNavigation(matching, first);
  assert.equal(outside.index, -1); assert.equal(outside.previous, undefined); assert.equal(outside.next, undefined);
  assert.deepEqual(outside.copies, []);
  const ungrouped = albumPhotoGroups(rows, false);
  assert.equal(albumPreviewNavigation(ungrouped, first).next, firstCopy);
  assert.equal(albumPreviewNavigation(ungrouped, firstCopy).previous, first);
  assert.equal(albumPreviewNavigation(ungrouped, firstCopy).count, 4);
});

test("explicit private links match contributor aliases but Everyone and text stay on one authenticated copy", () => scoped(async () => {
  const data = await fixture(), a = await open(0), first = await AlbumAccess.open(data.overview(), {}), [aPhoto] = (await first.loadPhotoPage()).photos;
  const sourceA = reviewed(data.initial[0].photo, a, "Mum");
  await first.shareDetails(aPhoto, sourceA, {people: true, location: false}, 1); first.dispose();
  const b = await open(1); await joinAlbumInvitation(data.overview(), {}, accounts.accounts[0]);
  const adding = await AlbumAccess.open(data.overview(), {}); await adding.add([data.other.photo], () => [data.other.photo]); adding.dispose();
  const access = await AlbumAccess.open(data.overview(), {}), photos = (await access.loadPhotoPage()).photos, own = photos.find(photo => photo.manifest.ownerAccountId === b.accountId)!;
  await access.shareDetails(own, reviewed(data.other.photo, b, "Mom"), {people: true, location: false}, 1);
  const facts = (await access.loadFacts()).facts, ownerCard = accounts.accounts[0], cards = access.definition.members.map(member => member.card);
  const scope = {accountId: b.accountId, origin: "https://fotoro.cloud", albumId: access.albumId, ownerCard, cards, current: () => access.current()};
  const mum = {id: crypto.randomUUID(), origin: scope.origin, albumId: scope.albumId, ownerCard, name: "Mother", aliases: [{card: ownerCard, name: "Mum"}, {card: b.card, name: "Mom"}], deleted: false};
  const dad = {...mum, id: crypto.randomUUID(), name: "Father", aliases: [{card: ownerCard, name: "Dad"}, {card: b.card, name: "Papa"}]};
  const book = {version: 1 as const, ownerAccountId: b.accountId, links: [mum, dad]};
  let linkedPeople = tripPeopleLinks(book, photos, facts, scope);
  assert.equal(linkedPeople.length, 1); assert.equal(linkedPeople[0].aliases.length, 2);
  assert.equal(searchAlbumPhotos(photos, "Mother", scope.current, Date.now(), {facts, linkedPeople}).length, 2);
  assert.equal(searchAlbumPhotos(photos, "Father", scope.current, Date.now(), {facts, linkedPeople}).length, 0, "A label without any authenticated source alias supplies no text");
  await access.shareDetails(own, {...reviewed(data.other.photo, b, "Mom"), people: ["Mom", "Papa"]}, {people: true, location: false}, 2);
  const bothFacts = (await access.loadFacts()).facts; linkedPeople = tripPeopleLinks(book, photos, bothFacts, scope);
  const everyone = searchAlbumPhotos(photos, "", scope.current, Date.now(), {facts: bothFacts, linkedPeople, people: {ids: new Set(linkedPeople.map(person => person.id)), mode: "everyone"}});
  assert.deepEqual(everyone, [own], "Two distinct canonical people must be present in one contributor's authenticated facts");
  assert.equal(searchAlbumPhotos(photos, "Mother Father", scope.current, Date.now(), {facts: bothFacts, linkedPeople}).length, 1);
  assert.deepEqual(tripPeopleLinks(book, photos, bothFacts, {...scope, origin: "https://other.test"}), []);
  assert.deepEqual(tripPeopleLinks(book, photos, bothFacts, {...scope, accountId: ownerCard.accountId}), []);
  assert.deepEqual(tripPeopleLinks(book, photos, bothFacts, {...scope, ownerCard: {...ownerCard, signingPublicKey: b.card.signingPublicKey}}), []);
  const onlyOwner = tripPeopleLinks(book, photos, bothFacts, {...scope, cards: [ownerCard]});
  assert.equal(onlyOwner.length, 1); assert.equal(onlyOwner[0].aliases.length, 1, "Absent contributor aliases never project");
  const changedContributor = tripPeopleLinks(book, photos, bothFacts, {...scope, cards: [ownerCard, {...b.card, signingPublicKey: ownerCard.signingPublicKey}]});
  assert.equal(searchAlbumPhotos(photos, "Mother", scope.current, Date.now(), {facts: bothFacts, linkedPeople: changedContributor}).length, 1, "The same name on a changed contributor card never supplies a canonical label");
  assert.deepEqual(tripPeopleLinks({...book, links: [{...mum, deleted: true}]}, photos, bothFacts, scope), []);
  access.dispose(); assert.deepEqual(tripPeopleLinks(book, photos, bothFacts, scope), []);
}));

test("linked-person aliases and labels are indexed once independently of photo count", () => {
  const owner = accounts.accounts[0].accountId;
  const photos = Array.from({length: 1000}, (_, index) => ({manifest: {photoId: "photo-" + index, ownerAccountId: owner}, metadata: {filename: "public.png", originalSha256: "original-" + index}} as Photo));
  const facts = new Map(photos.map(photo => [photo.manifest.photoId, {version: 1 as const, albumId: "public-trip", photoId: photo.manifest.photoId, ownerAccountId: owner, originalSha256: photo.metadata.originalSha256, people: ["Mum"]}]));
  let aliasReads = 0, labelReads = 0, idReads = 0;
  const linkedPeople = Array.from({length: 256}, (_, index) => ({
    get id() {idReads++; return "linked:" + index;},
    get name() {labelReads++; return index === 0 ? "Mother" : "Other";},
    get aliases() {aliasReads++; return [albumPersonKey(owner, index === 0 ? "Mum" : "Other " + index)];},
  }));
  const result = searchAlbumPhotos(photos, "Mother", () => true, Date.now(), {facts, linkedPeople, people: {ids: new Set(["linked:0"]), mode: "everyone"}});
  assert.deepEqual(result, photos, "Each photo receives only the label supported by its own reviewed source name");
  assert.equal(aliasReads, linkedPeople.length, "Aliases are enumerated once, rather than once per photo");
  assert.equal(labelReads, linkedPeople.length); assert.equal(idReads, linkedPeople.length);
});
