import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, sodium, unb64, b64, encryptMedia, signPayload, utf8, wrapKey} from "@fotoro/crypto";
import type {MediaBinding, PhotoManifestV1, PhotoMetadataV1, RepresentationV1, SignedPayloadV1} from "@fotoro/contracts";
import {configureVault, unlockVault, lockVault, encryptPrivate, decryptPrivate, type UnlockedVault} from "../src/vault/vault";
import {atomic, clearAccount, get, put, db} from "../src/exchange/cache";
import {cachedCatalog, cachedCatalogSnapshot, collect, digest, source} from "../src/library/catalog";
import {cachedSync, refreshSync, readableSyncError} from "../src/exchange/sync";
import {ExpiredSavedSelection} from "../src/exchange/sharing";
import {PhotoSelectionButton} from "../src/library/Library";
import {ConsumerSelectionRetention, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import {renderToStaticMarkup} from "react-dom/server";
import {cloudSearchRecords, mergeSearchPhotos} from "../src/library/search";
import {PhotoSearchIndex} from "../src/local/search";
import {CachedAccountSearch, scanCachedMetadata} from "../src/library/catalog";

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

test("concurrent Saved refresh owners receive independent photo keys while reusing verified metadata", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const item = await fixture(session, objects);
  let release!: () => void, changes = 0, metadataReads = 0;
  const held = new Promise<void>(resolve => {release = resolve;});
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "https://public.test");
    if (url.pathname === "/v1/changes") {
      changes++;
      if (changes === 1) await held;
      return new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: [], nextCursor: String(changes), hasMore: false}));
    }
    metadataReads++;
    const bytes = objects.get(url.pathname.split("/").at(-1)!); assert.ok(bytes);
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  let snapshots: Awaited<ReturnType<typeof refreshSync>>[] = [];
  try {
    const first = refreshSync(session, {limit: 100, signal: new AbortController().signal});
    while (!changes) await new Promise(resolve => setTimeout(resolve, 0));
    const second = refreshSync(session, {limit: 100, signal: new AbortController().signal});
    release(); snapshots = await Promise.all([first, second]);
    assert.equal(snapshots[0].photos[0].manifest.photoId, item.manifest.photoId);
    assert.equal(snapshots[1].photos[0].manifest.photoId, item.manifest.photoId);
    assert.deepEqual(snapshots[0].photos[0].metadataKey, snapshots[1].photos[0].metadataKey);
    snapshots[0].photos[0].metadataKey.fill(0);
    assert.ok(snapshots[1].photos[0].metadataKey.some(byte => byte !== 0), "Discarding one owner cannot wipe another owner's live photo key");
    assert.equal(changes, 2); assert.equal(metadataReads, 1, "Read ownership does not discard verified unchanged metadata reuse");
  } finally {
    release(); for (const snapshot of snapshots) for (const photo of snapshot.photos) photo.metadataKey.fill(0);
    globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);
  }
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

test("fresh server metadata discovery resumes committed cursors and searches beyond the 100-photo gallery", {timeout: 15000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const items = [];
  try {
    for (let n = 0; n < 225; n++) items.push(await fixture(session, objects, n === 224 ? "Lighthouse.jpg" : `public-${n}.jpg`, orderedID(n)));
    await atomic(items.map(item => ({store: "catalog" as const, key: session.accountId + ":" + item.manifest.photoId})));
    const cursors: (string | null)[] = []; let metadataReads = 0, failNext = true;
    const metadataObjects = new Set(items.map(item => item.manifest.metadataRepresentation.objectId));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://public.test");
      if (url.pathname === "/v1/changes") {
        const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
        if (cursor === "100" && failNext) {failNext = false; return new Response(JSON.stringify({version: 1, code: "UNAVAILABLE", retryable: true, requestId: crypto.randomUUID()}), {status: 503});}
        const start = cursor ? Number(cursor) : 0, end = Math.min(start + 100, items.length);
        return new Response(JSON.stringify({version: 1, mediaVersion: 1,
          changes: items.slice(start, end).map((item, offset) => ({cursor: String(start + offset + 1), entity: "photo", entityId: item.manifest.photoId, deleted: false, payload: item.signed})),
          nextCursor: String(end), hasMore: end < items.length}));
      }
      const objectId = url.pathname.split("/").at(-1)!;
      assert.ok(metadataObjects.has(objectId), "discovery and search must never fetch image originals");
      metadataReads++; return new Response(new Uint8Array(objects.get(objectId)!));
    }) as typeof fetch;
    await assert.rejects(refreshSync(session, {limit: 100}), /UNAVAILABLE/);
    assert.deepEqual(cursors, [null, "100"]);
    assert.equal((await cachedSync(session, undefined, {limit: 100})).coverage.hasMoreChanges, true);
    const beforeRetryReads = metadataReads;
    const result = await refreshSync(session, {limit: 100});
    assert.deepEqual(cursors, [null, "100", "100", "200"]);
    assert.equal(metadataReads, beforeRetryReads, "already verified visible metadata is reused");
    assert.deepEqual(result.coverage, {loaded: 100, cachedTotal: 225, hasMore: true, hasMoreChanges: false});
    assert.ok(result.lastSuccessfulSync);
    assert.equal(result.photos.some(photo => photo.manifest.photoId === items[224].manifest.photoId), false);
    const corpus = new CachedAccountSearch(session, () => true);
    await corpus.scan(new AbortController().signal);
    assert.deepEqual(corpus.index!.search("lighthouse").photoIds, [items[224].manifest.photoId]);
    const matches = await corpus.hydrate(corpus.index!.search("lighthouse").photoIds, new AbortController().signal);
    assert.equal(matches.length, 1); assert.equal(matches[0].metadata.filename, "Lighthouse.jpg");
    for (const photo of [...result.photos, ...matches]) photo.metadataKey.fill(0);
    corpus.dispose();
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("withdrawing discovery during held metadata stops subsequent rows and feed continuation", {timeout: 15000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const items = [];
  try {
    for (let n = 0; n < 425; n++) items.push(await fixture(session, objects, `public-${n}.jpg`, orderedID(n)));
    await atomic(items.map(item => ({store: "catalog" as const, key: session.accountId + ":" + item.manifest.photoId})));
    const controller = new AbortController(), cursors: (string | null)[] = [];
    let entered!: () => void, release!: () => void, metadataReads = 0, published = false;
    const began = new Promise<void>(resolve => {entered = resolve;});
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), "https://public.test");
      if (url.pathname === "/v1/changes") {
        const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
        const start = cursor ? Number(cursor) : 0, end = Math.min(start + 100, items.length);
        return new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: items.slice(start, end).map((item, offset) => ({cursor: String(start + offset + 1), entity: "photo", entityId: item.manifest.photoId, deleted: false, payload: item.signed})), nextCursor: String(end), hasMore: end < items.length}));
      }
      metadataReads++; entered();
      await new Promise<void>(resolve => {release = resolve;});
      return new Response(new Uint8Array(objects.get(url.pathname.split("/").at(-1)!)!));
    }) as typeof fetch;
    const pending = refreshSync(session, {limit: 100, signal: controller.signal}).then(() => {published = true;});
    const rejection = assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError");
    await began; controller.abort(); release(); await rejection;
    assert.equal(published, false); assert.equal(metadataReads, 1);
    assert.deepEqual(cursors, [null, "100", "200", "300"], "the fifth page cannot begin after withdrawal");
    assert.equal(decryptPrivate(await get("settings", session.accountId + ":catalog-has-more") as any), true);
    assert.equal(await get("settings", session.accountId + ":last-checked"), undefined);
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

test("cached account metadata finds an unloaded source without fetching originals, then hydrates only exact matches and retains selections", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const first = await fixture(session, objects, "window.jpg", "00000000-0000-4000-8000-000000000001");
  const entries = [first];
  for (let n = 2; n <= 100; n++) entries.push(await fixture(session, objects, "window-" + n + ".jpg", "00000000-0000-4000-8000-" + String(n).padStart(12, "0")));
  const hidden = await fixture(session, objects, "unloaded lighthouse.jpg", "00000000-0000-4000-8000-000000000101");
  entries.push(hidden);
  const metadataIDs = new Set(entries.map(item => item.manifest.metadataRepresentation.objectId));
  const requests: string[] = [];
  globalThis.fetch = (async input => {const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; requests.push(id); assert.ok(metadataIDs.has(id), "Only metadata objects may be fetched during account scanning"); const bytes = objects.get(id); assert.ok(bytes); return new Response(new Uint8Array(bytes));}) as typeof fetch;
  const corpus = new CachedAccountSearch(session, () => true);
  try {
    const browse = await cachedCatalogSnapshot(undefined, {limit: 100});
    assert.equal(browse.photos.length, 100); assert.ok(!browse.photos.some(photo => photo.manifest.photoId === hidden.manifest.photoId));
    assert.deepEqual(new PhotoSearchIndex(cloudSearchRecords(browse.photos)).search("lighthouse").photoIds, [], "The original browse-window search cannot find this cached source");
    await corpus.scan(new AbortController().signal);
    const result = corpus.index!.search("lighthouse");
    assert.deepEqual(result.photoIds, [hidden.manifest.photoId]);
    const scannedRequests = requests.length;
    const matches = await corpus.hydrate(result.photoIds, new AbortController().signal);
    assert.deepEqual(matches.map(photo => photo.manifest.photoId), result.photoIds);
    assert.equal(requests.length, scannedRequests, "Hydration reuses metadata ciphertext; no originals or thumbnails are requested");
    const joined = mergeSearchPhotos(browse.photos, matches, new Set(), new Set());
    assert.equal(joined.photos[0], browse.photos[0], "Existing browse source identity survives search publication");
    const repeatedMatches = await corpus.hydrate(result.photoIds, new AbortController().signal);
    const repeated = mergeSearchPhotos(joined.photos, repeatedMatches, joined.added, new Set());
    assert.ok(repeated.photos.every((photo, i) => photo === joined.photos[i]), "Repeated query hydration reaches a fixed point without replacing unselected match sources");
    assert.ok(repeatedMatches.every(photo => photo.metadataKey.every(byte => byte === 0)), "Unused repeat hydration keys are wiped");
    const selected = matches[0];
    const returned = mergeSearchPhotos(joined.photos, [], joined.added, new Set([selected.manifest.photoId]));
    assert.ok(returned.photos.includes(selected)); assert.ok(selected.metadataKey.some(byte => byte !== 0));
    const released = mergeSearchPhotos(returned.photos, [], returned.added, new Set());
    assert.deepEqual(released.photos, browse.photos); assert.ok(selected.metadataKey.every(byte => byte === 0));
    const changed = await fixture(session, objects, "replacement.jpg", hidden.manifest.photoId);
    metadataIDs.add(changed.manifest.metadataRepresentation.objectId);
    await assert.rejects(corpus.hydrate(result.photoIds, new AbortController().signal), /Saved search changed|CATALOG_SOURCE_CHANGED/);
    assert.notEqual(changed.manifest.metadataRepresentation.objectId, hidden.manifest.metadataRepresentation.objectId);
    const reused = new CachedAccountSearch(session, () => true, corpus);
    const instrumentation = spies();
    try {
      await reused.scan(new AbortController().signal);
      assert.equal(instrumentation.counts.crypto_secretstream_xchacha20poly1305_pull, 1, "Only the changed source revisits metadata decryption");
      assert.equal(instrumentation.counts.crypto_sign_verify_detached, 1, "Unchanged signed receipts reuse previously verified records");
      const database = await db();
      // A second tab does not share the in-memory notification generation.
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction("catalog", "readwrite");
        tx.objectStore("catalog").put(encryptPrivate(hidden.signed), session.accountId + ":" + hidden.manifest.photoId);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      assert.equal(reused.admitted, true);
      await assert.rejects(reused.hydrate([hidden.manifest.photoId], new AbortController().signal), /CATALOG_SOURCE_CHANGED/);
    } finally {instrumentation.restore(); reused.dispose();}
  } finally {corpus.dispose(); globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("metadata scan cancellation and visibility withdrawal clear all visited keys and unpublished records", async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId); await fixture(session, objects);
  globalThis.fetch = (async input => {const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; return new Response(new Uint8Array(objects.get(id)!));}) as typeof fetch;
  try {
    for (const withdraw of ["signal", "visibility"] as const) {
      const controller = new AbortController(); let current = true, key: Uint8Array | undefined;
      await assert.rejects(scanCachedMetadata(session, controller.signal, () => current, photo => {
        key = photo.metadataKey;
        if (withdraw === "signal") controller.abort(); else current = false;
      }), error => error instanceof DOMException && error.name === "AbortError");
      assert.ok(key?.every(byte => byte === 0), "Every visited metadata key is wiped even when scope changes in publication");
    }
    let visible = true;
    const corpus = new CachedAccountSearch(session, () => visible);
    await corpus.scan(new AbortController().signal); assert.equal(corpus.records.length, 1);
    visible = false; assert.equal(corpus.admitted, false);
    await assert.rejects(corpus.hydrate([corpus.records[0].id], new AbortController().signal), /Saved search changed/);
    corpus.dispose(); assert.deepEqual(corpus.records, []);
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});

test("a source replacement or vault lock during metadata await cannot publish search or retain its unwrapped key", async () => {
  await ready; const oldFetch = globalThis.fetch;
  try {
    for (const withdrawal of ["replace", "lock"] as const) {
      const session = await open(0), objects = new Map<string, Uint8Array>(); await clearAccount(session.accountId);
      const item = await fixture(session, objects);
      let release!: (response: Response) => void, began!: () => void;
      const entered = new Promise<void>(resolve => {began = resolve;});
      globalThis.fetch = (async () => {began(); return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
      const original = sodium.crypto_secretbox_open_easy, keys: Uint8Array[] = [];
      (sodium as any).crypto_secretbox_open_easy = (...args: any[]) => {const value = (original as any)(...args); if (value.length === 32) keys.push(value); return value;};
      const corpus = new CachedAccountSearch(session, () => true);
      try {
        const pending = corpus.scan(new AbortController().signal), rejected = withdrawal === "lock" ? assert.rejects(pending) : pending;
        await entered;
        if (withdrawal === "replace") await fixture(session, objects, "changed.jpg", item.manifest.photoId); else lockVault();
        release(new Response(new Uint8Array(objects.get(item.manifest.metadataRepresentation.objectId)!)));
        await rejected; assert.deepEqual(corpus.records, []); if (withdrawal === "replace") assert.equal(corpus.complete, false);
        assert.ok(keys.length > 0); assert.ok(keys.every(key => key.every(byte => byte === 0)));
      } finally {corpus.dispose(); (sodium as any).crypto_secretbox_open_easy = original;}
    }
  } finally {globalThis.fetch = oldFetch; lockVault(); await clearAccount(accounts.accounts[0].accountId);}
});


test("continuous append acknowledgments do not withdraw existing account search or cancel an in-flight scan", {timeout: 10000}, async () => {
  await ready; const session = await open(0), oldFetch = globalThis.fetch, objects = new Map<string, Uint8Array>();
  await clearAccount(session.accountId);
  const stable = await fixture(session, objects, "stable lighthouse.jpg", "00000000-0000-4000-8000-000000000001");
  const unaffected = await fixture(session, objects, "stable garden.jpg", "00000000-0000-4000-8000-000000000002");
  for (let n = 3; n <= 100; n++) await fixture(session, objects, "baseline-" + n + ".jpg", "00000000-0000-4000-8000-" + String(n).padStart(12, "0"));
  const response = (input: string | URL | Request) => {const id = new URL(String(input), "https://public.test").pathname.split("/").at(-1)!; const bytes = objects.get(id); assert.ok(bytes); return new Response(new Uint8Array(bytes));};
  globalThis.fetch = (async input => response(input)) as typeof fetch;
  const prior = new CachedAccountSearch(session, () => true);
  const match = String.prototype.match;
  let tokenizations = 0;
  String.prototype.match = function (expression: any): any {
    if (expression instanceof RegExp && expression.source === "[\\p{L}\\p{N}]+"
      && /^(stable lighthouse|stable garden|baseline-\d+|waiting|append-\d+|replacement)$/.test(String(this))) tokenizations++;
    return match.call(this, expression);
  };
  let next: CachedAccountSearch | undefined, final: CachedAccountSearch | undefined, changed: CachedAccountSearch | undefined, annotated: CachedAccountSearch | undefined;
  try {
    await prior.scan(new AbortController().signal);
    assert.equal(tokenizations, 200, "Initial scan tokenizes each of the 100 filenames twice for word and phrase postings");
    tokenizations = 0;
    const waiting = await fixture(session, objects, "waiting.jpg", "00000000-0000-4000-8000-000000000101");
    let release!: (response: Response) => void, enter!: () => void;
    const entered = new Promise<void>(resolve => {enter = resolve;});
    globalThis.fetch = (async input => {
      if (String(input).endsWith(waiting.manifest.metadataRepresentation.objectId)) {enter(); return new Promise<Response>(resolve => {release = resolve;});}
      return response(input);
    }) as typeof fetch;
    next = new CachedAccountSearch(session, () => true, prior);
    const scanning = next.scan(new AbortController().signal); await entered;
    for (let n = 102; n <= 103; n++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await fixture(session, objects, "append-" + n + ".jpg", "00000000-0000-4000-8000-" + String(n).padStart(12, "0"));
      assert.equal(prior.admitted, true); assert.equal(prior.complete, false);
      assert.deepEqual(prior.index!.search("lighthouse").photoIds, [stable.manifest.photoId]);
      const [match] = await prior.hydrate([stable.manifest.photoId], new AbortController().signal); match.metadataKey.fill(0);
    }
    release(response("/" + waiting.manifest.metadataRepresentation.objectId)); await scanning;
    const priorIDs = new Set(prior.records.map(record => record.id));
    assert.equal(tokenizations, 2 * next.records.filter(record => !priorIDs.has(record.id)).length, "Append scan tokenizes new receipts only");
    assert.equal(next.admitted, true); assert.equal(next.complete, false, "A pass spanning newer writes reports updating coverage");
    assert.deepEqual(next.index!.search("lighthouse").photoIds, [stable.manifest.photoId]);
    globalThis.fetch = (async input => response(input)) as typeof fetch;
    tokenizations = 0;
    final = new CachedAccountSearch(session, () => true, next); await final.scan(new AbortController().signal);
    const nextIDs = new Set(next.records.map(record => record.id));
    assert.equal(tokenizations, 2 * final.records.filter(record => !nextIDs.has(record.id)).length, "Follow-up scan keeps reusing unchanged postings");
    assert.equal(final.records.length, 103); assert.equal(final.complete, true);
    await fixture(session, objects, "replacement.jpg", stable.manifest.photoId);
    assert.deepEqual(final.index!.search("lighthouse").photoIds, [], "Only the changed source withdraws before refresh");
    assert.deepEqual(final.index!.search("garden").photoIds, [unaffected.manifest.photoId]);
    await assert.rejects(final.hydrate([stable.manifest.photoId], new AbortController().signal), /CATALOG_SOURCE_CHANGED/);
    tokenizations = 0;
    changed = new CachedAccountSearch(session, () => true, final); await changed.scan(new AbortController().signal);
    assert.equal(tokenizations, 2, "A changed manifest with the same photo ID and original digest retokenizes only that receipt");
    assert.deepEqual(changed.index!.search("lighthouse").photoIds, []);
    assert.deepEqual(changed.index!.search("replacement").photoIds, [stable.manifest.photoId]);
    assert.deepEqual(changed.index!.search("garden").photoIds, [unaffected.manifest.photoId]);
    const annotation = signPayload("photo-annotations", session.accountId, utf8({version: 1, photoId: unaffected.manifest.photoId, revision: 1,
      encrypted: encryptPrivate({version: 1, photoId: unaffected.manifest.photoId, originalSha256: unaffected.metadata.originalSha256, caption: "Fresh annotation receipt"})}), session.signingSecretKey);
    await put("settings", session.accountId + ":annotation:" + unaffected.manifest.photoId, encryptPrivate(annotation));
    tokenizations = 0;
    annotated = new CachedAccountSearch(session, () => true, changed); await annotated.scan(new AbortController().signal);
    assert.equal(tokenizations, 2, "Same original digest cannot authorize reuse after an annotation receipt changes");
    assert.deepEqual(annotated.index!.search("Fresh annotation").photoIds, [unaffected.manifest.photoId]);
    assert.deepEqual(changed.index!.search("Fresh annotation").photoIds, []);
  } finally {String.prototype.match = match; prior.dispose(); next?.dispose(); final?.dispose(); changed?.dispose(); annotated?.dispose(); globalThis.fetch = oldFetch; lockVault(); await clearAccount(session.accountId);}
});
