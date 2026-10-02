import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  syncStatus,
  ScopedFlight,
  readableSyncError,
} from "../src/exchange/sync";
import {
  cancelEnrollment,
  prepareEnrollment,
  completeEnrollment,
} from "../src/vault/session";
test("sync status reflects actual queue receipts, skipped sources and untouched local selections", () => {
  const date = "2026-10-01T12:00:00Z";
  assert.equal(
    syncStatus([{ state: "committed" }, { state: "queued" }], date).label,
    "1 pending",
  );
  assert.equal(
    syncStatus([{ state: "committed" }, { state: "failed" }], date).label,
    "1 failed",
  );
  assert.equal(
    syncStatus([{ state: "committed" }], date, 1).label,
    "1 skipped",
  );
  assert.equal(
    syncStatus([{ state: "committed" }], date, 0, 3).label,
    "3 local photos not synced",
  );
  assert.equal(syncStatus([{ state: "committed" }], date).label, "Synced");
  assert.equal(syncStatus([], null).label, "Not synced yet");
});
test("foreground/retry coalesce per vault and cannot start a second worker before prior await settles", async () => {
  const queue = new ScopedFlight<number>(),
    scope = {},
    other = {};
  let release: (n: number) => void = () => {},
    calls = 0;
  const first = queue.run(scope, () => {
    calls++;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  });
  const second = queue.run(scope, async () => {
    calls++;
    return 2;
  });
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(await queue.run(other, async () => 3), 3);
  release(1);
  assert.equal(await first, 1);
  assert.equal(
    await queue.run(scope, async () => {
      calls++;
      return 4;
    }),
    4,
  );
  assert.equal(calls, 2);
});
test("cancelled account preparation cannot publish a password after delayed service response", async () => {
  const old = globalThis.fetch;
  let release: (response: Response) => void = () => {},
    started = false;
  globalThis.fetch = (async () => {
    started = true;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as any;
  try {
    const preparing = prepareEnrollment();
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
    cancelEnrollment();
    release(
      new Response(
        JSON.stringify({
          version: 1,
          accountId: crypto.randomUUID(),
          challengeId: crypto.randomUUID(),
          challenge: "A".repeat(43),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200 },
      ),
    );
    await assert.rejects(
      preparing,
      (error) => error instanceof Error && error.name === "AbortError",
    );
    await assert.rejects(completeEnrollment(), /ACCOUNT_SETUP_NOT_STARTED/);
  } finally {
    globalThis.fetch = old;
    cancelEnrollment();
  }
});
test("normal sync UI uses readable failures and explicit cancellation instead of protocol codes", () => {
  assert.match(
    readableSyncError(new Error("STAGING_MISSING_RESELECT_ORIGINAL")),
    /original file again/,
  );
  assert.match(
    readableSyncError(new Error("PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED")),
    /cannot sync your private files/,
  );
  assert.match(
    readableSyncError(new DOMException("cancelled", "NotAllowedError")),
    /cancelled/,
  );
  assert.doesNotMatch(readableSyncError(new Error("HTTP_500")), /HTTP_500/);
});
test("known public demo identities remain blocked outside the fixture transport", async () => {
  const { isPublicDemoAccount } = await import("../src/exchange/api");
  assert.equal(
    isPublicDemoAccount("00000000-0000-4000-8000-000000000001"),
    true,
  );
  assert.equal(
    isPublicDemoAccount("00000000-0000-4000-8000-000000000002"),
    true,
  );
  assert.equal(
    isPublicDemoAccount("00000000-0000-4000-8000-000000000003"),
    false,
  );
});
test("skipped sources persist encrypted once per file and clear only on actual successful preparation", async () => {
  const cryptoModule = await import("@fotoro/crypto");
  await cryptoModule.ready;
  const accounts = (await import("../../../fixtures/accounts.json")).default;
  const vaultModule = await import("../src/vault/vault");
  const source = accounts.testSecrets[0];
  vaultModule.configureVault({
    version: 1,
    accountCard: accounts.accounts[0],
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: source.encryptedBundle,
      },
    ],
  } as any);
  const session = await vaultModule.unlockVault({
    kind: "recovery",
    secret: cryptoModule.unb64(source.recoverySecret),
  });
  const sync = await import("../src/exchange/sync");
  const file = new File(["public-sample"], "sample.jpg", {
    type: "image/jpeg",
    lastModified: 1,
  });
  await sync.recordSkipped(session, file, new Error("SOURCE_FORMAT_MISMATCH"));
  await sync.recordSkipped(session, file, new Error("SOURCE_FORMAT_MISMATCH"));
  assert.equal(await sync.skippedImports(session), 1);
  await sync.clearSkipped(session, file);
  assert.equal(await sync.skippedImports(session), 0);
  vaultModule.lockVault();
});
test("delayed queue reads stop on lock/account switch instead of decrypting with another vault", async () => {
  const cryptoModule = await import("@fotoro/crypto");
  await cryptoModule.ready;
  const accounts = (await import("../../../fixtures/accounts.json")).default;
  const vault = await import("../src/vault/vault");
  const journal = await import("../src/exchange/journal");
  const open = async (index: number) => {
    const source = accounts.testSecrets[index];
    vault.configureVault({
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
          wrappedBundle: source.encryptedBundle,
        },
      ],
    } as any);
    return vault.unlockVault({
      kind: "recovery",
      secret: cryptoModule.unb64(source.recoverySecret),
    });
  };
  await open(0);
  const reading = journal.pendingImports();
  const rejected = assert.rejects(reading, /VAULT_LOCKED/);
  vault.lockVault();
  await open(1);
  await rejected;
  assert.equal(vault.requireVault().accountId, accounts.accounts[1].accountId);
  vault.lockVault();
});
test("Pause aborts an in-flight reservation and retains queued ciphertext without a false failure receipt", async () => {
  const cryptoModule = await import("@fotoro/crypto");
  await cryptoModule.ready;
  const accounts = (await import("../../../fixtures/accounts.json")).default;
  const vault = await import("../src/vault/vault"),
    cache = await import("../src/exchange/cache"),
    journal = await import("../src/exchange/journal");
  const source = accounts.testSecrets[0];
  vault.configureVault({
    version: 1,
    accountCard: {
      ...accounts.accounts[0],
      accountId: "00000000-0000-4000-8000-000000000003",
    },
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: source.encryptedBundle,
      },
    ],
  } as any);
  const session = await vault.unlockVault({
    kind: "recovery",
    secret: cryptoModule.unb64(source.recoverySecret),
  });
  const operationId = crypto.randomUUID(),
    photoId = crypto.randomUUID(),
    representationId = crypto.randomUUID(),
    stagingKey = session.accountId + ":paused-cipher";
  const bytes = new Uint8Array([1, 2, 3]);
  const pending = {
    operationId,
    photoId,
    stagingKeys: [stagingKey],
    sourceFilename: "public-sample.jpg",
    sourceDigest: cryptoModule.b64(
      cryptoModule.sodium.crypto_hash_sha256(bytes),
    ),
    state: "queued",
    wrapped: cryptoModule.wrapKey(new Uint8Array(32), session.vaultKey),
    parts: [
      {
        binding: { version: 1, photoId, representationId, kind: "original" },
        header: cryptoModule.b64(new Uint8Array(24)),
        ciphertextBytes: bytes.length,
        ciphertextSha256: cryptoModule.b64(
          cryptoModule.sodium.crypto_hash_sha256(bytes),
        ),
        uploadOperation: crypto.randomUUID(),
      },
    ],
  };
  await cache.atomic([
    { store: "staging", key: stagingKey, value: bytes },
    {
      store: "journal",
      key: session.accountId + ":" + operationId,
      value: vault.encryptPrivate(pending),
    },
  ]);
  const old = globalThis.fetch;
  let started = false;
  globalThis.fetch = (async (_input: any, options: any) => {
    started = true;
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(new DOMException("paused", "AbortError")),
        { once: true },
      ),
    );
  }) as any;
  const controller = new AbortController();
  try {
    const syncing = journal.resumePendingImports(controller.signal);
    while (!started) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await syncing;
    const saved = await cache.get<any>(
      "journal",
      session.accountId + ":" + operationId,
    );
    const receipt = vault.decryptPrivate<any>(saved);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.error, undefined);
    assert.deepEqual(await cache.get("staging", stagingKey), bytes);
  } finally {
    globalThis.fetch = old;
    vault.lockVault();
  }
});
test("a failed first upload stops a multi-file selection before the second original is staged", async () => {
  const { syncSelectedSequential } = await import("../src/exchange/selected");
  const staged: string[] = [],
    drains: number[] = [];
  let unresolved = false;
  const result = await syncSelectedSequential(["first", "second", "third"], {
    current: () => true,
    stage: async (file) => {
      staged.push(file);
      unresolved = true;
    },
    drain: async () => {
      drains.push(staged.length);
    },
    unresolved: async () => unresolved,
    skipped: async () => {
      throw new Error("Unexpected source skip");
    },
  });
  assert.deepEqual(staged, ["first"]);
  assert.deepEqual(drains, [0, 1]);
  assert.equal(result.stopped, true);
});
test("existing unresolved staging is reconciled before any new selected source", async () => {
  const { syncSelectedSequential } = await import("../src/exchange/selected");
  let staged = 0,
    drained = 0;
  const result = await syncSelectedSequential(["next"], {
    current: () => true,
    stage: async () => {
      staged++;
    },
    drain: async () => {
      drained++;
    },
    unresolved: async () => true,
    skipped: async () => {},
  });
  assert.equal(drained, 1);
  assert.equal(staged, 0);
  assert.equal(result.stopped, true);
});
test("legacy public-account pending ciphertext stays queued and never reaches the network", async () => {
  const cryptoModule = await import("@fotoro/crypto");
  await cryptoModule.ready;
  const accounts = (await import("../../../fixtures/accounts.json")).default;
  const vault = await import("../src/vault/vault"),
    cache = await import("../src/exchange/cache"),
    journal = await import("../src/exchange/journal");
  const source = accounts.testSecrets[0];
  vault.configureVault({
    version: 1,
    accountCard: accounts.accounts[0],
    wrappers: [
      {
        version: 1,
        wrapperId: crypto.randomUUID(),
        kind: "recovery",
        credentialId: null,
        prfSalt: null,
        verified: true,
        wrappedBundle: source.encryptedBundle,
      },
    ],
  } as any);
  const session = await vault.unlockVault({
    kind: "recovery",
    secret: cryptoModule.unb64(source.recoverySecret),
  });
  const operationId = crypto.randomUUID(),
    key = session.accountId + ":" + operationId;
  await cache.put(
    "journal",
    key,
    vault.encryptPrivate({
      operationId,
      state: "queued",
      sourceFilename: "public-test-sample.jpg",
      parts: [],
    }),
  );
  const old = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    throw new Error("Network must not be used");
  }) as any;
  try {
    await journal.resumePendingImports();
    assert.equal(requests, 0);
    assert.equal(
      vault.decryptPrivate<any>((await cache.get<any>("journal", key))!).state,
      "queued",
    );
  } finally {
    globalThis.fetch = old;
    vault.lockVault();
  }
});
