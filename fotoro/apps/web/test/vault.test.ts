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
  cancelDeviceApproval,
  reviewDeviceChallenge,
  approveDeviceChallenge,
  vaultGeneration,
  configureApprovalVault,
  authenticatedApprovalAccount,
  deviceApprovalDeadline,
} from "../src/vault/vault";
import {ChosenSaveIntent} from "../src/exchange/chosen-save";
import {IncomingAlbumIntent} from "../src/albums/intent";
import {createAlbumLink, parseAlbumLink} from "@fotoro/contracts/albums-links";
import type {LocalPhoto} from "../src/local/resources";
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

test("device approval rejects mismatched and expired requests, and cancellation cannot publish late private enrollment", async () => {
  await ready;
  const {sodium, b64} = await import("@fotoro/crypto");
  const oldFetch = globalThis.fetch, oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const page = {origin: "https://fotoro.cloud"}; Object.defineProperty(globalThis, "location", {configurable: true, value: page});
  const reply = (body: unknown) => new Response(JSON.stringify(body));
  let challenge: any, mismatch = "", delayed = false, release: (() => void) | undefined, completionReads = 0;
  globalThis.fetch = async (input, init) => {
    if (input !== "/v1/devices/enroll") {completionReads++; assert.fail("Cancelled or expired enrollment must never reach completion");}
    const request = JSON.parse(String(init?.body));
    challenge = {version: 1, enrollmentId: crypto.randomUUID(), accountId: data.accountId, deviceId: request.deviceId,
      boxPublicKey: request.boxPublicKey, origin: request.origin, challenge: b64(sodium.randombytes_buf(32)),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "pending"};
    if (mismatch === "account") challenge.accountId = accounts.accounts[1].accountId;
    if (mismatch === "origin") challenge.origin = "https://wrong.example";
    if (mismatch === "key") challenge.boxPublicKey = b64(sodium.randombytes_buf(32));
    if (mismatch === "device") challenge.deviceId = crypto.randomUUID();
    if (mismatch === "expiry") challenge.expiresAt = new Date(Date.now() - 1).toISOString();
    if (delayed) await new Promise<void>(resolve => {release = resolve;});
    return reply(challenge);
  };
  try {
    lockVault(); configureVault(vault);
    for (const value of ["account", "origin", "key", "device", "expiry"]) {mismatch = value; await assert.rejects(requestDeviceApproval(), /INVALID_DEVICE_CHALLENGE/);}
    mismatch = ""; delayed = true;
    const pending = requestDeviceApproval(), rejected = assert.rejects(pending, {name: "AbortError"});
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    cancelDeviceApproval(); release(); await rejected;
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: challenge.enrollmentId}), /DEVICE_APPROVAL_REQUIRED/);
    delayed = false;
    const requested = await requestDeviceApproval();
    lockVault(); await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: requested.enrollmentId}), /DEVICE_APPROVAL_REQUIRED/);
    const replaced = await requestDeviceApproval();
    await requestDeviceApproval();
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: replaced.enrollmentId}), /DEVICE_APPROVAL_REQUIRED/);
    const changedOrigin = await requestDeviceApproval(); page.origin = "https://wrong.example";
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: changedOrigin.enrollmentId}), {name: "AbortError"});
    assert.equal(completionReads, 0); assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {lockVault(); globalThis.fetch = oldFetch; if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation); else Reflect.deleteProperty(globalThis, "location");}
});

test("only a current unlocked account can review and explicitly approve a valid public challenge", async () => {
  await ready;
  const {sodium, b64} = await import("@fotoro/crypto");
  const oldFetch = globalThis.fetch, oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://fotoro.cloud"}});
  let approves = 0, receipt: unknown, malformedReceipt = false;
  globalThis.fetch = async (_input, init) => {approves++; const text = String(init?.body); assert.equal(text.includes(data.vaultKey), false); assert.equal(text.includes(data.signingSecretKey), false); return new Response(malformedReceipt ? "{" : JSON.stringify(receipt));};
  try {
    lockVault(); configureVault(vault); await unlockVault({kind: "recovery", secret: unb64(data.recoverySecret)});
    const challenge = {version: 1, enrollmentId: crypto.randomUUID(), accountId: data.accountId, deviceId: crypto.randomUUID(),
      boxPublicKey: b64(sodium.crypto_box_keypair().publicKey), origin: "https://fotoro.cloud", challenge: b64(sodium.randombytes_buf(32)),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "pending"};
    for (const change of [{accountId: accounts.accounts[1].accountId}, {origin: "https://wrong.example"}, {expiresAt: new Date(Date.now() - 1).toISOString()}, {expiresAt: "invalid"}, {state: "completed"}]) {
      const text = JSON.stringify({...challenge, ...change}); assert.throws(() => reviewDeviceChallenge(text)); await assert.rejects(approveDeviceChallenge(text));
    }
    assert.equal(approves, 0); assert.deepEqual(reviewDeviceChallenge(JSON.stringify(challenge)), challenge); assert.equal(approves, 0, "Review alone cannot approve");
    await assert.rejects(approveDeviceChallenge(JSON.stringify(challenge), () => false), {name: "AbortError"}); assert.equal(approves, 0);
    for (const value of [{version: 1}, {...challenge, state: "pending"}, {...challenge, state: "approved", origin: "https://wrong.example"}, {...challenge, state: "approved", enrollmentId: crypto.randomUUID()}]) {
      receipt = value; await assert.rejects(approveDeviceChallenge(JSON.stringify(challenge)), /INVALID_DEVICE_APPROVAL_RECEIPT/);
    }
    malformedReceipt = true; await assert.rejects(approveDeviceChallenge(JSON.stringify(challenge)), /INVALID_DEVICE_APPROVAL_RECEIPT/); malformedReceipt = false;
    approves = 0; receipt = {...challenge, state: "approved"};
    await approveDeviceChallenge(JSON.stringify(challenge)); assert.equal(approves, 1);
    lockVault(); await assert.rejects(approveDeviceChallenge(JSON.stringify(challenge)), /VAULT_LOCKED/); assert.equal(approves, 1);
  } finally {lockVault(); globalThis.fetch = oldFetch; if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation); else Reflect.deleteProperty(globalThis, "location");}
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
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), oldNow = Date.now;
  Object.defineProperty(globalThis, "window", {configurable: true, value: new EventTarget()});
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
  let completionMode = "valid", enrollment401 = false;
  let delayComplete = false, releaseComplete: (() => void) | undefined;
  globalThis.fetch = (async (input: string, init: any) => {
    const request = JSON.parse(init.body);
    if (input === "/v1/devices/enroll") {
      if (enrollment401) return new Response(JSON.stringify({code: "UNAUTHENTICATED"}), {status: 401});
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
    if (completionMode === "pending") return new Response(JSON.stringify({code: "DEVICE_APPROVAL_REQUIRED"}), {status: 403});
    if (completionMode === "cookie") return new Response(JSON.stringify({code: "UNAUTHENTICATED"}), {status: 401});
    if (completionMode === "cookieDelayed") {await new Promise<void>(resolve => {releaseComplete = resolve;}); return new Response(JSON.stringify({code: "UNAUTHENTICATED"}), {status: 401});}
    if (completionMode === "network") throw new TypeError("Offline");
    if (completionMode === "json") return new Response("{");
    if (completionMode === "shape") return new Response(JSON.stringify({version: 1}));
    const bundle = utf8({
      vaultKey: data.vaultKey,
      boxSecretKey: data.boxSecretKey,
      signingSecretKey: data.signingSecretKey,
    });
    const sealedBundle = completionMode === "decrypt" ? b64(sodium.randombytes_buf(64)) : b64(
      sodium.crypto_box_seal(bundle, unb64(challenge.boxPublicKey)),
    );
    const proof = sorted({
      challenge: {
        ...challenge,
        ...(tamper ? { origin: "https://wrong.example" } : {}),
      },
      sealedBundle,
    });
    if (delayComplete) await new Promise<void>(resolve => {releaseComplete = resolve;});
    return new Response(
      JSON.stringify({
        version: completionMode === "version" ? 2 : 1,
        challenge: sorted({ ...challenge, state: "completed" }),
        sealedBundle,
        signedPayload: completionMode === "signature" ? {...signPayload("device-approval", data.accountId, utf8(proof), unb64(data.signingSecretKey)), signature: b64(new Uint8Array(64))} : signPayload(
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
    const file = new File(["chosen original"], "chosen.jpg"), save = new ChosenSaveIntent([{id: "chosen", file, filename: file.name} as LocalPhoto]);
    const trip = new IncomingAlbumIntent(parseAlbumLink(createAlbumLink(crypto.randomUUID(), accounts.accounts[0])));
    const saveTicket = save.beginAuthentication(vaultGeneration()), tripTicket = trip.beginAuthentication(vaultGeneration());
    window.addEventListener("fotoro-lock", () => {save.vaultLocked(); trip.vaultLocked();});
    const unlocked = await unlockVault({
      kind: "trustedDevice",
      enrollmentId: first.enrollmentId,
    });
    assert.equal(unlocked.accountId, data.accountId);
    save.finishAuthentication(saveTicket, {session: unlocked, generation: vaultGeneration(), current: () => requireVault() === unlocked});
    trip.finishAuthentication(tripTicket, unlocked, vaultGeneration());
    assert.equal(save.pending, true); assert.equal(save.boundVault, unlocked); assert.deepEqual(save.snapshot.files, [file]);
    assert.equal(trip.current(unlocked), true, "Trusted-device unlock uses the same explicit invitation continuation as password unlock");
    lockVault();
    configureVault(vault as any);
    tamper = true;
    const second = await requestDeviceApproval();
    await assert.rejects(
      unlockVault({ kind: "trustedDevice", enrollmentId: second.enrollmentId }),
      /DEVICE_BINDING_MISMATCH/,
    );
    assert.throws(requireVault, /VAULT_LOCKED/);
    tamper = false;
    for (const mode of ["json", "shape", "version", "signature", "decrypt"]) {
      completionMode = mode; configureVault(vault);
      const request = await requestDeviceApproval();
      await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: request.enrollmentId}));
      assert.equal(deviceApprovalDeadline(request.enrollmentId), undefined, mode + " must wipe its one-use pending key");
      await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: request.enrollmentId}), /DEVICE_APPROVAL_REQUIRED/);
      assert.throws(requireVault, /VAULT_LOCKED/);
    }
    for (const mode of ["pending", "network"]) {
      completionMode = mode; configureVault(vault);
      const request = await requestDeviceApproval();
      await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: request.enrollmentId}));
      assert.notEqual(deviceApprovalDeadline(request.enrollmentId), undefined, mode + " leaves ordinary retry available");
      completionMode = "valid"; await unlockVault({kind: "trustedDevice", enrollmentId: request.enrollmentId}); lockVault();
    }
    const cookieGeneration = vaultGeneration();
    configureApprovalVault(vault, new Date(Date.now() + 60_000).toISOString());
    const cookieRequest = await requestDeviceApproval(); completionMode = "cookie";
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: cookieRequest.enrollmentId}), /UNAUTHENTICATED/);
    assert.equal(deviceApprovalDeadline(cookieRequest.enrollmentId), undefined); assert.equal(authenticatedApprovalAccount(), undefined);
    assert.equal(vaultGeneration(), cookieGeneration, "A locked cookie rejection clears only the approval context, without unrelated account cleanup");
    configureApprovalVault(vault, new Date(Date.now() + 60_000).toISOString()); enrollment401 = true;
    await assert.rejects(requestDeviceApproval(), /UNAUTHENTICATED/); assert.equal(authenticatedApprovalAccount(), undefined);
    enrollment401 = false; completionMode = "valid";
    configureApprovalVault(vault, new Date(Date.now() + 60_000).toISOString());
    const oldRequest = await requestDeviceApproval(); completionMode = "cookieDelayed"; releaseComplete = undefined;
    const oldCompletion = unlockVault({kind: "trustedDevice", enrollmentId: oldRequest.enrollmentId}), oldRejected = assert.rejects(oldCompletion, /UNAUTHENTICATED/);
    while (!releaseComplete) await new Promise(resolve => setTimeout(resolve, 0));
    configureApprovalVault(vault, new Date(Date.now() + 60_000).toISOString()); completionMode = "valid";
    const newerRequest = await requestDeviceApproval(); releaseComplete(); await oldRejected;
    assert.notEqual(deviceApprovalDeadline(newerRequest.enrollmentId), undefined, "A stale locked401 cannot clear a replacement request");
    assert.equal(authenticatedApprovalAccount(), data.accountId);
    const sessionDeadline = Date.now() + 1000;
    configureApprovalVault(vault, new Date(sessionDeadline).toISOString());
    const earlyExpiry = await requestDeviceApproval();
    assert.equal(deviceApprovalDeadline(earlyExpiry.enrollmentId), sessionDeadline);
    assert.ok(sessionDeadline < Date.parse(earlyExpiry.expiresAt));
    Date.now = () => sessionDeadline + 1;
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: earlyExpiry.enrollmentId}), /DEVICE_APPROVAL_EXPIRED/);
    assert.equal(deviceApprovalDeadline(earlyExpiry.enrollmentId), undefined); Date.now = oldNow;
    configureVault(vault);
    const expiring = await requestDeviceApproval(), expiredAt = Date.parse(expiring.expiresAt);
    Date.now = () => expiredAt + 1;
    await assert.rejects(unlockVault({kind: "trustedDevice", enrollmentId: expiring.enrollmentId}), /DEVICE_APPROVAL_EXPIRED/);
    Date.now = oldNow;
    configureVault(vault);
    const cancelled = await requestDeviceApproval(); delayComplete = true;
    releaseComplete = undefined;
    const completion = unlockVault({kind: "trustedDevice", enrollmentId: cancelled.enrollmentId}), rejected = assert.rejects(completion, {name: "AbortError"});
    while (!releaseComplete) await new Promise(resolve => setTimeout(resolve, 0));
    cancelDeviceApproval(); releaseComplete(); await rejected; assert.throws(requireVault, /VAULT_LOCKED/);
  } finally {
    Date.now = oldNow;
    globalThis.fetch = oldFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    lockVault();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
