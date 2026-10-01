import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64 } from "@fotoro/crypto";
import { configureVault, unlockVault, lockVault } from "../src/vault/vault";
import { get } from "../src/exchange/cache";
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
