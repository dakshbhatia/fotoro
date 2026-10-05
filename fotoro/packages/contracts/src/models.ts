export type UUID = string;
export type Base64Url = string;
export interface AccountCardV1 {
  version: 1;
  accountId: UUID;
  boxPublicKey: Base64Url;
  signingPublicKey: Base64Url;
}
export interface MediaBinding {
  version: 1;
  photoId: UUID;
  representationId: UUID;
  kind: "thumbnail" | "preview" | "original" | "metadata";
}
export interface RepresentationV1 {
  binding: MediaBinding;
  objectId: UUID;
  header: Base64Url;
  ciphertextBytes: number;
  ciphertextSha256: Base64Url;
}
export interface PhotoMetadataV1 {
  version: 1;
  filename: string;
  mediaType: "image/jpeg" | "image/png" | "image/heic" | "video/mp4" | "video/quicktime" | "application/vnd.fotoro.live-photo";
  sourceDate: string;
  dateSource: "exif" | "photos" | "import";
  originalBytes: number;
  originalSha256: Base64Url;
  representationKeys: Record<UUID, Base64Url>;
}
/* Account-private search data. Encrypted separately from shared photo metadata. */
export interface PhotoVisualV1 {
  processor: string;
  labels: {label: string; identifier: string; confidence: number}[];
}
export interface PhotoAnnotationsV1 {
  version: 1;
  photoId: UUID;
  originalSha256: Base64Url;
  labels?: string[];
  caption?: string;
  keywords?: string[];
  facts?: string[];
  favorite?: boolean;
  ocr?: { text: string; confidence: number; processor: string };
  visual?: PhotoVisualV1;
}
export interface PhotoAnnotationsUpdateV1 {
  version: 1;
  photoId: UUID;
  revision: number;
  encrypted: WrappedKeyV1;
}
export interface PhotoAnnotationsReplyV1 {
  version: 1;
  annotations: SignedPayloadV1 | null;
}
export interface WrappedKeyV1 {
  version: 1;
  nonce: Base64Url;
  ciphertext: Base64Url;
}
export interface PhotoManifestV1 {
  version: 1;
  photoId: UUID;
  ownerAccountId: UUID;
  representations: RepresentationV1[];
  metadataRepresentation: RepresentationV1;
  ownerWrappedMetadataKey: WrappedKeyV1;
}
export interface SignedPayloadV1 {
  version: 1;
  kind: string;
  accountId: UUID;
  body: Base64Url;
  signature: Base64Url;
}
export interface UploadReservationV1 {
  version: 1;
  uploadId: UUID;
  photoId: UUID;
  representationId: UUID;
  stagingUrl: string;
  expiresAt: string;
}
export interface UploadCommitV1 {
  version: 1;
  uploadId: UUID;
  objectId: UUID;
  ciphertextBytes: number;
  ciphertextSha256: Base64Url;
}
export interface GrantV1 {
  grantId: UUID;
  momentId: UUID;
  ownerAccountId: UUID;
  recipientAccountId: UUID;
  role: "viewer" | "contributor";
  expiresAt: string | null;
  revokedAt: string | null;
  version: number;
}
export interface ShareBindingV1 {
  version: 1;
  grantId: UUID;
  photoId: UUID;
  senderAccountId: UUID;
  recipientAccountId: UUID;
}
export interface ShareKeyEnvelopeV1 extends ShareBindingV1 {
  sealedMetadataKey: Base64Url;
  senderSignature: Base64Url;
}
export interface SavedPhotoV1 {
  version: 1;
  operationId: UUID;
  photoId: UUID;
  sourceGrantId: UUID;
  sourcePhotoId: UUID;
  manifest: PhotoManifestV1;
  signedPayload: SignedPayloadV1;
}
export interface ChangeV1 {
  cursor: string;
  entity: "photo" | "grant" | "annotation";
  entityId: UUID;
  deleted: boolean;
  payload: SignedPayloadV1 | null;
}
export interface ChangePageV1 {
  version: 1;
  mediaVersion?: 1;
  changes: ChangeV1[];
  nextCursor: string | null;
  hasMore: boolean;
}
export interface ApiErrorV1 {
  version: 1;
  code: string;
  retryable: boolean;
  requestId: UUID;
}
export interface ReserveUploadV1 {
  version: 1;
  binding: MediaBinding;
  ciphertextBytes: number;
  ciphertextSha256: Base64Url;
  operationId: UUID;
}
export * from "./auth.js";
