import XCTest

@testable import Fotoro

final class TransferTests: XCTestCase {
  @MainActor func testJournalRestartAndTransactionalCursor() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let s = try AppServices(root: path)
    try await s.fixtureUnlock(index: 0)
    let importer = s.importer
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    let photo = try await importer.build(
      bytes: Data(contentsOf: url), filename: "singapore.jpg", accountId: s.session.accountId!,
      bundle: s.vault.requireBundle())
    try s.journal.enqueue(photo)
    try s.journal.enqueue(photo)
    let restarted = TransferJournal(store: s.store, api: s.api, vault: s.vault)
    XCTAssertEqual(try restarted.entries().count, 1)
    await restarted.resumePending()
    XCTAssertTrue(restarted.errors.isEmpty, "\(restarted.errors)")
    XCTAssertTrue(try restarted.entries().isEmpty)
    let committed = try s.store.photos().first { $0.photoId == photo.photoId }
    XCTAssertEqual(committed?.transferState, "committed")
    let before = try s.store.cursor()
    let page = ChangePageV1(
      version: 1,
      changes: [
        ChangeV1(
          cursor: "invalid", entity: "photo", entityId: Wire.id(), deleted: false, payload: nil)
      ], nextCursor: "invalid", hasMore: false)
    XCTAssertThrowsError(try s.store.apply(page, verified: [:]))
    XCTAssertEqual(try s.store.cursor(), before)
  }
  @MainActor func testAmbiguousCommitReconcilesWithoutStagedSource() async throws {
    let s = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try await s.fixtureUnlock(index: 0)
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    let photo = try await s.importer.build(
      bytes: Data(contentsOf: url), filename: "singapore.jpg", accountId: s.session.accountId!,
      bundle: s.vault.requireBundle())
    try s.journal.enqueue(photo)
    var entry = try XCTUnwrap(s.journal.entries().first)
    let rep = photo.manifest.representations[0]
    let id = rep.binding.representationId
    let reservation: UploadReservationV1 = try await s.api.post(
      "/v1/uploads/reserve",
      ReserveUploadV1(
        binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
        ciphertextSha256: rep.ciphertextSha256, operationId: id))
    entry.reservations[id] = reservation
    try s.journal.persist(entry)
    let staged = try XCTUnwrap(photo.staged[id])
    try await s.api.upload(Data(contentsOf: staged), to: reservation.stagingUrl)
    let commit = try await s.api.commit(reservation.uploadId)
    // Emulate process death after the server commits but before the local commit receipt persists.
    try FileManager.default.removeItem(at: staged)
    let restarted = TransferJournal(store: s.store, api: s.api, vault: s.vault)
    await restarted.resumePending()
    XCTAssertTrue(restarted.errors.isEmpty, "\(restarted.errors)")
    XCTAssertTrue(try restarted.entries().isEmpty)
    let restored = try XCTUnwrap(s.store.photos().first { $0.photoId == photo.photoId })
    XCTAssertEqual(restored.manifest.representations[0].objectId, commit.objectId)
    XCTAssertEqual(restored.metadata.originalSha256, photo.metadata.originalSha256)
  }

  @MainActor func testPromotedCommit503KeepsFailureAndRestoresWithoutStagedBytes() async throws {
    try await assertPromotedCommitRetry(failure: .unavailable)
  }

  @MainActor func testPromotedCommitNetworkFailureRestoresWithoutStagedBytes() async throws {
    try await assertPromotedCommitRetry(failure: .offline)
  }

  @MainActor private func assertPromotedCommitRetry(failure: CommitRetryFailure) async throws {
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let s = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try s.configureAPI("http://127.0.0.1:8787")
    try await s.auth.recover("fotoro1.\(account.accountId).\(account.recoverySecret)")
    try s.activateAccount()
    var baseline: ChangePageV1 = try await s.api.get("/v1/changes?media=1&limit=100")
    while baseline.hasMore {
      let cursor = try XCTUnwrap(baseline.nextCursor)
      baseline = try await s.api.get("/v1/changes?media=1&limit=100&cursor=" + cursor)
    }
    let cursor = baseline.nextCursor
    let url = try XCTUnwrap(Bundle.main.url(forResource: "singapore", withExtension: "jpg"))
    let photo = try await s.importer.build(
      bytes: Data(contentsOf: url), filename: "singapore.jpg", accountId: s.session.accountId!,
      bundle: s.vault.requireBundle())
    try s.journal.enqueue(photo)
    var entry = try XCTUnwrap(s.journal.entries().first)
    let target = try XCTUnwrap(photo.manifest.representations.first)
    var promoted: UploadCommitV1?
    for rep in photo.manifest.representations + [photo.manifest.metadataRepresentation] {
      let id = rep.binding.representationId
      let reservation: UploadReservationV1 = try await s.api.post(
        "/v1/uploads/reserve", ReserveUploadV1(binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
          ciphertextSha256: rep.ciphertextSha256, operationId: id))
      entry.reservations[id] = reservation
      try await s.api.upload(Data(contentsOf: XCTUnwrap(photo.staged[id])), to: reservation.stagingUrl)
      let receipt = try await s.api.commit(reservation.uploadId)
      if id == target.binding.representationId { promoted = receipt }
      else { entry.commits[id] = receipt }
    }
    try s.journal.persist(entry)
    for path in photo.staged.values { try FileManager.default.removeItem(at: path) }
    let receipt = try XCTUnwrap(promoted)
    let storageBefore: TransferStorageSnapshot = try await s.api.get("/v1/storage")
    let commitURL = s.api.baseURL.appendingPathComponent("v1/uploads/\(receipt.uploadId)/commit")
    CommitRetryProtocol.failures.set(failure, for: commitURL)
    defer { CommitRetryProtocol.failures.remove(commitURL) }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CommitRetryProtocol.self]
    let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
    let api = APIClient(session: s.session, baseURL: s.api.baseURL,
      networkConfiguration: configuration, diagnostics: diagnostics)
    let restarted = TransferJournal(store: s.store, api: api, vault: s.vault)

    await restarted.resumePending()
    let retained = try XCTUnwrap(restarted.entries().first)
    XCTAssertEqual(retained.reservations[target.binding.representationId]?.uploadId, receipt.uploadId)
    XCTAssertNil(retained.commits[target.binding.representationId])
    XCTAssertEqual(retained.commits.count, entry.commits.count)
    XCTAssertEqual(restarted.errors[photo.photoId], failure.localizedDescription)
    XCTAssertNil(try s.store.photos().first { $0.photoId == photo.photoId })
    let firstEvents = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    XCTAssertEqual(firstEvents.filter { $0.outcome == .started && $0.endpoint == .upload }.count, 1,
      "A transient commit failure must not reserve or upload again")

    await restarted.resumePending()
    XCTAssertTrue(restarted.errors.isEmpty, "\(restarted.errors)")
    XCTAssertTrue(try restarted.entries().isEmpty)
    let restored = try XCTUnwrap(s.store.photos().first { $0.photoId == photo.photoId })
    XCTAssertEqual(restored.transferState, "committed")
    XCTAssertEqual(restored.manifest.representations.first?.objectId, receipt.objectId)
    XCTAssertEqual(restored.metadata.originalSha256, photo.metadata.originalSha256)
    let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    XCTAssertEqual(events.filter { $0.outcome == .started && $0.endpoint == .upload }.count, 2,
      "Recovery should perform only the two commit reads, without PUT or reserve")
    let storageAfter: TransferStorageSnapshot = try await s.api.get("/v1/storage")
    XCTAssertEqual(storageAfter, storageBefore)
    var components = URLComponents()
    components.queryItems = [URLQueryItem(name: "media", value: "1"), URLQueryItem(name: "limit", value: "100")]
      + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
    let page: ChangePageV1 = try await s.api.get("/v1/changes?" + (components.percentEncodedQuery ?? ""))
    XCTAssertFalse(page.hasMore)
    XCTAssertEqual(page.changes.filter { $0.entity == "photo" && $0.entityId == photo.photoId }.count, 1)
    await restarted.resumePending()
    let replay: ChangePageV1 = try await s.api.get("/v1/changes?" + (components.percentEncodedQuery ?? ""))
    XCTAssertEqual(replay.changes.filter { $0.entity == "photo" && $0.entityId == photo.photoId }.count, 1)
  }

}

private struct TransferStorageSnapshot: Decodable, Equatable {
  let reservedBytes: Int
  let storedBytes: Int
}

private enum CommitRetryFailure: Sendable {
  case unavailable, offline
  var localizedDescription: String {
    switch self {
    case .unavailable:
      FotoroError("INTERNAL_ERROR", requestId: "12345678-1234-4234-8234-123456789abc", retryable: true).localizedDescription
    case .offline: URLError(.notConnectedToInternet).localizedDescription
    }
  }
}

// Only the first commit read is intercepted; all storage and catalog operations
// use the existing isolated public fixture API and its actual allocation ledger.
private final class CommitRetryFailures: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [URL: CommitRetryFailure] = [:]
  func set(_ value: CommitRetryFailure, for url: URL) { lock.lock(); defer { lock.unlock() }; values[url] = value }
  func contains(_ url: URL?) -> Bool { lock.lock(); defer { lock.unlock() }; return url.map { values[$0] != nil } ?? false }
  func remove(_ url: URL) { lock.lock(); defer { lock.unlock() }; values[url] = nil }
  func take(_ url: URL) -> CommitRetryFailure? { lock.lock(); defer { lock.unlock() }; return values.removeValue(forKey: url) }
}

private final class CommitRetryProtocol: URLProtocol, @unchecked Sendable {
  static let failures = CommitRetryFailures()
  override class func canInit(with request: URLRequest) -> Bool {
    request.httpMethod == "POST" && failures.contains(request.url)
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url, let failure = Self.failures.take(url) else {
      client?.urlProtocol(self, didFailWithError: URLError(.unknown)); return
    }
    switch failure {
    case .offline: client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    case .unavailable:
      let response = HTTPURLResponse(url: url, statusCode: 503, httpVersion: nil,
        headerFields: ["Content-Type": "application/json", "X-Request-Id": "12345678-1234-4234-8234-123456789abc"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data("{\"version\":1,\"code\":\"INTERNAL_ERROR\",\"retryable\":true}".utf8))
      client?.urlProtocolDidFinishLoading(self)
    }
  }
  override func stopLoading() {}
}
