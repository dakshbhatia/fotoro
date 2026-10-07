import CryptoKit
import Foundation
import Sodium

struct AlbumMemberV1: Codable, Equatable, Sendable { var card: AccountCardV1; var sealedAlbumKey: String }
struct AlbumDefinitionV1: Codable, Equatable, Sendable {
  var version = 1
  var albumId: String
  var ownerAccountId: String
  var createdAt: String
  var encryptedTitle: WrappedKeyV1
  var members: [AlbumMemberV1]
}
struct AlbumPhotoV1: Codable, Equatable, Sendable {
  var version = 1
  var albumId: String
  var photoId: String
  var ownerAccountId: String
  var wrappedMetadataKey: WrappedKeyV1
}
struct AlbumActionV1: Codable, Sendable { var version = 1; var albumId: String; var definitionSignature: String }
struct CreateAlbumV1: Codable, Sendable { var version = 1; var definition: SignedPayloadV1 }
struct AlbumAppendV1: Codable, Sendable {
  var version = 1; var operationId: String; var entries: [SignedPayloadV1]; var manifests: [SignedPayloadV1]
}
struct AlbumActionRequestV1: Codable, Sendable { var version = 1; var action: SignedPayloadV1 }
struct AlbumAppendResultV1: Codable, Sendable {
  var version: Int; var albumId: String; var operationId: String; var added: Int; var photoCount: Int
}
struct AlbumCapabilitiesV1: Codable, Sendable {
  var version: Int; var albumsVersion: Int; var maxMembers: Int; var maxPhotos: Int; var pageSize: Int
}
struct AlbumOverviewV1: Codable, Equatable, Sendable {
  var definition: SignedPayloadV1; var membership: String; var endedAt: String?; var photoCount: Int
  enum CodingKeys: String, CodingKey { case definition, membership, endedAt, photoCount }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(definition, forKey: .definition); try c.encode(membership, forKey: .membership)
    try c.encode(endedAt, forKey: .endedAt); try c.encode(photoCount, forKey: .photoCount)
  }
}
struct AlbumInboxV1: Codable, Sendable { var version: Int; var albums: [AlbumOverviewV1] }
struct AlbumDetailV1: Codable, Sendable {
  var version: Int; var definition: SignedPayloadV1; var membership: String; var endedAt: String?
  var photoCount: Int; var entries: [SignedPayloadV1]; var manifests: [SignedPayloadV1]
  var nextCursor: String?; var hasMore: Bool
  var overview: AlbumOverviewV1 { AlbumOverviewV1(definition: definition, membership: membership, endedAt: endedAt, photoCount: photoCount) }
  enum CodingKeys: String, CodingKey { case version, definition, membership, endedAt, photoCount, entries, manifests, nextCursor, hasMore }
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(version, forKey: .version); try c.encode(definition, forKey: .definition)
    try c.encode(membership, forKey: .membership); try c.encode(endedAt, forKey: .endedAt)
    try c.encode(photoCount, forKey: .photoCount); try c.encode(entries, forKey: .entries)
    try c.encode(manifests, forKey: .manifests); try c.encode(nextCursor, forKey: .nextCursor)
    try c.encode(hasMore, forKey: .hasMore)
  }
}
struct FotoroAlbumInvitation: Codable, Equatable, Sendable { var version = 1; var albumId: String; var ownerCard: AccountCardV1 }

enum NativeAlbumWire {
  static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
  static func title(_ value: String) throws -> String {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.unicodeScalars.count <= 80,
      !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw FotoroError("Use an album name of 1–80 characters.") }
    return value
  }
  static func date(_ date: Date = Date()) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }
  static func timestamp(_ value: String) -> Bool { Wire.parseDate(value).map { date($0) == value } ?? false }
  static func bytes(_ value: String, _ count: Int) throws { guard try Data(b64: value).count == count else { throw FotoroError("Invalid album key or identity.") } }
  static func wrapped(_ value: WrappedKeyV1, minimum: Int, maximum: Int? = nil) throws {
    try bytes(value.nonce, 24)
    let count = try Data(b64: value.ciphertext).count
    guard value.version == 1, count >= minimum, count <= (maximum ?? minimum) else { throw FotoroError("Invalid album wrapper.") }
  }
  // Compare the complete JSON tree to the decoded schema, rejecting unknown fields at every depth.
  // The bounded scanner also rejects duplicate keys (including differently escaped spellings).
  static func decode<T: Codable>(_ type: T.Type, _ data: Data) throws -> T {
    guard data.count <= 2 * 1024 * 1024 else { throw FotoroError("Album response is too large.") }
    var scanner = AlbumJSONScanner(bytes: Array(data)); try scanner.check()
    let value = try Wire.decode(type, data)
    let original = try JSONSerialization.jsonObject(with: data)
    let encoded = try JSONSerialization.jsonObject(with: Wire.encode(value))
    let a = try JSONSerialization.data(withJSONObject: original, options: [.sortedKeys, .withoutEscapingSlashes])
    let b = try JSONSerialization.data(withJSONObject: encoded, options: [.sortedKeys, .withoutEscapingSlashes])
    guard a == b else { throw FotoroError("Unsupported album fields.") }
    return value
  }
  static func signedBody<T: Codable>(_ type: T.Type, _ signed: SignedPayloadV1, kind: String) throws -> T {
    guard signed.version == 1, signed.kind == kind, uuid(signed.accountId) else { throw FotoroError("Invalid album signature binding.") }
    try bytes(signed.signature, 64)
    let raw = try Data(b64: signed.body)
    guard !raw.isEmpty, raw.count <= 32768 else { throw FotoroError("Invalid album body.") }
    return try decode(type, raw)
  }
  static func definition(_ value: AlbumDefinitionV1) throws {
    guard value.version == 1, uuid(value.albumId), uuid(value.ownerAccountId), timestamp(value.createdAt),
      (2...12).contains(value.members.count), value.members.contains(where: { $0.card.accountId == value.ownerAccountId }) else { throw FotoroError("Invalid album roster.") }
    try wrapped(value.encryptedTitle, minimum: 17, maximum: 336)
    var accounts = Set<String>(), boxes = Set<String>(), signs = Set<String>()
    for member in value.members {
      _ = try FotoroShareLinks.validatePublicAccountCard(member.card); try bytes(member.sealedAlbumKey, 80)
      guard accounts.insert(member.card.accountId).inserted, boxes.insert(member.card.boxPublicKey).inserted,
        signs.insert(member.card.signingPublicKey).inserted else { throw FotoroError("Duplicate album member.") }
    }
  }
  static func overview(_ value: AlbumOverviewV1) throws -> AlbumDefinitionV1 {
    let body = try signedBody(AlbumDefinitionV1.self, value.definition, kind: "album-v1")
    try definition(body)
    guard body.ownerAccountId == value.definition.accountId, ["invited", "accepted"].contains(value.membership),
      (0...1000).contains(value.photoCount), value.endedAt.map(timestamp) ?? true else { throw FotoroError("Invalid album status.") }
    return body
  }
  static func manifest(_ value: PhotoManifestV1) throws {
    guard value.version == 1, uuid(value.photoId), uuid(value.ownerAccountId), (1...3).contains(value.representations.count),
      value.representations.filter({ $0.binding.kind == "original" }).count == 1 else { throw FotoroError("Invalid album photo.") }
    try wrapped(value.ownerWrappedMetadataKey, minimum: 48)
    var ids = Set<String>(), kinds = Set<String>()
    for rep in value.representations + [value.metadataRepresentation] {
      guard rep.binding.version == 1, rep.binding.photoId == value.photoId, uuid(rep.binding.representationId), uuid(rep.objectId),
        ["original", "thumbnail", "preview", "metadata"].contains(rep.binding.kind),
        ids.insert(rep.binding.representationId).inserted, kinds.insert(rep.binding.kind).inserted,
        rep.ciphertextBytes >= 45, rep.ciphertextBytes <= 50 * 1024 * 1024 + 1024 else { throw FotoroError("Invalid album representation.") }
      try bytes(rep.header, 24); try bytes(rep.ciphertextSha256, 32)
    }
    guard value.metadataRepresentation.binding.kind == "metadata", !value.representations.contains(where: { $0.binding.kind == "metadata" }) else { throw FotoroError("Invalid album metadata binding.") }
  }
}

private struct AlbumJSONScanner {
  let bytes: [UInt8]; var i = 0
  mutating func check() throws { try value(depth: 0); space(); guard i == bytes.count else { throw FotoroError("Invalid album JSON.") } }
  mutating func space() { while i < bytes.count && [9,10,13,32].contains(bytes[i]) { i += 1 } }
  mutating func string() throws -> String {
    space(); guard i < bytes.count, bytes[i] == 34 else { throw FotoroError("Invalid album JSON.") }
    let start = i; i += 1
    while i < bytes.count {
      if bytes[i] == 92 { i += 2; continue }
      if bytes[i] == 34 { i += 1; return try JSONDecoder().decode(String.self, from: Data(bytes[start..<i])) }
      i += 1
    }
    throw FotoroError("Invalid album JSON.")
  }
  mutating func value(depth: Int) throws {
    space(); guard depth <= 32, i < bytes.count else { throw FotoroError("Invalid album JSON.") }
    if bytes[i] == 34 { _ = try string(); return }
    if bytes[i] == 123 || bytes[i] == 91 {
      let object = bytes[i] == 123; let end: UInt8 = object ? 125 : 93; i += 1; space()
      if i < bytes.count, bytes[i] == end { i += 1; return }
      var keys = Set<String>()
      while true {
        if object {
          let key = try string(); guard keys.insert(key).inserted else { throw FotoroError("Duplicate album JSON field.") }
          space(); guard i < bytes.count, bytes[i] == 58 else { throw FotoroError("Invalid album JSON.") }; i += 1
        }
        try value(depth: depth + 1); space()
        guard i < bytes.count else { throw FotoroError("Invalid album JSON.") }
        if bytes[i] == end { i += 1; return }
        guard bytes[i] == 44 else { throw FotoroError("Invalid album JSON.") }; i += 1
      }
    }
    let start = i
    while i < bytes.count && ![9,10,13,32,44,93,125].contains(bytes[i]) { i += 1 }
    guard start != i else { throw FotoroError("Invalid album JSON.") }
  }
}

enum NativeAlbumLinks {
  static func make(_ invitation: FotoroAlbumInvitation, origin: String = FotoroShareLinks.origin) throws -> URL {
    guard invitation.version == 1, NativeAlbumWire.uuid(invitation.albumId) else { throw FotoroShareLinkError() }
    // Reuse the existing strict origin and public identity checks; neither pins the owner.
    _ = try FotoroShareLinks.contactURL(invitation.ownerCard, origin: origin)
    let value = origin + "/#album=" + (try Wire.encode(invitation)).b64
    guard value.utf8.count <= FotoroShareLinks.maximumLength, let url = URL(string: value) else { throw FotoroShareLinkError() }
    return url
  }
  static func parse(_ url: URL, origin: String = FotoroShareLinks.origin) throws -> FotoroAlbumInvitation {
    let prefix = origin + "/#album="
    guard url.absoluteString.hasPrefix(prefix), url.absoluteString.utf8.count <= FotoroShareLinks.maximumLength else { throw FotoroShareLinkError() }
    let bytes = try Data(b64: String(url.absoluteString.dropFirst(prefix.count)))
    let value = try NativeAlbumWire.decode(FotoroAlbumInvitation.self, bytes)
    guard try make(value, origin: origin) == url else { throw FotoroShareLinkError() }
    return value
  }
}

struct NativeAlbumCrypto {
  let crypto = CryptoAdapter()
  func make(title: String, owner: AccountCardV1, members: [AccountCardV1], bundle: AccountBundle) throws -> SignedPayloadV1 {
    let key = crypto.randomKey(), name = try NativeAlbumWire.title(title)
    let secret = try Data(b64: bundle.signingSecretKey)
    guard try Curve25519.Signing.PrivateKey(rawRepresentation: secret.prefix(32)).publicKey.rawRepresentation.b64 == owner.signingPublicKey else { throw FotoroError("Album signing identity changed.") }
    let roster = try ([owner] + members).map { card -> AlbumMemberV1 in
      _ = try FotoroShareLinks.validatePublicAccountCard(card)
      guard let sealed = Sodium().box.seal(message: Array(key), recipientPublicKey: Array(try Data(b64: card.boxPublicKey))) else { throw FotoroError("Album encryption failed.") }
      return AlbumMemberV1(card: card, sealedAlbumKey: Data(sealed).b64)
    }
    let value = AlbumDefinitionV1(albumId: Wire.id(), ownerAccountId: owner.accountId, createdAt: NativeAlbumWire.date(), encryptedTitle: try crypto.wrap(Data(name.utf8), key: key), members: roster)
    try NativeAlbumWire.definition(value)
    return try crypto.sign(value, kind: "album-v1", accountId: owner.accountId, secret: secret)
  }
  func open(_ signed: SignedPayloadV1, expectedID: String, trustedOwner: AccountCardV1, recipient: AccountCardV1, bundle: AccountBundle, trusted: [String: AccountCardV1]) throws -> (AlbumDefinitionV1, Data, String) {
    let value = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, signed, kind: "album-v1")
    try NativeAlbumWire.definition(value)
    _ = try crypto.verify(signed, card: trustedOwner, kind: "album-v1")
    guard value.albumId == expectedID, value.ownerAccountId == trustedOwner.accountId,
      value.members.first(where: { $0.card.accountId == trustedOwner.accountId })?.card == trustedOwner,
      let member = value.members.first(where: { $0.card.accountId == recipient.accountId }), member.card == recipient,
      try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: bundle.boxSecretKey)).publicKey.rawRepresentation.b64 == recipient.boxPublicKey else { throw FotoroError("Album invitation identity changed.") }
    for member in value.members {
      if let pinned = trusted[member.card.accountId], pinned != member.card { throw FotoroError("An album member's identity changed. Confirm their new contact link first.") }
    }
    guard let bytes = Sodium().box.open(anonymousCipherText: Array(try Data(b64: member.sealedAlbumKey)), recipientPublicKey: Array(try Data(b64: recipient.boxPublicKey)), recipientSecretKey: Array(try Data(b64: bundle.boxSecretKey))), bytes.count == 32 else { throw FotoroError("Album key could not be opened.") }
    let key = Data(bytes), raw = try crypto.unwrap(value.encryptedTitle, key: key)
    guard let title = String(data: raw, encoding: .utf8) else { throw FotoroError("Invalid album name.") }
    return (value, key, try NativeAlbumWire.title(title))
  }
  func photo(_ signed: SignedPayloadV1, manifestSigned: SignedPayloadV1, definition: AlbumDefinitionV1, key: Data) throws -> (PhotoManifestV1, Data) {
    let value = try NativeAlbumWire.signedBody(AlbumPhotoV1.self, signed, kind: "album-photo-v1")
    guard value.version == 1, value.albumId == definition.albumId, NativeAlbumWire.uuid(value.photoId),
      value.ownerAccountId == signed.accountId, manifestSigned.accountId == signed.accountId,
      let author = definition.members.first(where: { $0.card.accountId == signed.accountId })?.card,
      ["photo-manifest", CameraMedia.mediaManifestKind].contains(manifestSigned.kind) else { throw FotoroError("Album photo owner binding failed.") }
    try NativeAlbumWire.wrapped(value.wrappedMetadataKey, minimum: 48)
    _ = try crypto.verify(signed, card: author, kind: "album-photo-v1")
    let manifest = try NativeAlbumWire.decode(PhotoManifestV1.self, crypto.verify(manifestSigned, card: author, kind: manifestSigned.kind))
    try NativeAlbumWire.manifest(manifest)
    guard manifest.photoId == value.photoId, manifest.ownerAccountId == value.ownerAccountId else { throw FotoroError("Album original binding failed.") }
    let metadataKey = try crypto.unwrap(value.wrappedMetadataKey, key: key)
    guard metadataKey.count == 32 else { throw FotoroError("Invalid album metadata key.") }
    return (manifest, metadataKey)
  }
  func append(_ photo: LocalPhoto, definition: AlbumDefinitionV1, albumKey: Data, card: AccountCardV1, bundle: AccountBundle) throws -> (SignedPayloadV1, SignedPayloadV1) {
    guard photo.manifest.ownerAccountId == card.accountId, definition.members.contains(where: { $0.card == card }), ["saved", "committed"].contains(photo.transferState) else { throw FotoroError("Save your own photo before adding it to an album.") }
    try NativeAlbumWire.manifest(photo.manifest)
    let secret = try Data(b64: bundle.signingSecretKey)
    guard try Curve25519.Signing.PrivateKey(rawRepresentation: secret.prefix(32)).publicKey.rawRepresentation.b64 == card.signingPublicKey else { throw FotoroError("Album signing identity changed.") }
    let metadataKey = try crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey))
    guard metadataKey.count == 32 else { throw FotoroError("Invalid owned photo key.") }
    let entry = AlbumPhotoV1(albumId: definition.albumId, photoId: photo.id, ownerAccountId: card.accountId, wrappedMetadataKey: try crypto.wrap(metadataKey, key: albumKey))
    return (try crypto.sign(entry, kind: "album-photo-v1", accountId: card.accountId, secret: secret), try crypto.sign(photo.manifest, kind: CameraMedia.manifestKind(for: photo.metadata.mediaType), accountId: card.accountId, secret: secret))
  }
  func action(_ definition: SignedPayloadV1, albumId: String, card: AccountCardV1, bundle: AccountBundle, ending: Bool) throws -> SignedPayloadV1 {
    let value = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, definition, kind: "album-v1")
    guard value.albumId == albumId, value.members.contains(where: { $0.card == card }), !ending || value.ownerAccountId == card.accountId else { throw FotoroError("Album action is not available to this account.") }
    let secret = try Data(b64: bundle.signingSecretKey)
    guard try Curve25519.Signing.PrivateKey(rawRepresentation: secret.prefix(32)).publicKey.rawRepresentation.b64 == card.signingPublicKey else { throw FotoroError("Album signing identity changed.") }
    return try crypto.sign(AlbumActionV1(albumId: albumId, definitionSignature: definition.signature), kind: ending ? "album-end-v1" : "album-accept-v1", accountId: card.accountId, secret: secret)
  }
}
