import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, b64, utf8, encryptMedia, signPayload, wrapKey} from "@fotoro/crypto";
import type {MediaBinding, RepresentationV1, PhotoManifestV1} from "@fotoro/contracts";
import {recover} from "../src/vault/session";
import {formatFotoroPassword} from "../src/vault/password";
import {configureVault, unlockVault, lockVault, requireVault, encryptPrivate} from "../src/vault/vault";
import {get, put, clearAccount} from "../src/exchange/cache";
import {cachedSync, refreshSync} from "../src/exchange/sync";
import {collect, source, digest, photoBytes} from "../src/library/catalog";

const vault = (index = 0) => ({version: 1 as const, accountCard: accounts.accounts[index], wrappers: [{version: 1 as const, wrapperId: crypto.randomUUID(), kind: "recovery" as const, credentialId: null, prfSalt: null, verified: true, wrappedBundle: accounts.testSecrets[index].encryptedBundle}]});
const password = (index = 0) => formatFotoroPassword(accounts.accounts[index].accountId, unb64(accounts.testSecrets[index].recoverySecret));
async function open(index = 0) {configureVault(vault(index)); return unlockVault({kind: "recovery", secret: unb64(accounts.testSecrets[index].recoverySecret)});}
async function scoped(run: () => Promise<void>) {
  const fetch = globalThis.fetch, descriptors = ["window", "location", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", {configurable: true, value: new EventTarget()});
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {onLine: true}});
  await ready; lockVault();
  try {await run();} finally {
    lockVault(); for (const card of accounts.accounts) await clearAccount(card.accountId);
    globalThis.fetch = fetch;
    for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}
  }
}
async function remember() {await put("settings", accounts.accounts[0].accountId + ":vault", vault());}
async function cachePhoto(session: ReturnType<typeof requireVault>) {
  const photoId = crypto.randomUUID(), originalKey = new Uint8Array(32).fill(7), metadataKey = new Uint8Array(32).fill(9);
  const representation = async (kind: MediaBinding["kind"], bytes: Uint8Array, key: Uint8Array): Promise<RepresentationV1> => {
    const binding: MediaBinding = {version: 1, photoId, representationId: crypto.randomUUID(), kind};
    const ciphertext = await collect(encryptMedia(source(bytes), key, binding)), objectId = crypto.randomUUID();
    await put("read", session.accountId + ":" + objectId, ciphertext);
    return {binding, objectId, header: b64(ciphertext.subarray(0, 24)), ciphertextBytes: ciphertext.length, ciphertextSha256: digest(ciphertext)};
  };
  const bytes = new TextEncoder().encode("cached original bytes"), original = await representation("original", bytes, originalKey);
  const metadata = {version: 1, filename: "remembered-photo.png", mediaType: "image/png", sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalBytes: bytes.length, originalSha256: digest(bytes), representationKeys: {[original.binding.representationId]: b64(originalKey)}};
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: session.accountId, representations: [original], metadataRepresentation: await representation("metadata", utf8(metadata), metadataKey), ownerWrappedMetadataKey: wrapKey(metadataKey, session.vaultKey)};
  await put("catalog", session.accountId + ":" + photoId, encryptPrivate(signPayload("photo-manifest", session.accountId, utf8(manifest), session.signingSecretKey)));
}

test("connected browser with unreachable API can decrypt its cached library using the correct password", async () => scoped(async () => {
  const previous = await open(), checked = "2026-10-01T12:00:00.000Z";
  await remember();
  await cachePhoto(previous);
  await put("settings", previous.accountId + ":last-checked", encryptPrivate(checked));
  lockVault();
  const paths: string[] = [];
  globalThis.fetch = async path => {paths.push(String(path)); throw new TypeError("Failed to fetch");};
  await recover(password());
  const session = requireVault(), snapshot = await cachedSync(session);
  assert.equal(session.accountId, accounts.accounts[0].accountId);
  assert.equal(snapshot.photos.length, 1);
  assert.equal(snapshot.photos[0].metadata.filename, "remembered-photo.png");
  assert.equal(new TextDecoder().decode(await photoBytes(snapshot.photos[0], "original")), "cached original bytes");
  assert.equal(snapshot.lastSuccessfulSync, checked);
  await assert.rejects(refreshSync(session), /Failed to fetch/);
  assert.equal(requireVault(), session, "A failed read refresh must leave cached access open");
  assert.equal((await cachedSync(session)).lastSuccessfulSync, checked, "Local unlock must not claim a new successful server check");
  assert.equal(await get("settings", "last-account"), undefined, "Local unlock must not record a completed server sign-in");
  assert.ok(paths.every(path => path === "/v1/auth/recovery/options" || path.startsWith("/v1/changes?")));
}));

test("unreachable API does not unlock a cached vault with a wrong password", async () => scoped(async () => {
  await remember();
  globalThis.fetch = async () => {throw new TypeError("Failed to fetch");};
  await assert.rejects(recover(formatFotoroPassword(accounts.accounts[0].accountId, new Uint8Array(32))), /wrong secret key/);
  assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("cached recovery rejects a vault stored under another account's key", async () => scoped(async () => {
  await put("settings", accounts.accounts[0].accountId + ":vault", vault(1));
  globalThis.fetch = async () => {throw new TypeError("Failed to fetch");};
  await assert.rejects(recover(password()), /PASSWORD_ACCOUNT_MISMATCH/);
  assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("reported offline password entry still opens its cached vault without contacting the API", async () => scoped(async () => {
  await remember();
  Object.defineProperty(globalThis, "navigator", {configurable: true, value: {onLine: false}});
  globalThis.fetch = async () => {throw new Error("Unexpected network request");};
  await recover(password());
  assert.equal(requireVault().accountId, accounts.accounts[0].accountId);
}));

test("unreachable API without an account cache retains the connection failure", async () => scoped(async () => {
  globalThis.fetch = async () => {throw new TypeError("Failed to fetch");};
  await assert.rejects(recover(password()), /Failed to fetch/);
  assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("HTTP rejection and invalid response data never fall back to the cached password", async () => scoped(async () => {
  await remember();
  for (const response of [
    () => new Response(JSON.stringify({version: 1, code: "FORBIDDEN"}), {status: 403}),
    () => new Response(JSON.stringify({version: 1, code: "NOT_FOUND"}), {status: 404}),
    () => new Response("not JSON"),
    () => new Response(JSON.stringify({version: 1})),
    () => {const value = new Response("{}"); value.json = async () => {throw new TypeError("Unreadable response");}; return value;},
  ]) {
    globalThis.fetch = async () => response();
    await assert.rejects(recover(password()));
    assert.throws(requireVault, /VAULT_LOCKED/);
  }
}));

test("cancelled fetch never authorizes cached password access", async () => scoped(async () => {
  await remember();
  globalThis.fetch = async () => {throw new DOMException("Cancelled", "AbortError");};
  await assert.rejects(recover(password()), {name: "AbortError"});
  assert.throws(requireVault, /VAULT_LOCKED/);
}));

test("late connection failure cannot reopen after lock, Back or an account switch", async () => scoped(async () => {
  await remember();
  for (const action of ["lock", "Back", "switch"]) {
    let started!: () => void, reject!: (error: Error) => void, current = true;
    const began = new Promise<void>(resolve => {started = resolve;});
    globalThis.fetch = async () => {started(); return new Promise<Response>((_resolve, fail) => {reject = fail;});};
    const recovering = recover(password(), () => current);
    const rejected = assert.rejects(recovering, {name: "AbortError"});
    await began;
    if (action === "Back") current = false;
    else lockVault();
    const newer = action === "switch" ? await open(1) : undefined;
    reject(new TypeError("Failed to fetch")); await rejected;
    if (newer) assert.equal(requireVault(), newer);
    else assert.throws(requireVault, /VAULT_LOCKED/);
    lockVault();
  }
}));
