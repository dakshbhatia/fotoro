import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64, b64, sodium, wrapKey } from "@fotoro/crypto";
import { configureVault, unlockVault, lockVault, requireVault, encryptPrivate } from "../src/vault/vault";
import { atomic, clearAccount, get } from "../src/exchange/cache";
import { queueAnnotations, pendingAnnotations } from "../src/exchange/annotations";
import { pendingImports } from "../src/exchange/journal";
import { cachedSync, refreshSync, saveSync, saveChosenImports } from "../src/exchange/sync";
import {saveQueuedAnnotations} from "../src/library/consumer-annotation-save";
import {loadUploadPause, saveUploadPause} from "../src/library/consumer-preferences";

const owner = "55555555-5555-4555-8555-555555555555", other = "66666666-6666-4666-8666-666666666666";
const identity = { ownerAccountId: owner, photoId: "77777777-7777-4777-8777-777777777777", originalSha256: "A".repeat(43) };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const page = (nextCursor = "1") => ({ version: 1, mediaVersion: 1, changes: [], nextCursor, hasMore: false });
async function open(accountId = owner) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({ version: 1, accountCard: { ...accounts.accounts[0], accountId }, wrappers: [{ version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle }] } as any);
  return unlockVault({ kind: "recovery", secret: unb64(secret.recoverySecret) });
}
async function scoped(run: () => Promise<void>) {
  const old = globalThis.fetch;
  await clearAccount(owner); await clearAccount(other);
  try { await run(); } finally { globalThis.fetch = old; await clearAccount(owner); await clearAccount(other); lockVault(); }
}
async function stageQueuedOriginal() {
  const session = requireVault(), bytes = new Uint8Array([1, 2, 3, 4]), operationId = crypto.randomUUID(), photoId = crypto.randomUUID(), stagingKey = owner + ":manual-original";
  const pending = { operationId, photoId, stagingKeys: [stagingKey], sourceFilename: "public-fixture.jpg", sourceDigest: b64(sodium.crypto_hash_sha256(bytes)), state: "queued", wrapped: wrapKey(new Uint8Array(32), session.vaultKey), parts: [{ binding: { version: 1, photoId, representationId: crypto.randomUUID(), kind: "original" }, header: b64(new Uint8Array(24)), ciphertextBytes: bytes.length, ciphertextSha256: b64(sodium.crypto_hash_sha256(bytes)), uploadOperation: crypto.randomUUID() }] };
  await atomic([{ store: "staging", key: stagingKey, value: bytes }, { store: "journal", key: owner + ":" + operationId, value: encryptPrivate(pending) }]);
  return { pending, bytes, stagingKey };
}

test("cached account hydration never contacts the server or drains queued work", async () => scoped(async () => {
  const session = await open(), queued = await stageQueuedOriginal();
  await queueAnnotations(identity, { labels: ["draft"] }, session);
  globalThis.fetch = (async () => { throw new Error("Cached hydration must not contact the server"); }) as typeof fetch;
  const snapshot = await cachedSync(session);
  assert.deepEqual(snapshot.pending, [queued.pending]);
  assert.equal(snapshot.annotations.length, 1);
  assert.equal(snapshot.lastSuccessfulSync, null);
}));

test("signin, online, visibility, label-edit and explicit Check refresh only GET; explicit Save drains originals and edits", async () => scoped(async () => {
  const session = await open(), queued = await stageQueuedOriginal(), calls: { path: string; method: string }[] = [];
  await queueAnnotations(identity, { labels: ["draft"] }, session);
  const draft = (await pendingAnnotations(session))[0].signed;
  globalThis.fetch = (async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ path: String(path), method });
    if (String(path).startsWith("/v1/changes?")) return response(page());
    if (path === "/v1/uploads/reserve") return response({ version: 1, code: "UNAVAILABLE" }, 503);
    if (String(path).endsWith("/annotations")) return response(JSON.parse(init!.body as string));
    throw new Error("Unexpected request " + path);
  }) as typeof fetch;
  for (const reason of ["signin", "online", "visibility", "label edit", "Check for photos while paused"]) {
    const result = await refreshSync(session);
    assert.deepEqual(result.pending, [queued.pending], reason);
    assert.deepEqual(result.annotations[0].signed, draft, reason);
    assert.ok(calls.every(call => call.method === "GET"), reason);
  }
  assert.deepEqual(await get("staging", queued.stagingKey), queued.bytes);
  const result = await saveSync(session);
  assert.equal(calls.filter(call => call.path === "/v1/uploads/reserve" && call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.path.endsWith("/annotations") && call.method === "PUT").length, 1);
  assert.equal(result.annotations.length, 0);
  assert.equal(result.pending[0].state, "failed");
  assert.deepEqual(await get("staging", queued.stagingKey), queued.bytes);
}));

test("read refresh and explicit Save serialize their catalog cursor work without losing manual intent", async () => scoped(async () => {
  const session = await open();
  await queueAnnotations(identity, { labels: ["draft"] }, session);
  let release: (value: Response) => void = () => {}, started = false;
  const calls: { path: string; method: string }[] = [];
  globalThis.fetch = (async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ path: String(path), method });
    if (calls.length === 1) {
      started = true;
      return new Promise<Response>(resolve => { release = resolve; });
    }
    if (method === "GET") { assert.match(String(path), /cursor=after-read/); return response(page("after-save")); }
    return response(JSON.parse(init!.body as string));
  }) as typeof fetch;
  const reading = refreshSync(session);
  while (!started) await new Promise(resolve => setTimeout(resolve, 0));
  const saving = saveSync(session);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  release(response(page("after-read")));
  await reading;
  const result = await saving;
  assert.deepEqual(calls.map(call => call.method), ["GET", "GET", "PUT"]);
  assert.equal(result.annotations.length, 0);
}));

test("Trip chosen retry waits for global Save and snapshots its selected IDs", async () => scoped(async () => {
  const session = await open();
  let release!: (value: Response) => void;
  const calls: string[] = [];
  globalThis.fetch = (async path => {
    calls.push(String(path));
    if (String(path).startsWith("/v1/changes?")) return new Promise<Response>(resolve => {release = resolve;});
    assert.equal(path, "/v1/uploads/reserve");
    return response({version: 1, code: "UNAVAILABLE"}, 503);
  }) as typeof fetch;
  const saving = saveSync(session);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const queued = await stageQueuedOriginal(), ids = [queued.pending.photoId];
  const chosen = saveChosenImports(session, ids);
  ids.length = 0;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1, "Trip must not write the journal while global Save is still active");
  release(response(page()));
  await saving; await chosen;
  assert.equal(calls.filter(path => path === "/v1/uploads/reserve").length, 1);
  assert.equal(calls.filter(path => path.startsWith("/v1/changes?")).length, 1, "Chosen retry adds no catalog sync");
}));

for (const cancellation of ["scope", "signal"] as const) {
  test(`queued Trip choice cancelled by ${cancellation} sends nothing after global Save`, async () => scoped(async () => {
    const session = await open();
    let release!: (value: Response) => void, current = true;
    const controller = new AbortController();
    globalThis.fetch = (async path => {
      assert.match(String(path), /^\/v1\/changes\?/, "Cancelled Trip must not send an upload");
      return new Promise<Response>(resolve => {release = resolve;});
    }) as typeof fetch;
    const saving = saveSync(session);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const queued = await stageQueuedOriginal();
    const chosen = saveChosenImports(session, [queued.pending.photoId], controller.signal, () => current);
    const rejected = assert.rejects(chosen, {name: "AbortError"});
    if (cancellation === "scope") current = false;
    else controller.abort();
    release(response(page()));
    await saving; await rejected;
    assert.deepEqual(await pendingImports(), [queued.pending], "Cancelled queue task leaves chosen encrypted staging untouched");
  }));
}

test("a delayed read refresh cannot publish into or close a newer account", async () => scoped(async () => {
  const session = await open();
  let release: (value: Response) => void = () => {}, started = false;
  globalThis.fetch = (async () => { started = true; return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch;
  const reading = refreshSync(session);
  while (!started) await new Promise(resolve => setTimeout(resolve, 0));
  lockVault();
  const newer = await open(other);
  release(response(page()));
  await assert.rejects(reading, /VAULT_LOCKED/);
  assert.equal(requireVault(), newer);
  assert.equal(await get("settings", owner + ":cursor"), undefined);
  assert.equal((await pendingImports()).length, 0);
}));

test("viewer Save changes sends annotations only and preserves paused originals through a read refresh", async () => scoped(async () => {
  const session = await open(), queued = await stageQueuedOriginal();
  await saveUploadPause(true, session);
  await queueAnnotations(identity, {labels: ["family"], favorite: true}, session);
  const calls: {path: string; method: string}[] = [];
  globalThis.fetch = (async (path, init) => {
    calls.push({path: String(path), method: init?.method ?? "GET"});
    if (String(path).endsWith("/annotations")) return response(JSON.parse(init!.body as string));
    if (String(path).startsWith("/v1/changes?")) return response(page());
    throw new Error("Save changes must not send original files");
  }) as typeof fetch;
  const saved = await saveQueuedAnnotations(session);
  assert.deepEqual(calls.map(call => call.method), ["PUT"], "Viewer Save changes needs no original upload or catalog request");
  assert.equal(saved.annotations.length, 0);
  assert.deepEqual(saved.pending, [queued.pending]);
  const refreshed = await refreshSync(session);
  assert.deepEqual(calls.map(call => call.method), ["PUT", "GET"]);
  assert.equal(refreshed.annotations.length, 0);
  assert.deepEqual(refreshed.pending, [queued.pending]);
  assert.deepEqual(await get("staging", queued.stagingKey), queued.bytes);
  assert.equal(await loadUploadPause(session), true);
}));

test("failed viewer Save changes retains its exact draft and never resumes queued originals", async () => scoped(async () => {
  const session = await open(), queued = await stageQueuedOriginal();
  await queueAnnotations(identity, {labels: ["family"]}, session);
  const draft = (await pendingAnnotations(session))[0].signed;
  globalThis.fetch = (async (path, init) => {
    assert.match(String(path), /\/annotations$/); assert.equal(init?.method, "PUT");
    return response({version: 1, code: "UNAVAILABLE"}, 503);
  }) as typeof fetch;
  await assert.rejects(saveQueuedAnnotations(session));
  assert.deepEqual((await pendingAnnotations(session))[0].signed, draft);
  assert.deepEqual(await pendingImports(), [queued.pending]);
  assert.deepEqual(await get("staging", queued.stagingKey), queued.bytes);
}));

test("a delayed viewer annotation save cannot publish across an account switch", async () => scoped(async () => {
  const session = await open();
  await queueAnnotations(identity, {favorite: true}, session);
  let release!: (response: Response) => void, sent!: string;
  globalThis.fetch = (async (_path, init) => {sent = init!.body as string; return new Promise<Response>(resolve => {release = resolve;});}) as typeof fetch;
  const saving = saveQueuedAnnotations(session);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  lockVault(); const newer = await open(other);
  release(response(JSON.parse(sent)));
  await assert.rejects(saving, /VAULT_LOCKED/);
  assert.equal(requireVault(), newer);
  assert.equal((await pendingAnnotations(newer)).length, 0);
}));
