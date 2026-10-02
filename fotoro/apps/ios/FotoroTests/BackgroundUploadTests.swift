import XCTest

@testable import Fotoro

final class BackgroundUploadTests: XCTestCase {
  private let account = "11111111-1111-4111-8111-111111111111"
  private let photo = "22222222-2222-4222-8222-222222222222"
  private let representation = "33333333-3333-4333-8333-333333333333"
  private let upload = "44444444-4444-4444-8444-444444444444"
  private let origin = URL(string: "https://fotoro.cloud")!

  private var location: String {
    "https://fotoro.cloud/v1/uploads/\(upload)/staging?cap=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
  }
  private func identity() -> BackgroundUploadIdentity {
    BackgroundUploadIdentity(
      accountId: account, photoId: photo, representationId: representation, uploadId: upload)
  }
  private func ledger() throws -> BackgroundUploadLedger {
    try BackgroundUploadLedger(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
  }

  func testUploadURLRequiresExactOriginAndReservationPath() throws {
    let request = try BackgroundUploadPolicy.request(
      stagingURL: location, baseURL: origin, uploadId: upload, bytes: 100)
    XCTAssertEqual(
      request.url?.absoluteString,
      "https://fotoro.cloud/v1/background/uploads/\(upload)/staging?cap=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")
    XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
    XCTAssertFalse(request.httpShouldHandleCookies)
    for bad in [
      location.replacingOccurrences(of: "fotoro.cloud", with: "evil.example"),
      location.replacingOccurrences(of: "https:", with: "http:"),
      location.replacingOccurrences(of: "fotoro.cloud", with: "user:secret@fotoro.cloud"),
      location.replacingOccurrences(of: upload, with: photo),
      location.replacingOccurrences(of: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", with: "short"),
      location.replacingOccurrences(of: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", with: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF!"),
      location + "&cap=second", location + "&token=secret", location + "#fragment",
    ] {
      XCTAssertThrowsError(
        try BackgroundUploadPolicy.request(
          stagingURL: bad, baseURL: origin, uploadId: upload, bytes: 100))
    }
  }

  func testRestartKeepsSuccessfulUploadWithoutVaultOrCredentials() throws {
    let first = try ledger()
    try first.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try first.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    XCTAssertTrue(try first.complete(id, statusCode: 200, responseURL: origin, errorCode: nil))
    let restarted = try BackgroundUploadLedger(root: first.root)
    XCTAssertEqual(try restarted.record(id)?.state, .uploaded)
    XCTAssertFalse(try restarted.needsUpload(id))
    XCTAssertTrue(try restarted.complete(id, statusCode: 200, responseURL: origin, errorCode: nil))
    XCTAssertEqual(try restarted.records(accountId: account).count, 1)
  }

  func testAccountSwitchRejectsLateCompletionAndNewOldAccountTasks() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try ledger.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    try ledger.authorize(accountId: photo, fixture: false, baseURL: origin)
    XCTAssertFalse(try ledger.complete(id, statusCode: 200, responseURL: origin, errorCode: nil))
    XCTAssertEqual(try ledger.record(id)?.state, .cancelled)
    XCTAssertThrowsError(try ledger.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest"))
  }

  func testExplicitCancelAndLogoutRemainFencedAcrossRestart() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try ledger.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    try ledger.cancel(accountId: account)
    let restarted = try BackgroundUploadLedger(root: ledger.root)
    XCTAssertFalse(try restarted.complete(id, statusCode: 200, responseURL: origin, errorCode: nil))
    try restarted.authorize(accountId: nil, fixture: false, baseURL: origin)
    XCTAssertThrowsError(try restarted.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest"))
  }

  func testFixtureAndPublicSeedCannotAuthorizeBackgroundUploads() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: true, baseURL: origin)
    XCTAssertThrowsError(try ledger.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest"))
    try ledger.authorize(
      accountId: "00000000-0000-4000-8000-000000000001", fixture: false, baseURL: origin)
    XCTAssertThrowsError(try ledger.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest"))
  }

  func testForeignResponseAndInterruptedTaskNeverBecomeUploaded() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try ledger.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    XCTAssertTrue(
      try ledger.complete(id, statusCode: 200, responseURL: URL(string: "https://evil.example"), errorCode: nil))
    XCTAssertEqual(try ledger.record(id)?.state, .failed)
    let next = identity()
    try ledger.register(next, ciphertextBytes: 100, ciphertextSha256: "digest")
    try ledger.reconcile(live: [])
    XCTAssertEqual(try ledger.record(next)?.state, .failed)
  }

  func testDurableIdentityRoundTripAndWrongReservationCannotComplete() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try ledger.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    XCTAssertEqual(try BackgroundUploadIdentity.decode(id.taskDescription), id)
    var wrong = id
    wrong.uploadId = photo
    XCTAssertFalse(try ledger.complete(wrong, statusCode: 200, responseURL: origin, errorCode: nil))
    XCTAssertEqual(try ledger.record(id)?.state, .transferring)
  }

  func testOriginChangeInvalidatesPriorSuccessfulReceipt() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    let id = identity()
    try ledger.register(id, ciphertextBytes: 100, ciphertextSha256: "digest")
    try ledger.complete(id, statusCode: 200, responseURL: origin, errorCode: nil)
    try ledger.authorize(accountId: account, fixture: false, baseURL: URL(string: "https://other.example")!)
    XCTAssertEqual(try ledger.record(id)?.state, .cancelled)
  }

  func testOneRepresentationCannotHaveConcurrentAttemptsAndQueueIsBounded() throws {
    let ledger = try ledger()
    try ledger.authorize(accountId: account, fixture: false, baseURL: origin)
    try ledger.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest")
    XCTAssertThrowsError(try ledger.register(identity(), ciphertextBytes: 100, ciphertextSha256: "digest"))
    var second = identity()
    second.representationId = photo
    try ledger.register(second, ciphertextBytes: 100, ciphertextSha256: "digest")
    var third = identity()
    third.representationId = upload
    XCTAssertThrowsError(try ledger.register(third, ciphertextBytes: 100, ciphertextSha256: "digest"))
    XCTAssertEqual(try ledger.records(accountId: account).filter { $0.state == .transferring }.count, 2)
  }
}
