import type {
  AccountCardV1,
  Base64Url,
  UUID,
  WrappedKeyV1,
  SignedPayloadV1,
  GrantV1,
  ShareKeyEnvelopeV1,
} from "./models.js";
export const PRODUCTION_AUTH = {
  rpId: "fotoro.cloud",
  origins: ["https://fotoro.cloud"],
  associatedDomains: ["webcredentials:fotoro.cloud", "applinks:fotoro.cloud"],
} as const;
export const FIXTURE_AUTH = {
  rpId: "localhost",
  origins: ["http://localhost:4310", "http://127.0.0.1:4310"],
  enrollmentSeconds: 300,
} as const;
export interface AuthOptionsRequestV1 {
  version: 1;
  accountId?: UUID;
  client: "web" | "native";
}
export interface AuthVerifyRequestV1 {
  version: 1;
  challengeId: UUID;
  response: unknown;
  enrollment?: AccountEnrollmentV1;
  client: "web" | "native";
}
export interface StartOptionsRequestV1 {
  version: 1;
  client: "web" | "native";
}
export interface StartOptionsV1 {
  version: 1;
  accountId: UUID;
  challengeId: UUID;
  challenge: Base64Url;
  expiresAt: string;
}
export interface StartVerifyRequestV1 {
  version: 1;
  challengeId: UUID;
  client: "web" | "native";
  enrollment: AccountEnrollmentV1;
  signedPayload: SignedPayloadV1;
}
export interface SessionV1 {
  version: 1;
  accountId: UUID;
  deviceId: UUID;
  expiresAt: string;
  token?: string;
}
export interface VaultWrapperV1 {
  version: 1;
  wrapperId: UUID;
  kind: "recovery" | "prf" | "device";
  credentialId: Base64Url | null;
  prfSalt: Base64Url | null;
  wrappedBundle: WrappedKeyV1;
  verified: boolean;
}
export interface VaultV1 {
  version: 1;
  accountCard: AccountCardV1;
  wrappers: VaultWrapperV1[];
}
export interface EnrollDeviceV1 {
  version: 1;
  deviceId: UUID;
  boxPublicKey: Base64Url;
  origin: string;
}
export interface DeviceChallengeV1 extends EnrollDeviceV1 {
  enrollmentId: UUID;
  accountId: UUID;
  challenge: Base64Url;
  expiresAt: string;
  state: "pending" | "approved" | "completed";
}
export interface DeviceApprovalV1 {
  version: 1;
  signedPayload: SignedPayloadV1;
  sealedBundle: Base64Url;
}
export interface CreateGrantV1 {
  version: 1;
  grant: GrantV1;
  envelopes: ShareKeyEnvelopeV1[];
  signedPayload: SignedPayloadV1;
}
export interface ContributionV1 {
  version: 1;
  operationId: UUID;
  expectedGrantVersion: number;
  manifests: SignedPayloadV1[];
  envelopes: ShareKeyEnvelopeV1[];
}
export interface SaveRequestV1 {
  version: 1;
  expectedGrantVersion: number;
  save: import("./models.js").SavedPhotoV1;
}
export interface AccountEnrollmentV1 {
  version: 1;
  accountCard: AccountCardV1;
  recoveryWrapper: VaultWrapperV1;
  proof: SignedPayloadV1;
}
export interface GrantInboxV1 {
  version: 1;
  grants: GrantV1[];
}
export interface GrantDetailV1 {
  version: 1;
  grant: GrantV1;
  envelopes: ShareKeyEnvelopeV1[];
  manifests: SignedPayloadV1[];
  cards: AccountCardV1[];
}
export interface GrantOptionsRequestV1 {
  version: 1;
  recipientAccountId: UUID;
  role: "viewer" | "contributor";
  access: "ongoing" | "temporary";
}
export interface RecoveryOptionsRequestV1 {
  version: 1;
  accountId: UUID;
  client: "web" | "native";
}
export interface RecoveryOptionsV1 {
  version: 1;
  challengeId: UUID;
  challenge: Base64Url;
  expiresAt: string;
  vault: VaultV1;
}
export interface RecoveryVerifyRequestV1 {
  version: 1;
  challengeId: UUID;
  signedPayload: SignedPayloadV1;
  client: "web" | "native";
}
export interface RecoverySessionProofV1 {
  version: 1;
  challengeId: UUID;
  challenge: Base64Url;
  accountId: UUID;
  client: "web" | "native";
  origin: string;
}
