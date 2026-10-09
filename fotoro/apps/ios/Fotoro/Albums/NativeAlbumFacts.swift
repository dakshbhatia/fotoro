import Foundation

struct AlbumFactsCapabilitiesV1: Codable { var version: Int; var albumFactsVersion: Int }
struct AlbumPhotoFactsV1: Codable, Equatable, Sendable {
  var version = 1
  var albumId: String
  var photoId: String
  var ownerAccountId: String
  var definitionSignature: String
  var revision: Int
  var encrypted: WrappedKeyV1
}
struct AlbumPhotoFactsContentV1: Codable, Equatable, Sendable {
  var version = 1
  var albumId: String
  var photoId: String
  var ownerAccountId: String
  var definitionSignature: String
  var revision: Int
  var originalSha256: String
  var people: [String]
  var location: PhotoLocationV1?
}
struct AlbumPhotoFactsRequestV1: Codable { var version = 1; var facts: SignedPayloadV1 }
struct AlbumPhotoFactsReplyV1: Codable {
  var version: Int
  var facts: SignedPayloadV1?
  enum CodingKeys: String, CodingKey { case version, facts }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(version, forKey: .version)
    if let facts { try values.encode(facts, forKey: .facts) } else { try values.encodeNil(forKey: .facts) }
  }
}
struct AlbumPhotoFactsPageV1: Codable {
  var version: Int
  var facts: [SignedPayloadV1]
  var nextCursor: String?
  var hasMore: Bool
  enum CodingKeys: String, CodingKey { case version, facts, nextCursor, hasMore }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(version, forKey: .version); try values.encode(facts, forKey: .facts)
    try values.encode(hasMore, forKey: .hasMore)
    if let nextCursor { try values.encode(nextCursor, forKey: .nextCursor) } else { try values.encodeNil(forKey: .nextCursor) }
  }
}

enum NativeAlbumFacts {
  static let kind = "album-photo-facts-v1"
  static func validate(_ value: AlbumPhotoFactsContentV1) throws {
    guard value.version == 1, NativeAlbumWire.uuid(value.albumId), NativeAlbumWire.uuid(value.photoId),
      NativeAlbumWire.uuid(value.ownerAccountId), (1...2147483647).contains(value.revision),
      value.people.count <= 12, Set(value.people.map { Data($0.utf8) }).count == value.people.count,
      value.people.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.unicodeScalars.count <= 80
        && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }),
      value.location?.isValid ?? true else { throw FotoroError("Invalid shared photo details.") }
    try NativeAlbumWire.bytes(value.definitionSignature, 64)
    try NativeAlbumWire.bytes(value.originalSha256, 32)
    guard try Data(b64: value.originalSha256).b64 == value.originalSha256 else { throw FotoroError("Invalid shared original digest.") }
  }
  static func read(_ signed: SignedPayloadV1, item: NativeAlbumItem, access: NativeAlbumAccess) throws -> AlbumPhotoFactsContentV1 {
    try validateItem(item, access: access)
    let value = try readEnvelope(signed, access: access)
    try bind(value, to: item)
    return value
  }
  private static func validateItem(_ item: NativeAlbumItem, access: NativeAlbumAccess) throws {
    let (manifest, _) = try NativeAlbumCrypto().photo(item.entry, manifestSigned: item.signedManifest,
      definition: access.definition, key: access.key)
    guard manifest == item.photo.manifest, manifest.photoId == item.id else { throw FotoroError("Shared details have another photo source.") }
  }
  static func bind(_ value: AlbumPhotoFactsContentV1, to item: NativeAlbumItem) throws {
    guard value.photoId == item.id, value.ownerAccountId == item.photo.manifest.ownerAccountId,
      value.originalSha256 == item.photo.metadata.originalSha256 else { throw FotoroError("Shared details do not match this original.") }
  }
  static func readEnvelope(_ signed: SignedPayloadV1, access: NativeAlbumAccess) throws -> AlbumPhotoFactsContentV1 {
    guard let contributor = access.definition.members.first(where: { $0.card.accountId == signed.accountId })?.card
    else { throw FotoroError("Shared details have another contributor.") }
    let crypto = CryptoAdapter()
    let outer = try NativeAlbumWire.decode(AlbumPhotoFactsV1.self, crypto.verify(signed, card: contributor, kind: kind))
    guard outer.version == 1, outer.albumId == access.albumID,
      outer.ownerAccountId == contributor.accountId, outer.definitionSignature == access.signedDefinition.signature,
      (1...2147483647).contains(outer.revision) else { throw FotoroError("Shared photo details changed context.") }
    try NativeAlbumWire.wrapped(outer.encrypted, minimum: 17, maximum: 8192)
    let value = try NativeAlbumWire.decode(AlbumPhotoFactsContentV1.self, crypto.unwrap(outer.encrypted, key: access.key))
    try validate(value)
    guard value.albumId == outer.albumId, value.photoId == outer.photoId, value.ownerAccountId == outer.ownerAccountId,
      value.definitionSignature == outer.definitionSignature, value.revision == outer.revision else { throw FotoroError("Shared details changed encrypted context.") }
    return value
  }
  static func make(item: NativeAlbumItem, access: NativeAlbumAccess, people: [String], location: PhotoLocationV1?,
    revision: Int, card: AccountCardV1, bundle: AccountBundle) throws -> SignedPayloadV1 {
    try validateItem(item, access: access)
    guard card.accountId == item.photo.manifest.ownerAccountId, card.accountId == access.context.photo.account,
      access.definition.members.contains(where: { $0.card == card }) else { throw FotoroError("Only the contributor can share photo details.") }
    let value = AlbumPhotoFactsContentV1(albumId: access.albumID, photoId: item.id, ownerAccountId: card.accountId,
      definitionSignature: access.signedDefinition.signature, revision: revision, originalSha256: item.photo.metadata.originalSha256,
      people: people, location: location)
    try validate(value)
    let crypto = CryptoAdapter()
    let outer = AlbumPhotoFactsV1(albumId: value.albumId, photoId: value.photoId, ownerAccountId: value.ownerAccountId,
      definitionSignature: value.definitionSignature, revision: value.revision, encrypted: try crypto.wrap(Wire.encode(value), key: access.key))
    try NativeAlbumWire.wrapped(outer.encrypted, minimum: 17, maximum: 8192)
    let signed = try crypto.sign(outer, kind: kind, accountId: card.accountId, secret: Data(b64: bundle.signingSecretKey))
    _ = try crypto.verify(signed, card: card, kind: kind)
    return signed
  }
}

struct NativeAlbumFactsReview: Identifiable {
  let id = UUID()
  let item: NativeAlbumItem
  let context: NativeAlbumContext
  let source: LocalPhoto
  let annotation: PhotoAnnotationsV1
  let revision: Int
  let people: [String]
  let location: PhotoLocationV1?
  let shared: AlbumPhotoFactsContentV1?
}

struct NativeAlbumFactsSelection {
  let people: [String]
  let includeLocation: Bool
  let unavailableSharedDetails: Bool

  init(people available: [String], location: PhotoLocationV1?, shared: AlbumPhotoFactsContentV1?) {
    let currentNames = Set(available.map { Data($0.utf8) })
    people = (shared?.people ?? []).filter { currentNames.contains(Data($0.utf8)) }
    if let previous = shared?.location, let location {
      includeLocation = previous.latitude == location.latitude && previous.longitude == location.longitude
        && previous.source == location.source && previous.accuracyMeters == location.accuracyMeters
        && previous.name.map { Data($0.utf8) } == location.name.map { Data($0.utf8) }
    } else { includeLocation = false }
    unavailableSharedDetails = people.count != (shared?.people.count ?? 0)
      || (shared?.location != nil && !includeLocation)
  }
}
