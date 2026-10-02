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
    facts.pending = 1
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
  func testSkippedPhotosNeedAttentionWhileLocalDraftsKeepSavedPhotosReady() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.completed = 1
    facts.lastChecked = Date()
    facts.skipped = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .needsAttention)
    facts.skipped = 0
    facts.annotationsPending = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).detail, "Photo changes are saved on this device.")
    facts.annotationsPending = 0
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start, "A finished batch must still allow another explicit Save")
  }
  func testManualSaveIsAvailableWhenIdleAndContinueRequiresActualQueue() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.paused = true
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start)
    facts.completed = 5
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start)
    facts.pending = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .continue)
    facts.paused = false
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .retry)
    facts.preparing = true
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .none)
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
  @MainActor func testAccountDiagnosticsEmitOnlyStateChangesWithoutIdentityOrCredentials() throws {
    let savedSession = try? Keychain.read("session")
    Keychain.remove("session")
    defer {
      if let savedSession { try? Keychain.write(savedSession, id: "session") }
      else { Keychain.remove("session") }
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: root.appendingPathComponent("app"), diagnostics: diagnostics)
    services.session.accountId = nil
    services.session.bearerToken = nil
    services.session.fixture = false
    services.refreshConsumerSyncSummary()
    let initial = try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }
    XCTAssertFalse(initial.isEmpty)
    XCTAssertEqual(initial.last?.accountState, .signedOut)
    services.refreshConsumerSyncSummary()
    services.refreshConsumerSyncSummary()
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }.count, initial.count)
    let account = Wire.id()
    let token = "private-account-status-token"
    services.session.accountId = account
    services.session.bearerToken = token
    services.refreshConsumerSyncSummary()
    services.session.fixture = true
    services.refreshConsumerSyncSummary()
    let events = try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }
    XCTAssertEqual(events.suffix(2).compactMap(\.accountState), [.recoveryRequired, .demo])
    XCTAssertTrue(events.allSatisfy { $0.phase == .app && $0.outcome == .changed && $0.requestId == nil && $0.completed == nil && $0.pending == nil })
    let bytes = try String(contentsOf: file, encoding: .utf8)
    XCTAssertFalse(bytes.contains(account))
    XCTAssertFalse(bytes.contains(token))
    for state in [NativeDiagnosticAccountState.signedOut, .locked, .recoveryRequired, .unlocked, .demo] {
      let event = NativeDiagnosticEvent(phase: .app, outcome: .changed, accountState: state)
      let decoded = try JSONDecoder().decode(NativeDiagnosticEvent.self, from: JSONEncoder().encode(event))
      XCTAssertEqual(decoded.accountState, state)
      XCTAssertNil(decoded.requestId)
    }
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

extension ConsumerCoreTests {
  @MainActor func testExplicitSavedLibraryOpenFetchesCatalogWithoutSendingQueuedOriginalsOrLocalDrafts() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Explicit catalog read started"))
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate) { services, server in
      var queued = try self.samplePhoto()
      queued.manifest.ownerAccountId = services.session.accountId!
      queued.transferState = "pending"
      try services.store.put(queued)
      try services.journal.enqueue(queued, publicSample: true)
      try services.reload()
      try services.setLabels(["local-only-draft"], photo: queued)
      let drafts = try services.annotations.ledger.pendingIDs()
      let refresh = SavedLibraryRefresh()
      XCTAssertTrue(server.requests.isEmpty)
      let opening = Task { await refresh.open(services) }
      await fulfillment(of: [gate.started], timeout: 3)
      XCTAssertTrue(refresh.isRefreshing)
      await refresh.open(services)
      await refresh.refresh(services)
      XCTAssertEqual(server.requests.count, 1, "Repeated taps cannot start a second catalog request")
      gate.release.signal()
      await opening.value
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertNil(refresh.error)
      XCTAssertEqual(try services.consumerSavedPhoto(server.photoID)?.metadata.filename, "remote-receipt.jpg")
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.id])
      XCTAssertEqual(try services.annotations.ledger.pendingIDs(), drafts)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      XCTAssertEqual(Set(server.requests.map(\.path)), ["/v1/changes", "/v1/objects/" + server.objectID, "/v1/grants"])
      let completed = server.requests.count
      await refresh.open(services)
      await services.resumeSavedAccount()
      XCTAssertEqual(server.requests.count, completed, "Reappearing and foreground restoration must not fetch again")
      services.vault.lock()
      refresh.cancel()
      try await services.vault.unlock(.localKeychain)
      try services.activateAccount()
      await refresh.open(services)
      XCTAssertGreaterThan(server.requests.count, completed, "Explicit unlock opens a fresh vault binding")
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testUnlockedUnactivatedAccountCannotReadWrongCatalogAndRemainsOpenable() async throws {
    try await withSavedLibrary { services, server in
      let refresh = SavedLibraryRefresh()
      services.store = try LibraryStore(root: services.storageRoot.appendingPathComponent(Wire.id()))
      XCTAssertTrue(services.vault.isUnlocked)
      XCTAssertNil(services.photoAccountAccess)
      await refresh.open(services)
      await refresh.refresh(services)
      do { try await services.sync(); XCTFail("An unactivated store was read") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "Open Fotoro before loading saved photos.") }
      XCTAssertTrue(server.requests.isEmpty)
      try services.activateAccount()
      XCTAssertNotNil(services.photoAccountAccess)
      await refresh.open(services)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSavedLibraryOpenTracksStoreReplacementWithinSameAccountAndVault() async throws {
    try await withSavedLibrary { services, server in
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      let completed = server.requests.count
      let generation = services.vault.generation
      let old = services.store
      try services.activateAccount()
      XCTAssertFalse(services.store === old)
      XCTAssertEqual(services.vault.generation, generation)
      await refresh.open(services)
      XCTAssertGreaterThan(server.requests.count, completed)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testFailedAccountActivationKeepsServicesTogetherAndAllowsExplicitRetry() async throws {
    try await withSavedLibrary { services, server in
      let originalStore = services.store, originalBackup = services.backup
      let originalJournal = services.journal
      try await originalStore.database.write { db in
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('backupSelection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [Data("invalid-json".utf8).b64])
      }
      XCTAssertThrowsError(try services.activateAccount())
      XCTAssertTrue(services.store === originalStore)
      XCTAssertTrue(services.backup === originalBackup)
      XCTAssertTrue(services.journal === originalJournal)
      XCTAssertNil(services.photoAccountAccess)
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      XCTAssertTrue(server.requests.isEmpty)
      try await originalStore.database.write { db in
        try db.execute(sql: "DELETE FROM state WHERE key='backupSelection'")
      }
      try services.activateAccount()
      XCTAssertNotNil(services.photoAccountAccess)
      await refresh.open(services)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSavedLibraryRefreshShowsFailureAndRetriesOnlyReadOnlyCatalogWork() async throws {
    try await withSavedLibrary(failFirst: true) { services, server in
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertEqual(refresh.error, "CONTROLLED_CATALOG_UNAVAILABLE")
      XCTAssertNil(try services.consumerSavedPhoto(server.photoID))
      await refresh.refresh(services)
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertNil(refresh.error)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2)
    }
  }
  @MainActor func testSavedLibrarySelectionSharesBothSearchChoicesAndRejectsChangedOrWithdrawnSources() async throws {
    try await withSavedLibrary { services, _ in
      var first = try self.samplePhoto(), second = try self.samplePhoto()
      first.manifest.ownerAccountId = services.session.accountId!
      second.manifest.ownerAccountId = services.session.accountId!
      first.metadata.filename = "first.jpg"; second.metadata.filename = "second.jpg"
      first.originalURL = try services.store.write(Data("one".utf8), name: "first-original.jpg")
      second.originalURL = try services.store.write(Data("two".utf8), name: "second-original.jpg")
      first.metadata.originalSha256 = Data("one".utf8).digest
      second.metadata.originalSha256 = Data("two".utf8).digest
      try services.store.put(first); try services.store.put(second); try services.reload()
      var selection = SavedPhotoSelection()
      selection.toggle(first)
      let secondQuery = try await services.searchCatalog("second.jpg")
      XCTAssertEqual(secondQuery.map(\.id), [second.id])
      selection.toggle(try XCTUnwrap(secondQuery.first))
      XCTAssertEqual(selection.count, 2)
      let choices = try selection.resolve(using: services.consumerSavedPhoto)
      XCTAssertEqual(Set(choices.map(\.id)), [first.id, second.id])
      var exports: [URL] = []
      defer { ConsumerShareExports.remove(exports) }
      for photo in choices { exports.append(try await services.consumerShareOriginal(photo)) }
      XCTAssertEqual(exports.count, selection.count)
      XCTAssertEqual(try Set(exports.map { try Data(contentsOf: $0) }), [Data("one".utf8), Data("two".utf8)])
      first.previewURL = try services.store.write(Data("preview".utf8), name: "fresh-preview.jpg")
      try services.store.put(first)
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 2, "Fresh cache fields do not change the chosen original")
      XCTAssertEqual(try selection.resolve(using: services.consumerSavedPhoto).first { $0.id == first.id }?.previewURL, first.previewURL)
      first.metadata.originalSha256 = Data("changed-original".utf8).digest
      try services.store.put(first)
      XCTAssertThrowsError(try selection.resolve(using: services.consumerSavedPhoto))
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 1)
      XCTAssertFalse(selection.contains(first.id))
      XCTAssertEqual(try selection.resolve(using: services.consumerSavedPhoto).map(\.id), [second.id])
      services.vault.lock()
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 0)
    }
  }
  @MainActor private func withSavedLibrary(gate: SavedLibraryRequestGate? = nil, failFirst: Bool = false,
    check: @MainActor (AppServices, SavedLibraryServer) async throws -> Void) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let previousCards = UserDefaults.standard.object(forKey: "fotoro.pinnedCards")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    var card = accounts.accounts[0]; card.accountId = Wire.id()
    let secret = accounts.testSecrets[0]
    let server = try SavedLibraryServer(card: card, secret: secret, gate: gate, failFirst: failFirst)
    SavedLibraryProtocol.server = server
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SavedLibraryProtocol.self]
    let services = try AppServices(root: directory, networkConfiguration: configuration,
      diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    defer {
      SavedLibraryProtocol.server = nil
      services.vault.lock(); Keychain.remove(card.accountId)
      if let previousCards { UserDefaults.standard.set(previousCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: directory)
    }
    services.api.baseURL = URL(string: "http://127.0.0.1:8796")!
    services.session.accountId = card.accountId; services.session.fixture = true
    try services.session.pin(card)
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
    try await check(services, server)
  }
}

private final class SavedLibraryRequestGate: @unchecked Sendable {
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  init(started: XCTestExpectation) { self.started = started }
}
private final class SavedLibraryServer: @unchecked Sendable {
  struct Request { var method: String; var path: String }
  let photoID = Wire.id(), objectID = Wire.id()
  private let lock = NSLock()
  private var recorded: [Request] = []
  private let gate: SavedLibraryRequestGate?
  private var failFirst: Bool
  private let page: Data
  private let metadata: Data
  init(card: AccountCardV1, secret: FixtureSecrets, gate: SavedLibraryRequestGate?, failFirst: Bool) throws {
    self.gate = gate; self.failFirst = failFirst
    let crypto = CryptoAdapter(), key = crypto.randomKey()
    let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata")
    let value = PhotoMetadataV1(filename: "remote-receipt.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(),
      dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:])
    metadata = try crypto.encrypt(Wire.encode(value), key: key, binding: binding)
    let rep = RepresentationV1(binding: binding, objectId: objectID, header: metadata.prefix(24).b64,
      ciphertextBytes: metadata.count, ciphertextSha256: metadata.digest)
    let manifest = PhotoManifestV1(photoId: photoID, ownerAccountId: card.accountId, representations: [],
      metadataRepresentation: rep, ownerWrappedMetadataKey: try crypto.wrap(key, key: Data(b64: secret.vaultKey)))
    let signed = try crypto.sign(manifest, kind: "photo-manifest", accountId: card.accountId,
      secret: Data(b64: secret.signingSecretKey))
    page = try Wire.encode(ChangePageV1(version: 1,
      changes: [ChangeV1(cursor: "1", entity: "photo", entityId: photoID, deleted: false, payload: signed)],
      nextCursor: "1", hasMore: false))
  }
  var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
  func response(_ request: URLRequest) throws -> (Int, Data) {
    guard request.httpMethod == "GET", let path = request.url?.path else { throw FotoroError("Catalog reading sent a write") }
    lock.lock(); recorded.append(Request(method: "GET", path: path)); let first = recorded.count == 1
    let fail = failFirst && path == "/v1/changes"; if fail { failFirst = false }; lock.unlock()
    if first, let gate { gate.started.fulfill(); _ = gate.release.wait(timeout: .now() + 5) }
    if fail { return (503, Data(#"{"code":"CONTROLLED_CATALOG_UNAVAILABLE","retryable":true}"#.utf8)) }
    if path == "/v1/changes" { return (200, page) }
    if path == "/v1/objects/" + objectID { return (200, metadata) }
    if path == "/v1/grants" { return (200, try Wire.encode(GrantInboxV1(version: 1, grants: []))) }
    throw FotoroError("Unexpected catalog read")
  }
}
private final class SavedLibraryProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var server: SavedLibraryServer?
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == 8796 }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let url = request.url, let server = Self.server else { throw FotoroError("Missing controlled catalog") }
      let (status, body) = try server.response(request)
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
