import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import accounts from "../../../fixtures/accounts.json";
import type {AccountCardV1, GrantDetailV1, GrantV1, MediaBinding, PhotoManifestV1, RepresentationV1, SaveRequestV1, WrappedKeyV1} from "@fotoro/contracts";
import {createContactLink, createMomentLink, parseShareLink} from "@fotoro/contracts/share-links";
import {b64, encryptMedia, ready, sealShareKey, signPayload, sodium, unb64, utf8, wrapKey, unwrapKey} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault, vaultGeneration} from "../src/vault/vault";
import {clearAccount, get, put, all} from "../src/exchange/cache";
import {collect, source, type Photo} from "../src/library/catalog";
import {contribute, contacts, contactNames, saveContactName, pinCard, receive, saveReceivedPhoto, sharePhotos, trustedCard} from "../src/exchange/share-service";
import {grantState, IncomingShareIntent, readableShareError, ShareSelection} from "../src/exchange/sharing";
import {Exchange, loadExchangeContext} from "../src/exchange/Exchange";
type ExchangeUpdate = Parameters<Parameters<typeof loadExchangeContext>[2]>[0];
const response = (value: unknown) => new Response(JSON.stringify(value));
async function open(index: number) {
  await ready;
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
async function scoped(fn: () => Promise<void>) {
  const old = globalThis.fetch;
  for (const card of accounts.accounts) await clearAccount(card.accountId);
  try {await fn();} finally {globalThis.fetch = old; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
}
async function fixture() {
  const sender = await open(0), key = sodium.randombytes_buf(32), originalKey = sodium.randombytes_buf(32), photoId = crypto.randomUUID();
  const objects = new Map<string, Uint8Array>();
  const original = utf8("exact original photo bytes");
  const sha = (bytes: Uint8Array) => b64(sodium.crypto_hash_sha256(bytes));
  const representation = async (kind: MediaBinding["kind"], bytes: Uint8Array, encryptionKey: Uint8Array): Promise<RepresentationV1> => {
    const binding: MediaBinding = {version: 1, photoId, representationId: crypto.randomUUID(), kind};
    const cipher = await collect(encryptMedia(source(bytes), encryptionKey, binding)), objectId = crypto.randomUUID(); objects.set(objectId, cipher);
    return {binding, objectId, header: b64(cipher.subarray(0, 24)), ciphertextBytes: cipher.length, ciphertextSha256: sha(cipher)};
  };
  const originalRep = await representation("original", original, originalKey);
  const metadata = {version: 1 as const, filename: "photo.png", mediaType: "image/png" as const, sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos" as const, originalBytes: original.length, originalSha256: sha(original), representationKeys: {[originalRep.binding.representationId]: b64(originalKey)}};
  const metadataRep = await representation("metadata", utf8(metadata), key);
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: sender.accountId, representations: [originalRep], metadataRepresentation: metadataRep, ownerWrappedMetadataKey: wrapKey(key, sender.vaultKey)};
  const grant: GrantV1 = {grantId: crypto.randomUUID(), momentId: crypto.randomUUID(), ownerAccountId: sender.accountId, recipientAccountId: accounts.accounts[1].accountId, role: "contributor", expiresAt: null, revokedAt: null, version: 1};
  const detail: GrantDetailV1 = {version: 1, grant, cards: accounts.accounts, manifests: [signPayload("photo-manifest", sender.accountId, utf8(manifest), sender.signingSecretKey)], envelopes: [sealShareKey(key, accounts.accounts[1], {version: 1, grantId: grant.grantId, photoId, senderAccountId: sender.accountId, recipientAccountId: grant.recipientAccountId}, sender.signingSecretKey)]};
  return {grant, detail, objects, photo: {manifest, metadata, metadataKey: key} as Photo};
}

test("incoming public identity survives its own password unlock and requires the captured account", async () => scoped(async () => {
  lockVault();
  const intent = new IncomingShareIntent(parseShareLink(createContactLink(accounts.accounts[0])));
  const ticket = intent.beginAuthentication(vaultGeneration()); intent.vaultLocked();
  const session = await open(1); intent.finishAuthentication(ticket, session, vaultGeneration());
  assert.equal(intent.pending, true); assert.equal(intent.current(session), true); assert.equal(intent.current({}), false);
  intent.vaultLocked(); assert.equal(intent.pending, false);
}));
test("rejected password preserves a link; explicit password retry preserves it while cancel blocks delayed authentication", async () => scoped(async () => {
  const session = await open(0), link = parseShareLink(createContactLink(accounts.accounts[1]));
  const retry = new IncomingShareIntent(link, session); retry.retryPassword(); retry.vaultLocked(); lockVault();
  const ticket = retry.beginAuthentication(vaultGeneration()); const next = await open(1); retry.finishAuthentication(ticket, next, vaultGeneration());
  assert.equal(retry.current(next), true);
  lockVault(); const cancelled = new IncomingShareIntent(link), failed = cancelled.beginAuthentication(vaultGeneration());
  cancelled.finishAuthentication(failed); assert.equal(cancelled.pending, true);
  const late = cancelled.beginAuthentication(vaultGeneration()); cancelled.cancel(); const opened = await open(0); cancelled.finishAuthentication(late, opened, vaultGeneration()); assert.equal(cancelled.pending, false);
}));
test("Share holds immutable photo/key snapshots and disposal cannot wipe the library original", async () => scoped(async () => {
  const {photo} = await fixture(), snapshot = new ShareSelection([photo]), originalKey = new Uint8Array(photo.metadataKey);
  photo.metadata.filename = "changed.png"; photo.manifest.representations.length = 0;
  assert.equal(snapshot.photos[0].metadata.filename, "photo.png"); assert.equal(snapshot.photos[0].manifest.representations.length, 1);
  snapshot.dispose(); assert.equal(snapshot.current, false); assert.deepEqual(snapshot.photos[0].metadataKey, new Uint8Array(32)); assert.deepEqual(photo.metadataKey, originalKey);
}));
test("contact acceptance persists encrypted identities and a changed key needs a new explicit acceptance", async () => scoped(async () => {
  await open(1); const sender = accounts.accounts[0]; await pinCard(sender);
  const stored = await get("settings", accounts.accounts[1].accountId + ":pin:" + sender.accountId);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(sender.signingPublicKey));
  await saveContactName(sender.accountId, "Alice");
  const nameRecord = await get("settings", accounts.accounts[1].accountId + ":contact-name:" + sender.accountId);
  assert.doesNotMatch(JSON.stringify(nameRecord), /Alice/);
  assert.equal((await contactNames()).get(sender.accountId), "Alice");
  assert.deepEqual(await contacts(), [sender]); assert.deepEqual(await trustedCard(sender.accountId), sender);
  await assert.rejects(pinCard(sender, {current: () => false}), /Share cancelled/);
  const replacement: AccountCardV1 = {...sender, boxPublicKey: accounts.accounts[1].boxPublicKey};
  await pinCard(replacement); assert.deepEqual(await trustedCard(sender.accountId), replacement);
}));
test("incoming sender opens without an optional inbox request and waits for saved name and changed identity checks", async () => scoped(async () => {
  const session = await open(1), sender = accounts.accounts[0];
  await pinCard(sender); await saveContactName(sender.accountId, "Alice");
  const changed = {...sender, signingPublicKey: accounts.accounts[1].signingPublicKey};
  const incoming = new IncomingShareIntent(parseShareLink(createMomentLink(crypto.randomUUID(), changed)), session);
  const markup = renderToStaticMarkup(createElement(Exchange, {selection: [], incoming, onClose() {}, onReceived() {assert.fail("Opening must require explicit acceptance");}, onRefresh() {}}));
  assert.match(markup, /Accept this sender/);
  assert.match(markup, /<button class="primary-action" disabled="">Accept sender and open photos<\/button>/);
  assert.doesNotMatch(markup, /Try again/);
  const requests: string[] = [], updates: ExchangeUpdate[] = [];
  globalThis.fetch = (async path => {requests.push(String(path)); throw new TypeError("offline");}) as typeof fetch;
  const pending = loadExchangeContext(session, {current: () => incoming.current(session)}, update => updates.push(update), changed);
  assert.deepEqual(updates, [{candidate: changed, candidateChecked: false}]);
  await pending;
  assert.equal(updates.some(update => update.identityChanged === true), true);
  assert.equal(updates.find(update => update.candidateName !== undefined)?.candidateName, "Alice");
  assert.equal(updates.at(-1)?.candidateChecked, true);
  assert.deepEqual(requests, []);
  assert.deepEqual(await trustedCard(sender.accountId), sender);
}));
test("an unreadable local name or pin never enables sender acceptance, while a missing pin still needs explicit acceptance", async () => scoped(async () => {
  const session = await open(1), sender = accounts.accounts[0];
  await pinCard(sender);
  const changed = {...sender, signingPublicKey: accounts.accounts[1].signingPublicKey};
  const nameKey = session.accountId + ":contact-name:" + sender.accountId;
  await put("settings", nameKey, wrapKey(utf8({version: 1, accountId: sender.accountId, name: 17}), session.vaultKey));
  const updates: ExchangeUpdate[] = [];
  await assert.rejects(loadExchangeContext(session, {}, update => updates.push(update), changed), /CONTACT_BINDING_MISMATCH/);
  // A failed name lookup cannot end the operation before the independent identity check settles.
  assert.equal(updates.some(update => update.identityChanged === true), true);
  assert.equal(updates.some(update => update.candidateChecked === true), false);
  await clearAccount(session.accountId);
  await put("settings", session.accountId + ":pin:" + sender.accountId, wrapKey(utf8({invalid: true}), session.vaultKey));
  const badPin: ExchangeUpdate[] = [];
  await assert.rejects(loadExchangeContext(session, {}, update => badPin.push(update), sender));
  assert.equal(badPin.some(update => update.candidateChecked === true), false);
  await clearAccount(session.accountId);
  const unknown: ExchangeUpdate[] = [];
  await loadExchangeContext(session, {}, update => unknown.push(update), sender);
  assert.equal(unknown.at(-1)?.candidateChecked, true);
  assert.equal(await get("settings", session.accountId + ":pin:" + sender.accountId), undefined);
}));
test("optional contact inbox failure cannot hide its candidate or erase the completed changed-key warning", async () => scoped(async () => {
  const session = await open(1), sender = accounts.accounts[0];
  await pinCard(sender); await saveContactName(sender.accountId, "Alice");
  const changed = {...sender, signingPublicKey: accounts.accounts[1].signingPublicKey}, state: ExchangeUpdate = {};
  const publish = (update: ExchangeUpdate) => Object.assign(state, update);
  globalThis.fetch = (async () => {throw new TypeError("offline");}) as typeof fetch;
  const inbox = loadExchangeContext(session, {}, publish);
  const candidate = loadExchangeContext(session, {}, publish, changed);
  assert.equal(state.candidateChecked, false); assert.deepEqual(state.candidate, changed);
  await Promise.all([inbox, candidate]);
  assert.equal(state.inboxFailed, true); assert.equal(state.identityChanged, true);
  assert.equal(state.candidateChecked, true); assert.equal(state.candidateName, "Alice");
  assert.deepEqual(state.candidate, changed); assert.deepEqual(await trustedCard(sender.accountId), sender);
}));
test("a failed Shared inbox keeps local contacts and names, then a successful retry clears only the load failure", async () => scoped(async () => {
  const {grant} = await fixture(), session = await open(1), sender = accounts.accounts[0];
  await pinCard(sender); await saveContactName(sender.accountId, "Alice");
  const state: ExchangeUpdate = {}, requests: string[] = [];
  let offline = true;
  globalThis.fetch = (async (path, init) => {
    requests.push(String(path)); assert.equal(init?.method, "GET");
    if (offline) throw new TypeError("offline");
    return response({version: 1, grants: [grant]});
  }) as typeof fetch;
  const publish = (update: ExchangeUpdate) => Object.assign(state, update);
  await loadExchangeContext(session, {}, publish);
  assert.equal(state.inboxFailed, true);
  assert.deepEqual(state.people, [sender]); assert.equal(state.names?.get(sender.accountId), "Alice");
  assert.equal(state.grants, undefined);
  offline = false; await loadExchangeContext(session, {}, publish);
  assert.equal(state.inboxFailed, false); assert.deepEqual(state.grants, [grant]);
  assert.deepEqual(requests, ["/v1/grants", "/v1/grants"]);
  assert.deepEqual(await trustedCard(sender.accountId), sender);
}));
test("closing, switching accounts, or cancelling an incoming link prevents late identity checks from enabling acceptance", async () => {
  for (const cancellation of ["close", "account", "intent"]) await scoped(async () => {
    const session = await open(1), sender = accounts.accounts[0], controller = new AbortController();
    await pinCard(sender); await saveContactName(sender.accountId, "Alice");
    const incoming = new IncomingShareIntent(parseShareLink(createMomentLink(crypto.randomUUID(), sender)), session);
    const updates: ExchangeUpdate[] = [];
    const pending = loadExchangeContext(session, {signal: controller.signal, current: () => incoming.current(session)}, update => updates.push(update), sender);
    const rejected = assert.rejects(pending, cancellation === "account" ? /VAULT_LOCKED/ : {name: "AbortError"});
    if (cancellation === "close") controller.abort();
    else if (cancellation === "intent") incoming.cancel();
    else {lockVault(); await open(0);}
    await rejected;
    assert.deepEqual(updates, [{candidate: sender, candidateChecked: false}]);
  });
});
test("a delayed inbox response cannot publish to a different account after local contacts loaded", async () => scoped(async () => {
  const session = await open(1), updates: ExchangeUpdate[] = [];
  let release!: (value: Response) => void, localLoaded!: () => void;
  const localReady = new Promise<void>(resolve => {localLoaded = resolve;});
  globalThis.fetch = (async () => new Promise<Response>(resolve => {release = resolve;})) as typeof fetch;
  const pending = loadExchangeContext(session, {}, update => {updates.push(update); if (update.people) localLoaded();});
  await localReady;
  lockVault(); await open(0);
  const before = updates.length;
  release(response({version: 1, grants: []})); await pending;
  assert.equal(updates.length, before);
  assert.equal(updates.some(update => update.grants !== undefined || update.inboxFailed !== undefined), false);
}));
test("delayed invitation reservation stops before signing or sending after account switch", async () => scoped(async () => {
  const {photo, grant} = await fixture(); await pinCard(accounts.accounts[1]);
  let release!: (response: Response) => void, requested!: () => void; const began = new Promise<void>(resolve => {requested = resolve;}); const paths: string[] = [];
  globalThis.fetch = (async path => {paths.push(String(path)); requested(); return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
  const pending = sharePhotos([photo], accounts.accounts[1], "ongoing"), rejected = assert.rejects(pending, /VAULT_LOCKED/);
  await began; lockVault(); await open(1); release(response(grant)); await rejected;
  assert.equal(paths.length, 1); assert.match(paths[0], /^\/v1\/moments\/[0-9a-f-]{36}\/grants\/options$/);
}));
test("sharing and contributing refuse received photos and changed pinned recipient keys before networking", async () => scoped(async () => {
  const {photo, grant} = await fixture(); await pinCard(accounts.accounts[1]);
  globalThis.fetch = (async () => assert.fail("No request may send these photos")) as typeof fetch;
  await assert.rejects(sharePhotos([{...photo, grantId: grant.grantId}], accounts.accounts[1], "ongoing"), /PHOTO_NOT_OWNED/);
  await assert.rejects(contribute(grant, [{...photo, grantId: grant.grantId}]), /PHOTO_NOT_OWNED/);
  await assert.rejects(sharePhotos([photo], {...accounts.accounts[1], signingPublicKey: accounts.accounts[0].signingPublicKey}, "ongoing"), /ACCOUNT_KEYS_CHANGED/);
}));
test("received photos verify identity, signature and exact original before an explicit idempotent Save", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]); const calls: string[] = [], saves: string[] = [];
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    if (String(path).startsWith("/v1/objects/")) return new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
    if (String(path).endsWith("/viewed")) return response({});
    if (path === "/v1/saves") {saves.push(init!.body as string); return response(JSON.parse(init!.body as string).save);}
    return response(detail);
  }) as typeof fetch;
  const received = await receive(detail.grant.grantId, {}, accounts.accounts[0]);
  assert.equal(received.photos[0].metadata.filename, "photo.png"); assert.equal(saves.length, 0);
  const first = await saveReceivedPhoto(detail.grant.grantId, received.photos[0].manifest.photoId), second = await saveReceivedPhoto(detail.grant.grantId, received.photos[0].manifest.photoId);
  assert.equal(first.photoId, second.photoId); assert.equal(saves[0], saves[1]); assert.equal(first.manifest.ownerAccountId, accounts.accounts[1].accountId);
  assert.ok(calls.includes("/v1/objects/" + photo.manifest.representations[0].objectId));
}));
test("overlapping Save attempts create one durable recipient copy and retry that exact request", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  const requests: string[] = [], records = new Map<string, unknown>();
  let release!: () => void, began!: () => void;
  const blocked = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {began = resolve;});
  globalThis.fetch = (async (path, init) => {
    if (String(path).startsWith("/v1/objects/")) return new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
    if (String(path).endsWith("/viewed")) return response({});
    if (path === "/v1/saves") {
      requests.push(init!.body as string);
      const request = JSON.parse(init!.body as string);
      records.set(request.save.operationId, request.save);
      return response(request.save);
    }
    began(); await blocked; return response(detail);
  }) as typeof fetch;
  const first = saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
  await started;
  const second = saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
  await new Promise(resolve => setTimeout(resolve, 0));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.operationId, b.operationId); assert.equal(a.photoId, b.photoId);
  assert.equal(records.size, 1); assert.equal(requests[0], requests[1]);
  await saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
  assert.equal(requests[2], requests[0]);
}));
test("a server identity replacement or wrong grant recipient never marks an invitation viewed", async () => scoped(async () => {
  const {detail} = await fixture(); await open(1); await pinCard(accounts.accounts[0]); const calls: string[] = [];
  globalThis.fetch = (async path => {calls.push(String(path)); return response({...detail, cards: [{...accounts.accounts[0], boxPublicKey: accounts.accounts[1].boxPublicKey}, accounts.accounts[1]]});}) as typeof fetch;
  await assert.rejects(receive(detail.grant.grantId), /ACCOUNT_KEYS_CHANGED/); assert.equal(calls.length, 1);
  globalThis.fetch = (async () => response({...detail, grant: {...detail.grant, recipientAccountId: crypto.randomUUID()}})) as typeof fetch;
  await assert.rejects(receive(detail.grant.grantId), /INVITATION_RECIPIENT_MISMATCH/);
}));
test("consumer sharing renders links and explicit identity acceptance without protocol forms", async () => scoped(async () => {
  await open(0);
  const markup = renderToStaticMarkup(createElement(Exchange, {selection: [], onClose() {}, onReceived() {}, onRefresh() {}}));
  assert.match(markup, /Shared photos/); assert.match(markup, /Share my contact link/); assert.match(markup, /Received photos/); assert.doesNotMatch(markup, /JSON|textarea|Pin account card|device|dashboard/);
  assert.equal(grantState({revokedAt: "2026-10-01"} as GrantV1), "Access ended");
  assert.equal(grantState({revokedAt: null, expiresAt: "2020-01-01"} as GrantV1), "Expired");
  assert.match(readableShareError(new Error("GRANT_INACTIVE")), /another Fotoro password/);
}));

test("a delayed receive cannot decrypt photos or mark them viewed after cancellation or account switch", async () => scoped(async () => {
  const {detail} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  let release!: (response: Response) => void, started!: () => void; const began = new Promise<void>(resolve => {started = resolve;}); const calls: string[] = [];
  globalThis.fetch = (async path => {calls.push(String(path)); started(); return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
  const pending = receive(detail.grant.grantId), rejected = assert.rejects(pending, /VAULT_LOCKED/);
  await began; lockVault(); await open(0); release(response(detail)); await rejected;
  assert.deepEqual(calls, ["/v1/grants/" + detail.grant.grantId]);
}));
test("closing sharing aborts its metadata download without caching or marking it viewed", async () => scoped(async () => {
  const {detail, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  const controller = new AbortController(), calls: string[] = [];
  let began!: () => void; const started = new Promise<void>(resolve => {began = resolve;});
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    if (String(path).startsWith("/v1/objects/")) {
      assert.equal(init?.signal, controller.signal);
      began();
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Sharing closed", "AbortError")), {once: true}));
    }
    return response(detail);
  }) as typeof fetch;
  const pending = receive(detail.grant.grantId, {signal: controller.signal}), rejected = assert.rejects(pending, {name: "AbortError"});
  await started; controller.abort(); await rejected;
  assert.equal(calls.some(path => path.endsWith("/viewed")), false);
  assert.equal(await get("read", accounts.accounts[1].accountId + ":" + photo.manifest.metadataRepresentation.objectId), undefined);
}));
test("cancelling during the original response body leaves no save request or downloaded original cache", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  const controller = new AbortController(), calls: string[] = [];
  let began!: () => void, release!: (bytes: ArrayBuffer) => void; const started = new Promise<void>(resolve => {began = resolve;});
  const originalID = photo.manifest.representations[0].objectId;
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    if (String(path).startsWith("/v1/objects/")) {
      assert.equal(init?.signal, controller.signal);
      const result = new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
      if (path === "/v1/objects/" + originalID) result.arrayBuffer = async () => {began(); return new Promise<ArrayBuffer>(resolve => {release = resolve;});};
      return result;
    }
    if (String(path).endsWith("/viewed")) return response({});
    if (path === "/v1/saves") assert.fail("A cancelled original cannot be saved");
    return response(detail);
  }) as typeof fetch;
  const pending = saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId, {signal: controller.signal}), rejected = assert.rejects(pending, {name: "AbortError"});
  await started; controller.abort(); release(new Uint8Array(objects.get(originalID)!).buffer); await rejected;
  assert.equal(calls.includes("/v1/saves"), false);
  assert.equal(await get("read", accounts.accounts[1].accountId + ":" + originalID), undefined);
  assert.equal(await get("saves", accounts.accounts[1].accountId + ":" + detail.grant.grantId + ":" + photo.manifest.photoId), undefined);
}));
test("a sender cannot open their recipient-only invitation by possessing the public link", async () => scoped(async () => {
  const {detail} = await fixture();
  globalThis.fetch = (async () => response(detail)) as typeof fetch;
  await assert.rejects(receive(detail.grant.grantId, {}, accounts.accounts[0]), /INVITATION_RECIPIENT_MISMATCH/);
}));

test("each new share creates a distinct moment and sends only the chosen photos", async () => scoped(async () => {
  const {photo, grant} = await fixture(); await pinCard(accounts.accounts[1]);
  const queuedKey = accounts.accounts[0].accountId + ":unrelated-import", queued = {phase: "pending", photoId: crypto.randomUUID()};
  await put("journal", queuedKey, queued);
  const moments: string[] = [], paths: string[] = [];
  globalThis.fetch = (async (path, init) => {
    const value = String(path); paths.push(value);
    const match = /^\/v1\/moments\/([0-9a-f-]{36})\/grants(?:\/options)?$/.exec(value);
    assert.ok(match, "Sharing must not start uploads or catalog writes");
    if (value.endsWith("/options")) {
      moments.push(match[1]);
      return response({...grant, grantId: crypto.randomUUID(), momentId: match[1]});
    }
    const request = JSON.parse(init!.body as string);
    assert.equal(request.grant.momentId, match[1]);
    assert.deepEqual(request.envelopes.map((item: {photoId: string}) => item.photoId), [photo.manifest.photoId]);
    return response(request.grant);
  }) as typeof fetch;
  const first = await sharePhotos([photo], accounts.accounts[1], "ongoing"), second = await sharePhotos([photo], accounts.accounts[1], "ongoing");
  assert.notEqual(first.momentId, second.momentId); assert.equal(new Set(moments).size, 2);
  assert.equal(paths.length, 4); assert.deepEqual(await get("journal", queuedKey), queued);
}));

test("reservation trust replacement in this tab or another tab stops before grant creation", async () => {
  for (const replacementMode of ["acceptance", "shared-cache"]) await scoped(async () => {
    const {photo, grant} = await fixture(); const session = await open(0); await pinCard(accounts.accounts[1]);
    let release!: (value: Response) => void, started!: () => void;
    const began = new Promise<void>(resolve => {started = resolve;}), calls: string[] = [];
    globalThis.fetch = (async path => {calls.push(String(path)); started(); return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
    const pending = sharePhotos([photo], accounts.accounts[1], "ongoing"), rejected = assert.rejects(pending, /ACCOUNT_KEYS_CHANGED/);
    await began;
    const changed = {...accounts.accounts[1], boxPublicKey: accounts.accounts[0].boxPublicKey};
    if (replacementMode === "acceptance") await pinCard(changed);
    else await put("settings", session.accountId + ":pin:" + changed.accountId, wrapKey(utf8(changed), session.vaultKey));
    const momentId = calls[0].split("/")[3]; release(response({...grant, momentId}));
    await rejected; assert.equal(calls.length, 1);
  });
});

test("sender trust replacement during metadata download prevents viewing or publishing", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  let release!: (value: Response) => void, started!: () => void;
  const began = new Promise<void>(resolve => {started = resolve;}), calls: string[] = [];
  globalThis.fetch = (async path => {
    calls.push(String(path));
    if (String(path) === "/v1/objects/" + photo.manifest.metadataRepresentation.objectId) {started(); return new Promise<Response>(resolve => {release = resolve;});}
    if (String(path).startsWith("/v1/grants/")) return response(detail);
    assert.fail("Stale trusted content must not be marked viewed");
  }) as typeof fetch;
  const pending = receive(detail.grant.grantId), rejected = assert.rejects(pending, /ACCOUNT_KEYS_CHANGED/);
  await began; await pinCard({...accounts.accounts[0], signingPublicKey: accounts.accounts[1].signingPublicKey});
  release(new Response(new Uint8Array(objects.get(photo.manifest.metadataRepresentation.objectId)!)));
  await rejected; assert.equal(calls.some(path => path.endsWith("/viewed")), false);
}));

test("sender trust replacement during original download prevents a durable save or POST", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  let release!: (value: Response) => void, started!: () => void;
  const began = new Promise<void>(resolve => {started = resolve;}), calls: string[] = [];
  const originalId = photo.manifest.representations[0].objectId;
  globalThis.fetch = (async path => {
    calls.push(String(path));
    if (String(path) === "/v1/objects/" + originalId) {started(); return new Promise<Response>(resolve => {release = resolve;});}
    if (String(path).startsWith("/v1/objects/")) return new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
    if (String(path).endsWith("/viewed")) return response({});
    if (String(path).startsWith("/v1/grants/")) return response(detail);
    assert.fail("Stale trusted originals must not create saved photos");
  }) as typeof fetch;
  const pending = saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId), rejected = assert.rejects(pending, /ACCOUNT_KEYS_CHANGED/);
  await began; await pinCard({...accounts.accounts[0], boxPublicKey: accounts.accounts[1].boxPublicKey});
  release(new Response(new Uint8Array(objects.get(originalId)!))); await rejected;
  assert.deepEqual(await all("saves"), []); assert.equal(calls.includes("/v1/saves"), false);
}));

test("trusted people outside grant participants cannot supply its photo manifests", async () => scoped(async () => {
  const {detail, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  const box = sodium.crypto_box_keypair(), signing = sodium.crypto_sign_keypair();
  const outsider: AccountCardV1 = {version: 1, accountId: crypto.randomUUID(), boxPublicKey: b64(box.publicKey), signingPublicKey: b64(signing.publicKey)};
  await pinCard(outsider);
  const manifest = {...photo.manifest, ownerAccountId: outsider.accountId}, calls: string[] = [];
  const forged = {...detail, cards: [...detail.cards, outsider], manifests: [signPayload("photo-manifest", outsider.accountId, utf8(manifest), signing.privateKey)],
    envelopes: [sealShareKey(photo.metadataKey, accounts.accounts[1], {version: 1, grantId: detail.grant.grantId, photoId: manifest.photoId, senderAccountId: outsider.accountId, recipientAccountId: accounts.accounts[1].accountId}, signing.privateKey)]};
  globalThis.fetch = (async path => {calls.push(String(path)); return response(forged);}) as typeof fetch;
  await assert.rejects(receive(detail.grant.grantId), /MANIFEST_PARTICIPANT_MISMATCH/);
  assert.deepEqual(calls, ["/v1/grants/" + detail.grant.grantId]);
}));

test("contribution retry checks renewed trust after its cache read and preserves identical durable data", async () => scoped(async () => {
  const {photo, grant} = await fixture(); await pinCard(accounts.accounts[1]);
  const calls: string[] = [], bodies: string[] = [];
  globalThis.fetch = (async (path, init) => {calls.push(String(path)); bodies.push(init!.body as string); return response({version: 1, operationId: JSON.parse(init!.body as string).operationId, accepted: 1});}) as typeof fetch;
  await contribute(grant, [photo]);
  const [cacheKey, before] = (await all("saves"))[0];
  const originalGet = IDBObjectStore.prototype.get;
  let changed = false, replacement: Promise<unknown> | undefined;
  IDBObjectStore.prototype.get = function(key) {
    if (this.name === "saves" && key === cacheKey && !changed) {
      changed = true; replacement = pinCard({...accounts.accounts[1], boxPublicKey: accounts.accounts[0].boxPublicKey});
    }
    return originalGet.call(this, key);
  };
  try {await assert.rejects(contribute(grant, [photo]), /ACCOUNT_KEYS_CHANGED/); await replacement;}
  finally {IDBObjectStore.prototype.get = originalGet;}
  assert.equal(changed, true); assert.equal(calls.length, 1); assert.deepEqual(await get("saves", cacheKey), before);
  await pinCard(accounts.accounts[1]); await contribute(grant, [photo]);
  assert.equal(bodies[0], bodies[1], "Renewed acceptance can replay the same operation without generating another contribution");
}));

test("forged receipt fields and signatures cannot report success and keep a verified retry", async () => {
  for (const alteration of ["operation", "photo", "source-grant", "source-photo", "manifest", "signature", "signer", "kind"]) await scoped(async () => {
    const {detail, objects, photo} = await fixture(); const session = await open(1); await pinCard(accounts.accounts[0]);
    let durableBody = "";
    globalThis.fetch = (async (path, init) => {
      if (String(path).startsWith("/v1/objects/")) return new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
      if (String(path).endsWith("/viewed")) return response({});
      if (path !== "/v1/saves") return response(detail);
      durableBody = init!.body as string;
      const request = JSON.parse(durableBody) as SaveRequestV1, result = structuredClone(request.save);
      if (alteration === "operation") result.operationId = crypto.randomUUID();
      if (alteration === "source-grant") result.sourceGrantId = crypto.randomUUID();
      if (alteration === "source-photo") result.sourcePhotoId = crypto.randomUUID();
      if (alteration === "signature") result.signedPayload.signature = b64(new Uint8Array(64));
      if (alteration === "signer") result.signedPayload.accountId = accounts.accounts[0].accountId;
      if (alteration === "kind") result.signedPayload.kind = "grant";
      if (alteration === "photo") {result.photoId = crypto.randomUUID(); result.manifest.photoId = result.photoId;}
      if (alteration === "manifest") result.manifest.ownerWrappedMetadataKey = wrapKey(photo.metadataKey, session.vaultKey);
      if (["photo", "manifest"].includes(alteration)) result.signedPayload = signPayload("photo-manifest", session.accountId, utf8(result.manifest), session.signingSecretKey);
      return response(result);
    }) as typeof fetch;
    await assert.rejects(saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId), /SAVE_RECEIPT_MISMATCH/, alteration);
    const cached = await get<WrappedKeyV1>("saves", session.accountId + ":" + detail.grant.grantId + ":" + photo.manifest.photoId);
    assert.ok(cached); assert.deepEqual(JSON.parse(new TextDecoder().decode(unwrapKey(cached, session.vaultKey))), JSON.parse(durableBody));
    globalThis.fetch = (async (path, init) => {assert.equal(path, "/v1/saves"); assert.equal(init!.body, durableBody); return response(JSON.parse(durableBody).save);}) as typeof fetch;
    const accepted = await saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
    assert.equal(accepted.operationId, JSON.parse(durableBody).save.operationId);
  });
});

test("accepted save replay survives revoked grants and JSON field reordering without downloading again", async () => scoped(async () => {
  const {detail, objects, photo} = await fixture(); await open(1); await pinCard(accounts.accounts[0]);
  let durableBody = "";
  globalThis.fetch = (async (path, init) => {
    if (String(path).startsWith("/v1/objects/")) return new Response(new Uint8Array(objects.get(String(path).split("/").at(-1)!)!));
    if (String(path).endsWith("/viewed")) return response({});
    if (path === "/v1/saves") {durableBody = init!.body as string; return response(JSON.parse(durableBody).save);}
    return response(detail);
  }) as typeof fetch;
  const first = await saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, nested]) => [key, reorder(nested)])) : value;
  globalThis.fetch = (async (path, init) => {
    if (path !== "/v1/saves") return new Response(JSON.stringify({version: 1, code: "GRANT_INACTIVE"}), {status: 403});
    assert.equal(init!.body, durableBody); return response(reorder(JSON.parse(durableBody).save));
  }) as typeof fetch;
  const replay = await saveReceivedPhoto(detail.grant.grantId, photo.manifest.photoId);
  assert.equal(first.photoId, replay.photoId); assert.equal(first.operationId, replay.operationId);
}));
