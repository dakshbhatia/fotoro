import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import { ready, unb64 } from "@fotoro/crypto";
import {
  configureVault,
  unlockVault,
  requireVault,
  lockVault,
  mediaURL,
  requestDeviceApproval,
} from "../src/vault/vault";
const data = accounts.testSecrets[0];
const vault = {
  version: 1 as const,
  accountCard: accounts.accounts[0],
  wrappers: [
    {
      version: 1 as const,
      wrapperId: "00000000-0000-4000-8000-000000000090",
      kind: "recovery" as const,
      credentialId: null,
      prfSalt: null,
      wrappedBundle: data.encryptedBundle,
      verified: true,
    },
  ],
};
test("non-PRF vault requires recovery after lock/reload and lock clears keys and Blob URLs", async () => {
  await ready;
  configureVault(vault as any);
  await assert.rejects(unlockVault({ kind: "prf" }), /PRF_UNAVAILABLE/);
  const v = await unlockVault({
    kind: "recovery",
    secret: unb64(data.recoverySecret),
  });
  assert.equal(v.accountId, data.accountId);
  const bytes = v.vaultKey;
  const url = mediaURL("test", new Uint8Array([1, 2]), "image/jpeg");
  lockVault();
  assert.equal(
    bytes.every((n) => n === 0),
    true,
  );
  assert.throws(requireVault, /VAULT_LOCKED/);
  await assert.rejects(fetch(url));
  await assert.rejects(unlockVault({ kind: "prf" }), /PRF_UNAVAILABLE/);
});
test("wrong recovery cannot open account bundle", async () => {
  await ready;
  configureVault(vault as any);
  await assert.rejects(
    unlockVault({ kind: "recovery", secret: new Uint8Array(32) }),
  );
  assert.throws(requireVault, /VAULT_LOCKED/);
});

test("trusted device accepts Swift-sorted signed JSON and rejects changed challenge fields", async () => {
  const { sodium, b64, signPayload, utf8 } = await import("@fotoro/crypto");
  await ready;
  const oldFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://fotoro.cloud" },
  });
  const sorted = (value: any): any =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted(value[key])]),
          )
        : value;
  let challenge: any;
  let tamper = false;
  globalThis.fetch = (async (input: string, init: any) => {
    const request = JSON.parse(init.body);
    if (input === "/v1/devices/enroll") {
      challenge = {
        version: 1,
        enrollmentId: crypto.randomUUID(),
        accountId: data.accountId,
        deviceId: request.deviceId,
        boxPublicKey: request.boxPublicKey,
        challenge: b64(sodium.randombytes_buf(32)),
        origin: request.origin,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        state: "pending",
      };
      return new Response(JSON.stringify(challenge));
    }
    const bundle = utf8({
      vaultKey: data.vaultKey,
      boxSecretKey: data.boxSecretKey,
      signingSecretKey: data.signingSecretKey,
    });
    const sealedBundle = b64(
      sodium.crypto_box_seal(bundle, unb64(challenge.boxPublicKey)),
    );
    const proof = sorted({
      challenge: {
        ...challenge,
        ...(tamper ? { origin: "https://wrong.example" } : {}),
      },
      sealedBundle,
    });
    return new Response(
      JSON.stringify({
        version: 1,
        challenge: sorted({ ...challenge, state: "completed" }),
        sealedBundle,
        signedPayload: signPayload(
          "device-approval",
          data.accountId,
          utf8(proof),
          unb64(data.signingSecretKey),
        ),
      }),
    );
  }) as any;
  try {
    configureVault(vault as any);
    const first = await requestDeviceApproval();
    const unlocked = await unlockVault({
      kind: "trustedDevice",
      enrollmentId: first.enrollmentId,
    });
    assert.equal(unlocked.accountId, data.accountId);
    lockVault();
    configureVault(vault as any);
    tamper = true;
    const second = await requestDeviceApproval();
    await assert.rejects(
      unlockVault({ kind: "trustedDevice", enrollmentId: second.enrollmentId }),
      /DEVICE_BINDING_MISMATCH/,
    );
    assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {
    globalThis.fetch = oldFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    lockVault();
  }
});
