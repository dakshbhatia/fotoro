import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {makeAlbumDefinition} from "@fotoro/crypto/albums";
import {createAlbumLink, parseAlbumLink} from "@fotoro/contracts/albums-links";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {clearAccount} from "../src/exchange/cache";
import {albumInbox} from "../src/albums/service";
import {loadAlbumEntry, unsupportedAlbumCapabilities} from "../src/albums/bootstrap";
import {IncomingAlbumIntent} from "../src/albums/intent";
import {pinCard, trustedCard} from "../src/exchange/share-service";
import {ApiError} from "../src/exchange/api-errors";

const capabilities = {version: 1, albumsVersion: 1, maxMembers: 12, maxPhotos: 1000, pageSize: 100};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]});
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
async function fixture() {
  await ready; const owner = await open(0);
  const made = makeAlbumDefinition({albumId: crypto.randomUUID(), title: "Family", createdAt: new Date().toISOString(), ownerCard: owner.card,
    members: [owner.card, accounts.accounts[1]], signingSecretKey: owner.signingSecretKey});
  made.albumKey.fill(0);
  const session = await open(1), incoming = new IncomingAlbumIntent(parseAlbumLink(createAlbumLink(made.definition.albumId, accounts.accounts[0])), session);
  return {session, incoming, overview: {definition: made.signed, membership: "invited" as const, endedAt: null, photoCount: 0}};
}
async function scoped(run: () => Promise<void>) {
  const previous = globalThis.fetch;
  try {for (const card of accounts.accounts) await clearAccount(card.accountId); await run();}
  finally {globalThis.fetch = previous; lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);}
}

test("capabilities/inbox503 and transport failure retry the exact invitation and still require explicit first-owner trust", () => scoped(async () => {
  for (const stage of ["capabilities", "inbox"]) for (const transport of [false, true]) {
    const data = await fixture(); await clearAccount(data.session.accountId);
    let attempts = 0, inboxReads = 0, available = 0;
    const scope = {current: () => data.incoming.current(data.session)};
    globalThis.fetch = async (path, init) => {
      assert.equal(init?.method, "GET", "Entry/retry cannot accept or contribute automatically");
      if (String(path).endsWith("/capabilities")) {
        if (++attempts === 1 && stage === "capabilities") {if (transport) throw new TypeError("offline"); return response({code: "UNAVAILABLE", retryable: true}, 503);}
        return response(capabilities);
      }
      assert.equal(path, "/v1/albums"); inboxReads++;
      if (inboxReads === 1 && stage === "inbox") {if (transport) throw new TypeError("offline"); return response({code: "UNAVAILABLE", retryable: true}, 503);}
      return response({version: 1, albums: [data.overview]});
    };
    const enter = () => loadAlbumEntry({...data, scope, loadInbox: () => albumInbox(scope), onAvailable: () => available++});
    await assert.rejects(enter(), error => {assert.equal(unsupportedAlbumCapabilities(error), false); return true;});
    assert.equal(data.incoming.current(data.session), true); assert.equal(inboxReads, stage === "inbox" ? 1 : 0); assert.equal(available, stage === "inbox" ? 1 : 0);
    const retry = await enter();
    assert.equal(retry.kind, "review");
    if (retry.kind === "review") {assert.deepEqual(retry.overview, data.overview); assert.equal(retry.changed, false);}
    assert.equal(data.incoming.link.albumId, JSON.parse(new TextDecoder().decode(unb64(data.overview.definition.body))).albumId);
    await assert.rejects(trustedCard(accounts.accounts[0].accountId, data.session, scope), /PIN_ACCOUNT_CARD/);
    await pinCard(accounts.accounts[0], scope);
    assert.equal((await enter()).kind, "open", "Only explicitly pinned identity bypasses first-owner review");
    assert.equal(attempts, 3); assert.equal(inboxReads, stage === "inbox" ? 3 : 2);
  }
}));

test("retry entry cannot publish availability or owner review after unmount, incoming cancellation or account swap", () => scoped(async () => {
  for (const invalidate of ["unmount", "incoming", "account"] as const) {
    const data = await fixture(), controller = new AbortController(); let active = true, available = 0, inboxReads = 0;
    const scope = {signal: controller.signal, current: () => active && data.incoming.current(data.session)};
    let release!: (value: Response) => void;
    globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
    const entering = loadAlbumEntry({...data, scope, loadInbox: async () => {inboxReads++; return [data.overview];}, onAvailable: () => available++});
    const rejected = assert.rejects(entering, /VAULT_LOCKED|AbortError|closed|aborted/i);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    if (invalidate === "unmount") {active = false; controller.abort();}
    else if (invalidate === "incoming") data.incoming.cancel();
    else await open(0);
    release(response(capabilities)); await rejected;
    assert.equal(available, 0); assert.equal(inboxReads, 0);
  }
}));

test("late inbox completion stays fenced and retry cannot substitute a different link owner", () => scoped(async () => {
  const data = await fixture(); let active = true, release!: () => void;
  globalThis.fetch = async () => response(capabilities);
  const scope = {current: () => active};
  const entering = loadAlbumEntry({...data, scope, loadInbox: () => new Promise(resolve => {release = () => resolve([data.overview]);}), onAvailable() {}});
  const rejected = assert.rejects(entering, {name: "AbortError"});
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  active = false; release(); await rejected;
  active = true;
  const substituted = new IncomingAlbumIntent(parseAlbumLink(createAlbumLink(data.incoming.link.albumId, accounts.accounts[1])), data.session);
  await assert.rejects(loadAlbumEntry({...data, incoming: substituted, scope, loadInbox: async () => [data.overview], onAvailable() {}}));
  await assert.rejects(trustedCard(accounts.accounts[0].accountId, data.session), /PIN_ACCOUNT_CARD/);
}));

test("unsupported capability responses stay distinct from temporary HTTP or transport failure", () => {
  for (const error of [new Error("ALBUM_UPDATE_REQUIRED"), new ApiError("NOT_FOUND"), new ApiError("HTTP_404"), new ApiError("HTTP_501")]) assert.equal(unsupportedAlbumCapabilities(error), true);
  for (const error of [new ApiError("UNAVAILABLE", true), new ApiError("HTTP_503"), new TypeError("offline"), new ApiError("ACCOUNT_MISMATCH")]) assert.equal(unsupportedAlbumCapabilities(error), false);
});


test("chosen-photo return resolves the exact active album from the verified inbox, without accepting or adding", () => scoped(async () => {
  const data = await fixture();
  const id = JSON.parse(new TextDecoder().decode(unb64(data.overview.definition.body))).albumId;
  let reads = 0;
  globalThis.fetch = async (path, init) => {assert.equal(init?.method, "GET"); reads++; assert.equal(path, "/v1/albums/capabilities"); return response(capabilities);};
  const result = await loadAlbumEntry({session: data.session, scope: {current: () => true}, albumId: id,
    loadInbox: async () => [data.overview], onAvailable: () => {}});
  assert.equal(result.kind, "open"); if (result.kind === "open") assert.deepEqual(result.overview, data.overview);
  assert.equal(reads, 1);
  assert.equal((await loadAlbumEntry({session: data.session, scope: {current: () => true}, albumId: crypto.randomUUID(), loadInbox: async () => [data.overview], onAvailable: () => {}})).kind, "missing");
}));
