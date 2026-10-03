import Foundation

struct FotoroMomentInvitation: Codable, Equatable, Sendable {
  var version = 1
  var grantId: String
  var senderCard: AccountCardV1
}

enum FotoroShareLink: Equatable, Sendable {
  case contact(AccountCardV1)
  case moment(FotoroMomentInvitation)
}

struct FotoroShareLinkError: Error, LocalizedError {
  var errorDescription: String? { "This Fotoro link is invalid or belongs to another service." }
}

enum FotoroShareLinks {
  static let origin = "https://fotoro.cloud"
  static let maximumLength = 2048

  private static func canonicalUUID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
  }
  private static func encoded(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  private static func decoded(_ value: String) throws -> Data {
    guard !value.isEmpty, value.utf8.count <= maximumLength,
      value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
      value.utf8.count % 4 != 1 else { throw FotoroShareLinkError() }
    let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      + String(repeating: "=", count: (4 - value.utf8.count % 4) % 4)
    guard let bytes = Data(base64Encoded: standard), encoded(bytes) == value else { throw FotoroShareLinkError() }
    return bytes
  }
  // Public identity validation never pins or trusts the card.
  static func validatePublicAccountCard(_ card: AccountCardV1) throws -> AccountCardV1 {
    guard card.version == 1, canonicalUUID(card.accountId), card.boxPublicKey.utf8.count == 43,
      card.signingPublicKey.utf8.count == 43, try decoded(card.boxPublicKey).count == 32,
      try decoded(card.signingPublicKey).count == 32 else { throw FotoroShareLinkError() }
    return card
  }
  private static func checkedOrigin(_ value: String) throws -> String {
    guard let components = URLComponents(string: value), let host = components.host,
      !host.isEmpty, components.user == nil, components.password == nil, components.path.isEmpty,
      components.query == nil, components.fragment == nil, components.url?.absoluteString == value,
      host == host.lowercased(), !host.hasSuffix("."),
      components.scheme == "https" || (components.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host))
    else { throw FotoroShareLinkError() }
    let namedHost = host.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", options: .regularExpression) != nil
      && host.split(separator: ".").last?.contains(where: { $0 >= "a" && $0 <= "z" }) == true
    let authorityHost = host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host
    let normalized = (components.scheme ?? "") + "://" + authorityHost + (components.port.map { ":" + String($0) } ?? "")
    guard namedHost || ["127.0.0.1", "::1", "[::1]"].contains(host), value == normalized,
      components.port.map({ (1...65535).contains($0) }) ?? true
    else { throw FotoroShareLinkError() }
    if (components.scheme == "https" && components.port == 443) || (components.scheme == "http" && components.port == 80) {
      throw FotoroShareLinkError()
    }
    return value
  }
  private static func canonical<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
  }
  private static func make<T: Encodable>(_ kind: String, _ value: T, origin: String) throws -> URL {
    let result = try checkedOrigin(origin) + "/#" + kind + "=" + encoded(canonical(value))
    guard result.utf8.count <= maximumLength, let url = URL(string: result) else { throw FotoroShareLinkError() }
    return url
  }
  static func contactURL(_ card: AccountCardV1, origin: String = FotoroShareLinks.origin) throws -> URL {
    try make("contact", validatePublicAccountCard(card), origin: origin)
  }
  static func momentURL(grantId: String, senderCard: AccountCardV1, origin: String = FotoroShareLinks.origin) throws -> URL {
    guard canonicalUUID(grantId) else { throw FotoroShareLinkError() }
    return try make("moment", FotoroMomentInvitation(grantId: grantId, senderCard: validatePublicAccountCard(senderCard)), origin: origin)
  }
  static func parse(_ url: URL, expectedOrigin: String = FotoroShareLinks.origin) throws -> FotoroShareLink {
    try parse(url.absoluteString, expectedOrigin: expectedOrigin)
  }
  // Reencoding rejects unknown fields, duplicate JSON keys and noncanonical JSON/base64url.
  static func parse(_ value: String, expectedOrigin: String = FotoroShareLinks.origin) throws -> FotoroShareLink {
    let prefix = try checkedOrigin(expectedOrigin) + "/#"
    guard value.utf8.count <= maximumLength, value.hasPrefix(prefix) else { throw FotoroShareLinkError() }
    let fragment = String(value.dropFirst(prefix.count))
    let parts = fragment.split(separator: "=", omittingEmptySubsequences: false)
    guard parts.count == 2 else { throw FotoroShareLinkError() }
    let bytes = try decoded(String(parts[1]))
    do {
      switch parts[0] {
      case "contact":
        let card = try validatePublicAccountCard(JSONDecoder().decode(AccountCardV1.self, from: bytes))
        guard try canonical(card) == bytes else { throw FotoroShareLinkError() }
        return .contact(card)
      case "moment":
        let invitation = try JSONDecoder().decode(FotoroMomentInvitation.self, from: bytes)
        guard invitation.version == 1, canonicalUUID(invitation.grantId) else { throw FotoroShareLinkError() }
        _ = try validatePublicAccountCard(invitation.senderCard)
        guard try canonical(invitation) == bytes else { throw FotoroShareLinkError() }
        return .moment(invitation)
      default: throw FotoroShareLinkError()
      }
    } catch { throw FotoroShareLinkError() }
  }
}
