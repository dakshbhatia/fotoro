import XCTest

@testable import Fotoro

final class RecoveryTests: XCTestCase {
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
