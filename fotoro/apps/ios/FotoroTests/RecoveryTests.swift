import AuthenticationServices
import XCTest

@testable import Fotoro

final class RecoveryTests: XCTestCase {
  @MainActor func testSessionPersistenceFailurePreservesActiveIdentityAndCredentials() throws {
    let remembered = UserDefaults.standard.object(forKey: "fotoro.account")
    defer {
      if let remembered { UserDefaults.standard.set(remembered, forKey: "fotoro.account") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.account") }
    }
    let previous = SessionV1(version: 1, accountId: Wire.id(), deviceId: Wire.id(), expiresAt: "2099-01-01T00:00:00Z", token: "previous-public-test-session")
    let bytes = try Wire.encode(previous)
    var persisted = bytes
    let session = AccountSession(loadSession: { bytes }, persistSession: { _ in throw FotoroError("Controlled protected-storage failure") })
    let replacement = SessionV1(version: 1, accountId: Wire.id(), deviceId: Wire.id(), expiresAt: "2099-01-01T00:00:00Z", token: "replacement-public-test-session")
    XCTAssertThrowsError(try session.accept(replacement))
    XCTAssertEqual(session.accountId, previous.accountId)
    XCTAssertEqual(session.bearerToken, previous.token)
    XCTAssertEqual(session.deviceId, previous.deviceId)
    XCTAssertTrue(session.isSignedIn)
    XCTAssertEqual(persisted, bytes)
    let successful = AccountSession(loadSession: { bytes }, persistSession: { persisted = $0 })
    try successful.accept(replacement)
    XCTAssertEqual(successful.accountId, replacement.accountId)
    XCTAssertEqual(try Wire.decode(SessionV1.self, persisted).accountId, replacement.accountId)
  }
  @MainActor func testSessionValidationRejectsInvalidAcceptanceAndRestorationWithoutDeletingSavedData() throws {
    let defaults = UserDefaults.standard
    let fixtureAccount = defaults.object(forKey: "fotoro.fixtureAccount")
    defaults.removeObject(forKey: "fotoro.fixtureAccount")
    defer { if let fixtureAccount { defaults.set(fixtureAccount, forKey: "fotoro.fixtureAccount") } }
    let valid = SessionV1(version: 1, accountId: Wire.id(), deviceId: Wire.id(), expiresAt: "2099-01-01T00:00:00Z", token: "public-controlled-session")
    var invalid = [SessionV1]()
    var candidate = valid; candidate.version = 2; invalid.append(candidate)
    candidate = valid; candidate.accountId = "invalid-account"; invalid.append(candidate)
    candidate = valid; candidate.deviceId = "invalid-device"; invalid.append(candidate)
    candidate = valid; candidate.token = ""; invalid.append(candidate)
    candidate = valid; candidate.expiresAt = "invalid-expiry"; invalid.append(candidate)
    for record in invalid {
      var writes = 0
      let bytes = try Wire.encode(record)
      let session = AccountSession(loadSession: { bytes }, persistSession: { _ in writes += 1 })
      XCTAssertNil(session.accountId)
      XCTAssertFalse(session.isSignedIn)
      XCTAssertThrowsError(try session.accept(record))
      XCTAssertEqual(writes, 0)
      XCTAssertEqual(try Wire.decode(SessionV1.self, bytes).accountId, record.accountId)
    }
    var expired = valid; expired.expiresAt = "2000-01-01T00:00:00Z"
    let session = AccountSession(loadSession: { try Wire.encode(expired) })
    XCTAssertEqual(session.accountId, valid.accountId, "Expired credentials must not erase the known local account")
    XCTAssertEqual(session.accountReference, String(valid.accountId.prefix(8)) + "…" + String(valid.accountId.suffix(4)))
    XCTAssertNil(session.bearerToken)
    XCTAssertFalse(session.isSignedIn)
    XCTAssertThrowsError(try session.accept(expired))
  }
  @MainActor func testKnownAccountPasskeyRequestUsesServerAllowedCredentials() async throws {
    let credentials: [[String: Any]] = [["type": "public-key", "id": Data([1, 2, 3]).b64]]
    try await withIsolatedLogin(enrolled: true, allowedCredentials: credentials, ceremony: { request in
      let assertion = try XCTUnwrap(request as? ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
      XCTAssertEqual(assertion.allowedCredentials.map(\.credentialID), [Data([1, 2, 3])])
      return Self.loginCredential
    }) { auth, _, _, _ in
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .unlocked)
    }
  }
  @MainActor func testMalformedAllowedCredentialsNeverStartPasskey() async throws {
    var ceremonies = 0
    try await withIsolatedLogin(allowedCredentials: [["type": "public-key", "id": ""]], ceremony: { _ in
      ceremonies += 1; return Self.loginCredential
    }) { auth, session, _, responses in
      do { _ = try await auth.login(); XCTFail("Invalid credential accepted") } catch {}
      XCTAssertEqual(ceremonies, 0)
      XCTAssertFalse(session.isSignedIn)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
    }
  }
  @MainActor func testLockDuringPasskeyCannotVerifyOrRestoreSession() async throws {
    var lockVault: (() -> Void)?
    try await withIsolatedLogin(ceremony: { _ in lockVault?(); return Self.loginCredential }) {
      auth, session, vault, responses in
      lockVault = { vault.lock() }
      do { _ = try await auth.login(); XCTFail("A withdrawn sign-in must not accept a session") }
      catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertFalse(session.isSignedIn)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
    }
  }
  @MainActor func testLockDuringAuthenticatedCardFetchCannotPinOrUnlockLateResponse() async throws {
    let gate = NativeLoginVaultGate(started: expectation(description: "Authenticated card fetch started"))
    defer { gate.release.signal() }
    try await withIsolatedLogin(vaultGate: gate, ceremony: { _ in Self.loginCredential }) {
      auth, session, vault, responses in
      let signingIn = Task { try await auth.login() }
      await fulfillment(of: [gate.started], timeout: 3)
      XCTAssertTrue(session.isSignedIn)
      vault.lock()
      gate.release.signal()
      do { _ = try await signingIn.value; XCTFail("A locked account must reject late card completion") }
      catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertNil(session.pinnedCards[responses.card.accountId])
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertFalse(Keychain.contains(responses.card.accountId))
    }
  }
  @MainActor func testOptionalPRFWrapperFailureKeepsCompletedEnrollmentWithoutPendingRetry() async throws {
    try await withIsolatedLogin(wrapperFail: true, ceremony: { _ in
      var credential = Self.loginCredential
      credential.prf = Data(repeating: 7, count: 32)
      return credential
    }) { auth, session, vault, responses in
      try await auth.prepareEnrollment()
      XCTAssertNotNil(auth.pending)
      try await auth.completeEnrollment(recoverySaved: true)
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      XCTAssertNil(auth.pending)
      XCTAssertNil(auth.recoveryCode)
      XCTAssertNotNil(auth.fallbackMessage)
      XCTAssertTrue(Keychain.contains(responses.card.accountId))
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/register/verify" }.count, 1)
      do { try await auth.completeEnrollment(recoverySaved: true); XCTFail("Completed enrollment must not submit again") }
      catch {}
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/register/verify" }.count, 1)
    }
  }
  @MainActor func testRestoredLockedSessionRecoveryStateDoesNotDependOnFallbackMessage() async throws {
    for enrolled in [false, true] {
      try await withIsolatedLogin(enrolled: enrolled, ceremony: { _ in Self.loginCredential }) {
        auth, session, vault, responses in
        _ = try await auth.login()
        vault.lock()
        let restored = AccountSession()
        let api = APIClient(session: restored, baseURL: auth.api.baseURL,
          diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
        let freshVault = VaultStore(session: restored, api: api)
        let freshAuth = NativeAuth(session: restored, api: api, vault: freshVault)
        XCTAssertTrue(restored.isSignedIn)
        XCTAssertEqual(restored.accountReference, session.accountReference)
        XCTAssertEqual(restored.accountId, responses.card.accountId)
        XCTAssertNil(freshAuth.fallbackMessage)
        XCTAssertEqual(freshAuth.needsRecovery, !enrolled)
        if enrolled {
          try await freshVault.unlock(.localKeychain)
          XCTAssertTrue(freshVault.isUnlocked)
          XCTAssertFalse(freshAuth.needsRecovery)
          freshVault.lock()
        }
      }
    }
  }
  @MainActor func testFreshVerifiedLoginRestoresMissingPinForExistingLocalKeys() async throws {
    try await withIsolatedLogin(enrolled: true, ceremony: { _ in Self.loginCredential }) {
      auth, session, vault, responses in
      session.pinnedCards = [:]
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .unlocked)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(try session.requireCard(responses.card.accountId), responses.card)
    }
  }
  @MainActor func testAcceptingDifferentAccountClearsPreviousUnlockedBundleAndPreservesItsLocalKeys() async throws {
    try await withIsolatedLogin(ceremony: { _ in Self.loginCredential }) {
      auth, session, vault, responses in
      var previousCard = responses.card; previousCard.accountId = Wire.id()
      let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
      let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
      let previousBytes = try Wire.encode(bundle)
      defer { Keychain.remove(previousCard.accountId) }
      try session.pin(previousCard)
      session.accountId = previousCard.accountId
      session.bearerToken = "previous-public-session"
      try Keychain.write(previousBytes, id: previousCard.accountId)
      try await vault.unlock(.localKeychain)
      XCTAssertTrue(vault.isUnlocked)
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .recoveryRequired)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertThrowsError(try vault.requireBundle())
      XCTAssertEqual(try Keychain.read(previousCard.accountId), previousBytes)
    }
  }
  func testRecoveryCodeValidation() throws {
    XCTAssertThrowsError(try RecoveryCode("fotoro1.bad.AA"))
    XCTAssertThrowsError(try RecoveryCode("fotoro1.00000000-0000-4000-8000-000000000001.AA"))
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let code = try RecoveryCode("fotoro1.\(account.accountId).\(account.recoverySecret)")
    XCTAssertEqual(code.secret.count, 32)
  }
  func testRecoveryEnrollmentPreservesRequiredNullWireFields() throws {
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let wrapper = VaultWrapperV1(
      version: 1, wrapperId: Wire.id(), kind: "recovery", credentialId: nil, prfSalt: nil,
      wrappedBundle: secret.encryptedBundle, verified: true)
    let encoded = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Wire.encode(wrapper)) as? [String: Any])
    XCTAssertTrue(encoded["credentialId"] is NSNull)
    XCTAssertTrue(encoded["prfSalt"] is NSNull)
  }
  @MainActor func testLoginOptionsFailureNeverStartsPasskeyOrAcceptsSession() async throws {
    var ceremonies = 0
    try await withIsolatedLogin(optionsFail: true, ceremony: { _ in
      ceremonies += 1
      return Self.loginCredential
    }) { auth, session, vault, responses in
      do { _ = try await auth.login(); XCTFail("Failed options accepted") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "LOGIN_OPTIONS_BLOCKED") }
      XCTAssertEqual(ceremonies, 0)
      XCTAssertNil(session.accountId)
      XCTAssertNil(session.bearerToken)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertNil(auth.fallbackMessage)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
    }
  }
  @MainActor func testPasskeyCancellationNeverVerifiesOrAcceptsSession() async throws {
    try await withIsolatedLogin(ceremony: { _ in
      throw NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.canceled.rawValue)
    }) { auth, session, vault, responses in
      do { _ = try await auth.login(); XCTFail("Cancelled passkey accepted") }
      catch let error as NativePasskeyError {
        XCTAssertTrue(error.isCancelled)
        XCTAssertEqual(error.localizedDescription, "Sign-in was cancelled. Tap Sign in to try again.")
      }
      XCTAssertNil(session.accountId)
      XCTAssertNil(session.bearerToken)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertNil(auth.fallbackMessage)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
    }
  }
  @MainActor func testPasskeyFailureOffersAccountCreationOrRecoveryWithoutAcceptingSession() async throws {
    for code in [ASAuthorizationError.Code.failed, .notHandled] {
      try await withIsolatedLogin(ceremony: { _ in
        throw NSError(domain: ASAuthorizationError.errorDomain, code: code.rawValue)
      }) { auth, session, vault, responses in
        do { _ = try await auth.login(); XCTFail("Unavailable passkey accepted") }
        catch let error as NativePasskeyError {
          XCTAssertFalse(error.isCancelled)
          XCTAssertEqual(error.localizedDescription, "Passkey sign-in could not finish. If this is your first time, create an account. Otherwise try again or use your recovery code or a trusted device.")
        }
        XCTAssertNil(session.accountId)
        XCTAssertNil(session.bearerToken)
        XCTAssertFalse(vault.isUnlocked)
        XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
      }
    }
  }
  @MainActor func testNonPasskeyCeremonyFailureKeepsItsOriginalError() async throws {
    try await withIsolatedLogin(ceremony: { _ in throw URLError(.notConnectedToInternet) }) {
      auth, session, vault, responses in
      do { _ = try await auth.login(); XCTFail("Failed ceremony accepted") }
      catch let error as URLError { XCTAssertEqual(error.code, .notConnectedToInternet) }
      XCTAssertNil(session.accountId)
      XCTAssertNil(session.bearerToken)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options"])
    }
  }
  @MainActor func testAcceptedLoginWithoutLocalKeysPreservesSessionAndRequiresRecovery() async throws {
    var ceremonies = 0
    try await withIsolatedLogin(ceremony: { _ in
      ceremonies += 1
      return Self.loginCredential
    }) { auth, session, vault, responses in
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .recoveryRequired)
      XCTAssertEqual(ceremonies, 1)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      XCTAssertEqual(session.bearerToken, "public-controlled-session")
      XCTAssertFalse(session.fixture)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(auth.fallbackMessage, "Authenticated. Recover the vault with your saved code or a trusted device.")
      let persisted = try Wire.decode(SessionV1.self, Keychain.read("session"))
      XCTAssertEqual(persisted.accountId, session.accountId)
      XCTAssertEqual(persisted.token, session.bearerToken)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options", "/v1/auth/login/verify", "/v1/vault"])
    }
  }
  @MainActor func testAcceptedLoginUnlocksPinnedLocalKeysAndClearsStaleRecoveryGuidance() async throws {
    try await withIsolatedLogin(enrolled: true, ceremony: { _ in Self.loginCredential }) {
      auth, session, vault, responses in
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .unlocked)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      XCTAssertEqual(session.bearerToken, "public-controlled-session")
      XCTAssertTrue(vault.isUnlocked)
      let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
      XCTAssertEqual(try vault.requireBundle().vaultKey, secret.vaultKey)
      XCTAssertNil(auth.fallbackMessage)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options", "/v1/vault", "/v1/auth/login/verify"])
    }
  }
  @MainActor func testRecoveryRequiredCannotCompleteAccountOrRequestCatalog() async throws {
    try await withIsolatedLogin(ceremony: { _ in Self.loginCredential }) {
      auth, session, vault, responses in
      let outcome = try await auth.login()
      XCTAssertEqual(outcome, .recoveryRequired)
      XCTAssertFalse(vault.isUnlocked)
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [NativeLoginProtocol.self]
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      defer { try? FileManager.default.removeItem(at: root) }
      let services = try AppServices(root: root, networkConfiguration: configuration)
      services.api.baseURL = auth.api.baseURL
      let catalog = services.store
      var completed = false
      try await AccountView(services: services, onSignedIn: { completed = true }).finishSignIn()
      XCTAssertFalse(completed)
      XCTAssertTrue(services.store === catalog)
      XCTAssertFalse(services.vault.isUnlocked)
      XCTAssertEqual(services.session.accountId, session.accountId)
      XCTAssertEqual(services.session.bearerToken, session.bearerToken)
      XCTAssertEqual(responses.paths, ["/v1/auth/login/options", "/v1/auth/login/verify", "/v1/vault"])
    }
  }
  private static var loginCredential: CredentialResult {
    CredentialResult(response: Data(#"{"id":"controlled-public-credential","type":"public-key"}"#.utf8),
      credentialId: Data([1]).b64, prf: nil)
  }
  @MainActor private func withIsolatedLogin(optionsFail: Bool = false, enrolled: Bool = false,
    allowedCredentials: [[String: Any]]? = nil,
    vaultGate: NativeLoginVaultGate? = nil, wrapperFail: Bool = false,
    ceremony: @escaping NativeCredentialCeremony,
    check: @MainActor (NativeAuth, AccountSession, VaultStore, NativeLoginResponses) async throws -> Void) async throws {
    let defaults = UserDefaults.standard
    let savedAccount = defaults.object(forKey: "fotoro.account")
    let savedCards = defaults.object(forKey: "fotoro.pinnedCards")
    let savedSession = try? Keychain.read("session")
    var card = try fixture(FixtureAccounts.self, "accounts").accounts[0]
    card.accountId = Wire.id()
    let host = "login-" + card.accountId.lowercased() + ".invalid"
    defer {
      NativeLoginProtocol.responses.remove(host)
      Keychain.remove(card.accountId)
      Keychain.remove("session")
      if let savedSession {
        do { try Keychain.write(savedSession, id: "session") }
        catch { XCTFail("Could not restore the public test session: \(error)") }
      }
      if let savedAccount { defaults.set(savedAccount, forKey: "fotoro.account") }
      else { defaults.removeObject(forKey: "fotoro.account") }
      if let savedCards { defaults.set(savedCards, forKey: "fotoro.pinnedCards") }
      else { defaults.removeObject(forKey: "fotoro.pinnedCards") }
    }
    let responses = try NativeLoginResponses(card: card, optionsFail: optionsFail,
      allowedCredentials: allowedCredentials, vaultGate: vaultGate, wrapperFail: wrapperFail)
    NativeLoginProtocol.responses.insert(responses, for: host)
    let session = AccountSession()
    session.accountId = nil
    session.bearerToken = nil
    session.deviceId = nil
    session.fixture = false
    session.pinnedCards = [:]
    if enrolled {
      let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
      let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey,
        signingSecretKey: secret.signingSecretKey)
      try session.pin(card)
      try Keychain.write(Wire.encode(bundle), id: card.accountId)
      session.accountId = card.accountId
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeLoginProtocol.self]
    let api = APIClient(session: session, baseURL: URL(string: "https://" + host)!,
      networkConfiguration: configuration, diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    let vault = VaultStore(session: session, api: api)
    let auth = NativeAuth(session: session, api: api, vault: vault, credentialCeremony: ceremony)
    auth.fallbackMessage = "Stale recovery guidance"
    try await check(auth, session, vault, responses)
    vault.lock()
  }
  @MainActor func testLostCredentialRealRecoverySessionAndDeviceApprovalReplay() async throws {
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let trusted = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try trusted.configureAPI("http://127.0.0.1:8787")
    let wrong = "fotoro1.\(account.accountId).\(Data(repeating:0,count:32).b64)"
    do {
      try await trusted.auth.recover(wrong)
      XCTFail("Wrong secret authenticated")
    } catch {}
    XCTAssertNil(trusted.session.bearerToken)
    try await trusted.auth.recover("fotoro1.\(account.accountId).\(account.recoverySecret)")
    try trusted.activateAccount()
    XCTAssertEqual(trusted.session.accountId, account.accountId)
    XCTAssertFalse(trusted.session.fixture)
    XCTAssertNotNil(trusted.session.bearerToken)
    XCTAssertTrue(trusted.vault.isUnlocked)
    let newDevice = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try newDevice.configureAPI("http://127.0.0.1:8787")
    try await newDevice.auth.recover("fotoro1.\(account.accountId).\(account.recoverySecret)")
    newDevice.vault.lock()
    try await newDevice.deviceTrust.begin()
    let pending = try XCTUnwrap(newDevice.deviceTrust.pending)
    let request = try XCTUnwrap(newDevice.deviceTrust.challengeJSON)
    try await trusted.deviceTrust.approve(request)
    try await newDevice.deviceTrust.complete()
    XCTAssertTrue(newDevice.vault.isUnlocked)
    do {
      let _: DeviceCompleteResponse = try await newDevice.api.post(
        "/v1/devices/enroll/\(pending.challenge.enrollmentId)/complete",
        DeviceCompleteRequest(challenge: pending.challenge.challenge))
      XCTFail("Replayed device completion accepted")
    } catch {}
    var wrongOrigin = pending.challenge
    wrongOrigin.origin = "https://attacker.invalid"
    do {
      try await trusted.deviceTrust.approve(
        String(data: Wire.encode(wrongOrigin), encoding: .utf8)!)
      XCTFail("Wrong origin accepted")
    } catch {}
    try await newDevice.vault.unlock(.localKeychain)
    XCTAssertEqual(try newDevice.vault.requireBundle().vaultKey, account.vaultKey)
  }
}

private final class NativeLoginResponses: @unchecked Sendable {
  let card: AccountCardV1
  private let optionsFail: Bool
  private let sessionBytes: Data
  private let vaultBytes: Data
  private let optionsBytes: Data
  private let vaultGate: NativeLoginVaultGate?
  private let wrapperFail: Bool
  private let lock = NSLock()
  private var requestedPaths: [String] = []
  init(card: AccountCardV1, optionsFail: Bool, allowedCredentials: [[String: Any]]?,
    vaultGate: NativeLoginVaultGate?, wrapperFail: Bool) throws {
    self.card = card
    self.optionsFail = optionsFail
    self.vaultGate = vaultGate; self.wrapperFail = wrapperFail
    sessionBytes = try Wire.encode(SessionV1(version: 1, accountId: card.accountId,
      deviceId: Wire.id(), expiresAt: "2099-01-01T00:00:00Z", token: "public-controlled-session"))
    vaultBytes = try Wire.encode(VaultV1(version: 1, accountCard: card, wrappers: []))
    var options: [String: Any] = ["challenge": "AQ"]
    if let allowedCredentials { options["allowCredentials"] = allowedCredentials }
    optionsBytes = try JSONSerialization.data(withJSONObject: ["version": 1, "challengeId": "public-challenge", "options": options])
  }
  var paths: [String] {
    lock.lock(); defer { lock.unlock() }
    return requestedPaths
  }
  func response(to request: URLRequest) throws -> (Int, Data) {
    let path = request.url!.path
    lock.lock(); requestedPaths.append(path); lock.unlock()
    switch (request.httpMethod, path) {
    case ("POST", "/v1/auth/login/options"):
      if optionsFail { return (503, Data(#"{"code":"LOGIN_OPTIONS_BLOCKED","retryable":true}"#.utf8)) }
      return (200, optionsBytes)
    case ("POST", "/v1/auth/login/verify"): return (200, sessionBytes)
    case ("GET", "/v1/vault"):
      vaultGate?.started.fulfill()
      if let vaultGate { _ = vaultGate.release.wait(timeout: .now() + 5) }
      return (200, vaultBytes)
    case ("POST", "/v1/auth/register/options"):
      return (200, try JSONSerialization.data(withJSONObject: ["version": 1,
        "challengeId": "public-register-challenge", "accountId": card.accountId,
        "options": ["challenge": "AQ", "user": ["id": Data(card.accountId.utf8).b64]]]))
    case ("POST", "/v1/auth/register/verify"): return (200, sessionBytes)
    default:
      if wrapperFail, request.httpMethod == "PUT", path.hasPrefix("/v1/vault/wrappers/") {
        return (503, Data(#"{"code":"CONTROLLED_WRAPPER_FAILURE","retryable":true}"#.utf8))
      }
      throw FotoroError("Unexpected isolated login request")
    }
  }
}
private final class NativeLoginVaultGate: @unchecked Sendable {
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  init(started: XCTestExpectation) { self.started = started }
}
private final class NativeLoginResponseRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: NativeLoginResponses] = [:]
  func insert(_ response: NativeLoginResponses, for host: String) {
    lock.lock(); defer { lock.unlock() }
    values[host] = response
  }
  func remove(_ host: String) {
    lock.lock(); defer { lock.unlock() }
    values.removeValue(forKey: host)
  }
  func response(for host: String) -> NativeLoginResponses? {
    lock.lock(); defer { lock.unlock() }
    return values[host]
  }
}
private final class NativeLoginProtocol: URLProtocol, @unchecked Sendable {
  static let responses = NativeLoginResponseRegistry()
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host.map { $0.hasPrefix("login-") && $0.hasSuffix(".invalid") } == true
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let url = request.url, let response = Self.responses.response(for: url.host ?? "") else {
        throw FotoroError("Missing isolated login response")
      }
      let (status, body) = try response.response(to: request)
      let http = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
