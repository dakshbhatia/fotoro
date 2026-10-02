import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ready, b64, unb64, sodium, verifyPayload } from "@fotoro/crypto";
import { formatFotoroPassword, parseFotoroPassword } from "../src/vault/password";
import { prepareEnrollment, completeEnrollment, cancelEnrollment, recover } from "../src/vault/session";
import { requireVault, lockVault, configureVault, unlockVault } from "../src/vault/vault";
import { db, get, put } from "../src/exchange/cache";
import { AccountAccess } from "../src/vault/AccountAccess";
import { readableSyncError } from "../src/exchange/sync";
import accounts from "../../../fixtures/accounts.json";

const accountId = "00112233-4455-6677-8899-aabbccddeeff";
const secret = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const vector = "foto_ABEiM0RVZneImaq7zN3u_wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const options = () => ({ version: 1, accountId, challengeId: crypto.randomUUID(), challenge: b64(sodium.randombytes_buf(32)), expiresAt: new Date(Date.now() + 300_000).toISOString() });
const session = () => ({ version: 1, accountId, deviceId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 300_000).toISOString() });

async function browserTest(run: () => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const previous = ["navigator", "location"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://fotoro.cloud" } });
  await ready;
  lockVault();
  cancelEnrollment();
  try { await run(); } finally {
    cancelEnrollment();
    lockVault();
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("Fotoro password matches the native UUID byte-order vector and accepts old saved credentials", async () => {
  await ready;
  assert.equal(formatFotoroPassword(accountId, secret), vector);
  assert.equal(vector.length, 69);
  const parsed = parseFotoroPassword(" \n" + vector + "\n");
  assert.equal(parsed.accountId, accountId);
  assert.deepEqual(parsed.secret, secret);
  const old = parseFotoroPassword("fotoro1." + accountId.toUpperCase() + "." + b64(secret));
  assert.equal(old.accountId, accountId);
  assert.deepEqual(old.secret, secret);
  assert.deepEqual(secret, new Uint8Array(Array.from({ length: 32 }, (_, i) => i)));
});

test("malformed passwords fail before any account request", async () => browserTest(async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Unexpected network"); }) as typeof fetch;
  for (const password of ["", "hello", vector.slice(0, -1), vector + "=", vector.replace("ABEi", "AB E"), "fotoro1.not-a-uuid." + b64(secret), "fotoro1." + accountId + "." + b64(secret.slice(1))]) {
    await assert.rejects(recover(password), /INVALID_FOTORO_PASSWORD/);
  }
  assert.equal(requests, 0);
  assert.match(readableSyncError(new Error("INVALID_FOTORO_PASSWORD")), /Fotoro password/);
}));

test("new account uses signed start enrollment and unlocks without a passkey or save acknowledgement", async () => browserTest(async () => {
  const start = options(), paths: string[] = [];
  let generated = "";
  globalThis.fetch = (async (path, init) => {
    paths.push(String(path));
    const input = JSON.parse(init!.body as string);
    if (path === "/v1/auth/start/options") {
      assert.deepEqual(input, { version: 1, client: "web" });
      return response(start);
    }
    assert.equal(path, "/v1/auth/start/verify");
    assert.equal(input.enrollment.version, 1);
    assert.equal(input.response, undefined);
    const card = input.enrollment.accountCard;
    assert.equal(card.accountId, accountId);
    const proof = JSON.parse(new TextDecoder().decode(verifyPayload(input.signedPayload, unb64(card.signingPublicKey))));
    assert.equal(input.signedPayload.kind, "start-enrollment");
    assert.deepEqual(proof, { version: 1, accountId, challengeId: start.challengeId, challenge: start.challenge, client: "web", origin: "https://fotoro.cloud" });
    const enrollment = JSON.parse(new TextDecoder().decode(verifyPayload(input.enrollment.proof, unb64(card.signingPublicKey))));
    assert.deepEqual(enrollment, { accountCard: card, recoveryWrapper: input.enrollment.recoveryWrapper });
    assert.equal(parseFotoroPassword(generated).accountId, accountId);
    assert.equal(JSON.stringify(input).includes(generated), false);
    return response(session());
  }) as typeof fetch;
  generated = await prepareEnrollment();
  assert.match(generated, /^foto_[A-Za-z0-9_-]{64}$/);
  await completeEnrollment();
  assert.equal(requireVault().accountId, accountId);
  assert.deepEqual(paths, ["/v1/auth/start/options", "/v1/auth/start/verify"]);
  await assert.rejects(completeEnrollment(), /ACCOUNT_SETUP_NOT_STARTED/);
}));

test("failed completion keeps the same pending password for retry", async () => browserTest(async () => {
  let starts = 0, verifies = 0;
  const start = options();
  globalThis.fetch = (async path => {
    if (path === "/v1/auth/start/options") { starts++; return response(start); }
    if (path === "/v1/auth/recovery/options") return response({ version: 1, code: "NOT_FOUND" }, 404);
    verifies++;
    return verifies === 1 ? response({ version: 1, code: "UNAVAILABLE" }, 503) : response(session());
  }) as typeof fetch;
  const password = await prepareEnrollment();
  await assert.rejects(completeEnrollment(), /UNAVAILABLE/);
  assert.throws(requireVault, /VAULT_LOCKED/);
  await completeEnrollment();
  assert.equal(requireVault().accountId, parseFotoroPassword(password).accountId);
  assert.equal(starts, 1);
  assert.equal(verifies, 2);
}));

test("Continue after a lost creation response signs in with the same displayed password", async () => browserTest(async () => {
  const start = options();
  let enrollment: any;
  globalThis.fetch = (async (path, init) => {
    if (path === "/v1/auth/start/options") return response(start);
    if (path === "/v1/auth/start/verify") {
      enrollment = JSON.parse(init!.body as string).enrollment;
      throw new TypeError("Response lost after account creation");
    }
    if (path === "/v1/auth/recovery/options") return response({ version: 1, challengeId: start.challengeId, challenge: start.challenge, expiresAt: start.expiresAt, vault: { version: 1, accountCard: enrollment.accountCard, wrappers: [enrollment.recoveryWrapper] } });
    assert.equal(path, "/v1/auth/recovery/verify");
    const input = JSON.parse(init!.body as string);
    assert.equal(input.signedPayload.kind, "recovery-session");
    return response(session());
  }) as typeof fetch;
  const password = await prepareEnrollment();
  await assert.rejects(completeEnrollment(), /Response lost/);
  await completeEnrollment();
  assert.equal(requireVault().accountId, accountId);
  assert.equal(parseFotoroPassword(password).accountId, accountId);
}));

test("cancelling while start verification is pending cannot open a late account", async () => browserTest(async () => {
  let release: (value: Response) => void = () => {}, started = false;
  globalThis.fetch = (async path => {
    if (path === "/v1/auth/start/options") return response(options());
    started = true;
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  await prepareEnrollment();
  const completing = completeEnrollment();
  while (!started) await new Promise(resolve => setTimeout(resolve, 0));
  cancelEnrollment();
  release(response(session()));
  await assert.rejects(completing, error => error instanceof Error && error.name === "AbortError");
  assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("password sign-in rejects a mismatched account response and supports a legacy saved code", async () => browserTest(async () => {
  const card = accounts.accounts[0], saved = accounts.testSecrets[0], challengeId = crypto.randomUUID();
  let mismatch = true;
  globalThis.fetch = (async path => path === "/v1/auth/recovery/options"
    ? response({ version: 1, challengeId, challenge: b64(secret), expiresAt: new Date(Date.now() + 300_000).toISOString(), vault: { version: 1, accountCard: card, wrappers: [{ version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, wrappedBundle: saved.encryptedBundle, verified: true }] } })
    : response({ ...session(), accountId: mismatch ? accountId : card.accountId })) as typeof fetch;
  const code = "fotoro1." + card.accountId + "." + saved.recoverySecret;
  await assert.rejects(recover(code), /PASSWORD_ACCOUNT_MISMATCH/);
  assert.throws(requireVault, /VAULT_LOCKED/);
  mismatch = false;
  await recover(code);
  assert.equal(requireVault().accountId, card.accountId);
}));

const publicVault = (index: number) => ({ version: 1 as const, accountCard: accounts.accounts[index], wrappers: [{ version: 1 as const, wrapperId: crypto.randomUUID(), kind: "recovery" as const, credentialId: null, prfSalt: null, verified: true, wrappedBundle: accounts.testSecrets[index].encryptedBundle }] });
const recoveryOptions = (vault = publicVault(0)) => ({ version: 1, challengeId: crypto.randomUUID(), challenge: b64(secret), expiresAt: new Date(Date.now() + 300_000).toISOString(), vault });

test("late password options cannot reopen after lock or close a newly opened account", async () => browserTest(async () => {
  for (const switchAccount of [false, true]) {
    let release: (value: Response) => void = () => {}, started = false, requests = 0;
    globalThis.fetch = (async () => {
      requests++; started = true;
      return new Promise<Response>(resolve => { release = resolve; });
    }) as typeof fetch;
    const signingIn = recover("fotoro1." + accounts.accounts[0].accountId + "." + accounts.testSecrets[0].recoverySecret);
    while (!started) await new Promise(resolve => setTimeout(resolve, 0));
    lockVault();
    let newer: ReturnType<typeof requireVault> | undefined;
    if (switchAccount) {
      configureVault(publicVault(1) as any);
      newer = await unlockVault({ kind: "recovery", secret: unb64(accounts.testSecrets[1].recoverySecret) });
    }
    release(response(recoveryOptions()));
    await assert.rejects(signingIn, error => error instanceof Error && error.name === "AbortError");
    assert.equal(requests, 1);
    if (newer) assert.equal(requireVault(), newer);
    else assert.throws(requireVault, /VAULT_LOCKED/);
  }
}));

test("Back cancellation during password verification cannot complete account activation", async () => browserTest(async () => {
  let release: (value: Response) => void = () => {}, started = false, current = true;
  const previousAccount = await get("settings", "last-account");
  globalThis.fetch = (async path => {
    if (path === "/v1/auth/recovery/options") return response(recoveryOptions());
    started = true;
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  const signingIn = recover("fotoro1." + accounts.accounts[0].accountId + "." + accounts.testSecrets[0].recoverySecret, () => current);
  while (!started) await new Promise(resolve => setTimeout(resolve, 0));
  current = false;
  release(response({ ...session(), accountId: accounts.accounts[0].accountId }));
  await assert.rejects(signingIn, error => error instanceof Error && error.name === "AbortError");
  assert.throws(requireVault, /VAULT_LOCKED/);
  assert.equal(await get("settings", "last-account"), previousAccount);
}));

for (const interruption of ["lock", "cancel"] as const) test(interruption + " during enrollment cache write closes the opened vault and does not overwrite last account", async () => browserTest(async () => {
  const database: any = await db(), originalTransaction = database.transaction;
  const previousAccount = accounts.accounts[1].accountId;
  await put("settings", "last-account", previousAccount);
  let enrollment: any;
  const start = options();
  globalThis.fetch = (async (path, init) => {
    if (path === "/v1/auth/start/options") return response(start);
    if (path === "/v1/auth/start/verify") {
      enrollment = JSON.parse(init!.body as string).enrollment;
      return response(session());
    }
    if (path === "/v1/auth/recovery/options") return response({ ...recoveryOptions(), vault: { version: 1, accountCard: enrollment.accountCard, wrappers: [enrollment.recoveryWrapper] } });
    return response(session());
  }) as typeof fetch;
  const password = await prepareEnrollment();
  let intercepted = false;
  database.transaction = function (...args: any[]) {
    const tx = originalTransaction.apply(this, args);
    if (!intercepted && args[1] === "readwrite") {
      intercepted = true;
      tx.addEventListener("complete", () => { if (interruption === "lock") lockVault(); else cancelEnrollment(); }, { once: true });
    }
    return tx;
  };
  try {
    await assert.rejects(completeEnrollment(), error => error instanceof Error && error.name === "AbortError");
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally { database.transaction = originalTransaction; }
  assert.equal(await get("settings", "last-account"), previousAccount);
  if (interruption === "lock") await completeEnrollment();
  else {
    await assert.rejects(completeEnrollment(), /ACCOUNT_SETUP_NOT_STARTED/);
    await recover(password);
  }
  assert.equal(requireVault().accountId, parseFotoroPassword(password).accountId);
}));

test("primary account UI has one password entry and no second recovery/save checkbox flow", () => {
  const props = { password: "", onPassword: () => {}, generatedPassword: "", busy: false, onSignIn: () => {}, onCreate: () => {}, onContinue: () => {}, onBack: () => {}, onPasskey: () => {}, onCopy: () => {}, onSave: () => {} };
  const markup = renderToStaticMarkup(createElement(AccountAccess, props));
  assert.equal((markup.match(/<input/g) ?? []).length, 1);
  assert.match(markup, /autoComplete="current-password"/i);
  assert.match(markup, /Fotoro password/);
  assert.match(markup, /<details><summary>Other ways to sign in/);
  assert.doesNotMatch(markup, /recovery|checkbox/);
  const newAccount = renderToStaticMarkup(createElement(AccountAccess, { ...props, generatedPassword: vector }));
  assert.match(newAccount, /Copy password/);
  assert.match(newAccount, /Save password/);
  assert.match(newAccount, /autoComplete="new-password"/i);
  assert.doesNotMatch(newAccount, /checkbox|passkey|recovery/);
  assert.match(newAccount, /<button class="primary-action" type="submit">Continue<\/button>/);
});
