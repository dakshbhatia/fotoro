import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64 } from "@fotoro/crypto";
import { configureVault, unlockVault, lockVault, encryptPrivate, decryptPrivate } from "../src/vault/vault";
import { get, put } from "../src/exchange/cache";
import { syncCatalog } from "../src/library/catalog";

async function open(index: number) {
  const secret = accounts.testSecrets[index];
  configureVault({
    version: 1,
    accountCard: accounts.accounts[index],
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: secret.encryptedBundle,
      },
    ],
  } as any);
  return unlockVault({
    kind: "recovery",
    secret: unb64(secret.recoverySecret),
  });
}

test("an old account's delayed sync cannot write the new account's cursor", async () => {
  await ready;
  await open(0);
  const old = globalThis.fetch;
  let receive!: (response: Response) => void;
  let requested!: () => void;
  const began = new Promise<void>((resolve) => {
    requested = resolve;
  });
  globalThis.fetch = (async () => {
    requested();
    return new Promise<Response>((resolve) => {
      receive = resolve;
    });
  }) as any;
  try {
    const pending = syncCatalog();
    const rejected = assert.rejects(pending, /VAULT_LOCKED/);
    await began;
    lockVault();
    await open(1);
    receive(
      new Response(
        JSON.stringify({
          version: 1,
          changes: [],
          nextCursor: "b2xkLWFjY291bnQ",
          hasMore: false,
        }),
      ),
    );
    await rejected;
    assert.equal(
      await get("settings", accounts.accounts[1].accountId + ":cursor"),
      undefined,
    );
    assert.equal(
      await get("settings", accounts.accounts[0].accountId + ":cursor"),
      undefined,
    );
  } finally {
    globalThis.fetch = old;
    lockVault();
  }
});

test("an older service cannot acknowledge media support or advance the current reader cursor", async () => {
  await ready; await open(0);
  const old = globalThis.fetch, id = accounts.accounts[0].accountId;
  globalThis.fetch = (async (path: string | URL | Request) => {
    assert.ok(String(path).includes("media=1"));
    return new Response(JSON.stringify({version: 1, changes: [], nextCursor: "unsupported", hasMore: false}));
  }) as any;
  try {
    await assert.rejects(syncCatalog(), /MEDIA_READER_UPDATE_REQUIRED/);
    assert.equal(await get("settings", id + ":cursor"), undefined);
    assert.equal(await get("settings", id + ":media-reader-v1"), undefined);
  } finally {globalThis.fetch = old; lockVault();}
});

test("current media reader rescans a legacy cursor once, then resumes the acknowledged cursor", async () => {
  await ready; await open(0);
  const old = globalThis.fetch, id = accounts.accounts[0].accountId, requests: URL[] = [];
  await put("settings", id + ":cursor", encryptPrivate("legacy-skipped-media"));
  globalThis.fetch = (async (path: string | URL | Request) => {
    requests.push(new URL(String(path), "http://localhost"));
    return new Response(JSON.stringify({version: 1, mediaVersion: 1, changes: [], nextCursor: "current-media", hasMore: false}));
  }) as any;
  try {
    await syncCatalog();
    assert.equal(requests[0].searchParams.get("media"), "1");
    assert.equal(requests[0].searchParams.get("cursor"), null);
    assert.equal(decryptPrivate(await get("settings", id + ":media-reader-v1")), true);
    await syncCatalog();
    assert.equal(requests[1].searchParams.get("cursor"), "current-media");
  } finally {globalThis.fetch = old; lockVault();}
});
