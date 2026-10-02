import Foundation
import Observation

@MainActor @Observable final class AccountSession {
  var accountId: String?
  var bearerToken: String?
  var deviceId: String?
  var fixture = false
  private(set) var expiresAt: Date?
  @ObservationIgnored private let persistSession: (Data) throws -> Void
  var pinnedCards: [String: AccountCardV1] = [:]
  var isSignedIn: Bool {
    guard let accountId, UUID(uuidString: accountId) != nil else { return false }
    if fixture { return true }
    guard let bearerToken, !bearerToken.isEmpty else { return false }
    return expiresAt.map { $0 > Date() } ?? true
  }
  var accountReference: String? {
    guard let accountId, let id = UUID(uuidString: accountId) else { return nil }
    let reference = id.uuidString.lowercased()
    return String(reference.prefix(8)) + "…" + String(reference.suffix(4))
  }
  private static func expiry(_ saved: SessionV1) throws -> Date {
    guard saved.version == 1, UUID(uuidString: saved.accountId) != nil,
      UUID(uuidString: saved.deviceId) != nil, let token = saved.token, !token.isEmpty,
      let expiry = Wire.parseDate(saved.expiresAt)
    else { throw FotoroError("Invalid native session") }
    return expiry
  }
  func accept(_ result: SessionV1) throws {
    let expiry = try Self.expiry(result)
    guard expiry > Date() else { throw FotoroError("Native session expired") }
    // Do not change the active account until its replacement is safely persisted.
    try persistSession(Wire.encode(result))
    accountId = result.accountId
    bearerToken = result.token
    deviceId = result.deviceId
    expiresAt = expiry
    fixture = false
    UserDefaults.standard.set(result.accountId, forKey: "fotoro.account")
  }
  func pin(_ card: AccountCardV1) throws {
    guard card.version == 1, UUID(uuidString: card.accountId) != nil,
      try Data(b64: card.boxPublicKey).count == 32, try Data(b64: card.signingPublicKey).count == 32
    else { throw FotoroError("Invalid account card") }
    pinnedCards[card.accountId] = card
    UserDefaults.standard.set(try Wire.encode(pinnedCards), forKey: "fotoro.pinnedCards")
  }
  init(loadSession: () throws -> Data = { try Keychain.read("session") },
    persistSession: @escaping (Data) throws -> Void = { try Keychain.write($0, id: "session") }) {
    self.persistSession = persistSession
    #if DEBUG
      accountId = UserDefaults.standard.string(forKey: "fotoro.fixtureAccount")
      fixture = accountId != nil
    #endif
    if let bytes = try? loadSession(), let saved = try? Wire.decode(SessionV1.self, bytes),
      let expiry = try? Self.expiry(saved)
    {
      accountId = saved.accountId
      bearerToken = expiry > Date() ? saved.token : nil
      deviceId = saved.deviceId
      expiresAt = expiry
      fixture = false
    }
    if let bytes = UserDefaults.standard.data(forKey: "fotoro.pinnedCards"),
      let cards = try? Wire.decode([String: AccountCardV1].self, bytes)
    {
      pinnedCards = cards
    }
  }
  func requireCard(_ id: String) throws -> AccountCardV1 {
    guard let card = pinnedCards[id] else {
      throw FotoroError("Pin this person's authentic account card before receiving photos")
    }
    return card
  }
}
