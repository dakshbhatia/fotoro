import XCTest
@testable import Fotoro

final class ConsumerCoreTests: XCTestCase {
  func testUnknownTotalsAreOmittedAndQueuedPhotosDoNotCountAsCompleted() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.pending = 2
    let summary = ConsumerSyncSummary.derive(facts)
    XCTAssertEqual(summary.completedPhotos, 0)
    XCTAssertNil(summary.totalPhotos)
    XCTAssertEqual(summary.state, .needsAttention)
  }
  func testPausePrecedesOfflineAndLockedSnapshotDropsPrivateCounts() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.paused = true
    facts.offline = true
    facts.completed = 12
    facts.total = 13
    facts.skipped = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .paused)
    facts.unlocked = false
    let locked = ConsumerSyncSummary.derive(facts)
    XCTAssertNil(locked.completedPhotos)
    XCTAssertNil(locked.totalPhotos)
    XCTAssertEqual(locked.skippedPhotos, 0)
    XCTAssertEqual(locked.action, .signIn)
  }
  func testSkippedOrPendingAnnotationsNeverClaimUpToDate() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.enabled = true
    facts.lastChecked = Date()
    facts.skipped = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .needsAttention)
    facts.skipped = 0
    facts.annotationsPending = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .needsAttention)
    facts.annotationsPending = 0
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
  }
  func testVerifiedMappingDeduplicatesOnlyCurrentRevisionAndOriginalDigest() throws {
    let photo = try samplePhoto()
    var source = BackupSource(id: "local", photoId: photo.id, phase: .committed, sourceRevision: "current", originalSha256: photo.metadata.originalSha256)
    let record = SearchRecord(id: "local", revision: "current")
    func duplicate(_ saved: LocalPhoto) -> Bool {
      ConsumerSearchBinding.duplicate(saved: saved, copies: ConsumerSearchBinding.verifiedCopies(sources: [source], records: [record.id: record]))
    }
    XCTAssertTrue(duplicate(photo))
    XCTAssertTrue(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    var altered = photo
    altered.metadata.originalSha256 = Data("different".utf8).digest
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: altered))
    XCTAssertFalse(duplicate(altered))
    source.sourceRevision = "old"
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
    source.sourceRevision = nil
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
    source.sourceRevision = "current"
    source.photoId = UUID().uuidString
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
  }
  @MainActor func testCloudOnlyReceiptAndLocalRankingSurviveLocalPermissionWithdrawal() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let defaults = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let services = try AppServices(root: root)
    defer {
      services.vault.lock()
      Keychain.remove(accounts.accounts[0].accountId)
      if let defaults { UserDefaults.standard.set(defaults, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: root)
    }
    services.session.accountId = accounts.accounts[0].accountId
    services.session.fixture = true
    try services.session.pin(accounts.accounts[0])
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: accounts.testSecrets[0].recoverySecret), wrapper: accounts.testSecrets[0].encryptedBundle))
    try services.activateAccount()
    let cloud = try samplePhoto()
    try services.store.put(cloud)
    let index = try SearchIndex()
    var localRecord = SearchRecord(id: "permitted-local")
    localRecord.labels = ["receipt"]
    localRecord.burstID = "known-burst"
    var child = SearchRecord(id: "permitted-child")
    child.labels = ["receipt"]
    child.burstID = "known-burst"
    child.capturedAt = Date(timeIntervalSince1970: 1)
    localRecord.capturedAt = Date(timeIntervalSince1970: 2)
    try index.replacePermitted([localRecord, child])
    let local = LocalSearchStore(index: index)
    let result = try await services.consumerSearch("receipt", local: local)
    XCTAssertEqual(result.map(\.photo), [.device("permitted-local"), .device("permitted-child"), .saved(cloud.id)])
    XCTAssertEqual(try services.consumerSavedPhoto(cloud.id)?.id, cloud.id)
    let gate = CatalogScanGate()
    var unrelated = try samplePhoto()
    unrelated.metadata.filename = "other.jpg"
    try services.store.put(unrelated)
    services.catalogSearchWillRead = { gate.visit() }
    let scan = Task { try await services.searchCatalog("receipt") }
    while gate.count == 0 { await Task.yield() }
    scan.cancel()
    gate.release.signal()
    do { _ = try await scan.value; XCTFail("Cancelled scan must not publish") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(gate.count, 1, "Parent cancellation must stop the actual catalog worker before it reads another photo")
    services.catalogSearchWillRead = nil
    local.auditAuthorization(status: .denied)
    let afterWithdrawal = try await services.consumerSearch("receipt", local: local)
    XCTAssertEqual(afterWithdrawal.map(\.photo), [.saved(cloud.id)])
    services.vault.lock()
    let afterLock = try await services.consumerSearch("receipt", local: local)
    XCTAssertTrue(afterLock.isEmpty)
    XCTAssertNil(services.consumerSyncSummary.completedPhotos)
    XCTAssertNil(try services.consumerSavedPhoto(cloud.id))
  }
  @MainActor func testSavedResolutionRejectsPendingAndOtherAccountRecords() async throws {
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let priorCards = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    defer {
      services.vault.lock(); Keychain.remove(accounts.accounts[0].accountId)
      if let priorCards { UserDefaults.standard.set(priorCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: services.storageRoot)
    }
    services.session.accountId = accounts.accounts[0].accountId
    services.session.fixture = true
    try services.session.pin(accounts.accounts[0])
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: accounts.testSecrets[0].recoverySecret), wrapper: accounts.testSecrets[0].encryptedBundle))
    try services.activateAccount()
    var photo = try samplePhoto()
    try services.store.put(photo)
    XCTAssertNotNil(try services.consumerSavedPhoto(photo.id))
    photo.metadata.filename = "../../receipt.jpg"
    photo.originalURL = try services.store.write(Data("jpg".utf8), name: "cache-original.jpg")
    try services.store.put(photo)
    let exported = try await services.consumerShareOriginal(photo)
    defer { try? FileManager.default.removeItem(at: exported.deletingLastPathComponent()) }
    XCTAssertEqual(exported.lastPathComponent, "receipt.jpg")
    XCTAssertNotEqual(exported, photo.originalURL)
    try FileManager.default.removeItem(at: XCTUnwrap(photo.originalURL))
    XCTAssertEqual(try? Data(contentsOf: exported), Data("jpg".utf8), "Owned share copy must survive cache eviction")

    photo.transferState = "pending"
    try services.store.put(photo)
    XCTAssertNil(try services.consumerSavedPhoto(photo.id))
    photo.transferState = "committed"
    photo.manifest.ownerAccountId = accounts.accounts[1].accountId
    try services.store.put(photo)
    XCTAssertNil(try services.consumerSavedPhoto(photo.id))
    photo.manifest.ownerAccountId = accounts.accounts[0].accountId
    photo.originalURL = try services.store.write(Data("jpg".utf8), name: "cache-original.jpg")
    try services.store.put(photo)
    var written: URL?
    services.consumerShareDidWrite = { written = $0 }
    let cancelled = Task { try await services.consumerShareOriginal(photo) }
    cancelled.cancel()
    do { _ = try await cancelled.value; XCTFail("Cancelled share cannot publish a copy") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertNil(written)
    services.consumerShareDidWrite = { written = $0; services.vault.lock() }
    do { _ = try await services.consumerShareOriginal(photo); XCTFail("Lock after export must reject the copy") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(written).deletingLastPathComponent().path))
    services.consumerShareDidWrite = nil
  }
  private func samplePhoto() throws -> LocalPhoto {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let owner = accounts.testSecrets[0]
    let id = Wire.id()
    let rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("cipher".utf8).digest)
    return LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: owner.accountId, representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "receipt.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:]), transferState: "committed")
  }
}

private final class CatalogScanGate: @unchecked Sendable {
  private let lock = NSLock()
  private var visits = 0
  let release = DispatchSemaphore(value: 0)
  var count: Int { lock.lock(); defer { lock.unlock() }; return visits }
  func visit() {
    lock.lock(); visits += 1; let first = visits == 1; lock.unlock()
    if first { _ = release.wait(timeout: .now() + 10) }
  }
}

extension ConsumerCoreTests {
  func testReleaseAPIRestorationIgnoresEverySavedOverride() {
    for saved in [nil, "http://127.0.0.1:8787", "http://localhost:8790", "https://old-api.invalid",
      "https://user:secret@fotoro.cloud", "https://fotoro.cloud?token=secret", "http://[invalid"] {
      XCTAssertEqual(APIURLPolicy.restored(saved, development: false), APIURLPolicy.canonical)
    }
    XCTAssertNil(APIURLPolicy.configured("http://127.0.0.1:8787", development: false))
    XCTAssertNil(APIURLPolicy.configured("https://old-api.invalid", development: false))
    XCTAssertEqual(APIURLPolicy.configured("https://fotoro.cloud:443/", development: false), APIURLPolicy.canonical)
  }
  func testDevelopmentAPIOverridesMustBeCredentialFreeOrigins() {
    for valid in ["http://127.0.0.1:8787", "http://localhost:8790", "https://dev-api.invalid"] {
      XCTAssertEqual(APIURLPolicy.restored(valid, development: true).absoluteString, valid)
    }
    for invalid in ["http://remote.invalid", "https://user:secret@fotoro.cloud", "https://fotoro.cloud?token=secret",
      "https://fotoro.cloud#secret", "https://fotoro.cloud/v1", "https://fotoro.cloud:65536", "http://[invalid"] {
      XCTAssertNil(APIURLPolicy.configured(invalid, development: true))
      XCTAssertEqual(APIURLPolicy.restored(invalid, development: true), APIURLPolicy.canonical)
    }
  }
  @MainActor func testAPIRejectedOriginsAndFixtureSecretsRecordAttemptsWithoutPrivateData() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let session = AccountSession()
    session.fixture = false
    let api = APIClient(session: session, baseURL: APIURLPolicy.canonical, diagnostics: diagnostics)
    do {
      _ = try await api.request("https://foreign.invalid/v1/auth/private-token?token=private-secret", method: "POST")
      XCTFail("Foreign origins must be rejected before networking")
    } catch { XCTAssertEqual((error as? FotoroError)?.message, "Untrusted API URL") }
    session.fixture = true
    do {
      _ = try await api.request("/v1/auth/private-token", method: "POST", body: Data("private-secret".utf8))
      XCTFail("Fixture credentials must be rejected before networking")
    } catch { XCTAssertEqual((error as? FotoroError)?.message, "Fixture secrets cannot leave loopback") }
    let events = try diagnosticEvents(diagnostics, file: file)
    XCTAssertEqual(events.map(\.outcome), [.started, .failed, .started, .failed])
    XCTAssertTrue(events.allSatisfy { $0.phase == .api && $0.endpoint == .auth && $0.method == .POST })
    let serialized = try String(contentsOf: file, encoding: .utf8)
    for secret in ["private-token", "private-secret", "foreign.invalid", "https://"] { XCTAssertFalse(serialized.contains(secret)) }
  }
  @MainActor func testAuthenticationRequestsUseTwentySecondTimeoutAndStartedOutcome() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let session = AccountSession(); session.fixture = false; session.bearerToken = nil
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AuthTimeoutProtocol.self]
    let api = APIClient(session: session, baseURL: URL(string: "https://auth-timeout.invalid")!,
      networkConfiguration: configuration, diagnostics: diagnostics)
    let data = try await api.request("/v1/auth/login/options", method: "POST")
    XCTAssertEqual(String(data: data, encoding: .utf8), "20.0")
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).map(\.outcome), [.started, .completed])
  }
  @MainActor func testRunClaimsBusyImmediatelyRejectsDuplicateAndRecordsCompletion() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: directory.appendingPathComponent("library"), diagnostics: diagnostics)
    services.error = "previous failure"
    let suspended = expectation(description: "First action suspended")
    var continuation: CheckedContinuation<Void, Never>?
    var actions = 0
    let first = try XCTUnwrap(services.run(phase: .auth) {
      actions += 1
      await withCheckedContinuation { continuation = $0; suspended.fulfill() }
    })
    defer { first.cancel(); continuation?.resume(); continuation = nil }
    XCTAssertTrue(services.busy)
    XCTAssertNil(services.error)
    XCTAssertNil(services.run(phase: .auth) { actions += 1 })
    await fulfillment(of: [suspended], timeout: 3)
    XCTAssertEqual(actions, 1)
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }.map(\.outcome), [.started])
    continuation?.resume(); continuation = nil
    await first.value
    XCTAssertFalse(services.busy)
    XCTAssertNil(services.error)
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }.map(\.outcome), [.started, .completed])
  }
  @MainActor func testRunRecordsFailureAllowsRetryAndClassifiesPasskeyCancellation() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: directory.appendingPathComponent("library"), diagnostics: diagnostics)
    let failed = try XCTUnwrap(services.run(phase: .auth) { throw NativePasskeyError(code: .failed) })
    await failed.value
    XCTAssertFalse(services.busy)
    XCTAssertNotNil(services.error)
    let retry = try XCTUnwrap(services.run(phase: .auth) {})
    XCTAssertTrue(services.busy)
    XCTAssertNil(services.error)
    await retry.value
    let cancelled = try XCTUnwrap(services.run(phase: .auth) { throw NativePasskeyError(code: .canceled) })
    await cancelled.value
    let fence = try XCTUnwrap(services.run(phase: .auth) { throw CancellationError() })
    await fence.value
    let events = try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }
    XCTAssertEqual(events.map(\.outcome), [.started, .failed, .started, .completed, .started, .cancelled, .started, .cancelled])
    XCTAssertEqual(events[1].authorizationCode, NativePasskeyError(code: .failed).code.rawValue)
    XCTAssertEqual(events[5].authorizationCode, NativePasskeyError(code: .canceled).code.rawValue)
    XCTAssertNil(events[7].authorizationCode)
    let serialized = try String(contentsOf: file, encoding: .utf8)
    XCTAssertFalse(serialized.contains(NativePasskeyError(code: .failed).localizedDescription))
    XCTAssertFalse(serialized.contains(NativePasskeyError(code: .canceled).localizedDescription))
  }
  private func diagnosticEvents(_ diagnostics: NativeDiagnostics, file: URL) throws -> [NativeDiagnosticEvent] {
    diagnostics.flush()
    return try Data(contentsOf: file).split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
  }
  func testRuntimeDiagnosticsCannotIncludeRequestPathsOrUntrustedIdentifiers() throws {
    XCTAssertEqual(NativeDiagnosticEndpoint(path: "/v1/background/uploads/private-id/staging"), .upload)
    let secret = "private-photo-recovery-query-token"
    let url = try XCTUnwrap(URL(string: "https://fotoro.cloud/v1/grants/\(secret)?token=\(secret)"))
    let event = NativeDiagnosticEvent(phase: .api, outcome: .failed,
      endpoint: NativeDiagnosticEndpoint(path: url.path), method: secret,
      elapsed: .infinity, status: 999, networkError: URLError(.notConnectedToInternet), requestId: secret)
    let serialized = try XCTUnwrap(String(data: JSONEncoder().encode(event), encoding: .utf8))
    XCTAssertFalse(serialized.contains(secret))
    XCTAssertFalse(serialized.contains("https://"))
    XCTAssertEqual(event.endpoint, .exchange)
    XCTAssertEqual(event.method, .OTHER)
    XCTAssertEqual(event.elapsedMS, 0)
    XCTAssertEqual(event.networkCode, URLError.notConnectedToInternet.rawValue)
    XCTAssertNil(event.requestId)
    XCTAssertNil(event.status)
  }
  func testRuntimeDiagnosticsPreserveCorrelationAndBoundTimingAndCounts() throws {
    let request = UUID()
    let event = NativeDiagnosticEvent(phase: .api, outcome: .failed, endpoint: .upload,
      method: "PUT", elapsed: 1.25, status: 408, requestId: request.uuidString,
      state: .offline, completed: -1, pending: Int.max)
    let decoded = try JSONDecoder().decode(NativeDiagnosticEvent.self, from: JSONEncoder().encode(event))
    XCTAssertEqual(decoded.requestId, request)
    XCTAssertEqual(decoded.elapsedMS, 1250)
    XCTAssertEqual(decoded.status, 408)
    XCTAssertEqual(decoded.completed, 0)
    XCTAssertEqual(decoded.pending, 1_000_000)
    XCTAssertEqual(decoded.state, .offline)
  }
  func testRuntimeDiagnosticsRotatePersistAndExcludeDeviceBackup() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    for index in 0..<200 {
      diagnostics.record(NativeDiagnosticEvent(phase: .sync, outcome: .changed, completed: index))
    }
    diagnostics.flush()
    let data = try Data(contentsOf: file)
    XCTAssertLessThanOrEqual(data.count, NativeDiagnostics.maximumBytes)
    var events = try data.split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
    XCTAssertEqual(events.count, 160)
    XCTAssertEqual(events.first?.completed, 40)
    XCTAssertEqual(events.last?.completed, 199)
    XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    let restored = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    restored.record(NativeDiagnosticEvent(phase: .app, outcome: .started))
    restored.flush()
    events = try Data(contentsOf: file).split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
    XCTAssertEqual(events.count, 160)
    XCTAssertEqual(events.first?.completed, 41)
    XCTAssertEqual(events.last?.phase, .app)
  }
}

private final class AuthTimeoutProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "auth-timeout.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url,
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(String(request.timeoutInterval).utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
