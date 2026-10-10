import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import accounts from "../../../fixtures/accounts.json";
import {ready, b64, unb64, utf8, wrapKey, unwrapKey, verifyPayload} from "@fotoro/crypto";
import {addPasskey, passkeyLogin} from "../src/vault/session";
import {configureVault, unlockVault, lockVault, requireVault, authenticatedApprovalAccount} from "../src/vault/vault";
import {atomic, get, put} from "../src/exchange/cache";
import {AccountAccess} from "../src/vault/AccountAccess";

await ready;
const credentialId = b64(new Uint8Array([1,2,3])), salt = b64(new Uint8Array(32).fill(9)), prf = new Uint8Array(32).fill(7);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
const session = (index = 0) => ({version: 1, accountId: accounts.accounts[index].accountId, deviceId: crypto.randomUUID(), expiresAt: "2099-01-01T00:00:00Z"});
function vault(index = 0, withPrf = true) {
  const secret = accounts.testSecrets[index];
  return {version: 1 as const, accountCard: accounts.accounts[index], wrappers: [
    {version: 1 as const, wrapperId: crypto.randomUUID(), kind: "recovery" as const, credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle},
    ...(withPrf ? [{version: 1 as const, wrapperId: crypto.randomUUID(), kind: "prf" as const, credentialId, prfSalt: salt, verified: false,
      wrappedBundle: wrapKey(utf8({vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey}), prf)}] : []),
  ]};
}
const options = (accountId?: string) => ({version: 1, accountId, challengeId: crypto.randomUUID(), options: {
  challenge: "AQ", rpId: "fotoro.cloud", rp: {name: "Fotoro", id: "fotoro.cloud"},
  user: {id: b64(utf8(accountId ?? accounts.accounts[0].accountId)), name: "Fotoro", displayName: "Fotoro"},
  pubKeyCredParams: [{type: "public-key", alg: -7}],
}});
function credential(output: Uint8Array | undefined, registration = false, prfEnabled = !!output) {
  return {id: credentialId, rawId: unb64(credentialId).buffer, type: "public-key", authenticatorAttachment: "platform",
    response: registration ? {clientDataJSON: new ArrayBuffer(1), attestationObject: new ArrayBuffer(1), getTransports: () => ["internal"]}
      : {clientDataJSON: new ArrayBuffer(1), authenticatorData: new ArrayBuffer(1), signature: new ArrayBuffer(1), userHandle: new ArrayBuffer(1)},
    getClientExtensionResults: () => ({prf: {enabled: prfEnabled, ...(output ? {results: {first: output.slice().buffer}} : {})}}),
  };
}
async function scoped(run: (credentials: {create: (input: any) => Promise<any>; get: (input: any) => Promise<any>}) => Promise<void>) {
  const savedFetch = globalThis.fetch, keys = ["navigator", "location", "window", "PublicKeyCredential"];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const credentials = {create: async (_input: any) => credential(prf, true), get: async (_input: any) => credential(prf)};
  for (const [key, value] of Object.entries({navigator: {credentials, onLine: true}, location: {origin: "https://fotoro.cloud"}, window: new EventTarget(), PublicKeyCredential: class {}}))
    Object.defineProperty(globalThis, key, {configurable: true, value});
  await ready; lockVault();
  await atomic([{store: "settings", key: "last-account"}]);
  try {await run(credentials);} finally {
    lockVault(); globalThis.fetch = savedFetch;
    await atomic([{store: "settings", key: "last-account"}, ...accounts.accounts.map(card => ({store: "settings" as const, key: card.accountId + ":vault"}))]);
    for (const [key, descriptor] of saved) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
  }
}
async function open() {
  configureVault(vault(0, false));
  return unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[0].recoverySecret)});
}

test("adding a passkey preserves the existing account/recovery and uploads only an encrypted bundle", async () => scoped(async credentials => {
  const opened = await open(), source = vault(0, false); let registered = false, stored: any, inputSalt: Uint8Array | undefined;
  credentials.create = async input => {inputSalt = input.publicKey.extensions.prf.eval.first; return credential(prf, true);};
  globalThis.fetch = async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/vault") return response(source);
    if (path === "/v1/auth/register/options") {assert.equal(body.accountId, opened.accountId); return response(options(opened.accountId));}
    if (path === "/v1/auth/register/verify") {
      registered = true; assert.deepEqual(body.enrollment.accountCard, opened.card);
      assert.deepEqual(body.enrollment.recoveryWrapper, source.wrappers[0]);
      const proof = JSON.parse(new TextDecoder().decode(verifyPayload(body.enrollment.proof, unb64(opened.card.signingPublicKey))));
      assert.deepEqual(proof, {accountCard: opened.card, recoveryWrapper: source.wrappers[0]});
      assert.deepEqual(body.response.clientExtensionResults.prf, {enabled: true});
      assert.equal(String(init!.body).includes(b64(prf)), false);
      return response(session());
    }
    assert.equal(registered, true); assert.match(String(path), /^\/v1\/vault\/wrappers\//); stored = body;
    assert.equal(String(init!.body).includes(accounts.testSecrets[0].vaultKey), false);
    return response(body);
  };
  assert.equal(await addPasskey(), true); assert.equal(requireVault(), opened);
  assert.equal(stored.credentialId, credentialId); assert.equal(stored.prfSalt, b64(inputSalt!));
  const bundle = JSON.parse(new TextDecoder().decode(unwrapKey(stored.wrappedBundle, prf)));
  assert.equal(bundle.vaultKey, accounts.testSecrets[0].vaultKey);
  const cached = await get<ReturnType<typeof vault>>("settings", opened.accountId + ":vault");
  assert.deepEqual(cached!.wrappers[0], source.wrappers[0]); assert.equal(cached!.wrappers.length, 2);
}));

test("unsupported PRF and failed wrapper storage leave password recovery and the open account intact", async () => scoped(async credentials => {
  for (const mode of ["unsupported", "storage failure"]) {
    const opened = await open(), source = vault(0, false); let writes = 0;
    credentials.create = async () => credential(mode === "unsupported" ? undefined : prf, true);
    globalThis.fetch = async path => {
      if (path === "/v1/vault") return response(source);
      if (path === "/v1/auth/register/options") return response(options(opened.accountId));
      if (path === "/v1/auth/register/verify") return response(session());
      writes++; return response({code: "UNAVAILABLE"}, 503);
    };
    assert.equal(await addPasskey(), false); assert.equal(requireVault(), opened);
    assert.equal(writes, mode === "unsupported" ? 0 : 1);
  }
}));

test("PRF-enabled creation without usable output evaluates the new credential before wrapping the unchanged vault", async () => scoped(async credentials => {
  for (const creationOutput of [undefined, new Uint8Array(31).fill(8)]) {
    const opened = await open(), source = vault(0, false), assertionOutput = prf.slice();
    let inputSalt: Uint8Array | undefined, stored: any, assertions = 0, verified = false;
    credentials.create = async input => {inputSalt = input.publicKey.extensions.prf.eval.first; return credential(creationOutput, true, true);};
    credentials.get = async input => {
      assertions++;
      assert.deepEqual(input.publicKey.allowCredentials.map((c: any) => b64(new Uint8Array(c.id))), [credentialId]);
      assert.deepEqual(new Uint8Array(input.publicKey.extensions.prf.eval.first), inputSalt);
      assert.equal(requireVault(), opened);
      return {...credential(undefined), getClientExtensionResults: () => ({prf: {results: {first: assertionOutput.buffer}}})};
    };
    globalThis.fetch = async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/v1/vault") return response(source);
      if (path === "/v1/auth/register/options") return response(options(opened.accountId));
      if (path === "/v1/auth/register/verify") {
        assert.deepEqual(body.enrollment.accountCard, opened.card);
        assert.deepEqual(body.enrollment.recoveryWrapper, source.wrappers[0]);
        assert.deepEqual(body.response.clientExtensionResults.prf, {enabled: true});
        return response(session());
      }
      if (path === "/v1/auth/login/options") {assert.equal(body.accountId, opened.accountId); return response(options());}
      if (path === "/v1/auth/login/verify") {
        assert.equal(body.response.id, credentialId);
        assert.equal(body.response.clientExtensionResults.prf.results, undefined);
        assert.equal(String(init!.body).includes(b64(prf)), false);
        verified = true; return response(session());
      }
      assert.equal(verified, true); assert.match(String(path), /^\/v1\/vault\/wrappers\//);
      assert.equal(String(init!.body).includes(accounts.testSecrets[0].vaultKey), false);
      stored = body; return response(body);
    };
    assert.equal(await addPasskey(), true); assert.equal(assertions, 1); assert.equal(requireVault(), opened);
    assert.equal(stored.credentialId, credentialId); assert.equal(stored.prfSalt, b64(inputSalt!));
    const bundle = JSON.parse(new TextDecoder().decode(unwrapKey(stored.wrappedBundle, prf)));
    assert.deepEqual(bundle, {vaultKey: accounts.testSecrets[0].vaultKey, boxSecretKey: accounts.testSecrets[0].boxSecretKey, signingSecretKey: accounts.testSecrets[0].signingSecretKey});
    const cached = await get<ReturnType<typeof vault>>("settings", opened.accountId + ":vault");
    assert.deepEqual(cached!.accountCard, opened.card); assert.deepEqual(cached!.wrappers[0], source.wrappers[0]);
    assert.ok(assertionOutput.every(byte => byte === 0));
  }
}));

test("cancelling PRF assertion or its verification cannot publish a wrapper or replace a newer vault", async () => scoped(async credentials => {
  for (const action of ["back", "lock", "origin", "replacement", "verify-back"]) {
    const opened = await open(), source = vault(0, false), output = prf.slice();
    let current = true, verifies = 0, writes = 0, replacement: ReturnType<typeof requireVault> | undefined;
    credentials.create = async () => credential(undefined, true, true);
    credentials.get = async () => {
      if (action === "back") current = false;
      if (action === "lock") lockVault();
      if (action === "origin") Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://other.invalid"}});
      if (action === "replacement") {
        configureVault(vault(1, false));
        replacement = await unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[1].recoverySecret)});
      }
      return {...credential(undefined), getClientExtensionResults: () => ({prf: {results: {first: output.buffer}}})};
    };
    globalThis.fetch = async path => {
      if (path === "/v1/vault") return response(source);
      if (path === "/v1/auth/register/options") return response(options(opened.accountId));
      if (path === "/v1/auth/register/verify") return response(session());
      if (path === "/v1/auth/login/options") return response(options());
      if (path === "/v1/auth/login/verify") {verifies++; current = false; return response(session());}
      writes++; return response({});
    };
    await assert.rejects(addPasskey(() => current), {name: "AbortError"});
    assert.equal(verifies, action === "verify-back" ? 1 : 0); assert.equal(writes, 0);
    assert.ok(output.every(byte => byte === 0));
    assert.equal(await get("settings", opened.accountId + ":vault"), undefined);
    if (action === "lock") assert.throws(requireVault, /VAULT_LOCKED/);
    else assert.equal(requireVault(), replacement ?? opened);
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  }
}));

test("PRF follow-up requires both the registered credential and the existing server account", async () => scoped(async credentials => {
  for (const mismatch of ["credential", "account"]) {
    const opened = await open(), source = vault(0, false), output = prf.slice(); let verifies = 0, writes = 0;
    credentials.create = async () => credential(undefined, true, true);
    credentials.get = async () => ({...credential(undefined), id: mismatch === "credential" ? b64(new Uint8Array([4,5,6])) : credentialId,
      getClientExtensionResults: () => ({prf: {results: {first: output.buffer}}})});
    globalThis.fetch = async path => {
      if (path === "/v1/vault") return response(source);
      if (path === "/v1/auth/register/options") return response(options(opened.accountId));
      if (path === "/v1/auth/register/verify") return response(session());
      if (path === "/v1/auth/login/options") return response(options());
      if (path === "/v1/auth/login/verify") {verifies++; return response(session(1));}
      writes++; return response({});
    };
    await assert.rejects(addPasskey(), /PASSWORD_ACCOUNT_MISMATCH/);
    assert.equal(verifies, mismatch === "account" ? 1 : 0); assert.equal(writes, 0);
    assert.equal(requireVault(), opened); assert.ok(output.every(byte => byte === 0));
    assert.equal(await get("settings", opened.accountId + ":vault"), undefined);
  }
}));

test("locking during passkey creation defeats verification and wrapper publication", async () => scoped(async credentials => {
  await open(); const paths: string[] = [];
  credentials.create = async () => {lockVault(); return credential(prf, true);};
  globalThis.fetch = async path => {paths.push(String(path)); return response(path === "/v1/vault" ? vault(0, false) : options(accounts.accounts[0].accountId));};
  await assert.rejects(addPasskey(), {name: "AbortError"});
  assert.deepEqual(paths, ["/v1/vault", "/v1/auth/register/options"]); assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("fresh-browser passkey login learns its salt and unlocks with the same credential", async () => scoped(async credentials => {
  let ceremonies = 0, verifies = 0; const source = vault();
  credentials.get = async input => {
    ceremonies++;
    if (ceremonies === 1) {assert.equal(input.publicKey.extensions, undefined); return credential(undefined);}
    assert.deepEqual(input.publicKey.allowCredentials.map((c: any) => b64(new Uint8Array(c.id))), [credentialId]);
    assert.equal(b64(new Uint8Array(input.publicKey.extensions.prf.eval.first)), salt);
    return credential(prf);
  };
  globalThis.fetch = async path => {
    if (path === "/v1/auth/login/options") return response(options());
    if (path === "/v1/auth/login/verify") {verifies++; return response(session());}
    assert.equal(path, "/v1/vault"); return response(source);
  };
  await passkeyLogin(); assert.equal(ceremonies, 2); assert.equal(verifies, 2);
  assert.equal(b64(requireVault().vaultKey), accounts.testSecrets[0].vaultKey);
  assert.equal(await get("settings", "last-account"), source.accountCard.accountId);
}));

test("remembered browsers allow another account without invalid discoverable PRF input", async () => scoped(async credentials => {
  const remembered = vault(); await put("settings", "last-account", remembered.accountCard.accountId); await put("settings", remembered.accountCard.accountId + ":vault", remembered);
  let ceremonies = 0;
  credentials.get = async input => {
    ceremonies++;
    if (input.publicKey.extensions?.prf?.evalByCredential && !input.publicKey.allowCredentials?.length)
      throw new DOMException("Discoverable PRF map is unsupported", "NotSupportedError");
    if (ceremonies === 1) {assert.equal(input.publicKey.extensions, undefined); return credential(undefined);}
    assert.deepEqual(input.publicKey.allowCredentials.map((c: any) => b64(new Uint8Array(c.id))), [credentialId]);
    assert.equal(b64(new Uint8Array(input.publicKey.extensions.prf.eval.first)), salt);
    return credential(prf);
  };
  globalThis.fetch = async (path, init) => {
    if (path === "/v1/auth/login/options") {assert.equal(JSON.parse(String(init!.body)).accountId, ceremonies === 0 ? undefined : accounts.accounts[1].accountId); return response(options());}
    if (path === "/v1/auth/login/verify") return response(session(1));
    return response(vault(1));
  };
  await passkeyLogin(() => true, {discoverAccount: true}); assert.equal(ceremonies, 2); assert.equal(requireVault().accountId, accounts.accounts[1].accountId);
}));

test("returning-browser passkey evaluates cached salt once on an account-bound server challenge", async () => scoped(async credentials => {
  const remembered = vault(); await put("settings", "last-account", remembered.accountCard.accountId); await put("settings", remembered.accountCard.accountId + ":vault", remembered);
  let ceremonies = 0, verifies = 0, reads = 0;
  credentials.get = async input => {
    ceremonies++;
    assert.deepEqual(input.publicKey.allowCredentials.map((value: any) => b64(new Uint8Array(value.id))), [credentialId]);
    assert.equal(b64(new Uint8Array(input.publicKey.extensions.prf.evalByCredential[credentialId].first)), salt);
    return credential(prf);
  };
  globalThis.fetch = async (path, init) => {
    if (path === "/v1/auth/login/options") {
      assert.equal(JSON.parse(String(init!.body)).accountId, remembered.accountCard.accountId);
      return response({...options(), options: {...options().options, allowCredentials: [{type: "public-key", id: credentialId}]}});
    }
    if (path === "/v1/auth/login/verify") {
      verifies++; const body = JSON.parse(String(init!.body));
      assert.equal(body.response.id, credentialId); assert.equal(body.response.clientExtensionResults.prf.results, undefined);
      assert.equal(String(init!.body).includes(b64(prf)), false); return response(session());
    }
    assert.equal(path, "/v1/vault"); reads++; return response(remembered);
  };
  await passkeyLogin(); assert.equal(ceremonies, 1); assert.equal(verifies, 1); assert.equal(reads, 1);
  assert.equal(b64(requireVault().vaultKey), accounts.testSecrets[0].vaultKey);
}));

test("returning-browser first assertion cannot switch credential, account or pinned vault keys", async () => scoped(async credentials => {
  for (const mismatch of ["credential", "account", "keys", "vault-account", "allowlist"]) {
    const remembered = vault(); await put("settings", "last-account", remembered.accountCard.accountId); await put("settings", remembered.accountCard.accountId + ":vault", remembered);
    let verifies = 0, ceremonies = 0;
    credentials.get = async () => {ceremonies++; return {...credential(prf), id: mismatch === "credential" ? b64(new Uint8Array([6,7,8])) : credentialId};};
    globalThis.fetch = async path => {
      if (path === "/v1/auth/login/options") return response({...options(), options: {...options().options,
        ...(mismatch === "allowlist" ? {} : {allowCredentials: [{type: "public-key", id: credentialId}]})}});
      if (path === "/v1/auth/login/verify") {verifies++; return response(session(mismatch === "account" ? 1 : 0));}
      if (mismatch === "vault-account") return response(vault(1));
      return response(mismatch === "keys" ? {...remembered, accountCard: {...remembered.accountCard, boxPublicKey: accounts.accounts[1].boxPublicKey}} : remembered);
    };
    await assert.rejects(passkeyLogin(), mismatch === "allowlist" ? /NO_ACCOUNT_PASSKEY/ : /PASSWORD_ACCOUNT_MISMATCH/);
    assert.equal(ceremonies, mismatch === "allowlist" ? 0 : 1); assert.equal(verifies, ["credential", "allowlist"].includes(mismatch) ? 0 : 1);
    assert.throws(requireVault, /VAULT_LOCKED/); lockVault();
  }
}));

test("rotated account salt discards stale first output and evaluates current wrapper once", async () => scoped(async credentials => {
  const remembered = vault(), nextSalt = b64(new Uint8Array(32).fill(4));
  const fresh = {...remembered, wrappers: remembered.wrappers.map(wrapper => wrapper.kind === "prf" ? {...wrapper, prfSalt: nextSalt} : wrapper)};
  await put("settings", "last-account", remembered.accountCard.accountId); await put("settings", remembered.accountCard.accountId + ":vault", remembered);
  let ceremonies = 0;
  credentials.get = async input => {
    ceremonies++;
    assert.equal(b64(new Uint8Array(ceremonies === 1 ? input.publicKey.extensions.prf.evalByCredential[credentialId].first : input.publicKey.extensions.prf.eval.first)), ceremonies === 1 ? salt : nextSalt);
    return credential(ceremonies === 1 ? new Uint8Array(32).fill(10) : prf);
  };
  globalThis.fetch = async path => response(path === "/v1/auth/login/options" ? {...options(), options: {...options().options, allowCredentials: [{type: "public-key", id: credentialId}]}} : path === "/v1/auth/login/verify" ? session() : fresh);
  await passkeyLogin(); assert.equal(ceremonies, 2); assert.equal(b64(requireVault().vaultKey), accounts.testSecrets[0].vaultKey);
}));

test("corrupt public cache falls back to discovery and first-ceremony cancellation never verifies", async () => scoped(async credentials => {
  await put("settings", "last-account", accounts.accounts[0].accountId); await put("settings", accounts.accounts[0].accountId + ":vault", {version: 1, accountCard: accounts.accounts[0]});
  let ceremonies = 0;
  credentials.get = async () => {ceremonies++; return credential(prf);};
  globalThis.fetch = async (path, init) => {
    if (path === "/v1/auth/login/options") {
      assert.equal(JSON.parse(String(init!.body)).accountId, ceremonies === 0 ? undefined : accounts.accounts[0].accountId); return response(options());
    }
    return response(path === "/v1/auth/login/verify" ? session() : vault());
  };
  await passkeyLogin(); assert.equal(ceremonies, 2); lockVault();
  const remembered = vault(); await put("settings", remembered.accountCard.accountId + ":vault", remembered);
  for (const action of ["lock", "back", "origin"]) {
    let current = true, verifies = 0;
    credentials.get = async () => {
      if (action === "lock") lockVault();
      if (action === "back") current = false;
      if (action === "origin") Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://other.invalid"}});
      return credential(prf);
    };
    globalThis.fetch = async path => {if (path === "/v1/auth/login/verify") verifies++; return response({...options(), options: {...options().options, allowCredentials: [{type: "public-key", id: credentialId}]}});};
    await assert.rejects(passkeyLogin(() => current), {name: "AbortError"}); assert.equal(verifies, 0); assert.throws(requireVault, /VAULT_LOCKED/);
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  }
}));

test("authentication without PRF keeps Saved locked and offers password recovery", async () => scoped(async credentials => {
  credentials.get = async () => credential(undefined);
  globalThis.fetch = async path => response(path === "/v1/auth/login/options" ? options() : path === "/v1/auth/login/verify" ? session() : vault(0, false));
  await assert.rejects(passkeyLogin(), /PRF_UNAVAILABLE_USE_RECOVERY/);
  assert.throws(requireVault, /VAULT_LOCKED/); assert.equal(await get("settings", "last-account"), undefined);
  assert.equal(authenticatedApprovalAccount(), accounts.accounts[0].accountId, "The authenticated account can explicitly request trusted-device unlock without caching keys");
  lockVault(); assert.equal(authenticatedApprovalAccount(), undefined);
}));

test("a replaced server cookie cannot bind another account's vault to the selected passkey", async () => scoped(async credentials => {
  let ceremonies = 0; credentials.get = async () => {ceremonies++; return credential(undefined);};
  globalThis.fetch = async path => response(path === "/v1/auth/login/options" ? options() : path === "/v1/auth/login/verify" ? session() : vault(1));
  await assert.rejects(passkeyLogin(), /PASSWORD_ACCOUNT_MISMATCH/);
  assert.equal(ceremonies, 1); assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("back, lock and origin changes during the first ceremony cannot verify a late credential", async () => scoped(async credentials => {
  for (const action of ["back", "lock", "origin"]) {
    let current = true; const paths: string[] = [];
    credentials.get = async () => {if (action === "back") current = false; else if (action === "lock") lockVault(); else Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://other.invalid"}}); return credential(prf);};
    globalThis.fetch = async path => {paths.push(String(path)); return response(options());};
    await assert.rejects(passkeyLogin(() => current), {name: "AbortError"});
    assert.deepEqual(paths, ["/v1/auth/login/options"]); assert.throws(requireVault, /VAULT_LOCKED/);
    Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  }
}));

test("a late sign-in response cannot replace a newer open vault", async () => scoped(async () => {
  let replacement: ReturnType<typeof requireVault> | undefined;
  globalThis.fetch = async path => {
    if (path === "/v1/auth/login/options") return response(options());
    configureVault(vault(1, false)); replacement = await unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[1].recoverySecret)});
    return response(session());
  };
  await assert.rejects(passkeyLogin(), {name: "AbortError"}); assert.equal(requireVault(), replacement);
}));

test("passkey sign-in is optional and never adds account setup to local/new photos", () => {
  const props = {password: "", generatedPassword: "", busy: false, onPassword() {}, onSignIn() {}, onCreate() {}, onContinue() {}, onBack() {}, onCopy() {}, onSave() {}, onPasskey() {}, onAnotherAccount() {}};
  const existing = renderToStaticMarkup(createElement(AccountAccess, props));
  assert.match(existing, /Continue with a passkey/); assert.match(existing, /Use another account/);
  const generated = renderToStaticMarkup(createElement(AccountAccess, {...props, generatedPassword: "public fixture password"}));
  assert.doesNotMatch(generated, /Continue with a passkey|Use another account/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AccountAccess, {...props, onAnotherAccount: undefined})), /Use another account/);
});
