import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {api, fetchCipher} from "../src/exchange/api";
import {configureVault, unlockVault, requireVault, lockVault, encryptPrivate, decryptPrivate} from "../src/vault/vault";
import {put, get, clearAccount} from "../src/exchange/cache";

const denied = () => new Response(JSON.stringify({version: 1, code: "UNAUTHENTICATED"}), {status: 401});
async function open(index = 0) {
  configureVault({version: 1, accountCard: accounts.accounts[index], wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: accounts.testSecrets[index].encryptedBundle}]});
  return unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[index].recoverySecret)});
}
async function scoped(run: () => Promise<void>) {
  const fetch = globalThis.fetch, descriptors = ["window", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", {configurable: true, value: new EventTarget()});
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  await ready; lockVault();
  try {await run();} finally {
    lockVault(); globalThis.fetch = fetch;
    for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
  }
}

test("expired private API and original reads close the exact vault and announce reauthentication", async () => scoped(async () => {
  for (const read of [() => api("/v1/grants"), () => fetchCipher(crypto.randomUUID())]) {
    const session = await open(), reasons: unknown[] = [];
    const listener = (event: Event) => reasons.push((event as CustomEvent).detail?.reason);
    window.addEventListener("fotoro-lock", listener);
    globalThis.fetch = async () => denied();
    await assert.rejects(read(), /UNAUTHENTICATED/);
    assert.throws(requireVault, /VAULT_LOCKED/);
    assert.deepEqual(session.vaultKey, new Uint8Array(32));
    assert.deepEqual(reasons, ["expired"]);
    window.removeEventListener("fotoro-lock", listener);
  }
}));

test("late 401 cannot lock a renewed same account, another account, or another origin", async () => scoped(async () => {
  for (const replacement of ["same account", "other account", "origin"]) {
    const original = await open(); let release!: (response: Response) => void;
    globalThis.fetch = async () => new Promise<Response>(resolve => {release = resolve;});
    const pending = api("/v1/grants"), rejected = assert.rejects(pending, /UNAUTHENTICATED/);
    let current = original;
    if (replacement === "origin") Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://other.invalid"}});
    else current = await open(replacement === "other account" ? 1 : 0);
    release(denied()); await rejected;
    assert.equal(requireVault(), current, replacement);
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  }
}));

test("authentication rejection, forbidden access and cancelled requests do not expire an open vault", async () => scoped(async () => {
  const session = await open();
  globalThis.fetch = async () => denied();
  await assert.rejects(api("/v1/auth/recovery/verify", {}), /UNAUTHENTICATED/);
  assert.equal(requireVault(), session);
  globalThis.fetch = async () => new Response(JSON.stringify({version: 1, code: "FORBIDDEN"}), {status: 403});
  await assert.rejects(api("/v1/grants"), /FORBIDDEN/);
  assert.equal(requireVault(), session);
  const controller = new AbortController();
  globalThis.fetch = async () => {controller.abort(); return denied();};
  await assert.rejects(api("/v1/grants", undefined, undefined, "GET", controller.signal), {name: "AbortError"});
  assert.equal(requireVault(), session);
}));

test("session renewal or cancellation while an error body is pending defeats expiration", async () => scoped(async () => {
  for (const action of ["renew", "cancel"]) {
    const old = await open(), controller = new AbortController();
    let release!: (body: unknown) => void, began!: () => void;
    const reading = new Promise<void>(resolve => {began = resolve;});
    globalThis.fetch = async () => {
      const response = denied();
      response.json = () => {began(); return new Promise(resolve => {release = resolve;});};
      return response;
    };
    const pending = api("/v1/grants", undefined, undefined, "GET", controller.signal);
    const rejected = action === "renew" ? assert.rejects(pending, /UNAUTHENTICATED/) : assert.rejects(pending, {name: "AbortError"});
    await reading;
    const current = action === "renew" ? await open() : old;
    if (action === "cancel") controller.abort();
    release({version: 1, code: "UNAUTHENTICATED"}); await rejected;
    assert.equal(requireVault(), current);
  }
}));

test("expiration preserves encrypted queued work and recipient Save receipts for same-account recovery", async () => scoped(async () => {
  const session = await open(), value = {operationId: crypto.randomUUID(), chosen: "pending original"}, encrypted = encryptPrivate(value);
  const key = session.accountId + ":expiration-work";
  try {
    for (const store of ["journal", "saves"] as const) await put(store, key, encrypted);
    globalThis.fetch = async () => denied();
    await assert.rejects(api("/v1/grants"), /UNAUTHENTICATED/);
    await open();
    for (const store of ["journal", "saves"] as const) {
      const stored = await get<typeof encrypted>(store, key);
      assert.deepEqual(stored, encrypted); assert.deepEqual(decryptPrivate(stored!), value);
    }
  } finally {await clearAccount(session.accountId);}
}));
