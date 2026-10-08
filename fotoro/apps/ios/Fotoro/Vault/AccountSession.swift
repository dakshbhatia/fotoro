import Foundation
import Observation

@MainActor @Observable final class AccountSession {
  var accountId: String? {
    didSet {
      if Self.ownerKey(accountId) != Self.ownerKey(oldValue) { loadPinnedCards() }
    }
  }
  var bearerToken: String?
  var deviceId: String?
  var fixture = false
  private(set) var expiresAt: Date?
  @ObservationIgnored private let persistSession: (Data) throws -> Void
  @ObservationIgnored private let defaults: UserDefaults
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
    defaults.set(result.accountId, forKey: "fotoro.account")
  }
  func pin(_ card: AccountCardV1) throws {
    guard let key = Self.ownerKey(accountId) else { throw FotoroError("Authenticate before trusting an account card") }
    guard Self.validCard(card) else { throw FotoroError("Invalid account card") }
    var cards = pinnedCards
    cards[card.accountId] = card
    let bytes = try Wire.encode(cards)
    defaults.set(bytes, forKey: key)
    pinnedCards = cards
  }
  private static func validCard(_ card: AccountCardV1) -> Bool {
    guard card.version == 1, UUID(uuidString: card.accountId) != nil,
      (try? Data(b64: card.boxPublicKey).count) == 32, (try? Data(b64: card.signingPublicKey).count) == 32
    else { return false }
    return true
  }
  private static func ownerKey(_ id: String?) -> String? {
    guard let id, let owner = UUID(uuidString: id) else { return nil }
    return "fotoro.pinnedCards.v2." + owner.uuidString.lowercased()
  }
  private func loadPinnedCards() {
    pinnedCards = [:]
    guard let id = accountId, let key = Self.ownerKey(id) else { return }
    if let stored = defaults.object(forKey: key) {
      guard let bytes = stored as? Data,
        let cards = try? Wire.decode([String: AccountCardV1].self, bytes),
        cards.allSatisfy({ $0.key == $0.value.accountId && Self.validCard($0.value) })
      else { return }
      pinnedCards = cards
      return
    }
    // Legacy contacts have no owner binding. Keep only the owner's verification card;
    // local vault unlock independently checks its public keys against the private bundle.
    if let bytes = defaults.data(forKey: "fotoro.pinnedCards"),
      let legacy = try? Wire.decode([String: AccountCardV1].self, bytes),
      let own = legacy[id], own.accountId == id, Self.validCard(own)
    {
      pinnedCards = [id: own]
    }
  }
  init(loadSession: () throws -> Data = { try Keychain.read("session") },
    persistSession: @escaping (Data) throws -> Void = { try Keychain.write($0, id: "session") },
    defaults: UserDefaults = .standard) {
    self.persistSession = persistSession
    self.defaults = defaults
    #if DEBUG
      accountId = defaults.string(forKey: "fotoro.fixtureAccount")
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
    loadPinnedCards()
  }
  func requireCard(_ id: String) throws -> AccountCardV1 {
    guard Self.ownerKey(accountId) != nil, let card = pinnedCards[id] else {
      throw FotoroError("Pin this person's authentic account card before receiving photos")
    }
    return card
  }
}
