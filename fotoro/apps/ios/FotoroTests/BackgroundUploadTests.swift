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

// These exercise APIClient's real URLSession error boundary, without contacting
// any account, fixture server or media store.
final class APIClientErrorTests: XCTestCase {
  private let reference = "12345678-1234-4234-8234-123456789abc"

  @MainActor private func client(diagnostics: NativeDiagnostics = .shared) -> APIClient {
    let account = AccountSession()
    account.fixture = false
    account.bearerToken = nil
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FailureResponseProtocol.self]
    return APIClient(session: account, baseURL: URL(string: "https://api-errors.invalid")!, networkConfiguration: configuration, diagnostics: diagnostics)
  }

  @MainActor func testJSONFailureKeepsConflictCodeAndPresentsOnlyOpaqueReference() async throws {
    do {
      _ = try await client().request("/conflict?cap=PRIVATE_CAP", method: "POST", body: Data("PRIVATE_PHOTO_BODY".utf8))
      XCTFail("Expected conflict")
    } catch let error as FotoroError {
      XCTAssertEqual(error.message, "VERSION_CONFLICT")
      XCTAssertEqual(error.localizedDescription, "VERSION_CONFLICT (reference: \(reference))")
      XCTAssertEqual(error.requestId, reference)
      XCTAssertEqual(error.retryable, true)
      XCTAssertFalse(error.localizedDescription.contains("PRIVATE_"))
    }
  }

  @MainActor func testMediaUploadRetainsTheSameFailureMetadata() async throws {
    do {
      try await client().upload(Data("PRIVATE_CIPHERTEXT".utf8), to: "/unavailable?cap=PRIVATE_CAP")
      XCTFail("Expected media failure")
    } catch let error as FotoroError {
      XCTAssertEqual(error.message, "INTERNAL_ERROR")
      XCTAssertEqual(error.requestId, reference)
      XCTAssertEqual(error.retryable, true)
      XCTAssertTrue(error.localizedDescription.contains(reference))
    }
  }
  @MainActor func testValidatedHeaderSupportReferenceWinsAndUsesSameLowercaseUIAndDiagnosticIdentity() async throws {
    let headerReference = "abcdefab-1234-4234-8234-123456789abc"
    for path in ["/header-only", "/header-first", "/invalid-header"] {
      let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
      let expected = path == "/invalid-header" ? reference : headerReference
      do {
        _ = try await client(diagnostics: diagnostics).request(path)
        XCTFail("Expected HTTP failure")
      } catch let error as FotoroError {
        XCTAssertEqual(error.requestId, expected)
        XCTAssertEqual(error.localizedDescription, "FORBIDDEN (reference: \(expected))")
        let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
        XCTAssertEqual(events.last?.requestId, UUID(uuidString: expected))
        XCTAssertEqual(events.last?.reason, .http)
        XCTAssertFalse(String(decoding: diagnostics.exportJSON(), as: UTF8.self).contains("PRIVATE_"))
      }
    }
  }

  @MainActor func testMalformedRequestIDAndNumericRetryableCannotBecomeSupportMetadata() async throws {
    for path in ["/malformed-id", "/numeric-retryable", "/false-retryable"] {
      do {
        _ = try await client().request(path)
        XCTFail("Expected rejection")
      } catch let error as FotoroError {
        XCTAssertEqual(error.message, "FORBIDDEN")
        XCTAssertNil(error.requestId)
        XCTAssertEqual(error.retryable, false)
        XCTAssertEqual(error.localizedDescription, "FORBIDDEN")
      }
    }
  }

  @MainActor func testMalformedHTTPBodiesUseStatusFallbackWithoutDecoderErrors() async throws {
    for path in ["/html", "/null", "/broken-json", "/wrong-code"] {
      do {
        _ = try await client().request(path)
        XCTFail("Expected HTTP error")
      } catch let error as FotoroError {
        XCTAssertEqual(error.message, "Network request failed (503)")
        XCTAssertEqual(error.localizedDescription, "Network request failed (503)")
        XCTAssertNil(error.requestId)
        XCTAssertEqual(error.retryable, false)
      }
    }
  }


}

private final class FailureResponseProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "api-errors.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let reference = "12345678-1234-4234-8234-123456789abc"
    let status: Int
    let body: String
    var headers = ["Content-Type": "application/json"]
    switch request.url!.path {
    case "/conflict":
      status = 409; body = "{\"version\":1,\"code\":\"VERSION_CONFLICT\",\"retryable\":true,\"requestId\":\"\(reference)\",\"private\":\"PRIVATE_SERVER_BODY\"}"
    case "/unavailable":
      status = 500; body = "{\"version\":1,\"code\":\"INTERNAL_ERROR\",\"retryable\":true,\"requestId\":\"\(reference)\"}"
    case "/malformed-id":
      status = 403; body = "{\"code\":\"FORBIDDEN\",\"retryable\":false,\"requestId\":\"private-token\\nnot-an-id\"}"
    case "/numeric-retryable":
      status = 403; body = "{\"code\":\"FORBIDDEN\",\"retryable\":1,\"requestId\":\"12345678123442348234123456789abc\"}"
    case "/false-retryable":
      status = 403; body = "{\"code\":\"FORBIDDEN\",\"retryable\":false}"
    case "/header-only":
      status = 403; body = "{\"code\":\"FORBIDDEN\"}"
      headers["X-Request-Id"] = "ABCDEFAB-1234-4234-8234-123456789ABC"
    case "/header-first":
      status = 403; body = "{\"code\":\"FORBIDDEN\",\"requestId\":\"\(reference)\"}"
      headers["X-Request-Id"] = "ABCDEFAB-1234-4234-8234-123456789ABC"
    case "/invalid-header":
      status = 403; body = "{\"code\":\"FORBIDDEN\",\"requestId\":\"\(reference)\"}"
      headers["X-Request-Id"] = "PRIVATE_INVALID_SUPPORT_VALUE"
    case "/null": status = 503; body = "null"
    case "/broken-json": status = 503; body = "{bad json"
    case "/wrong-code": status = 503; body = "{\"code\":42}"
    default: status = 503; body = "<html>PRIVATE_SERVER_BODY</html>"
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
