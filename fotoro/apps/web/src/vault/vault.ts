import type {
  AccountCardV1,
  VaultV1,
  WrappedKeyV1,
  DeviceChallengeV1,
} from "@fotoro/contracts";
import {
  ready,
  unb64,
  unwrapKey,
  wrapKey,
  sodium,
  b64,
  verifyPayload,
  signPayload,
} from "@fotoro/crypto";
import { api } from "../exchange/api";
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
let device:
  | {
      id: string;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
      challenge: DeviceChallengeV1;
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
  envelope = value;
  prfKey = prf;
  credentialId = credential;
}
export function configureDevice(id: string) {
  sessionDeviceId = id;
}
export async function unlockVault(
  method: UnlockMethod,
): Promise<UnlockedVault> {
  await ready;
  if (!envelope) throw new Error("AUTHENTICATION_REQUIRED");
  let bytes: Uint8Array;
  if (method.kind === "trustedDevice") {
    if (!device || device.id !== method.enrollmentId)
      throw new Error("DEVICE_APPROVAL_REQUIRED");
    const result = await api<any>(
      "/v1/devices/enroll/" + device.id + "/complete",
      { version: 1, challenge: device.challenge.challenge },
    );
    const signed = result.signedPayload;
    if (
      signed.kind !== "device-approval" ||
      signed.accountId !== envelope.accountCard.accountId
    )
      throw new Error("INVALID_DEVICE_SIGNATURE");
    const proof = JSON.parse(
      new TextDecoder().decode(
        verifyPayload(signed, unb64(envelope.accountCard.signingPublicKey)),
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
    device.privateKey.fill(0);
    device = undefined;
  } else {
    const kind = method.kind === "prf" ? "prf" : "recovery";
    const wrapper = envelope.wrappers.find(
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
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  bytes.fill(0);
  const card = envelope.accountCard;
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
  lockVault();
  active = {
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
  return active;
}
export function lockVault() {
  generation++;
  active?.dispose();
  active = undefined;
  prfKey?.fill(0);
  prfKey = undefined;
  for (const { url } of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("fotoro-lock"));
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
export const encryptPrivate = (value: unknown): WrappedKeyV1 =>
  wrapKey(
    new TextEncoder().encode(JSON.stringify(value)),
    requireVault().vaultKey,
  );
export const decryptPrivate = <T>(value: WrappedKeyV1): T =>
  JSON.parse(
    new TextDecoder().decode(unwrapKey(value, requireVault().vaultKey)),
  );
export async function requestDeviceApproval() {
  await ready;
  const kp = sodium.crypto_box_keypair();
  const result = await api<any>(
    "/v1/devices/enroll",
    {
      version: 1,
      deviceId: sessionDeviceId ?? crypto.randomUUID(),
      boxPublicKey: b64(kp.publicKey),
      origin: location.origin,
    },
    "DeviceChallengeV1",
  );
  device = { id: result.enrollmentId, ...kp, challenge: result };
  return result;
}

export async function approveDeviceChallenge(text: string) {
  const v = requireVault();
  const challenge = JSON.parse(text);
  if (
    challenge.accountId !== v.accountId ||
    challenge.origin !== location.origin ||
    challenge.state !== "pending" ||
    Date.parse(challenge.expiresAt) <= Date.now()
  )
    throw new Error("INVALID_DEVICE_CHALLENGE");
  const bundle = new TextEncoder().encode(
    JSON.stringify({
      vaultKey: b64(v.vaultKey),
      boxSecretKey: b64(v.boxSecretKey),
      signingSecretKey: b64(v.signingSecretKey),
    }),
  );
  const sealedBundle = b64(
    sodium.crypto_box_seal(bundle, unb64(challenge.boxPublicKey)),
  );
  bundle.fill(0);
  const signedPayload = signPayload(
    "device-approval",
    v.accountId,
    new TextEncoder().encode(JSON.stringify({ challenge, sealedBundle })),
    v.signingSecretKey,
  );
  return api("/v1/devices/enroll/" + challenge.enrollmentId + "/approve", {
    version: 1,
    sealedBundle,
    signedPayload,
  });
}
