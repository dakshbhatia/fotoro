import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, b64} from "@fotoro/crypto";
import {clearBrowserSession, recover} from "../src/vault/session";
import {configureVault, unlockVault, requireVault, lockVault, encryptPrivate} from "../src/vault/vault";
import {put, get, clearAccount} from "../src/exchange/cache";

const vault = (index = 0) => ({version: 1 as const, accountCard: accounts.accounts[index], wrappers: [{version: 1 as const, wrapperId: crypto.randomUUID(), kind: "recovery" as const, credentialId: null, prfSalt: null, verified: true, wrappedBundle: accounts.testSecrets[index].encryptedBundle}]});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
async function open(index = 0) {configureVault(vault(index)); return unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[index].recoverySecret)});}
async function scoped(run: () => Promise<void>) {
  const fetch = globalThis.fetch, descriptors = ["window", "location", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", {configurable: true, value: new EventTarget()});
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {onLine: true}});
  await ready; lockVault();
  try {await run();} finally {
    lockVault(); for (const account of accounts.accounts) await clearAccount(account.accountId);
    globalThis.fetch = fetch;
    for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
  }
}

test("explicit browser clear locks immediately and erases only its account without waiting for logout", async () => scoped(async () => {
  const session = await open(), key = session.accountId + ":pending", other = accounts.accounts[1].accountId + ":pending";
  await put("journal", key, encryptPrivate({operationId: crypto.randomUUID()})); await put("journal", other, {kept: true});
  let release!: (value: Response) => void;
  globalThis.fetch = async (path, init) => {
    assert.equal(path, "/v1/auth/logout"); assert.equal(init?.method, "POST");
    return new Promise<Response>(resolve => {release = resolve;});
  };
  const clearing = clearBrowserSession(session);
  assert.throws(requireVault, /VAULT_LOCKED/);
  const result = await clearing;
  assert.equal(await get("journal", key), undefined); assert.deepEqual(await get("journal", other), {kept: true});
  release(response({version: 1, removed: true})); assert.equal(await result.remote, true);
}));

test("expired or offline logout still clears local data and leaves server sign-out unconfirmed", async () => scoped(async () => {
  for (const mode of ["expired", "offline"]) {
    const session = await open(), key = session.accountId + ":receipt";
    await put("saves", key, encryptPrivate({photoId: crypto.randomUUID()}));
    globalThis.fetch = async () => {if (mode === "offline") throw new TypeError("Offline"); return response({version: 1, code: "UNAUTHENTICATED"}, 401);};
    const result = await clearBrowserSession(session);
    assert.throws(requireVault, /VAULT_LOCKED/); assert.equal(await get("saves", key), undefined);
    assert.equal(await result.remote, false);
  }
}));

test("new password entry cancels pending logout before authentication and a stale clear cannot lock it", async () => scoped(async () => {
  const previous = await open(); let logoutSignal: AbortSignal | undefined;
  globalThis.fetch = async (path, init) => {
    if (path === "/v1/auth/logout") {
      logoutSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => logoutSignal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {once: true}));
    }
    assert.equal(logoutSignal!.aborted, true, "Logout must be cancelled before another session can set a cookie");
    if (path === "/v1/auth/recovery/options") return response({version: 1, challengeId: crypto.randomUUID(), challenge: b64(new Uint8Array(32)), expiresAt: "2100-01-01T00:00:00Z", vault: vault(1)});
    assert.equal(path, "/v1/auth/recovery/verify");
    return response({version: 1, accountId: accounts.accounts[1].accountId, deviceId: crypto.randomUUID(), expiresAt: "2100-01-01T00:00:00Z"});
  };
  const result = await clearBrowserSession(previous);
  await recover("fotoro1." + accounts.accounts[1].accountId + "." + accounts.testSecrets[1].recoverySecret);
  assert.equal(await result.remote, false);
  const current = requireVault();
  await assert.rejects(clearBrowserSession(previous), /VAULT_LOCKED/);
  assert.equal(requireVault(), current);
}));
