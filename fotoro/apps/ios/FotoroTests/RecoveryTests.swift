import AuthenticationServices
import XCTest

@testable import Fotoro

final class RecoveryTests: XCTestCase {
  func testCompactPasswordMatchesWebVectorAndAcceptsLegacyCodes() throws {
    let account = "00112233-4455-6677-8899-aabbccddeeff"
    let secret = Data((0..<32).map(UInt8.init))
    let expected = "foto_ABEiM0RVZneImaq7zN3u_wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"
    XCTAssertEqual(try RecoveryCode.format(accountId: account, secret: secret), expected)
    XCTAssertEqual(expected.count, 69)
    for value in [expected, " \n" + expected + "\n", "fotoro1." + account.uppercased() + "." + secret.b64] {
      let password = try RecoveryCode(value)
      XCTAssertEqual(password.accountId, account)
      XCTAssertEqual(password.secret, secret)
    }
    for value in ["", "a-short-password", "foto_AA", expected + "=", String(expected.dropLast()), expected + "A"] {
      XCTAssertThrowsError(try RecoveryCode(value))
    }
  }
  @MainActor func testStartPasswordCreatesAccountOnlyAfterConfirmationWithoutPasskeyOrPlaintextSecret() async throws {
    var ceremonies = 0
    try await withIsolatedLogin(ceremony: { _ in
      ceremonies += 1; throw FotoroError("Unexpected passkey ceremony")
    }) { auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword)
      let code = try RecoveryCode(password)
      XCTAssertFalse(session.isSignedIn)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(responses.paths, ["/v1/auth/start/options"])
      let wrong = try RecoveryCode.format(accountId: code.accountId, secret: Data(repeating: 0, count: 32))
      do { try await auth.completeStart(code: wrong); XCTFail("Different password created an account") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "Check your Fotoro password and try again.") }
      XCTAssertEqual(responses.paths, ["/v1/auth/start/options"])
      try await auth.completeStart(code: "\n" + password + "\n")
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(session.accountId, code.accountId)
      XCTAssertNil(auth.startPassword)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertEqual(ceremonies, 0)
      XCTAssertEqual(responses.paths, ["/v1/auth/start/options", "/v1/auth/start/verify"])
      let wire = try XCTUnwrap(responses.body(for: "/v1/auth/start/verify"))
      let request = try Wire.decode(StartVerify.self, wire)
      let crypto = CryptoAdapter()
      let bundle = try Wire.decode(AccountBundle.self,
        crypto.unwrap(request.enrollment.recoveryWrapper.wrappedBundle, key: code.secret))
      XCTAssertEqual(bundle.vaultKey, try vault.requireBundle().vaultKey)
      let json = try XCTUnwrap(String(data: wire, encoding: .utf8))
      XCTAssertFalse(json.contains(password))
      XCTAssertFalse(json.contains(code.secret.b64))
      XCTAssertFalse(json.contains(bundle.vaultKey))
      XCTAssertFalse(json.contains(bundle.signingSecretKey))
      XCTAssertFalse(json.contains("\"response\""))
      let wrapperJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(request.enrollment.recoveryWrapper)) as? [String: Any])
      XCTAssertTrue(wrapperJSON["credentialId"] is NSNull)
      XCTAssertTrue(wrapperJSON["prfSalt"] is NSNull)
      do { try await auth.completeStart(code: password); XCTFail("Completed account was enrolled twice") } catch {}
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/start/verify" }.count, 1)
    }
  }
  @MainActor func testCompactAndLegacyPasswordsBothAuthenticateAndUnlockOnFreshDeviceWithoutPasskey() async throws {
    try await withIsolatedLogin(ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) {
      auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword), code = try RecoveryCode(password)
      try await auth.completeStart(code: password)
      let key = try vault.requireBundle().vaultKey
      for value in [password, "fotoro1.\(code.accountId).\(code.secret.b64)"] {
        try vault.signOut()
        XCTAssertFalse(Keychain.contains(code.accountId))
        XCTAssertFalse(Keychain.contains("password-" + code.accountId))
        XCTAssertThrowsError(try auth.savedPassword())
        session.pinnedCards = [:]
        let restoredVault = VaultStore(session: session, api: auth.api)
        let restoredAuth = NativeAuth(session: session, api: auth.api, vault: restoredVault,
          credentialCeremony: { _ in throw FotoroError("Unexpected passkey ceremony") })
        try await restoredAuth.loginWithCode(value)
        XCTAssertTrue(session.isSignedIn)
        XCTAssertTrue(restoredVault.isUnlocked)
        XCTAssertEqual(try restoredVault.requireBundle().vaultKey, key)
        XCTAssertEqual(try restoredAuth.savedPassword(), password)
        restoredVault.lock()
      }
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/recovery/options" }.count, 2)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/recovery/verify" }.count, 2)
      XCTAssertFalse(responses.paths.contains { $0.contains("login/") || $0.contains("register/") || $0 == "/v1/vault" })
    }
  }
  @MainActor func testExpiredRememberedAccountRenewsWithProofAndFreshSessionUsesLocalUnlock() async throws {
    try await withExpiredRememberedLogin { auth, session, vault, responses in
      let before = responses.paths
      XCTAssertFalse(session.isSignedIn)
      XCTAssertNil(session.bearerToken)
      XCTAssertTrue(vault.canUnlockLocally)
      XCTAssertTrue(auth.hasRememberedPassword)
      XCTAssertFalse(auth.hasSavedPassword)
      XCTAssertThrowsError(try auth.savedPassword(), "Expiry must not expose the stored password")
      let storedPassword = try Keychain.read("password-" + XCTUnwrap(session.accountId))
      let generation = try await auth.openRememberedAccount()
      XCTAssertEqual(generation, vault.generation)
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(Array(responses.paths.dropFirst(before.count)), ["/v1/auth/recovery/options", "/v1/auth/recovery/verify"])
      XCTAssertEqual(try Keychain.read("password-" + XCTUnwrap(session.accountId)), storedPassword)
      vault.lock()
      let renewedPaths = responses.paths
      _ = try await auth.openRememberedAccount()
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(responses.paths, renewedPaths, "A fresh session must open locally without another password proof")
    }
  }
  @MainActor func testRememberedRenewalFailureKeepsPasswordForExplicitRetry() async throws {
    try await withExpiredRememberedLogin { auth, session, vault, responses in
      responses.recoveryUnavailable = true
      do { _ = try await auth.openRememberedAccount(); XCTFail("Unavailable service renewed the account") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "CONTROLLED_RECOVERY_UNAVAILABLE") }
      XCTAssertFalse(session.isSignedIn)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertTrue(auth.hasRememberedPassword)
      XCTAssertFalse(auth.isOpeningRememberedAccount)
      responses.recoveryUnavailable = false
      _ = try await auth.openRememberedAccount()
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/recovery/options" }.count, 2)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/recovery/verify" }.count, 1)
    }
  }
  @MainActor func testRejectedCurrentRememberedSessionRenewsWithoutClearingAccountOrStoredPassword() async throws {
    try await withExpiredRememberedLogin { auth, session, vault, responses in
      _ = try await auth.openRememberedAccount()
      let account = try XCTUnwrap(session.accountId), token = session.bearerToken
      let password = try Keychain.read("password-" + account)
      let key = try vault.requireBundle().vaultKey
      let first = responses.paths.count
      responses.recoveryUnavailable = true
      do {
        _ = try await auth.openRememberedAccount(forceReauthentication: true)
        XCTFail("A rejected session must request fresh authentication")
      } catch let error as FotoroError {
        XCTAssertEqual(error.message, "CONTROLLED_RECOVERY_UNAVAILABLE")
      }
      XCTAssertEqual(session.accountId, account)
      XCTAssertEqual(session.bearerToken, token)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(try vault.requireBundle().vaultKey, key)
      XCTAssertEqual(try Keychain.read("password-" + account), password)
      XCTAssertEqual(Array(responses.paths.dropFirst(first)), ["/v1/auth/recovery/options"])
      responses.recoveryUnavailable = false
      let retry = responses.paths.count
      _ = try await auth.openRememberedAccount(forceReauthentication: true)
      XCTAssertEqual(Array(responses.paths.dropFirst(retry)), ["/v1/auth/recovery/options", "/v1/auth/recovery/verify"])
      XCTAssertEqual(session.accountId, account)
      XCTAssertEqual(try vault.requireBundle().vaultKey, key)
      XCTAssertEqual(try Keychain.read("password-" + account), password)
    }
  }
  @MainActor func testRememberedRenewalRejectsLateResponsesAfterCancellationLockAccountOrOriginChange() async throws {
    for path in ["/v1/auth/recovery/options", "/v1/auth/recovery/verify"] {
      for interruption in ["cancel", "lock", "account", "origin", "server"] {
        let gate = NativeLoginVaultGate(started: expectation(description: path + " " + interruption))
        defer { gate.release.signal() }
        try await withExpiredRememberedLogin(gate: gate, path: path) { auth, session, vault, responses in
          let persisted = try Keychain.read("session")
          let opening = Task { try await auth.openRememberedAccount() }
          await fulfillment(of: [gate.started], timeout: 3)
          let count = responses.paths.count
          do { _ = try await auth.openRememberedAccount(); XCTFail("Duplicate renewal was allowed") }
          catch let error as FotoroError { XCTAssertEqual(error.message, "Your Fotoro is already opening.") }
          XCTAssertEqual(responses.paths.count, count)
          switch interruption {
          case "cancel": opening.cancel()
          case "lock": vault.lock()
          case "account": session.accountId = Wire.id()
          case "server": auth.api.baseURL = URL(string: "https://replacement.invalid")!
          default: auth.api.baseURL = URL(string: "http://127.0.0.1:8790")!
          }
          gate.release.signal()
          do { _ = try await opening.value; XCTFail("Withdrawn renewal accepted a late response") }
          catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
          XCTAssertFalse(session.isSignedIn)
          XCTAssertNil(session.bearerToken)
          XCTAssertFalse(vault.isUnlocked)
          XCTAssertFalse(auth.isOpeningRememberedAccount)
          XCTAssertEqual(try Keychain.read("session"), persisted)
        }
      }
    }
  }
  @MainActor func testRememberedPasswordRejectsMissingMalformedDifferentAccountAndFixtureValues() async throws {
    try await withExpiredRememberedLogin { auth, session, vault, responses in
      let account = try XCTUnwrap(session.accountId), before = responses.paths
      let stored = try Keychain.read("password-" + account)
      let other = try RecoveryCode.format(accountId: Wire.id(), secret: Data(repeating: 1, count: 32))
      for value in [Data(), Data("malformed".utf8), Data(other.utf8)] {
        try Keychain.write(value, id: "password-" + account)
        XCTAssertFalse(auth.hasRememberedPassword)
        do { _ = try await auth.openRememberedAccount(); XCTFail("Invalid remembered password was used") } catch {}
        XCTAssertFalse(vault.isUnlocked)
        XCTAssertEqual(responses.paths, before)
      }
      Keychain.remove("password-" + account)
      XCTAssertFalse(auth.hasRememberedPassword)
      try Keychain.write(stored, id: "password-" + account)
      session.fixture = true
      XCTAssertFalse(auth.hasRememberedPassword)
      do { _ = try await auth.openRememberedAccount(); XCTFail("Fixture account attempted remembered sign-in") } catch {}
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(responses.paths, before)
    }
  }
  @MainActor func testInitialRestorationRenewsRememberedAccountWithoutDrainingQueuedPhotos() async throws {
    try await withExpiredRememberedLogin { auth, session, _, responses in
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      let services = try restoredRememberedServices(api: auth.api, root: root)
      defer { services.vault.lock(); try? FileManager.default.removeItem(at: root) }
      let account = try XCTUnwrap(session.accountId), photoID = Wire.id()
      let rep = RepresentationV1(binding: MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("cipher".utf8).digest)
      let photo = LocalPhoto(photoId: photoID, manifest: PhotoManifestV1(photoId: photoID, ownerAccountId: account, representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "public-test.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:]), transferState: "pending")
      try services.store.put(photo)
      try services.journal.enqueue(photo, publicSample: true)
      try services.store.setSyncEnabled(true)
      var scans = 0
      services.photosBackupSnapshot = { _ in scans += 1; return [] }
      let before = responses.paths
      await services.resumeSavedAccount(initialRestoration: true)
      XCTAssertTrue(services.session.isSignedIn)
      XCTAssertNotNil(services.photoAccountAccess)
      XCTAssertEqual(services.photos.map(\.id), [photoID])
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [photoID])
      XCTAssertFalse(try services.store.syncEnabled())
      XCTAssertEqual(scans, 0)
      XCTAssertEqual(Array(responses.paths.dropFirst(before.count)), ["/v1/auth/recovery/options", "/v1/auth/recovery/verify"])
      await services.resumeSavedAccount()
      XCTAssertEqual(responses.paths.count, before.count + 2)
    }
  }
  @MainActor func testRestorationDoesNotRenewOnForegroundManualLockMissingPasswordOrFixture() async throws {
    try await withExpiredRememberedLogin { auth, session, _, responses in
      let account = try XCTUnwrap(session.accountId), before = responses.paths
      let stored = try Keychain.read("password-" + account)
      let lockKey = "fotoro.manualLock." + account
      defer { UserDefaults.standard.removeObject(forKey: lockKey) }
      for condition in ["foreground", "manualLock", "missingPassword", "fixture"] {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
        let services = try restoredRememberedServices(api: auth.api, root: root)
        defer { services.vault.lock(); try? FileManager.default.removeItem(at: root) }
        if condition == "manualLock" { UserDefaults.standard.set(true, forKey: lockKey) }
        if condition == "missingPassword" { Keychain.remove("password-" + account) }
        if condition == "fixture" { services.session.fixture = true }
        await services.resumeSavedAccount(initialRestoration: condition != "foreground")
        XCTAssertFalse(services.vault.isUnlocked, condition)
        XCTAssertNil(services.photoAccountAccess, condition)
        XCTAssertEqual(responses.paths, before, condition)
        UserDefaults.standard.removeObject(forKey: lockKey)
        try Keychain.write(stored, id: "password-" + account)
      }
    }
  }
  @MainActor func testWrongPasswordCannotVerifyOrReplaceUnlockedAccountAndNetworkFailureStaysActionable() async throws {
    try await withIsolatedLogin(ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) {
      auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword), code = try RecoveryCode(password)
      try await auth.completeStart(code: password)
      let key = try vault.requireBundle().vaultKey
      let wrong = try RecoveryCode.format(accountId: code.accountId, secret: Data(repeating: 0, count: 32))
      for value in ["simple-weak-password", wrong,
        try RecoveryCode.format(accountId: Wire.id(), secret: code.secret)] {
        do { try await auth.loginWithCode(value); XCTFail("Invalid password authenticated") }
        catch let error as FotoroError { XCTAssertEqual(error.message, "Check your Fotoro password and try again.") }
        XCTAssertEqual(session.accountId, code.accountId)
        XCTAssertEqual(try vault.requireBundle().vaultKey, key)
        XCTAssertEqual(try auth.savedPassword(), password)
      }
      XCTAssertFalse(responses.paths.contains("/v1/auth/recovery/verify"))
      responses.recoveryUnavailable = true
      do { try await auth.loginWithCode(password); XCTFail("Failed request authenticated") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "CONTROLLED_RECOVERY_UNAVAILABLE") }
      XCTAssertEqual(try vault.requireBundle().vaultKey, key)
    }
  }
  @MainActor func testCancelledStartNeverPublishesGeneratedPasswordOrAcceptsLateSession() async throws {
    for path in ["/v1/auth/start/options", "/v1/auth/start/verify", "/v1/auth/recovery/options", "/v1/auth/recovery/verify"] {
      let gate = NativeLoginVaultGate(started: expectation(description: path + " is pending"))
      defer { gate.release.signal() }
      try await withIsolatedLogin(startGate: gate, startGatePath: path,
        ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) { auth, session, vault, responses in
        let task: Task<Void, Error>
        if path == "/v1/auth/start/options" { task = Task { try await auth.prepareStart() } }
        else {
          try await auth.prepareStart()
          let password = try XCTUnwrap(auth.startPassword)
          if path.contains("/recovery/") {
            responses.loseStartResponse = true
            do { try await auth.completeStart(code: password); XCTFail("Controlled response loss was hidden") }
            catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
          }
          task = Task { try await auth.completeStart(code: password) }
        }
        await fulfillment(of: [gate.started], timeout: 3)
        let count = responses.paths.count
        do {
          if path == "/v1/auth/start/options" { try await auth.prepareStart() }
          else { try await auth.completeStart(code: try XCTUnwrap(auth.startPassword)) }
          XCTFail("Duplicate action started while a request was pending")
        } catch let error as FotoroError { XCTAssertEqual(error.message, "Account setup is already in progress") }
        XCTAssertEqual(responses.paths.count, count)
        auth.cancelStart()
        gate.release.signal()
        do { try await task.value; XCTFail("Cancelled setup completed") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertNil(auth.startPassword)
        XCTAssertFalse(session.isSignedIn)
        XCTAssertFalse(vault.isUnlocked)
        XCTAssertFalse(Keychain.contains("password-" + responses.card.accountId))
      }
    }
  }
  @MainActor func testProtectedPasswordSaveFailureKeepsCompletedAccountAndRetriesWithoutEnrollment() async throws {
    var writes = 0
    try await withIsolatedLogin(rememberPassword: { bytes, id in
      writes += 1
      if writes == 1 { throw FotoroError("Controlled protected-storage failure") }
      try Keychain.write(bytes, id: id)
    }, ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) { auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword)
      do { try await auth.completeStart(code: password); XCTFail("Storage failure was hidden") }
      catch let error as FotoroError { XCTAssertTrue(error.message.contains("Keep a copy")) }
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(auth.startPassword, password)
      XCTAssertThrowsError(try auth.savedPassword())
      try await auth.completeStart(code: password)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertNil(auth.startPassword)
      XCTAssertEqual(writes, 2)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/start/verify" }.count, 1)
    }
  }
  @MainActor func testLostEnrollmentResponseContinuesWithSamePasswordWithoutSubmittingConsumedChallenge() async throws {
    try await withIsolatedLogin(ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) {
      auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword)
      responses.loseStartResponse = true
      do { try await auth.completeStart(code: password); XCTFail("Controlled response loss was hidden") }
      catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
      XCTAssertFalse(session.isSignedIn)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(auth.startPassword, password)
      try await auth.completeStart(code: password)
      XCTAssertTrue(session.isSignedIn)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertNil(auth.startPassword)
      XCTAssertEqual(responses.paths, ["/v1/auth/start/options", "/v1/auth/start/verify",
        "/v1/auth/recovery/options", "/v1/auth/recovery/verify"])
    }
  }
  @MainActor func testSessionStorageFailureAfterServerEnrollmentContinuesSameAccountWithoutCreatingAgain() async throws {
    var writes = 0
    try await withIsolatedLogin(persistSession: { bytes in
      writes += 1
      if writes == 1 { throw FotoroError("Controlled session storage failure") }
      try Keychain.write(bytes, id: "session")
    }, ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) { auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword), code = try RecoveryCode(password)
      do { try await auth.completeStart(code: password); XCTFail("Controlled session failure was hidden") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "Controlled session storage failure") }
      XCTAssertFalse(session.isSignedIn)
      XCTAssertEqual(auth.startPassword, password)
      try await auth.completeStart(code: password)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(session.accountId, code.accountId)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertEqual(writes, 2)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/start/verify" }.count, 1)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/recovery/verify" }.count, 1)
    }
  }
  @MainActor func testLocalBundleFailureDuringLostResponseRecoveryPreservesPasswordAndRetriesOnlyLocalUnlock() async throws {
    var writes = 0
    try await withIsolatedLogin(storeBundle: { bytes, id in
      writes += 1
      if writes == 1 { throw FotoroError("Controlled local bundle failure") }
      try Keychain.write(bytes, id: id)
    }, ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) { auth, session, vault, responses in
      try await auth.prepareStart()
      let password = try XCTUnwrap(auth.startPassword)
      responses.loseStartResponse = true
      do { try await auth.completeStart(code: password); XCTFail("Controlled response loss was hidden") }
      catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
      do { try await auth.completeStart(code: password); XCTFail("Controlled bundle failure was hidden") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "Controlled local bundle failure") }
      XCTAssertTrue(session.isSignedIn)
      XCTAssertFalse(vault.isUnlocked)
      XCTAssertEqual(auth.startPassword, password)
      let requests = responses.paths
      try await auth.completeStart(code: password)
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertEqual(writes, 2)
      XCTAssertEqual(responses.paths, requests)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/start/verify" }.count, 1)
    }
  }
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
  @MainActor func testAddPasskeyKeepsExistingIdentityRecoveryAndEncryptedBundle() async throws {
    var credential = Self.loginCredential
    credential.prf = Data(repeating: 7, count: 32)
    try await withIsolatedLogin(ceremony: { request in
      XCTAssertTrue(request is ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest)
      return credential
    }) { auth, session, vault, responses in
      try await auth.prepareStart()
      try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
      let account = try XCTUnwrap(session.accountId), bundle = try vault.requireBundle()
      let password = try auth.savedPassword(), before = responses.currentVault
      let ready = try await auth.addPasskey()
      XCTAssertTrue(ready)
      XCTAssertEqual(session.accountId, account)
      XCTAssertEqual(try vault.requireBundle().vaultKey, bundle.vaultKey)
      XCTAssertEqual(try auth.savedPassword(), password)
      let registration = try XCTUnwrap(responses.body(for: "/v1/auth/register/verify"))
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: registration) as? [String: Any])
      let enrollment = try Wire.decode(Enrollment.self, JSONSerialization.data(withJSONObject: XCTUnwrap(json["enrollment"])))
      XCTAssertEqual(enrollment.accountCard, try session.requireCard(account))
      XCTAssertEqual(enrollment.recoveryWrapper.wrapperId, before.wrappers.first?.wrapperId)
      let wrapper = try XCTUnwrap(responses.currentVault.wrappers.first(where: { $0.kind == "prf" }))
      let restored = try Wire.decode(AccountBundle.self, CryptoAdapter().unwrap(wrapper.wrappedBundle, key: XCTUnwrap(credential.prf)))
      XCTAssertEqual(restored.vaultKey, bundle.vaultKey)
      XCTAssertEqual(restored.signingSecretKey, bundle.signingSecretKey)
      let wire = String(data: registration, encoding: .utf8)!
      XCTAssertFalse(wire.contains(bundle.vaultKey)); XCTAssertFalse(wire.contains(password))
      XCTAssertFalse(wire.contains(credential.prf!.b64))
    }
  }
  @MainActor func testAddPasskeyWithoutPRFOrWrapperStorageKeepsPasswordAccess() async throws {
    for failedStorage in [false, true] {
      try await withIsolatedLogin(wrapperFail: failedStorage, ceremony: { _ in
        var result = Self.loginCredential
        result.prf = failedStorage ? Data(repeating: 7, count: 32) : nil
        return result
      }) { auth, _, vault, _ in
        try await auth.prepareStart(); try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
        let password = try auth.savedPassword(), key = try vault.requireBundle().vaultKey
        let ready = try await auth.addPasskey()
        XCTAssertFalse(ready)
        XCTAssertTrue(vault.isUnlocked)
        XCTAssertEqual(try auth.savedPassword(), password)
        XCTAssertEqual(try vault.requireBundle().vaultKey, key)
      }
    }
  }
  @MainActor func testSupportedRegistrationWithoutOutputVerifiesSelectedCredentialBeforeWrapping() async throws {
    var salt: Data?, ceremonies = 0
    try await withIsolatedLogin(allowedCredentials: [["type": "public-key", "id": Self.loginCredential.credentialId]], ceremony: { request in
      ceremonies += 1
      var result = Self.loginCredential
      if let registration = request as? ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest {
        salt = try XCTUnwrap(registration.prf?.inputValues?.saltInput1)
        result.prfSupported = true
      } else {
        let assertion = try XCTUnwrap(request as? ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
        XCTAssertEqual(assertion.allowedCredentials.map(\.credentialID), [Data([1])])
        XCTAssertEqual(assertion.prf?.perCredentialInputValues?[Data([1])]?.saltInput1, salt)
        XCTAssertEqual(assertion.userVerificationPreference, .required)
        result.prf = Data(repeating: 7, count: 32)
      }
      return result
    }) { auth, session, vault, responses in
      try await auth.prepareStart(); try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
      let bundle = try vault.requireBundle(), password = try auth.savedPassword()
      let ready = try await auth.addPasskey()
      XCTAssertTrue(ready)
      XCTAssertEqual(ceremonies, 2)
      let wrapper = try XCTUnwrap(responses.currentVault.wrappers.first { $0.kind == "prf" })
      XCTAssertEqual(wrapper.prfSalt, salt?.b64)
      let unwrapped = try Wire.decode(AccountBundle.self, CryptoAdapter().unwrap(wrapper.wrappedBundle, key: Data(repeating: 7, count: 32)))
      XCTAssertEqual(unwrapped.vaultKey, bundle.vaultKey)
      XCTAssertEqual(try auth.savedPassword(), password)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      let verify = try XCTUnwrap(responses.paths.lastIndex(of: "/v1/auth/login/verify"))
      let publish = try XCTUnwrap(responses.paths.firstIndex { $0.hasPrefix("/v1/vault/wrappers/") })
      XCTAssertLessThan(verify, publish)
    }
  }
  @MainActor func testSupportedRegistrationRejectsDifferentAssertionCredentialWithoutWrapper() async throws {
    try await withIsolatedLogin(ceremony: { request in
      var result = Self.loginCredential
      if request is ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest { result.prfSupported = true }
      else { result.credentialId = Data([2]).b64; result.prf = Data(repeating: 7, count: 32) }
      return result
    }) { auth, _, vault, responses in
      try await auth.prepareStart(); try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
      do { _ = try await auth.addPasskey(); XCTFail("Different assertion credential was wrapped") }
      catch { XCTAssertEqual(error.localizedDescription, "PRF credential mismatch") }
      XCTAssertTrue(vault.isUnlocked)
      XCTAssertFalse(responses.paths.contains("/v1/auth/login/verify"))
      XCTAssertFalse(responses.paths.contains { $0.hasPrefix("/v1/vault/wrappers/") })
    }
  }
  @MainActor func testSupportedRegistrationStopsAfterAssertionContextWithdrawal() async throws {
    for withdrawal in ["lock", "account", "origin", "cancel"] {
      var invalidate: (() -> Void)?
      try await withIsolatedLogin(ceremony: { request in
        var result = Self.loginCredential
        if request is ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest { result.prfSupported = true }
        else { invalidate?(); result.prf = Data(repeating: 7, count: 32) }
        return result
      }) { auth, session, vault, responses in
        try await auth.prepareStart(); try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
        var adding: Task<Bool, Error>?
        invalidate = {
          switch withdrawal {
          case "lock": vault.lock()
          case "account": session.accountId = Wire.id()
          case "origin": auth.api.baseURL = URL(string: "http://localhost:8787")!
          default: adding?.cancel()
          }
        }
        adding = Task { try await auth.addPasskey() }
        do { _ = try await adding!.value; XCTFail("Withdrawn \(withdrawal) context published a wrapper") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertFalse(responses.paths.contains("/v1/auth/login/verify"))
        XCTAssertFalse(responses.paths.contains { $0.hasPrefix("/v1/vault/wrappers/") })
      }
    }
  }
  @MainActor func testPasskeyTaskCancellationReleasesCeremonyAndIgnoresOldControllerCallback() async throws {
    let firstStarted = expectation(description: "First ceremony started")
    let secondStarted = expectation(description: "Replacement ceremony started")
    var controllers: [ASAuthorizationController] = [], cancellations = 0
    let ceremony = PasskeyCeremony(performRequests: { controller in
      controllers.append(controller)
      (controllers.count == 1 ? firstStarted : secondStarted).fulfill()
    }, cancelRequest: { _ in cancellations += 1 })
    func request() -> ASAuthorizationRequest {
      ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: "fotoro.cloud")
        .createCredentialAssertionRequest(challenge: Data([1]))
    }
    let first = Task { try await ceremony.perform(request()) }
    await fulfillment(of: [firstStarted], timeout: 2)
    first.cancel()
    do { _ = try await first.value; XCTFail("Cancelled ceremony returned a credential") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(cancellations, 1)
    var secondCompleted = false
    let second = Task {
      defer { secondCompleted = true }
      return try await ceremony.perform(request())
    }
    await fulfillment(of: [secondStarted], timeout: 2)
    ceremony.authorizationController(controller: controllers[0], didCompleteWithError:
      NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.canceled.rawValue))
    await Task.yield()
    XCTAssertFalse(secondCompleted)
    ceremony.authorizationController(controller: controllers[1], didCompleteWithError:
      NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.failed.rawValue))
    do { _ = try await second.value; XCTFail("Failed replacement returned a credential") }
    catch let error as ASAuthorizationError { XCTAssertEqual(error.code, .failed) }
    XCTAssertEqual(cancellations, 1)
  }
  @MainActor func testAddPasskeyLockDuringCeremonyCannotRegisterOrPublishWrapper() async throws {
    var lock: (() -> Void)?
    try await withIsolatedLogin(ceremony: { _ in lock?(); return Self.loginCredential }) { auth, session, vault, responses in
      try await auth.prepareStart(); try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
      lock = { vault.lock() }
      do { _ = try await auth.addPasskey(); XCTFail("Locked account published a passkey") }
      catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertFalse(vault.isUnlocked); XCTAssertTrue(session.isSignedIn)
      XCTAssertFalse(responses.paths.contains("/v1/auth/register/verify"))
      XCTAssertFalse(responses.paths.contains(where: { $0.hasPrefix("/v1/vault/wrappers/") }))
    }
  }
  @MainActor func testFreshPasskeyFindsEncryptedWrapperAndUnlocksSameCredential() async throws {
    var ceremonies = 0
    try await withIsolatedLogin(ceremony: { request in
      ceremonies += 1
      let assertion = try XCTUnwrap(request as? ASAuthorizationPlatformPublicKeyCredentialAssertionRequest)
      var result = Self.loginCredential
      if ceremonies == 2 {
        XCTAssertEqual(assertion.allowedCredentials.map(\.credentialID), [Data([1])])
        result.prf = Data(repeating: 7, count: 32)
      }
      return result
    }) { auth, session, vault, responses in
      let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
      let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
      responses.setVault(VaultV1(version: 1, accountCard: responses.card, wrappers: [VaultWrapperV1(version: 1,
        wrapperId: Wire.id(), kind: "prf", credentialId: Self.loginCredential.credentialId,
        prfSalt: Data(repeating: 9, count: 32).b64,
        wrappedBundle: try CryptoAdapter().wrap(Wire.encode(bundle), key: Data(repeating: 7, count: 32)), verified: false)]))
      let outcome = try await auth.login(discoverAccount: true)
      XCTAssertEqual(outcome, .unlocked); XCTAssertEqual(ceremonies, 2)
      XCTAssertEqual(session.accountId, responses.card.accountId)
      XCTAssertEqual(try vault.requireBundle().vaultKey, secret.vaultKey)
      XCTAssertEqual(responses.paths.filter { $0 == "/v1/auth/login/verify" }.count, 2)
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
        XCTAssertEqual(error.localizedDescription, "Passkey sign-in was cancelled.")
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
          XCTAssertEqual(error.localizedDescription, "Passkey sign-in could not finish. Enter your Fotoro password, or tap New Fotoro to start.")
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
      XCTAssertEqual(auth.fallbackMessage, "Enter your Fotoro password to unlock photos on this iPhone.")
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
  @MainActor private func withExpiredRememberedLogin(gate: NativeLoginVaultGate? = nil, path: String? = nil,
    check: @MainActor (NativeAuth, AccountSession, VaultStore, NativeLoginResponses) async throws -> Void) async throws {
    try await withIsolatedLogin(startGate: gate, startGatePath: path,
      ceremony: { _ in throw FotoroError("Unexpected passkey ceremony") }) { auth, session, _, responses in
      try await auth.prepareStart()
      try await auth.completeStart(code: XCTUnwrap(auth.startPassword))
      let expired = SessionV1(version: 1, accountId: try XCTUnwrap(session.accountId), deviceId: Wire.id(),
        expiresAt: "2000-01-01T00:00:00Z", token: "expired-public-controlled-session")
      try Keychain.write(Wire.encode(expired), id: "session")
      let restored = AccountSession()
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [NativeLoginProtocol.self]
      let api = APIClient(session: restored, baseURL: auth.api.baseURL, networkConfiguration: configuration,
        diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
      let vault = VaultStore(session: restored, api: api)
      let remembered = NativeAuth(session: restored, api: api, vault: vault,
        credentialCeremony: { _ in throw FotoroError("Unexpected passkey ceremony") })
      defer { vault.lock() }
      try await check(remembered, restored, vault, responses)
    }
  }
  @MainActor private func restoredRememberedServices(api: APIClient, root: URL) throws -> AppServices {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NativeLoginProtocol.self]
    let services = try AppServices(root: root, networkConfiguration: configuration,
      diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    services.api.baseURL = api.baseURL
    return services
  }
  @MainActor private func withIsolatedLogin(optionsFail: Bool = false, enrolled: Bool = false,
    allowedCredentials: [[String: Any]]? = nil,
    vaultGate: NativeLoginVaultGate? = nil, wrapperFail: Bool = false,
    startGate: NativeLoginVaultGate? = nil, startGatePath: String? = nil,
    persistSession: ((Data) throws -> Void)? = nil,
    storeBundle: (@MainActor (Data, String) throws -> Void)? = nil,
    rememberPassword: (@MainActor (Data, String) throws -> Void)? = nil,
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
      Keychain.remove("password-" + card.accountId)
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
      allowedCredentials: allowedCredentials, vaultGate: vaultGate, wrapperFail: wrapperFail,
      startGate: startGate, startGatePath: startGatePath)
    NativeLoginProtocol.responses.insert(responses, for: host)
    let session = AccountSession(persistSession: persistSession ?? { try Keychain.write($0, id: "session") })
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
    let vault = VaultStore(session: session, api: api, storeBundle: storeBundle)
    let auth = NativeAuth(session: session, api: api, vault: vault, credentialCeremony: ceremony,
      rememberPassword: rememberPassword)
    vault.onLock = { [weak auth] in auth?.cancelStart() }
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
  private let startGate: NativeLoginVaultGate?
  private let startGatePath: String?
  private let startOptions: StartOptionsResponse
  private let recoveryChallengeId = Wire.id()
  private let recoveryChallenge = Data(repeating: 19, count: 32).b64
  private let lock = NSLock()
  private var requestedPaths: [String] = []
  private var requestBodies: [String: Data] = [:]
  private var enrolledVault: VaultV1?
  private var unavailable = false
  private var loseResponse = false
  init(card: AccountCardV1, optionsFail: Bool, allowedCredentials: [[String: Any]]?,
    vaultGate: NativeLoginVaultGate?, wrapperFail: Bool,
    startGate: NativeLoginVaultGate?, startGatePath: String?) throws {
    self.card = card
    self.optionsFail = optionsFail
    self.vaultGate = vaultGate; self.wrapperFail = wrapperFail
    self.startGate = startGate; self.startGatePath = startGatePath
    startOptions = StartOptionsResponse(version: 1, accountId: card.accountId,
      challengeId: Wire.id(), challenge: Data(repeating: 13, count: 32).b64,
      expiresAt: "2099-01-01T00:00:00Z")
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
  var currentVault: VaultV1 {
    lock.lock(); defer { lock.unlock() }
    return enrolledVault ?? (try! Wire.decode(VaultV1.self, vaultBytes))
  }
  func setVault(_ vault: VaultV1) {lock.lock(); enrolledVault = vault; lock.unlock()}
  var recoveryUnavailable: Bool {
    get { lock.lock(); defer { lock.unlock() }; return unavailable }
    set { lock.lock(); unavailable = newValue; lock.unlock() }
  }
  var loseStartResponse: Bool {
    get { lock.lock(); defer { lock.unlock() }; return loseResponse }
    set { lock.lock(); loseResponse = newValue; lock.unlock() }
  }
  func body(for path: String) -> Data? {
    lock.lock(); defer { lock.unlock() }
    return requestBodies[path]
  }
  private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { throw FotoroError("Missing controlled request body") }
    stream.open()
    defer { stream.close() }
    var body = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw stream.streamError ?? FotoroError("Cannot read controlled request") }
      if count == 0 { return body }
      body.append(contentsOf: buffer.prefix(count))
    }
  }
  func response(to request: URLRequest) throws -> (Int, Data) {
    let path = request.url!.path
    lock.lock(); requestedPaths.append(path); lock.unlock()
    if path == startGatePath {
      startGate?.started.fulfill()
      if let startGate { _ = startGate.release.wait(timeout: .now() + 5) }
    }
    switch (request.httpMethod, path) {
    case ("POST", "/v1/auth/start/options"):
      let body = try requestBody(request)
      let value = try Wire.decode(StartOptionsRequest.self, body)
      guard value.version == 1, value.client == "native" else { throw FotoroError("Incorrect start options request") }
      return (200, try Wire.encode(startOptions))
    case ("POST", "/v1/auth/start/verify"):
      let bytes = try requestBody(request), value = try Wire.decode(StartVerify.self, bytes)
      let enrollment = value.enrollment, crypto = CryptoAdapter()
      guard value.version == 1, value.client == "native", value.challengeId == startOptions.challengeId,
        enrollment.version == 1, enrollment.accountCard.accountId == card.accountId,
        enrollment.recoveryWrapper.kind == "recovery", enrollment.recoveryWrapper.verified,
        enrollment.recoveryWrapper.credentialId == nil, enrollment.recoveryWrapper.prfSalt == nil
      else { throw FotoroError("Incorrect start enrollment") }
      let enrollmentProof = try Wire.decode(EnrollmentProof.self,
        crypto.verify(enrollment.proof, card: enrollment.accountCard, kind: "account-enrollment"))
      guard enrollmentProof.accountCard == enrollment.accountCard,
        try Wire.encode(enrollmentProof.recoveryWrapper) == Wire.encode(enrollment.recoveryWrapper)
      else { throw FotoroError("Enrollment proof binding failed") }
      let proof = try Wire.decode(RecoveryProof.self,
        crypto.verify(value.signedPayload, card: enrollment.accountCard, kind: "start-enrollment"))
      guard proof.version == 1, proof.client == "native", proof.accountId == card.accountId,
        proof.challengeId == startOptions.challengeId, proof.challenge == startOptions.challenge,
        proof.origin == request.value(forHTTPHeaderField: "Origin")
      else { throw FotoroError("Start proof binding failed") }
      lock.lock()
      requestBodies[path] = bytes
      enrolledVault = VaultV1(version: 1, accountCard: enrollment.accountCard, wrappers: [enrollment.recoveryWrapper])
      lock.unlock()
      if loseStartResponse { throw URLError(.networkConnectionLost) }
      return (200, sessionBytes)
    case ("POST", "/v1/auth/recovery/options"):
      if recoveryUnavailable { return (503, Data(#"{"code":"CONTROLLED_RECOVERY_UNAVAILABLE","retryable":true}"#.utf8)) }
      let value = try Wire.decode(AuthOptionsRequest.self, requestBody(request))
      guard value.accountId == card.accountId else { return (404, Data(#"{"code":"NOT_FOUND","retryable":false}"#.utf8)) }
      lock.lock(); let vault = enrolledVault; lock.unlock()
      guard let vault else { return (404, Data(#"{"code":"NOT_FOUND","retryable":false}"#.utf8)) }
      return (200, try Wire.encode(RecoveryOptionsResponse(version: 1,
        challengeId: recoveryChallengeId, challenge: recoveryChallenge,
        expiresAt: "2099-01-01T00:00:00Z", vault: vault)))
    case ("POST", "/v1/auth/recovery/verify"):
      let value = try Wire.decode(RecoveryVerify.self, requestBody(request))
      lock.lock(); let vault = enrolledVault; lock.unlock()
      guard let vault else { throw FotoroError("No controlled account enrolled") }
      let proof = try Wire.decode(RecoveryProof.self,
        CryptoAdapter().verify(value.signedPayload, card: vault.accountCard, kind: "recovery-session"))
      guard value.version == 1, value.client == "native", value.challengeId == recoveryChallengeId,
        proof.version == 1, proof.client == "native", proof.accountId == card.accountId,
        proof.challengeId == recoveryChallengeId, proof.challenge == recoveryChallenge,
        proof.origin == request.value(forHTTPHeaderField: "Origin")
      else { throw FotoroError("Recovery proof binding failed") }
      return (200, sessionBytes)
    case ("POST", "/v1/auth/login/options"):
      if optionsFail { return (503, Data(#"{"code":"LOGIN_OPTIONS_BLOCKED","retryable":true}"#.utf8)) }
      return (200, optionsBytes)
    case ("POST", "/v1/auth/login/verify"): return (200, sessionBytes)
    case ("GET", "/v1/vault"):
      vaultGate?.started.fulfill()
      if let vaultGate { _ = vaultGate.release.wait(timeout: .now() + 5) }
      return (200, try Wire.encode(currentVault))
    case ("POST", "/v1/auth/register/options"):
      let bytes = try requestBody(request)
      lock.lock(); requestBodies[path] = bytes; lock.unlock()
      return (200, try JSONSerialization.data(withJSONObject: ["version": 1,
        "challengeId": "public-register-challenge", "accountId": card.accountId,
        "options": ["challenge": "AQ", "user": ["id": Data(card.accountId.utf8).b64]]]))
    case ("POST", "/v1/auth/register/verify"):
      let bytes = try requestBody(request)
      lock.lock(); requestBodies[path] = bytes; lock.unlock()
      return (200, sessionBytes)
    default:
      if wrapperFail, request.httpMethod == "PUT", path.hasPrefix("/v1/vault/wrappers/") {
        return (503, Data(#"{"code":"CONTROLLED_WRAPPER_FAILURE","retryable":true}"#.utf8))
      }
      if request.httpMethod == "PUT", path.hasPrefix("/v1/vault/wrappers/") {
        let bytes = try requestBody(request), wrapper = try Wire.decode(VaultWrapperV1.self, bytes)
        var vault = currentVault; vault.wrappers.append(wrapper); setVault(vault)
        lock.lock(); requestBodies[path] = bytes; lock.unlock()
        return (200, bytes)
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
