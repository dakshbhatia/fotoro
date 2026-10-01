import Foundation
import Observation

@MainActor @Observable final class AccountSession {
  var accountId: String?
  var bearerToken: String?
  var deviceId: String?
  var fixture = false
  var pinnedCards: [String: AccountCardV1] = [:]
  func pin(_ card: AccountCardV1) throws {
    guard card.version == 1, UUID(uuidString: card.accountId) != nil,
      try Data(b64: card.boxPublicKey).count == 32, try Data(b64: card.signingPublicKey).count == 32
    else { throw FotoroError("Invalid account card") }
    pinnedCards[card.accountId] = card
    UserDefaults.standard.set(try Wire.encode(pinnedCards), forKey: "fotoro.pinnedCards")
  }
  init() {
    #if DEBUG
      accountId = UserDefaults.standard.string(forKey: "fotoro.fixtureAccount")
      fixture = accountId != nil
    #endif
    if let bytes = try? Keychain.read("session"),
      let saved = try? Wire.decode(SessionV1.self, bytes)
    {
      accountId = saved.accountId
      bearerToken = saved.token
      deviceId = saved.deviceId
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
