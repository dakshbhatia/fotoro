import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, sodium, unb64, b64, encryptMedia, signPayload, utf8, wrapKey} from "@fotoro/crypto";
import type {MediaBinding, PhotoManifestV1, PhotoMetadataV1, RepresentationV1, SignedPayloadV1} from "@fotoro/contracts";
import {configureVault, unlockVault, lockVault, encryptPrivate, type UnlockedVault} from "../src/vault/vault";
import {atomic, clearAccount, get, put} from "../src/exchange/cache";
import {cachedCatalog, cachedCatalogSnapshot, collect, digest, source} from "../src/library/catalog";
import {cachedSync, refreshSync, readableSyncError} from "../src/exchange/sync";
import {ExpiredSavedSelection} from "../src/exchange/sharing";
import {PhotoSelectionButton} from "../src/library/Library";
import {ConsumerSelectionRetention, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import {renderToStaticMarkup} from "react-dom/server";

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

const orderedID = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
test("large cached browse opens a bounded first page, preserves selected sources and continues after deletions", {timeout: 20000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  let requests = 0;
  try {
    for (let n = 0; n < 1000; n++) await fixture(session, objects, `public-${n}.jpg`, orderedID(n));
    globalThis.fetch = (async (input: string | URL | Request) => {
      requests++; const objectId = String(input).split("/").at(-1)!;
      const bytes = objects.get(objectId); assert.ok(bytes); return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const first = await cachedSync(session, undefined, {limit: 100});
    assert.equal(requests, 100, "The first view must not fetch metadata for the other 900 photos");
    assert.deepEqual(first.coverage, {loaded: 100, cachedTotal: 1000, hasMore: true, hasMoreChanges: null});
    assert.deepEqual(first.photos.map(photo => photo.manifest.photoId), Array.from({length: 100}, (_, n) => orderedID(n)));
    // A low-sorting insertion must not remove a manually selected previous edge of the window.
    const selectedID = orderedID(99);
    await fixture(session, objects, "new-public.jpg", "00000000-0000-4000-8000-000000000000".replace(/0$/, "a"));
    const retained = await cachedSync(session, undefined, {limit: 100, retainPhotoIds: [selectedID]});
    assert.ok(retained.photos.some(photo => photo.manifest.photoId === selectedID));
    assert.equal(retained.coverage.loaded, 101);
    // Re-read a bounded prefix, so a deleted earlier row cannot make a continuation skip an unseen row.
    await atomic(Array.from({length: 10}, (_, n) => ({store: "catalog" as const, key: session.accountId + ":" + orderedID(n)})));
    const second = await cachedSync(session, undefined, {limit: 200});
    assert.equal(second.photos.length, 200);
    assert.ok(second.photos.some(photo => photo.manifest.photoId === orderedID(208)));
    assert.ok(second.photos.every(photo => !Array.from({length: 10}, (_, n) => orderedID(n)).includes(photo.manifest.photoId)));
    const complete = await cachedSync(session, undefined, {limit: 1100});
    assert.equal(complete.photos.length, 991);
    assert.equal(complete.coverage.hasMore, false);
    assert.equal(complete.coverage.hasMoreChanges, null, "Cached metadata cannot claim the server has been fully checked");
    assert.equal(new Set(complete.photos.map(photo => photo.manifest.photoId)).size, 991);
    assert.ok(first.photos.every(photo => photo.metadataKey.some(byte => byte !== 0)), "Page changes cannot zero gallery-held keys");
    const expired = new ExpiredSavedSelection(session.accountId, complete.photos, new Set([orderedID(999)]));
    assert.deepEqual(expired.photoIdsFor(accounts.accounts[1].accountId), []);
    lockVault(); const renewed = await open(0);
    const restored = await cachedSync(renewed, undefined, {limit: 100, retainPhotoIds: expired.photoIdsFor(renewed.accountId)});
    assert.equal(restored.photos.length, 101, "Recover an exact historical choice without hydrating the other 890 rows");
    assert.deepEqual([...expired.restore(restored.photos, renewed.accountId)], [orderedID(999)]);
    await atomic([{store: "catalog", key: renewed.accountId + ":" + orderedID(999)}]);
    const deleted = await cachedSync(renewed, undefined, {limit: 100, retainPhotoIds: expired.photoIdsFor(renewed.accountId)});
    assert.deepEqual([...expired.restore(deleted.photos, renewed.accountId)], [], "Retained IDs cannot resurrect a deleted source");
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("bounded server refresh resumes the committed cursor one page at a time without claiming early completion", {timeout: 15000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const items = [];
  try {
    for (let n = 0; n < 225; n++) items.push(await fixture(session, objects, `public-${n}.jpg`, orderedID(n)));
    await atomic(items.map(item => ({store: "catalog" as const, key: session.accountId + ":" + item.manifest.photoId})));
    const cursors: (string | null)[] = []; let metadataReads = 0, failNext = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://public.test");
      if (url.pathname === "/v1/changes") {
        const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
        if (failNext) {failNext = false; return new Response(JSON.stringify({version: 1, code: "UNAVAILABLE", retryable: true, requestId: crypto.randomUUID()}), {status: 503});}
        const start = cursor ? Number(cursor) : 0, end = Math.min(start + 100, items.length);
        return new Response(JSON.stringify({version: 1, mediaVersion: 1,
          changes: items.slice(start, end).map((item, offset) => ({cursor: String(start + offset + 1), entity: "photo", entityId: item.manifest.photoId, deleted: false, payload: item.signed})),
          nextCursor: String(end), hasMore: end < items.length}));
      }
      metadataReads++; const bytes = objects.get(url.pathname.split("/").at(-1)!); assert.ok(bytes); return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const first = await refreshSync(session, {limit: 100});
    assert.deepEqual(cursors, [null]); assert.equal(metadataReads, 100);
    assert.deepEqual(first.coverage, {loaded: 100, cachedTotal: 100, hasMore: false, hasMoreChanges: true});
    assert.equal(first.lastSuccessfulSync, null);
    failNext = true;
    await assert.rejects(refreshSync(session, {limit: 200}), /UNAVAILABLE/);
    assert.equal(metadataReads, 100);
    assert.equal((await cachedSync(session, undefined, {limit: 100})).coverage.hasMoreChanges, true);
    const second = await refreshSync(session, {limit: 200});
    assert.deepEqual(cursors, [null, "100", "100"]); assert.equal(metadataReads, 200);
    assert.equal(second.photos.length, 200); assert.equal(second.coverage.hasMoreChanges, true);
    assert.equal(second.lastSuccessfulSync, null);
    const third = await refreshSync(session, {limit: 300});
    assert.deepEqual(cursors, [null, "100", "100", "200"]); assert.equal(metadataReads, 225);
    assert.deepEqual(third.coverage, {loaded: 225, cachedTotal: 225, hasMore: false, hasMoreChanges: false});
    assert.ok(third.lastSuccessfulSync);
    assert.equal(new Set(third.photos.map(photo => photo.manifest.photoId)).size, 225);
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("lock/account change during bounded metadata hydration rejects the old window and cannot seed the new account", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const item = await fixture(session, objects);
  let release!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>(resolve => {release = resolve;})) as typeof fetch;
  try {
    const reading = cachedCatalogSnapshot(undefined, {limit: 100}), rejected = assert.rejects(reading, /VAULT_LOCKED/);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    lockVault(); const other = await open(1); await clearAccount(other.accountId);
    release(new Response(new Uint8Array(objects.get(item.manifest.metadataRepresentation.objectId)!)));
    await rejected;
    const snapshot = await cachedSync(other, undefined, {limit: 100});
    assert.equal(snapshot.photos.length, 0); assert.equal(snapshot.coverage.cachedTotal, 0);
    assert.equal(await get("read", session.accountId + ":" + item.manifest.metadataRepresentation.objectId), undefined);
  } finally {globalThis.fetch = oldFetch; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
});

test("a gated bounded refresh disables live tile mutations until the shifted catalog window is published", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  let release!: (response: Response) => void;
  let reading: ReturnType<typeof refreshSync> | undefined, page: unknown;
  try {
    for (let n = 100; n < 200; n++) await fixture(session, objects, `public-${n}.jpg`, orderedID(n));
    const incoming = await fixture(session, objects, "new-public.jpg", orderedID(0));
    await atomic([{store: "catalog", key: session.accountId + ":" + incoming.manifest.photoId}]);
    page = {version: 1, mediaVersion: 1, changes: [{cursor: "1", entity: "photo", entityId: incoming.manifest.photoId, deleted: false, payload: incoming.signed}], nextCursor: "1", hasMore: false};
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://public.test");
      if (url.pathname === "/v1/changes") return new Promise<Response>(resolve => {release = resolve;});
      const bytes = objects.get(url.pathname.split("/").at(-1)!); assert.ok(bytes); return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const initial = await cachedSync(session, undefined, {limit: 100});
    const edge = initial.photos.find(photo => photo.manifest.photoId === orderedID(199))!;
    assert.ok(edge);
    const selected = new Set([orderedID(198)]);
    reading = refreshSync(session, {limit: 100, retainPhotoIds: [...selected]});
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    // Invoke the production tile control while the real network refresh is still gated.
    const disabled = PhotoSelectionButton({filename: edge.metadata.filename, selected: false, disabled: true, onSelect: () => {selected.add(edge.manifest.photoId);}});
    assert.match(renderToStaticMarkup(disabled), /disabled=""/);
    disabled.props.onClick();
    assert.deepEqual([...selected], [orderedID(198)], "A late page-edge choice cannot be accepted and silently lost on publication");
    release(new Response(JSON.stringify(page)));
    const refreshed = await reading;
    assert.equal(refreshed.photos.length, 100);
    assert.ok(refreshed.photos.some(photo => photo.manifest.photoId === orderedID(0)));
    assert.ok(!refreshed.photos.some(photo => photo.manifest.photoId === edge.manifest.photoId));
    assert.ok(refreshed.photos.some(photo => selected.has(photo.manifest.photoId)), "The earlier explicit choice remains available");
    assert.equal(refreshed.coverage.hasMore, true, "Unselected historical rows remain explicitly unloaded");
    const enabled = PhotoSelectionButton({filename: incoming.metadata.filename, selected: false, disabled: false, onSelect: () => {selected.add(incoming.manifest.photoId);}});
    assert.doesNotMatch(renderToStaticMarkup(enabled), /disabled=""/);
    enabled.props.onClick();
    assert.deepEqual([...selected], [orderedID(198), orderedID(0)], "Selection resumes against the published current window");
  } finally {
    release?.(new Response(JSON.stringify(page))); await reading?.catch(() => undefined);
    globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);
  }
});


test("consumer explicit Saved choices survive a shifted bounded page and late callbacks cannot cross lock/account/origin", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  let release!: (response: Response) => void, reading: ReturnType<typeof refreshSync> | undefined;
  const retention = new ConsumerSelectionRetention();
  try {
    for (let n = 100; n < 200; n++) await fixture(session, objects, `public-${n}.jpg`, orderedID(n));
    const incoming = await fixture(session, objects, "new-public.jpg", orderedID(0));
    await atomic([{store: "catalog", key: session.accountId + ":" + incoming.manifest.photoId}]);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://public.test");
      if (url.pathname === "/v1/changes") return new Promise<Response>(resolve => {release = resolve;});
      const bytes = objects.get(url.pathname.split("/").at(-1)!); assert.ok(bytes); return new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const first = await cachedSync(session, undefined, {limit: 100});
    let currentPhotos = first.photos, unlocked = true, busy = false, origin = "https://public.test";
    const snapshot: OwnedPhotoSnapshot = {accountId: session.accountId, token: session, photos: first.photos,
      current: () => unlocked && currentPhotos === first.photos, get selectionReady() {return !busy;},
      sourceCurrent: photo => currentPhotos.includes(photo), preview: async () => new Blob()};
    const choose = retention.bind(snapshot, origin, () => origin);
    choose(new Set([orderedID(199), "not-a-source"]));
    assert.deepEqual(retention.idsFor(session, session.accountId, origin), [orderedID(199)]);
    busy = true;
    reading = refreshSync(session, {limit: 100, retainPhotoIds: retention.idsFor(session, session.accountId, origin)});
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    choose(new Set([orderedID(199), orderedID(198)]));
    assert.deepEqual(retention.idsFor(session, session.accountId, origin), [orderedID(199)], "Consumer cannot add a late choice during refresh");
    release(new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: [{cursor: "1", entity: "photo", entityId: incoming.manifest.photoId, deleted: false, payload: incoming.signed}], nextCursor: "1", hasMore: false})));
    const refreshed = await reading; currentPhotos = refreshed.photos; busy = false;
    assert.equal(refreshed.photos.length, 101, "Only the explicit consumer choice extends the100-row browse budget");
    assert.ok(refreshed.photos.some(photo => photo.manifest.photoId === orderedID(199)));
    assert.equal(refreshed.coverage.hasMore, false);
    retention.bind({...snapshot, photos: refreshed.photos, current: () => unlocked && currentPhotos === refreshed.photos}, origin, () => origin);
    choose(new Set());
    assert.deepEqual(retention.idsFor(session, session.accountId, origin), [orderedID(199)], "An obsolete projection cannot overwrite current choices");
    unlocked = false; lockVault(); retention.clear();
    choose(new Set([orderedID(198)]));
    assert.deepEqual(retention.idsFor(session, session.accountId, origin), []);
    const other = await open(1); await clearAccount(other.accountId);
    const otherItem = await fixture(other, objects);
    const otherPhotos = (await cachedSync(other, undefined, {limit: 100})).photos;
    const otherSnapshot: OwnedPhotoSnapshot = {accountId: other.accountId, token: other, photos: otherPhotos, current: () => true, preview: async () => new Blob()};
    const otherChoose = retention.bind(otherSnapshot, origin, () => origin);
    otherChoose(new Set([otherItem.manifest.photoId]));
    choose(new Set([orderedID(199)]));
    assert.deepEqual(retention.idsFor(session, session.accountId, origin), []);
    assert.deepEqual(retention.idsFor(other, other.accountId, origin), [otherItem.manifest.photoId], "A stale read/callback cannot clear the new account choice");
    origin = "https://other.test"; otherChoose(new Set());
    assert.deepEqual(retention.idsFor(other, other.accountId, "https://public.test"), [], "An origin-changed getter cannot expose the captured context");
    assert.deepEqual(retention.idsFor(other, other.accountId, origin), []);
  } finally {
    release?.(new Response("{}")); await reading?.catch(() => undefined);
    retention.clear(); globalThis.fetch = oldFetch; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);
  }
});
