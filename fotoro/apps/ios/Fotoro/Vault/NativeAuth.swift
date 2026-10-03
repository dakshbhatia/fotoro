import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import Sodium
import UIKit

struct RecoveryCode {
  let accountId: String
  let secret: Data
  init(_ code: String) throws {
    let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("foto_") {
      let bytes = try Data(b64: String(value.dropFirst(5)))
      guard bytes.count == 48 else { throw FotoroError("Check your Fotoro password and try again.") }
      let id = Array(bytes.prefix(16))
      accountId = UUID(uuid: (id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7],
        id[8], id[9], id[10], id[11], id[12], id[13], id[14], id[15])).uuidString.lowercased()
      secret = Data(bytes.suffix(32))
      return
    }
    let parts = value.split(
      separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0] == "fotoro1", let id = UUID(uuidString: String(parts[1])) else {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    accountId = id.uuidString.lowercased()
    secret = try Data(b64: String(parts[2]))
    guard secret.count == 32 else { throw FotoroError("Check your Fotoro password and try again.") }
  }
  static func format(accountId: String, secret: Data) throws -> String {
    guard let id = UUID(uuidString: accountId), secret.count == 32 else {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    var bytes = id.uuid
    var payload = withUnsafeBytes(of: &bytes) { Data($0) }
    payload.append(secret)
    return "foto_" + payload.b64
  }
}
struct StartOptionsRequest: Codable {
  var version = 1
  var client = "native"
}
struct StartOptionsResponse: Codable {
  var version: Int
  var accountId: String
  var challengeId: String
  var challenge: String
  var expiresAt: String
}
struct StartVerify: Codable {
  var version = 1
  var challengeId: String
  var client = "native"
  var enrollment: Enrollment
  var signedPayload: SignedPayloadV1
}
private struct PendingStartAccount {
  var options: StartOptionsResponse
  var card: AccountCardV1
  var bundle: AccountBundle
  var secret: Data
  var wrapper: VaultWrapperV1
  var password: String
  var previousAccount: String?
  var generation: UUID
  var origin: String
  var attempted = false
  var verified = false
}
struct AuthOptionsRequest: Codable {
  var version = 1
  var client = "native"
  var accountId: String?
}
struct RecoveryOptionsResponse: Codable {
  var version: Int
  var challengeId: String
  var challenge: String
  var expiresAt: String
  var vault: VaultV1
}
struct RecoveryProof: Codable {
  var version = 1
  var challengeId: String
  var challenge: String
  var accountId: String
  var client = "native"
  var origin: String
}
struct RecoveryVerify: Codable {
  var version = 1
  var challengeId: String
  var signedPayload: SignedPayloadV1
  var client = "native"
}
struct EnrollmentProof: Codable {
  var accountCard: AccountCardV1
  var recoveryWrapper: VaultWrapperV1
}
struct Enrollment: Codable {
  var version = 1
  var accountCard: AccountCardV1
  var recoveryWrapper: VaultWrapperV1
  var proof: SignedPayloadV1
}
struct PendingEnrollment {
  var challengeId: String
  var challenge: Data
  var userID: Data
  var card: AccountCardV1
  var bundle: AccountBundle
  var recovery: Data
  var wrapper: VaultWrapperV1
  var salt: Data
}
struct CredentialResult {
  var response: Data
  var credentialId: String
  var prf: Data?
}
enum NativeSignInOutcome: Equatable, Sendable {
  case unlocked, recoveryRequired
}
struct NativePasskeyError: LocalizedError {
  let code: ASAuthorizationError.Code
  var isCancelled: Bool { code == .canceled }
  var errorDescription: String? {
    switch code {
    case .canceled:
      return "Passkey sign-in was cancelled."
    case .failed, .notHandled:
      return "Passkey sign-in could not finish. Enter your Fotoro password, or tap New Fotoro to start."
    default:
      return "Passkey sign-in could not finish. Try again or enter your Fotoro password."
    }
  }
}
typealias NativeCredentialCeremony = @MainActor (ASAuthorizationRequest) async throws -> CredentialResult

@MainActor
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private var continuation: CheckedContinuation<CredentialResult, Error>?
  private var controller: ASAuthorizationController?
  func perform(_ request: ASAuthorizationRequest) async throws -> CredentialResult {
    guard continuation == nil else { throw FotoroError("A passkey request is already active") }
    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let controller = ASAuthorizationController(authorizationRequests: [request])
      self.controller = controller
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    }
  }
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
      .first(where: { $0.isKeyWindow }) ?? UIWindow()
  }
  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    do {
      let response: [String: Any]
      let credentialId: String
      let prf: Data?
      if let registration = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialRegistration
      {
        guard let attestation = registration.rawAttestationObject else {
          throw FotoroError("Passkey attestation unavailable")
        }
        credentialId = registration.credentialID.b64
        prf = registration.prf?.first.map { $0.withUnsafeBytes { Data($0) } }
        response = [
          "id": credentialId, "rawId": credentialId, "type": "public-key",
          "authenticatorAttachment": "platform", "clientExtensionResults": [:],
          "response": [
            "clientDataJSON": registration.rawClientDataJSON.b64,
            "attestationObject": attestation.b64, "transports": ["internal"],
          ],
        ]
      } else if let assertion = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialAssertion
      {
        credentialId = assertion.credentialID.b64
        prf = assertion.prf?.first.withUnsafeBytes { Data($0) }
        response = [
          "id": credentialId, "rawId": credentialId, "type": "public-key",
          "authenticatorAttachment": "platform", "clientExtensionResults": [:],
          "response": [
            "clientDataJSON": assertion.rawClientDataJSON.b64,
            "authenticatorData": assertion.rawAuthenticatorData.b64,
            "signature": assertion.signature.b64, "userHandle": assertion.userID.b64,
          ],
        ]
      } else {
        throw FotoroError("Unexpected passkey credential")
      }
      continuation?.resume(
        returning: CredentialResult(
          response: try JSONSerialization.data(withJSONObject: response),
          credentialId: credentialId, prf: prf))
    } catch { continuation?.resume(throwing: error) }
    continuation = nil
    self.controller = nil
  }
  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    continuation?.resume(throwing: error)
    continuation = nil
    self.controller = nil
  }
}

@MainActor @Observable final class NativeAuth {
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  private let crypto = CryptoAdapter()
  private let credentialCeremony: NativeCredentialCeremony
  private let rememberPassword: @MainActor (Data, String) throws -> Void
  private var pendingStart: PendingStartAccount?
  @ObservationIgnored private var startOperation: UUID?
  var pending: PendingEnrollment?
  var recoveryCode: String? { pending.map { "fotoro1.\($0.card.accountId).\($0.recovery.b64)" } }
  var startPassword: String? { pendingStart?.password }
  private(set) var isOpeningRememberedAccount = false
  var hasRememberedPassword: Bool {
    guard !session.fixture, let account = session.accountId else { return false }
    return (try? rememberedPassword(for: account)) != nil
  }
  var hasSavedPassword: Bool {
    guard session.isSignedIn, let account = session.accountId else { return false }
    return Keychain.contains("password-" + account)
  }
  var fallbackMessage: String?
  var needsRecovery: Bool { session.isSignedIn && !vault.isUnlocked && !vault.canUnlockLocally }
  init(session: AccountSession, api: APIClient, vault: VaultStore,
    credentialCeremony: NativeCredentialCeremony? = nil,
    rememberPassword: (@MainActor (Data, String) throws -> Void)? = nil) {
    self.session = session
    self.api = api
    self.vault = vault
    let ceremony = PasskeyCeremony()
    self.credentialCeremony = credentialCeremony ?? { request in
      try await ceremony.perform(request)
    }
    self.rememberPassword = rememberPassword ?? { bytes, id in try Keychain.write(bytes, id: id) }
  }
  private func performCredential(_ request: ASAuthorizationRequest) async throws -> CredentialResult {
    do { return try await credentialCeremony(request) }
    catch let error as ASAuthorizationError { throw NativePasskeyError(code: error.code) }
  }
  private func checkAuthentication(account: String?, generation: UUID) throws {
    try Task.checkCancellation()
    guard session.accountId == account, vault.generation == generation else { throw CancellationError() }
  }
  private func options(_ path: String, accountId: String? = nil) async throws -> [String: Any] {
    let bytes = try await api.request(
      path, method: "POST", body: Wire.encode(AuthOptionsRequest(accountId: accountId)))
    guard let json = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      json["version"] as? Int == 1
    else { throw FotoroError("Invalid authentication options") }
    return json
  }
  private func accept(_ result: SessionV1, preservingStart: Bool = false) throws {
    let previousAccount = session.accountId
    try session.accept(result)
    if previousAccount != result.accountId {
      let operation = preservingStart ? startOperation : nil
      vault.lock()
      if preservingStart { startOperation = operation }
    }
  }
  private func applyAllowedCredentials(_ options: [String: Any], to request: ASAuthorizationPlatformPublicKeyCredentialAssertionRequest) throws {
    guard let value = options["allowCredentials"] else { return }
    guard let credentials = value as? [[String: Any]] else { throw FotoroError("Invalid sign-in credentials") }
    guard !credentials.isEmpty || session.accountId == nil else {
      throw FotoroError("This account has no passkey. Enter your Fotoro password.")
    }
    request.allowedCredentials = try credentials.map { credential in
      guard credential["type"] as? String == "public-key", let id = credential["id"] as? String else {
        throw FotoroError("Invalid sign-in credential")
      }
      let bytes = try Data(b64: id)
      guard !bytes.isEmpty else { throw FotoroError("Invalid sign-in credential") }
      return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: bytes)
    }
  }
  func cancelStart() {
    pendingStart = nil
    startOperation = nil
  }
  func savedPassword() throws -> String {
    guard session.isSignedIn, let account = session.accountId else { throw FotoroError("Sign in to see your Fotoro password.") }
    return try rememberedPassword(for: account)
  }
  private func rememberedPassword(for account: String) throws -> String {
    guard let bytes = try? Keychain.read("password-" + account),
      let value = String(data: bytes, encoding: .utf8), let code = try? RecoveryCode(value),
      code.accountId == account
    else { throw FotoroError("This iPhone hasn't saved a Fotoro password yet.") }
    return try RecoveryCode.format(accountId: account, secret: code.secret)
  }
  func openRememberedAccount() async throws -> UUID {
    try Task.checkCancellation()
    guard !session.fixture, let account = session.accountId else {
      throw FotoroError("Enter your Fotoro password to sign in.")
    }
    guard !isOpeningRememberedAccount else { throw FotoroError("Your Fotoro is already opening.") }
    let generation = vault.generation, origin = api.origin, server = api.baseURL
    isOpeningRememberedAccount = true
    defer { isOpeningRememberedAccount = false }
    do {
      if session.isSignedIn {
        if !vault.isUnlocked {
          if vault.canUnlockLocally { try await vault.unlock(.localKeychain) }
          else { try await recover(rememberedPassword(for: account)) }
        }
      } else {
        try await recover(rememberedPassword(for: account))
      }
      try Task.checkCancellation()
      guard session.accountId == account, session.isSignedIn, vault.isUnlocked,
        api.origin == origin, api.baseURL == server else {
        throw CancellationError()
      }
      fallbackMessage = nil
      return vault.generation
    } catch {
      try checkAuthentication(account: account, generation: generation)
      guard api.origin == origin, api.baseURL == server else { throw CancellationError() }
      throw error
    }
  }
  private func savePassword(_ password: RecoveryCode) throws {
    let value = try RecoveryCode.format(accountId: password.accountId, secret: password.secret)
    do { try rememberPassword(Data(value.utf8), "password-" + password.accountId) }
    catch { throw FotoroError("Your account is open. Keep a copy of your Fotoro password; it couldn't be saved on this iPhone.") }
  }
  private func checkStart(_ operation: UUID, account: String?, generation: UUID, origin: String) throws {
    try checkAuthentication(account: account, generation: generation)
    guard startOperation == operation, api.origin == origin else { throw CancellationError() }
  }
  func prepareStart() async throws {
    guard !session.fixture else { throw FotoroError("Choose a real API to create an account") }
    guard startOperation == nil else { throw FotoroError("Account setup is already in progress") }
    let operation = UUID(), account = session.accountId, generation = vault.generation, origin = api.origin
    startOperation = operation
    pendingStart = nil
    defer { if startOperation == operation { startOperation = nil } }
    let options: StartOptionsResponse = try await api.post("/v1/auth/start/options", StartOptionsRequest())
    try checkStart(operation, account: account, generation: generation, origin: origin)
    guard options.version == 1, UUID(uuidString: options.accountId) != nil,
      UUID(uuidString: options.challengeId) != nil,
      let expiry = Wire.parseDate(options.expiresAt), expiry > Date(),
      !(try Data(b64: options.challenge)).isEmpty,
      let box = Sodium().box.keyPair(), let sign = Sodium().sign.keyPair()
    else { throw FotoroError("Account setup could not finish. Try again.") }
    let bundle = AccountBundle(vaultKey: crypto.randomKey().b64,
      boxSecretKey: Data(box.secretKey).b64, signingSecretKey: Data(sign.secretKey).b64)
    let card = AccountCardV1(accountId: options.accountId,
      boxPublicKey: Data(box.publicKey).b64, signingPublicKey: Data(sign.publicKey).b64)
    let secret = crypto.randomKey()
    let wrapper = VaultWrapperV1(version: 1, wrapperId: Wire.id(), kind: "recovery",
      credentialId: nil, prfSalt: nil,
      wrappedBundle: try crypto.wrap(Wire.encode(bundle), key: secret), verified: true)
    pendingStart = PendingStartAccount(options: options, card: card, bundle: bundle,
      secret: secret, wrapper: wrapper,
      password: try RecoveryCode.format(accountId: card.accountId, secret: secret),
      previousAccount: account, generation: generation, origin: origin)
    fallbackMessage = nil
  }
  func completeStart(code: String) async throws {
    guard startOperation == nil else { throw FotoroError("Account setup is already in progress") }
    guard var pendingStart else { throw FotoroError("Create a Fotoro password first.") }
    let password: RecoveryCode
    do { password = try RecoveryCode(code) }
    catch { throw FotoroError("Check your Fotoro password and try again.") }
    guard password.accountId == pendingStart.card.accountId, password.secret == pendingStart.secret else {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    let operation = UUID()
    startOperation = operation
    defer { if startOperation == operation { startOperation = nil } }
    try checkStart(operation, account: pendingStart.previousAccount,
      generation: pendingStart.generation, origin: pendingStart.origin)
    if pendingStart.attempted && !pendingStart.verified {
      // A prior response or local session write may have failed after the account was created.
      // Recover that same account before attempting its one-use enrollment challenge again.
      do {
        let account = pendingStart.previousAccount, generation = pendingStart.generation, origin = pendingStart.origin
        try await recover(pendingStart.password, missingAccountIsPasswordError: false,
          validation: { try self.checkStart(operation, account: account, generation: generation, origin: origin) },
          accepted: {
            pendingStart.verified = true
            pendingStart.previousAccount = pendingStart.card.accountId
            pendingStart.generation = self.vault.generation
            self.pendingStart = pendingStart
          })
        try Task.checkCancellation()
        guard startOperation == operation, session.accountId == pendingStart.card.accountId,
          vault.isUnlocked, api.origin == pendingStart.origin else { throw CancellationError() }
        pendingStart.verified = true
        pendingStart.previousAccount = pendingStart.card.accountId
        pendingStart.generation = vault.generation
        self.pendingStart = pendingStart
      } catch let error as FotoroError where error.message == "NOT_FOUND" {
        try checkStart(operation, account: pendingStart.previousAccount,
          generation: pendingStart.generation, origin: pendingStart.origin)
      }
    }
    if !pendingStart.verified {
      guard let expiry = Wire.parseDate(pendingStart.options.expiresAt), expiry > Date() else {
        throw FotoroError("This account setup expired. Create a new Fotoro password.")
      }
      let proof = try crypto.sign(
        EnrollmentProof(accountCard: pendingStart.card, recoveryWrapper: pendingStart.wrapper),
        kind: "account-enrollment", accountId: pendingStart.card.accountId,
        secret: Data(b64: pendingStart.bundle.signingSecretKey))
      let challengeProof = RecoveryProof(challengeId: pendingStart.options.challengeId,
        challenge: pendingStart.options.challenge, accountId: pendingStart.card.accountId,
        origin: pendingStart.origin)
      let signed = try crypto.sign(challengeProof, kind: "start-enrollment",
        accountId: pendingStart.card.accountId, secret: Data(b64: pendingStart.bundle.signingSecretKey))
      pendingStart.attempted = true
      self.pendingStart = pendingStart
      let result: SessionV1 = try await api.post("/v1/auth/start/verify",
        StartVerify(challengeId: pendingStart.options.challengeId,
          enrollment: Enrollment(accountCard: pendingStart.card, recoveryWrapper: pendingStart.wrapper, proof: proof),
          signedPayload: signed))
      try checkStart(operation, account: pendingStart.previousAccount,
        generation: pendingStart.generation, origin: pendingStart.origin)
      guard result.accountId == pendingStart.card.accountId else { throw FotoroError("Account setup could not finish. Try again.") }
      try accept(result, preservingStart: true)
      try session.pin(pendingStart.card)
      pendingStart.verified = true
      pendingStart.previousAccount = pendingStart.card.accountId
      pendingStart.generation = vault.generation
      self.pendingStart = pendingStart
    }
    if !vault.isUnlocked {
      try await vault.unlock(.recoveryEnvelope(secret: pendingStart.secret, wrapper: pendingStart.wrapper.wrappedBundle))
    }
    try Task.checkCancellation()
    guard startOperation == operation, session.accountId == pendingStart.card.accountId,
      vault.isUnlocked, api.origin == pendingStart.origin else { throw CancellationError() }
    pendingStart.generation = vault.generation
    self.pendingStart = pendingStart
    try savePassword(password)
    self.pendingStart = nil
    fallbackMessage = nil
  }
  func loginWithCode(_ code: String) async throws {
    guard !session.fixture else { throw FotoroError("Choose a real API to sign in") }
    try await recover(code)
    try savePassword(RecoveryCode(code))
    cancelStart()
    fallbackMessage = nil
  }
  func prepareEnrollment() async throws {
    guard !session.fixture else {
      throw FotoroError("Fixture authentication is unavailable; choose a real API")
    }
    let account = session.accountId, generation = vault.generation
    let response = try await options("/v1/auth/register/options")
    try checkAuthentication(account: account, generation: generation)
    guard let id = response["accountId"] as? String,
      let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String, let user = options["user"] as? [String: Any],
      let userID = user["id"] as? String, let box = Sodium().box.keyPair(),
      let sign = Sodium().sign.keyPair()
    else { throw FotoroError("Invalid registration options") }
    let bundle = AccountBundle(
      vaultKey: crypto.randomKey().b64, boxSecretKey: Data(box.secretKey).b64,
      signingSecretKey: Data(sign.secretKey).b64)
    let card = AccountCardV1(
      accountId: id, boxPublicKey: Data(box.publicKey).b64,
      signingPublicKey: Data(sign.publicKey).b64)
    let recovery = crypto.randomKey()
    let wrapper = VaultWrapperV1(
      version: 1, wrapperId: Wire.id(), kind: "recovery", credentialId: nil, prfSalt: nil,
      wrappedBundle: try crypto.wrap(Wire.encode(bundle), key: recovery), verified: true)
    _ = try crypto.unwrap(wrapper.wrappedBundle, key: recovery)
    pending = PendingEnrollment(
      challengeId: challengeId, challenge: try Data(b64: challenge), userID: try Data(b64: userID),
      card: card, bundle: bundle, recovery: recovery, wrapper: wrapper, salt: crypto.randomKey())
  }
  func completeEnrollment(recoverySaved: Bool) async throws {
    guard recoverySaved, let pending else {
      throw FotoroError("Save the recovery code before enrolling")
    }
    let account = session.accountId, generation = vault.generation
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId)
    let request = provider.createCredentialRegistrationRequest(
      challenge: pending.challenge, name: "Fotoro", userID: pending.userID)
    request.prf = .inputValues(.saltInput1(pending.salt))
    request.userVerificationPreference = .required
    let credential = try await performCredential(request)
    try checkAuthentication(account: account, generation: generation)
    let proof = try crypto.sign(
      EnrollmentProof(accountCard: pending.card, recoveryWrapper: pending.wrapper),
      kind: "account-enrollment", accountId: pending.card.accountId,
      secret: Data(b64: pending.bundle.signingSecretKey))
    let enrollment = Enrollment(
      accountCard: pending.card, recoveryWrapper: pending.wrapper, proof: proof)
    let body: [String: Any] = [
      "version": 1, "challengeId": pending.challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response),
      "enrollment": try JSONSerialization.jsonObject(with: Wire.encode(enrollment)),
      "client": "native",
    ]
    let result: SessionV1 = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/register/verify", method: "POST",
        body: JSONSerialization.data(withJSONObject: body)))
    guard result.accountId == pending.card.accountId else {
      throw FotoroError("Enrollment account mismatch")
    }
    try checkAuthentication(account: account, generation: generation)
    try accept(result)
    try session.pin(pending.card)
    try await vault.unlock(
      .recoveryEnvelope(secret: pending.recovery, wrapper: pending.wrapper.wrappedBundle))
    // Registration and local enrollment are complete; the optional PRF wrapper can fail independently.
    self.pending = nil
    fallbackMessage = nil
    if let output = credential.prf, output.count == 32 {
      let enrolledGeneration = vault.generation
      do {
        let wrapper = VaultWrapperV1(
          version: 1, wrapperId: Wire.id(), kind: "prf", credentialId: credential.credentialId,
          prfSalt: pending.salt.b64,
          wrappedBundle: try crypto.wrap(Wire.encode(pending.bundle), key: output), verified: false)
        let _: VaultWrapperV1 = try Wire.decode(
          VaultWrapperV1.self,
          await api.request(
            "/v1/vault/wrappers/\(wrapper.wrapperId)", method: "PUT", body: Wire.encode(wrapper)))
        try checkAuthentication(account: pending.card.accountId, generation: enrolledGeneration)
      } catch {
        try checkAuthentication(account: pending.card.accountId, generation: enrolledGeneration)
        if (error as? URLError)?.code == .cancelled { throw error }
        fallbackMessage = "This iPhone is enrolled. Use your saved recovery code or a trusted device to unlock your account on another device."
      }
    } else {
      fallbackMessage =
        "This passkey has no PRF output. This enrolled iPhone uses Keychain; another device needs the saved recovery code or trusted-device approval."
    }
  }
  @discardableResult func login() async throws -> NativeSignInOutcome {
    fallbackMessage = nil
    guard !session.fixture else {
      throw FotoroError("Fixture authentication cannot create passkeys")
    }
    let account = session.accountId, generation = vault.generation
    let response = try await options("/v1/auth/login/options", accountId: account)
    try checkAuthentication(account: account, generation: generation)
    guard let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String
    else { throw FotoroError("Invalid sign-in options") }
    let request = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId
    ).createCredentialAssertionRequest(challenge: try Data(b64: challenge))
    try applyAllowedCredentials(options, to: request)
    request.userVerificationPreference = .required
    var wrappers: [VaultWrapperV1] = []
    if let account = session.accountId, let v: VaultV1 = try? await api.get("/v1/vault"),
      v.version == 1, v.accountCard.accountId == account {
      wrappers = v.wrappers
      let values = try wrappers.filter { $0.kind == "prf" }.reduce(
        into: [Data: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues]()
      ) { dict, w in
        if let id = w.credentialId, let salt = w.prfSalt {
          dict[try Data(b64: id)] = .saltInput1(try Data(b64: salt))
        }
      }
      if !values.isEmpty { request.prf = .perCredentialInputValues(values) }
    }
    try checkAuthentication(account: account, generation: generation)
    let credential = try await performCredential(request)
    try checkAuthentication(account: account, generation: generation)
    let body: [String: Any] = [
      "version": 1, "challengeId": challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response), "client": "native",
    ]
    let result = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/login/verify", method: "POST", body: JSONSerialization.data(withJSONObject: body))
    )
    try checkAuthentication(account: account, generation: generation)
    try accept(result)
    if vault.isUnlocked { return .unlocked }
    if session.pinnedCards[result.accountId] == nil {
      let acceptedGeneration = vault.generation
      let current: VaultV1 = try await api.get("/v1/vault")
      try checkAuthentication(account: result.accountId, generation: acceptedGeneration)
      guard current.version == 1, current.accountCard.accountId == result.accountId else {
        throw FotoroError("Vault account mismatch")
      }
      try session.pin(current.accountCard)
    }
    if let output = credential.prf,
      let wrapper = wrappers.first(where: { $0.credentialId == credential.credentialId })
    {
      try await vault.unlock(.prf(output: output, wrapper: wrapper.wrappedBundle))
    } else {
      do { try await vault.unlock(.localKeychain) } catch {
        fallbackMessage =
          "Authenticated. Recover the vault with your saved code or a trusted device."
        return .recoveryRequired
      }
    }
    return .unlocked
  }
  func unlockWithPRF() async throws {
    let account = session.accountId, generation = vault.generation
    let v: VaultV1 = try await api.get("/v1/vault")
    try checkAuthentication(account: account, generation: generation)
    guard v.accountCard.accountId == session.accountId else {
      throw FotoroError("Vault account mismatch")
    }
    let response = try await options("/v1/auth/login/options", accountId: session.accountId)
    guard let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String
    else { throw FotoroError("Invalid PRF challenge") }
    let values = try v.wrappers.filter { $0.kind == "prf" }.reduce(
      into: [Data: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues]()
    ) { dict, w in
      if let id = w.credentialId, let salt = w.prfSalt {
        dict[try Data(b64: id)] = .saltInput1(try Data(b64: salt))
      }
    }
    guard !values.isEmpty else {
      throw FotoroError("No PRF credential wrapper. Use recovery or trusted-device approval.")
    }
    let request = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId
    ).createCredentialAssertionRequest(challenge: try Data(b64: challenge))
    try applyAllowedCredentials(options, to: request)
    request.prf = .perCredentialInputValues(values)
    request.userVerificationPreference = .required
    let credential = try await performCredential(request)
    try checkAuthentication(account: account, generation: generation)
    guard let output = credential.prf, output.count == 32,
      let wrapper = v.wrappers.first(where: {
        $0.credentialId == credential.credentialId && $0.kind == "prf"
      })
    else {
      throw FotoroError(
        "This passkey returned no PRF output. Use recovery or trusted-device approval.")
    }
    let bundle = try Wire.decode(
      AccountBundle.self, crypto.unwrap(wrapper.wrappedBundle, key: output))
    let test = try crypto.signBytes(
      Data("fotoro-prf-identity".utf8), kind: "unlock", accountId: v.accountCard.accountId,
      secret: Data(b64: bundle.signingSecretKey))
    _ = try crypto.verify(test, card: v.accountCard, kind: "unlock")
    guard
      try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: bundle.boxSecretKey))
        .publicKey.rawRepresentation.b64 == v.accountCard.boxPublicKey
    else { throw FotoroError("PRF identity mismatch") }
    let body: [String: Any] = [
      "version": 1, "challengeId": challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response), "client": "native",
    ]
    let result = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/login/verify", method: "POST", body: JSONSerialization.data(withJSONObject: body))
    )
    guard result.accountId == v.accountCard.accountId else {
      throw FotoroError("PRF authenticated account mismatch")
    }
    try checkAuthentication(account: account, generation: generation)
    try accept(result)
    try session.pin(v.accountCard)
    try await vault.unlock(.prf(output: output, wrapper: wrapper.wrappedBundle))
  }
  func recover(_ code: String, missingAccountIsPasswordError: Bool = true,
    validation: (() throws -> Void)? = nil, accepted: (() -> Void)? = nil) async throws {
    let account = session.accountId, generation = vault.generation, origin = api.origin, server = api.baseURL
    let recovery: RecoveryCode
    do { recovery = try RecoveryCode(code) }
    catch { throw FotoroError("Check your Fotoro password and try again.") }
    let bytes: Data
    do {
      bytes = try await api.request(
        "/v1/auth/recovery/options", method: "POST",
        body: Wire.encode(AuthOptionsRequest(accountId: recovery.accountId)))
    } catch let error as FotoroError where error.message == "NOT_FOUND" && missingAccountIsPasswordError {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    let options = try Wire.decode(RecoveryOptionsResponse.self, bytes)
    try checkAuthentication(account: account, generation: generation)
    guard api.origin == origin, api.baseURL == server else { throw CancellationError() }
    try validation?()
    let wrapper: VaultWrapperV1
    let signed: SignedPayloadV1
    do {
      guard options.version == 1, options.vault.version == 1,
        options.vault.accountCard.version == 1, options.vault.accountCard.accountId == recovery.accountId,
        let expiry = Wire.parseDate(options.expiresAt), expiry > Date(),
        UUID(uuidString: options.challengeId) != nil, !(try Data(b64: options.challenge)).isEmpty,
        let current = options.vault.wrappers.first(where: { $0.kind == "recovery" && $0.verified })
      else { throw FotoroError("Invalid password response") }
      wrapper = current
      let bundle = try Wire.decode(
        AccountBundle.self, crypto.unwrap(wrapper.wrappedBundle, key: recovery.secret))
      let proof = RecoveryProof(
        challengeId: options.challengeId, challenge: options.challenge, accountId: recovery.accountId,
        origin: origin)
      signed = try crypto.sign(
        proof, kind: "recovery-session", accountId: recovery.accountId,
        secret: Data(b64: bundle.signingSecretKey))
      _ = try crypto.verify(signed, card: options.vault.accountCard, kind: "recovery-session")
      guard
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: bundle.boxSecretKey))
          .publicKey.rawRepresentation.b64 == options.vault.accountCard.boxPublicKey
      else { throw FotoroError("Invalid password identity") }
    } catch { throw FotoroError("Check your Fotoro password and try again.") }
    let result: SessionV1
    do {
      result = try await api.post(
        "/v1/auth/recovery/verify",
        RecoveryVerify(challengeId: options.challengeId, signedPayload: signed))
    } catch let error as FotoroError where ["BAD_SIGNATURE", "FORBIDDEN", "BODY_MISMATCH"].contains(error.message) {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    guard result.accountId == recovery.accountId else {
      throw FotoroError("Check your Fotoro password and try again.")
    }
    try checkAuthentication(account: account, generation: generation)
    guard api.origin == origin, api.baseURL == server else { throw CancellationError() }
    try validation?()
    try accept(result, preservingStart: validation != nil)
    try session.pin(options.vault.accountCard)
    accepted?()
    try await vault.unlock(
      .recoveryEnvelope(secret: recovery.secret, wrapper: wrapper.wrappedBundle))
  }
}
