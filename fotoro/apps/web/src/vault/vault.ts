import type {
  AccountCardV1,
  VaultV1,
  WrappedKeyV1,
  DeviceChallengeV1,
} from "@fotoro/contracts";
import {validateWire} from "@fotoro/contracts/validate";
type VaultCrypto = typeof import("./crypto-runtime");
let cryptoRuntime: VaultCrypto | undefined;
// Local browsing needs the session identity and lock events, but no crypto.
// Unlock initializes the runtime before exposing any synchronous private APIs.
async function loadCrypto(): Promise<VaultCrypto> {
  const runtime = cryptoRuntime ?? await import("./crypto-runtime");
  await runtime.ready;
  cryptoRuntime = runtime;
  return runtime;
}
function unlockedCrypto(): VaultCrypto {
  requireVault();
  if (!cryptoRuntime) throw new Error("VAULT_LOCKED");
  return cryptoRuntime;
}
export type UnlockMethod =
  | { kind: "prf" }
  | { kind: "trustedDevice"; enrollmentId: string }
  | { kind: "recovery"; secret: Uint8Array };
export interface UnlockedVault {
  accountId: string;
  card: AccountCardV1;
  vaultKey: Uint8Array;
  boxSecretKey: Uint8Array;
  signingSecretKey: Uint8Array;
  dispose(): void;
}
let active: UnlockedVault | undefined;
let generation = 0;
export const vaultGeneration = () => generation;
let envelope: VaultV1 | undefined;
let prfKey: Uint8Array | undefined;
let credentialId: string | undefined;
let sessionDeviceId: string | undefined;
let deviceEpoch = 0;
let approvalAuthentication: {accountId: string; generation: number; origin: string; expiresAt: number} | undefined;
export function authenticatedApprovalAccount() {
  const value = approvalAuthentication;
  return value && value.generation === generation && value.origin === location.origin && value.expiresAt > Date.now()
    && envelope?.accountCard.accountId === value.accountId ? value.accountId : undefined;
}
export function configureApprovalVault(value: VaultV1, expiresAt: string) {
  configureVault(value);
  approvalAuthentication = {accountId: value.accountCard.accountId, generation, origin: location.origin, expiresAt: Date.parse(expiresAt)};
}
export function cancelDeviceApproval() {
  deviceEpoch++;
  device?.privateKey.fill(0);
  device = undefined;
}
export function deviceApprovalDeadline(enrollmentId: string) {return device?.id === enrollmentId ? device.expiresAt : undefined;}
let device:
  | {
      id: string;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      challenge: DeviceChallengeV1;
      expiresAt: number;
    }
  | undefined;
const urls = new Map<string, { url: string; size: number }>();
// Signed bytes stay untouched; compare their parsed structure across encoders.
const orderedJSON = (value: any): any =>
  Array.isArray(value)
    ? value.map(orderedJSON)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, orderedJSON(value[key])]),
        )
      : value;
const sameJSON = (a: unknown, b: unknown) =>
  JSON.stringify(orderedJSON(a)) === JSON.stringify(orderedJSON(b));
export const requireVault = () => {
  if (!active) throw new Error("VAULT_LOCKED");
  return active;
};
export function configureVault(
  value: VaultV1,
  prf?: Uint8Array,
  credential?: string,
) {
  cancelDeviceApproval(); approvalAuthentication = undefined;
  prfKey?.fill(0);
  envelope = value;
  prfKey = prf;
  credentialId = credential;
}
export function configureDevice(id: string) {
  cancelDeviceApproval(); approvalAuthentication = undefined;
  sessionDeviceId = id;
}
export async function unlockVault(
  method: UnlockMethod,
): Promise<UnlockedVault> {
  const target = envelope, token = generation;
  const checkCurrent = () => {
    if (envelope !== target || generation !== token)
      throw new DOMException("Vault unlock cancelled", "AbortError");
  };
  const { unb64, unwrapKey, sodium, b64, verifyPayload, api, ApiError, ApiTransportError } = await loadCrypto();
  checkCurrent();
  if (!target) throw new Error("AUTHENTICATION_REQUIRED");
  let bytes: Uint8Array;
  if (method.kind === "trustedDevice") {
    if (!device || device.id !== method.enrollmentId)
      throw new Error("DEVICE_APPROVAL_REQUIRED");
    const pendingDevice = device;
    const checkDevice = () => {
      checkCurrent();
      if (device !== pendingDevice) throw new DOMException("Device approval cancelled", "AbortError");
      if (pendingDevice.challenge.origin !== location.origin) {cancelDeviceApproval(); throw new DOMException("Device approval cancelled", "AbortError");}
      if (pendingDevice.expiresAt <= Date.now()) {cancelDeviceApproval(); throw new Error("DEVICE_APPROVAL_EXPIRED");}
    };
    checkDevice();
    let received = false;
    try {
    const result = await api<any>(
      "/v1/devices/enroll/" + device.id + "/complete",
      { version: 1, challenge: device.challenge.challenge },
    );
    received = true;
    checkDevice();
    if (!result || result.version !== 1) throw new Error("INVALID_DEVICE_COMPLETION");
    const signed = result.signedPayload;
    if (
      signed.kind !== "device-approval" ||
      signed.accountId !== target.accountCard.accountId
    )
      throw new Error("INVALID_DEVICE_SIGNATURE");
    const proof = JSON.parse(
      new TextDecoder().decode(
        verifyPayload(signed, unb64(target.accountCard.signingPublicKey)),
      ),
    );
    if (
      !sameJSON(proof, {
        challenge: device.challenge,
        sealedBundle: result.sealedBundle,
      }) ||
      !sameJSON(result.challenge, { ...device.challenge, state: "completed" })
    )
      throw new Error("DEVICE_BINDING_MISMATCH");
    bytes = sodium.crypto_box_seal_open(
      unb64(result.sealedBundle),
      device.publicKey,
      device.privateKey,
    );
    cancelDeviceApproval();
    } catch (error) {
      if (device === pendingDevice && envelope === target && generation === token) {
        if (error instanceof ApiError && error.status === 401) {cancelDeviceApproval(); approvalAuthentication = undefined;}
        else if (received || !(error instanceof ApiTransportError) && !(error instanceof ApiError &&
          (["DEVICE_APPROVAL_REQUIRED", "FORBIDDEN"].includes(error.code) || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500))) cancelDeviceApproval();
      }
      throw error;
    }
  } else {
    const kind = method.kind === "prf" ? "prf" : "recovery";
    const wrapper = target.wrappers.find(
      (w) =>
        w.kind === kind &&
        (kind === "recovery" ? w.verified : w.credentialId === credentialId),
    );
    const key = method.kind === "prf" ? prfKey : method.secret;
    if (!wrapper || !key)
      throw new Error(
        kind === "prf"
          ? "PRF_UNAVAILABLE_USE_RECOVERY"
          : "RECOVERY_UNAVAILABLE",
      );
    bytes = unwrapKey(wrapper.wrappedBundle, key);
  }
  let parsed: any;
  try {parsed = JSON.parse(new TextDecoder().decode(bytes));}
  finally {bytes.fill(0);}
  const card = target.accountCard;
  const vaultKey = unb64(parsed.vaultKey),
    boxSecretKey = unb64(parsed.boxSecretKey),
    signingSecretKey = unb64(parsed.signingSecretKey);
  if (
    vaultKey.length !== 32 ||
    boxSecretKey.length !== 32 ||
    signingSecretKey.length !== 64 ||
    b64(sodium.crypto_scalarmult_base(boxSecretKey)) !== card.boxPublicKey ||
    b64(sodium.crypto_sign_ed25519_sk_to_pk(signingSecretKey)) !==
      card.signingPublicKey
  )
    throw new Error("BUNDLE_IDENTITY_MISMATCH");
  const opened: UnlockedVault = {
    accountId: card.accountId,
    card,
    vaultKey,
    boxSecretKey,
    signingSecretKey,
    dispose() {
      vaultKey.fill(0);
      boxSecretKey.fill(0);
      signingSecretKey.fill(0);
    },
  };
  checkCurrent();
  lockVault("unlock");
  // Lock listeners run synchronously. An explicit lock/reconfiguration from a
  // listener must win over this operation's normal internal lock notification.
  if (generation !== token + 1 || envelope !== target) {
    opened.dispose();
    throw new DOMException("Vault unlock cancelled", "AbortError");
  }
  active = opened;
  return active;
}
export interface VaultLockDetail {reason: "manual" | "expired" | "unlock"; accountId?: string;}
export function vaultLockDetail(event: Event): VaultLockDetail | undefined {
  return (event as CustomEvent<VaultLockDetail>).detail;
}
export function lockVault(reason: VaultLockDetail["reason"] = "manual") {
  cancelDeviceApproval(); approvalAuthentication = undefined;
  const accountId = active?.accountId;
  generation++;
  active?.dispose();
  active = undefined;
  prfKey?.fill(0);
  prfKey = undefined;
  for (const { url } of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  if (typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent<VaultLockDetail>("fotoro-lock", {detail: {reason, accountId}}));
}
export function mediaURL(
  key: string,
  bytes: Uint8Array,
  type: string,
  decodedBytes = bytes.byteLength,
) {
  requireVault();
  const found = urls.get(key);
  if (found) return found.url;
  let size = [...urls.values()].reduce((n, v) => n + v.size, 0);
  for (const [id, v] of urls) {
    if (size + decodedBytes <= 48 * 1024 * 1024) break;
    URL.revokeObjectURL(v.url);
    urls.delete(id);
    size -= v.size;
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  urls.set(key, { url, size: decodedBytes });
  return url;
}
export const encryptPrivate = (value: unknown): WrappedKeyV1 => {
  const { wrapKey } = unlockedCrypto();
  return wrapKey(
    new TextEncoder().encode(JSON.stringify(value)),
    requireVault().vaultKey,
  );
};
export const decryptPrivate = <T>(value: WrappedKeyV1): T => {
  const { unwrapKey } = unlockedCrypto();
  return JSON.parse(
    new TextDecoder().decode(unwrapKey(value, requireVault().vaultKey)),
  );
};
export async function requestDeviceApproval(current = () => true) {
  cancelDeviceApproval();
  const epoch = deviceEpoch, token = generation, target = envelope, session = active, origin = typeof location === "undefined" ? undefined : location.origin;
  const checkCurrent = () => {
    if (!current() || epoch !== deviceEpoch || generation !== token || envelope !== target || active !== session || (typeof location === "undefined" ? undefined : location.origin) !== origin)
      throw new DOMException("Device approval cancelled", "AbortError");
  };
  const { sodium, b64, api, ApiError } = await loadCrypto();
  checkCurrent();
  if (!target || !origin) throw new Error("AUTHENTICATION_REQUIRED");
  if (approvalAuthentication && !authenticatedApprovalAccount()) throw new Error("DEVICE_APPROVAL_EXPIRED");
  const kp = sodium.crypto_box_keypair();
  const deviceId = sessionDeviceId ?? crypto.randomUUID();
  try {
    const result = await api<any>(
      "/v1/devices/enroll",
      {
        version: 1,
        deviceId,
        boxPublicKey: b64(kp.publicKey),
        origin,
      },
      "DeviceChallengeV1",
    );
    checkCurrent();
    if (approvalAuthentication && !authenticatedApprovalAccount()) throw new Error("DEVICE_APPROVAL_EXPIRED");
    if (result.accountId !== target.accountCard.accountId || result.deviceId !== deviceId || result.origin !== origin || result.boxPublicKey !== b64(kp.publicKey)
      || result.state !== "pending" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error("INVALID_DEVICE_CHALLENGE");
    device?.privateKey.fill(0);
    device = { id: result.enrollmentId, ...kp, challenge: structuredClone(result), expiresAt: Math.min(Date.parse(result.expiresAt), approvalAuthentication?.expiresAt ?? Infinity) };
    return structuredClone(result) as DeviceChallengeV1;
  } catch (error) {
    kp.privateKey.fill(0);
    if (error instanceof ApiError && error.status === 401 && epoch === deviceEpoch && envelope === target && generation === token) {cancelDeviceApproval(); approvalAuthentication = undefined;}
    throw error;
  }
}

export function reviewDeviceChallenge(text: string) {
  const v = requireVault();
  let challenge: DeviceChallengeV1;
  try {challenge = validateWire<DeviceChallengeV1>("DeviceChallengeV1", JSON.parse(text));}
  catch {throw new Error("INVALID_DEVICE_CHALLENGE");}
  if (challenge.accountId !== v.accountId || challenge.origin !== location.origin || challenge.state !== "pending"
    || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error("INVALID_DEVICE_CHALLENGE");
  return challenge;
}
export async function approveDeviceChallenge(text: string, current = () => true) {
  const { sodium, b64, unb64, signPayload, api } = unlockedCrypto();
  const v = requireVault(), token = generation, origin = location.origin;
  if (!current()) throw new DOMException("Device approval cancelled", "AbortError");
  const challenge = reviewDeviceChallenge(text);
  const bundle = new TextEncoder().encode(
    JSON.stringify({
      vaultKey: b64(v.vaultKey),
      boxSecretKey: b64(v.boxSecretKey),
      signingSecretKey: b64(v.signingSecretKey),
    }),
  );
  let sealedBundle: string;
  try {sealedBundle = b64(sodium.crypto_box_seal(bundle, unb64(challenge.boxPublicKey)));}
  finally {bundle.fill(0);}
  const signedPayload = signPayload(
    "device-approval",
    v.accountId,
    new TextEncoder().encode(JSON.stringify({ challenge, sealedBundle })),
    v.signingSecretKey,
  );
  const checkCurrent = () => {
    if (!current() || generation !== token || active !== v || location.origin !== origin || Date.parse(challenge.expiresAt) <= Date.now()) throw new DOMException("Device approval cancelled", "AbortError");
  };
  let result: unknown;
  try {result = await api<unknown>("/v1/devices/enroll/" + challenge.enrollmentId + "/approve", {version: 1, sealedBundle, signedPayload});}
  catch (error) {checkCurrent(); if (error instanceof SyntaxError) throw new Error("INVALID_DEVICE_APPROVAL_RECEIPT"); throw error;}
  checkCurrent();
  let receipt: DeviceChallengeV1;
  try {receipt = validateWire<DeviceChallengeV1>("DeviceChallengeV1", result);}
  catch {throw new Error("INVALID_DEVICE_APPROVAL_RECEIPT");}
  if (!sameJSON(receipt, {...challenge, state: "approved"})) throw new Error("INVALID_DEVICE_APPROVAL_RECEIPT");
  return receipt;
}
