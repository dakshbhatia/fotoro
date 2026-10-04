import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import type {GrantV1} from "@fotoro/contracts";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {currentReceivedGrant, ReceivedAccessRefresh} from "../src/exchange/received-access";

const grant: GrantV1 = {grantId: crypto.randomUUID(), momentId: crypto.randomUUID(), ownerAccountId: accounts.accounts[0].accountId,
  recipientAccountId: accounts.accounts[1].accountId, role: "contributor", revokedAt: null, expiresAt: null, version: 1};
const response = (grants: GrantV1[]) => new Response(JSON.stringify({version: 1, grants}));
async function open(index = 1) {
  await ready;
  const secret = accounts.testSecrets[index];
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}

test("a received presentation survives active access and withdraws only a verified missing, ended, expired or changed binding", () => {
  const account = grant.recipientAccountId;
  assert.equal(currentReceivedGrant(grant, [grant], account), grant);
  assert.equal(currentReceivedGrant(grant, [], account), null);
  assert.equal(currentReceivedGrant(grant, [{...grant, revokedAt: "2026-10-04T00:00:00Z"}], account), null);
  assert.equal(currentReceivedGrant(grant, [{...grant, expiresAt: "2000-01-01T00:00:00Z"}], account), null);
  for (const changed of [{momentId: crypto.randomUUID()}, {ownerAccountId: crypto.randomUUID()}, {recipientAccountId: crypto.randomUUID()}, {role: "viewer" as const}, {version: 0}]) {
    assert.equal(currentReceivedGrant(grant, [{...grant, ...changed}], account), null);
  }
  const updated = {...grant, version: 2, expiresAt: "2100-01-01T00:00:00Z"};
  assert.equal(currentReceivedGrant(grant, [updated], account), updated);
  assert.equal(currentReceivedGrant(grant, [grant], crypto.randomUUID()), null);
});

test("overlapping foreground reads coalesce into one GET and a transient failure allows retry", async () => {
  const prior = globalThis.fetch, reader = new ReceivedAccessRefresh();
  try {
    const session = await open(); let release!: (value: Response) => void; let calls = 0;
    globalThis.fetch = (async (path, init) => {assert.equal(path, "/v1/grants"); assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); calls++; return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
    const a = reader.read(grant, session, () => true), b = reader.read(grant, session, () => true);
    assert.equal(calls, 1); release(response([grant]));
    assert.deepEqual(await Promise.all([a, b]), [grant, grant]);
    globalThis.fetch = (async () => {throw new TypeError("Offline");}) as typeof fetch;
    await assert.rejects(reader.read(grant, session, () => true), /Offline/);
    globalThis.fetch = (async () => response([grant])) as typeof fetch;
    assert.deepEqual(await reader.read(grant, session, () => true), grant);
  } finally {reader.cancel(); globalThis.fetch = prior; lockVault();}
});

test("a cancelled or replacement account read cannot withdraw a new received presentation", async () => {
  const prior = globalThis.fetch, reader = new ReceivedAccessRefresh();
  try {
    const session = await open(); let release!: (value: Response) => void;
    globalThis.fetch = (async () => new Promise<Response>(resolve => {release = resolve;})) as typeof fetch;
    const old = reader.read(grant, session, () => true), rejected = assert.rejects(old, {name: "AbortError"});
    reader.cancel();
    globalThis.fetch = (async () => response([grant])) as typeof fetch;
    const fresh = reader.read(grant, session, () => true);
    release(response([])); await rejected;
    assert.deepEqual(await fresh, grant);
    globalThis.fetch = (async () => new Promise<Response>(resolve => {release = resolve;})) as typeof fetch;
    const switched = reader.read(grant, session, () => true), denied = assert.rejects(switched, /VAULT_LOCKED/);
    lockVault(); await open(0); release(response([])); await denied;
  } finally {reader.cancel(); globalThis.fetch = prior; lockVault();}
});
