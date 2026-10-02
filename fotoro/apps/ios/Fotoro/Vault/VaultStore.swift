import CryptoKit
import Foundation
import Observation
import Security
import Sodium

enum UnlockMethod {
  case recoveryEnvelope(secret: Data, wrapper: WrappedKeyV1)
  case localKeychain
  case recovery(Data)
  case prf(output: Data, wrapper: WrappedKeyV1)
  case trustedDevice(
    challenge: DeviceChallengeV1, expected: DeviceChallengeV1, sealedBundle: String,
    signedPayload: SignedPayloadV1, deviceSecret: Data)
}
@MainActor @Observable final class VaultStore {
  private(set) var generation = UUID()
  private(set) var bundle: AccountBundle?
  var isUnlocked: Bool { bundle != nil }
  var canUnlockLocally: Bool {
    guard let id = session.accountId else { return false }
    return Keychain.contains(id)
  }
  private let session: AccountSession
  private let api: APIClient
  private let crypto = CryptoAdapter()
  private let storeBundle: @MainActor (Data, String) throws -> Void
  var onLock: (() -> Void)?
  init(session: AccountSession, api: APIClient,
    storeBundle: (@MainActor (Data, String) throws -> Void)? = nil) {
    self.session = session
    self.api = api
    self.storeBundle = storeBundle ?? { bytes, id in try Keychain.write(bytes, id: id) }
  }
  func unlock(_ method: UnlockMethod) async throws {
    guard let id = session.accountId else { throw FotoroError("Authenticate before unlocking") }
    let unlockingGeneration = generation
    var bytes: Data
    switch method {
    case .recoveryEnvelope(let secret, let wrapper): bytes = try crypto.unwrap(wrapper, key: secret)
    case .localKeychain: bytes = try Keychain.read(id)
    case .recovery(let secret):
      let vault: VaultV1 = try await api.get("/v1/vault")
      guard vault.version == 1, vault.accountCard.accountId == id,
        let recovery = vault.wrappers.first(where: { $0.kind == "recovery" && $0.verified })
      else { throw FotoroError("No verified recovery wrapper") }
      bytes = try crypto.unwrap(recovery.wrappedBundle, key: secret)
    case .prf(let output, let wrapper):
      guard output.count == 32 else {
        throw FotoroError("Passkey PRF unavailable: use recovery or a trusted device")
      }
      bytes = try crypto.unwrap(wrapper, key: output)
    case .trustedDevice(let challenge, let expected, let sealed, let signed, let secret):
      guard challenge == expected, challenge.accountId == id, challenge.state == "pending",
        challenge.origin == api.origin,
        let expiry = Wire.parseDate(challenge.expiresAt), expiry > Date()
      else { throw FotoroError("Device approval binding or expiry failed") }
      let card = try session.requireCard(signed.accountId)
      guard card.accountId == id else { throw FotoroError("Device approval account mismatch") }
      let verified = try Wire.decode(
        DeviceApprovalBody.self, crypto.verify(signed, card: card, kind: "device-approval"))
      let pk = try Data(b64: challenge.boxPublicKey)
      let ciphertext = try Data(b64: sealed)
      guard verified.challenge == expected, verified.sealedBundle == sealed, secret.count == 32,
        pk.count == 32, ciphertext.count >= 48,
        let plain = Sodium().box.open(
          anonymousCipherText: Array(ciphertext), recipientPublicKey: Array(pk),
          recipientSecretKey: Array(secret))
      else { throw FotoroError("Device bundle authentication failed") }
      bytes = Data(plain)
    }
    let candidate = try Wire.decode(AccountBundle.self, bytes)
    guard try Data(b64: candidate.vaultKey).count == 32,
      try Data(b64: candidate.boxSecretKey).count == 32,
      try Data(b64: candidate.signingSecretKey).count == 64
    else { throw FotoroError("Invalid account bundle") }
    // Verify recovered private keys against the account card before enrolling this device.
    let card = try session.requireCard(id)
    let proof = try crypto.signBytes(
      Data("fotoro-unlock-check".utf8), kind: "unlock", accountId: id,
      secret: Data(b64: candidate.signingSecretKey))
    _ = try crypto.verify(proof, card: card, kind: "unlock")
    guard
      try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: candidate.boxSecretKey))
        .publicKey.rawRepresentation.b64 == card.boxPublicKey
    else { throw FotoroError("Recovered box identity mismatch") }
    try Task.checkCancellation()
    guard session.accountId == id, generation == unlockingGeneration else {
      throw CancellationError()
    }
    try storeBundle(bytes, id)
    generation = UUID()
    bundle = candidate
  }
  func recover(secret: Data) async throws { try await unlock(.recovery(secret)) }
  func lock() {
    generation = UUID()
    bundle = nil
    onLock?()
  }
  func signOut() throws {
    if let id = session.accountId {
      Keychain.remove(id)
      Keychain.remove("password-" + id)
    }
    lock()
    session.accountId = nil
    session.bearerToken = nil
  }
  func requireBundle() throws -> AccountBundle {
    guard let bundle else { throw FotoroError("Unlock your vault first") }
    return bundle
  }
}
enum Keychain {
  private static func query(_ id: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "cloud.fotoro.bundle", kSecAttrAccount as String: id,
    ]
  }
  static func write(_ bytes: Data, id: String) throws {
    let attributes: [String: Any] = [
      kSecValueData as String: bytes,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query(id) as CFDictionary, attributes as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else {
      throw FotoroError("Cannot enroll protected local access")
    }
    var q = query(id)
    q[kSecValueData as String] = bytes
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
      throw FotoroError("Cannot enroll protected local access")
    }
  }
  static func contains(_ id: String) -> Bool {
    SecItemCopyMatching(query(id) as CFDictionary, nil) == errSecSuccess
  }
  static func read(_ id: String) throws -> Data {
    var q = query(id)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let bytes = result as? Data
    else {
      throw FotoroError("This device is not enrolled: use recovery or trusted-device approval")
    }
    return bytes
  }
  static func remove(_ id: String) { SecItemDelete(query(id) as CFDictionary) }
}
