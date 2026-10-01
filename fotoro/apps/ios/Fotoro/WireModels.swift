import Foundation

struct AccountCardV1: Codable, Equatable, Sendable {
  var version = 1
  var accountId: String
  var boxPublicKey: String
  var signingPublicKey: String
}
struct MediaBinding: Codable, Equatable, Sendable {
  var version = 1
  var photoId: String
  var representationId: String
  var kind: String
}
struct RepresentationV1: Codable, Equatable, Sendable {
  var binding: MediaBinding
  var objectId: String
  var header: String
  var ciphertextBytes: Int
  var ciphertextSha256: String
}
struct PhotoMetadataV1: Codable, Equatable, Sendable {
  var version = 1
  var filename: String
  var mediaType: String
  var sourceDate: String
  var dateSource: String
  var originalBytes: Int
  var originalSha256: String
  var representationKeys: [String: String]
}
struct WrappedKeyV1: Codable, Equatable, Sendable {
  var version = 1
  var nonce: String
  var ciphertext: String
}
struct PhotoManifestV1: Codable, Equatable, Sendable {
  var version = 1
  var photoId: String
  var ownerAccountId: String
  var representations: [RepresentationV1]
  var metadataRepresentation: RepresentationV1
  var ownerWrappedMetadataKey: WrappedKeyV1
}
struct SignedPayloadV1: Codable, Equatable, Sendable {
  var version = 1
  var kind: String
  var accountId: String
  var body: String
  var signature: String
}
struct UploadReservationV1: Codable, Sendable {
  var version: Int
  var uploadId: String
  var photoId: String
  var representationId: String
  var stagingUrl: String
  var expiresAt: String
}
struct UploadCommitV1: Codable, Sendable {
  var version: Int
  var uploadId: String
  var objectId: String
  var ciphertextBytes: Int
  var ciphertextSha256: String
}
struct GrantV1: Codable, Equatable, Sendable {
  var grantId: String
  var momentId: String
  var ownerAccountId: String
  var recipientAccountId: String
  var role: String
  var expiresAt: String?
  var revokedAt: String?
  var version: Int
  enum CodingKeys: String, CodingKey {
    case grantId, momentId, ownerAccountId, recipientAccountId, role, expiresAt, revokedAt, version
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(grantId, forKey: .grantId)
    try c.encode(momentId, forKey: .momentId)
    try c.encode(ownerAccountId, forKey: .ownerAccountId)
    try c.encode(recipientAccountId, forKey: .recipientAccountId)
    try c.encode(role, forKey: .role)
    try c.encode(expiresAt, forKey: .expiresAt)
    try c.encode(revokedAt, forKey: .revokedAt)
    try c.encode(version, forKey: .version)
  }
}
struct ShareKeyEnvelopeV1: Codable, Equatable, Sendable {
  var version = 1
  var grantId: String
  var photoId: String
  var senderAccountId: String
  var recipientAccountId: String
  var sealedMetadataKey: String
  var senderSignature: String
}
struct SavedPhotoV1: Codable, Sendable {
  var version = 1
  var operationId: String
  var photoId: String
  var sourceGrantId: String
  var sourcePhotoId: String
  var manifest: PhotoManifestV1
  var signedPayload: SignedPayloadV1
}
struct SaveRequestV1: Codable, Sendable {
  var version = 1
  var expectedGrantVersion: Int
  var save: SavedPhotoV1
}
struct ChangeV1: Codable, Sendable {
  var cursor: String
  var entity: String
  var entityId: String
  var deleted: Bool
  var payload: SignedPayloadV1?
}
struct ChangePageV1: Codable, Sendable {
  var version: Int
  var changes: [ChangeV1]
  var nextCursor: String?
  var hasMore: Bool
}
struct ReserveUploadV1: Codable, Sendable {
  var version = 1
  var binding: MediaBinding
  var ciphertextBytes: Int
  var ciphertextSha256: String
  var operationId: String
}
struct VaultWrapperV1: Codable, Sendable {
  var version: Int
  var wrapperId: String
  var kind: String
  var credentialId: String?
  var prfSalt: String?
  var wrappedBundle: WrappedKeyV1
  var verified: Bool
  enum CodingKeys: String, CodingKey {
    case version, wrapperId, kind, credentialId, prfSalt, wrappedBundle, verified
  }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(version, forKey: .version)
    try c.encode(wrapperId, forKey: .wrapperId)
    try c.encode(kind, forKey: .kind)
    try c.encode(credentialId, forKey: .credentialId)
    try c.encode(prfSalt, forKey: .prfSalt)
    try c.encode(wrappedBundle, forKey: .wrappedBundle)
    try c.encode(verified, forKey: .verified)
  }
}
struct VaultV1: Codable, Sendable {
  var version: Int
  var accountCard: AccountCardV1
  var wrappers: [VaultWrapperV1]
}
struct SessionV1: Codable, Sendable {
  var version: Int
  var accountId: String
  var deviceId: String
  var expiresAt: String
  var token: String?
}
struct AccountBundle: Codable, Sendable {
  var vaultKey: String
  var boxSecretKey: String
  var signingSecretKey: String
}
struct GrantInboxV1: Codable, Sendable {
  var version: Int
  var grants: [GrantV1]
}
struct GrantDetailV1: Codable, Sendable {
  var version: Int
  var grant: GrantV1
  var envelopes: [ShareKeyEnvelopeV1]
  var manifests: [SignedPayloadV1]
  var cards: [AccountCardV1]
}
struct CreateGrantV1: Codable, Sendable {
  var version = 1
  var grant: GrantV1
  var envelopes: [ShareKeyEnvelopeV1]
  var signedPayload: SignedPayloadV1
}
struct GrantBody: Codable, Sendable {
  var grant: GrantV1
  var envelopes: [ShareKeyEnvelopeV1]
}
struct GrantOptions: Codable, Sendable {
  var version = 1
  var recipientAccountId: String
  var role: String
  var access: String
}
struct ContributionV1: Codable, Sendable {
  var version = 1
  var operationId: String
  var expectedGrantVersion: Int
  var manifests: [SignedPayloadV1]
  var envelopes: [ShareKeyEnvelopeV1]
}
struct ContributionResult: Codable, Sendable {
  var version: Int
  var operationId: String
  var accepted: Int
}
struct FixtureSecrets: Codable, Sendable {
  var accountId: String
  var boxSecretKey: String
  var signingSecretKey: String
  var vaultKey: String
  var recoverySecret: String
  var encryptedBundle: WrappedKeyV1
}
struct FixtureAccounts: Codable, Sendable {
  var version: Int
  var accounts: [AccountCardV1]
  var testSecrets: [FixtureSecrets]
}
struct EmptyBody: Codable, Sendable { var version = 1 }
struct DeviceChallengeV1: Codable, Equatable, Sendable {
  var version: Int
  var deviceId: String
  var boxPublicKey: String
  var origin: String
  var enrollmentId: String
  var accountId: String
  var challenge: String
  var expiresAt: String
  var state: String
}
struct DeviceApprovalBody: Codable, Sendable {
  var challenge: DeviceChallengeV1
  var sealedBundle: String
}

struct PhotoAnnotationsV1: Codable, Equatable, Sendable {
  struct OCR: Codable, Equatable, Sendable {
    var text: String
    var confidence: Double
    var processor: String
  }
  var version = 1
  var photoId: String
  var originalSha256: String
  var labels: [String]?
  var caption: String?
  var keywords: [String]?
  var facts: [String]?
  var favorite: Bool?
  var ocr: OCR?
}
struct PhotoAnnotationsUpdateV1: Codable, Equatable, Sendable {
  var version = 1
  var photoId: String
  var revision: Int
  var encrypted: WrappedKeyV1
}
struct PhotoAnnotationsReplyV1: Codable, Sendable {
  var version: Int
  var annotations: SignedPayloadV1?
}
