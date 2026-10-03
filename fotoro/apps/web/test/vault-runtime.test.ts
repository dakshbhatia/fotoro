import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
// Do not import @fotoro/crypto here: the first unlock exercises a cold runtime.
import {configureVault, unlockVault, lockVault, requireVault, requestDeviceApproval, approveDeviceChallenge} from "../src/vault/vault";

function vault(index = 0) {
  return {version: 1 as const, accountCard: accounts.accounts[index], wrappers: [{
    version: 1 as const, wrapperId: crypto.randomUUID(), kind: "recovery" as const,
    credentialId: null, prfSalt: null, wrappedBundle: accounts.testSecrets[index].encryptedBundle, verified: true,
  }]};
}
function method(index = 0) {
  return {kind: "recovery" as const, secret: new Uint8Array(Buffer.from(accounts.testSecrets[index].recoverySecret, "base64url"))};
}

test("explicit lock during cold crypto import cannot resurrect an unlocked vault", async () => {
  lockVault();
  configureVault(vault());
  const pending = unlockVault(method());
  lockVault();
  await assert.rejects(pending, {name: "AbortError"});
  assert.throws(requireVault, /VAULT_LOCKED/);
});

test("changed envelope during runtime await cannot unlock the new account using an old request", async () => {
  lockVault();
  configureVault(vault());
  const pending = unlockVault(method());
  configureVault(vault(1));
  await assert.rejects(pending, {name: "AbortError"});
  assert.throws(requireVault, /VAULT_LOCKED/);
  const newer = await unlockVault(method(1));
  assert.equal(newer.accountId, accounts.accounts[1].accountId);
  lockVault();
});

test("device enrollment runtime await stops before posting after explicit lock", async () => {
  lockVault();
  configureVault(vault());
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {requests++; throw new Error("Unexpected device request");}) as typeof fetch;
  try {
    const pending = requestDeviceApproval();
    lockVault();
    await assert.rejects(pending, {name: "AbortError"});
    assert.equal(requests, 0);
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {globalThis.fetch = originalFetch; lockVault();}
});

test("an explicit lock listener takes precedence over unlock's internal lock event", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {configurable: true, value: events});
  lockVault();
  configureVault(vault());
  events.addEventListener("fotoro-lock", () => lockVault(), {once: true});
  try {
    await assert.rejects(unlockVault(method()), {name: "AbortError"});
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    lockVault();
  }
});

test("trusted device response after lock cannot reopen the vault", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location"), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  let release!: (response: Response) => void, entered!: () => void, challenge: any;
  const response = new Promise<Response>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {entered = resolve;});
  globalThis.fetch = (async (input, init) => {
    if (input === "/v1/devices/enroll") {
      const body = JSON.parse(init!.body as string);
      challenge = {version: 1, enrollmentId: crypto.randomUUID(), accountId: accounts.accounts[0].accountId,
        deviceId: body.deviceId, boxPublicKey: body.boxPublicKey, challenge: Buffer.alloc(32, 1).toString("base64url"),
        origin: "https://fotoro.cloud", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "pending"};
      return new Response(JSON.stringify(challenge));
    }
    assert.equal(input, "/v1/devices/enroll/" + challenge.enrollmentId + "/complete");
    entered();
    return response;
  }) as typeof fetch;
  try {
    lockVault(); configureVault(vault());
    const pendingDevice = await requestDeviceApproval();
    const pending = unlockVault({kind: "trustedDevice", enrollmentId: pendingDevice.enrollmentId});
    await started;
    lockVault();
    release(new Response(JSON.stringify({})));
    await assert.rejects(pending, {name: "AbortError"});
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    lockVault();
  }
});

test("device approval response cannot report success in a locked scope", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location"), originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  let release!: (response: Response) => void, entered!: () => void;
  const response = new Promise<Response>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {entered = resolve;});
  globalThis.fetch = (async () => {entered(); return response;}) as typeof fetch;
  try {
    lockVault(); configureVault(vault()); await unlockVault(method());
    const challenge = {version: 1, enrollmentId: crypto.randomUUID(), accountId: accounts.accounts[0].accountId,
      deviceId: crypto.randomUUID(), boxPublicKey: accounts.accounts[1].boxPublicKey,
      challenge: Buffer.alloc(32, 1).toString("base64url"), origin: "https://fotoro.cloud",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "pending"};
    const pending = approveDeviceChallenge(JSON.stringify(challenge));
    await started;
    lockVault();
    release(new Response(JSON.stringify({approved: true})));
    await assert.rejects(pending, {name: "AbortError"});
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    lockVault();
  }
});
