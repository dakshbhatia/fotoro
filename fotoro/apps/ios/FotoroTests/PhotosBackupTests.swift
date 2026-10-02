import GRDB
import XCTest

@testable import Fotoro

final class PhotosBackupTests: XCTestCase {
  @MainActor func testExplicitPausePreservesQueuedFilesAcrossForegroundAndProcessRestoration() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try await services.importFiles([context.sample])
    let queued = try XCTUnwrap(services.journal.entries().first)
    XCTAssertFalse(try services.store.syncEnabled())

    services.pauseSync()
    await services.resumeSavedAccount()
    XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" })
    XCTAssertTrue(PausedUploadProtocol.server.requests.contains { $0.path == "/v1/changes" })
    do {
      try await services.resumeTransfers()
      XCTFail("Retrying an upload must respect explicit Pause")
    } catch { XCTAssertTrue(error.localizedDescription.contains("paused")) }

    try context.persistSession(services)
    let restarted = try context.restoredServices()
    await restarted.resumeSavedAccount(initialRestoration: true)
    XCTAssertTrue(restarted.vault.isUnlocked)
    XCTAssertEqual(try restarted.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" })
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(queued.photo.originalURL)), try Data(contentsOf: context.sample))
    XCTAssertTrue(queued.photo.staged.values.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
    restarted.vault.lock()
  }

  @MainActor func testManualFilesBeforePhotosOptInAndExplicitContinueReleaseUploadFence() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    XCTAssertFalse(try services.store.syncEnabled())
    try await services.importFiles([context.sample])
    try await services.resumeTransfers()
    XCTAssertTrue(try services.journal.entries().isEmpty, "Manual Files imports work before Photos opt-in")
    let photo = try XCTUnwrap(services.store.photos().first)
    XCTAssertEqual(photo.transferState, "committed")
    try services.setLabels(["  Pending private label  "], photo: photo)
    services.pauseSync()
    let writesBeforeRefresh = PausedUploadProtocol.server.requests.filter { $0.method != "GET" }.count
    try await services.sync()
    XCTAssertEqual(PausedUploadProtocol.server.requests.filter { $0.method != "GET" }.count, writesBeforeRefresh)
    XCTAssertEqual(try services.annotations.ledger.pendingIDs(), [photo.id])
    XCTAssertEqual(try services.annotations.ledger.state(photo.id)?.revision, 0)
    XCTAssertEqual(services.annotation(photo).labels, ["  Pending private label  "])
    try await services.importFiles([context.sample])
    XCTAssertEqual(try services.journal.entries().count, 1, "Pause retains newly selected Files locally")

    var scans = 0
    services.photosBackupSnapshot = { _ in scans += 1; return [] }
    try await services.continueSync()
    try await services.resumeTransfers()
    XCTAssertTrue(try services.journal.entries().isEmpty)
    await services.syncAnnotations()
    XCTAssertTrue(try services.annotations.ledger.pendingIDs().isEmpty)
    XCTAssertEqual(try services.annotations.ledger.state(photo.id)?.revision, 1)
    XCTAssertFalse(try services.store.syncEnabled(), "Manual transfer Continue must never opt into Photos")
    XCTAssertEqual(scans, 0, "Manual transfer Continue must never query Photos")
    services.vault.lock()
  }

  @MainActor func testOptedInPausePreservesScope() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try services.store.setSyncIntent(enabled: true, uploadsPaused: false)
    services.pauseSync()
    XCTAssertTrue(try services.store.syncEnabled(), "Pause must retain previously explicit Photos consent")
    XCTAssertTrue(try services.store.uploadsPaused())
    var observedCutoff: Date?
    services.photosBackupSnapshot = { cutoff in observedCutoff = cutoff; return [] }
    let before = RecentPhotosPolicy.cutoff(now: Date())
    try await services.continueSync()
    await services.backup.waitUntilSettled()
    XCTAssertFalse(try services.store.uploadsPaused())
    XCTAssertTrue(try services.store.syncEnabled())
    XCTAssertEqual(try XCTUnwrap(observedCutoff).timeIntervalSince(before), 0, accuracy: 2)
    services.vault.lock()
  }

  @MainActor func testContinueWaitsForCancelledRunBeforeRestartingOptedInPhotos() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try services.store.setSyncIntent(enabled: true, uploadsPaused: false)
    let gate = BackupGate()
    services.backup.start(snapshot: { [BackupCandidate(id: "cancelled-source")] }, valid: { true },
      stage: { _, _ in await gate.wait() }, upload: { _ in XCTFail("Cancelled run cannot upload") }, checkCatalog: {})
    while !gate.entered { await Task.yield() }
    services.pauseSync()
    var resumedScans = 0
    services.photosBackupSnapshot = { _ in resumedScans += 1; return [] }
    let continuing = Task { try await services.continueSync() }
    while try services.store.uploadsPaused() { await Task.yield() }
    XCTAssertEqual(resumedScans, 0)
    gate.open()
    try await continuing.value
    await services.backup.waitUntilSettled()
    XCTAssertEqual(resumedScans, 1, "Continue must restart the opted-in scan after the cancelled task settles")
    services.vault.lock()
  }

  @MainActor func testNewPauseWhileContinueWaitsPreventsRestart() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try services.store.setSyncIntent(enabled: true, uploadsPaused: false)
    let gate = BackupGate()
    services.backup.start(snapshot: { [BackupCandidate(id: "cancelled-source")] }, valid: { true },
      stage: { _, _ in await gate.wait() }, upload: { _ in XCTFail("Cancelled run cannot upload") }, checkCatalog: {})
    while !gate.entered { await Task.yield() }
    services.pauseSync()
    var resumedScans = 0
    services.photosBackupSnapshot = { _ in resumedScans += 1; return [] }
    let continuing = Task { try await services.continueSync() }
    while try services.store.uploadsPaused() { await Task.yield() }
    services.pauseSync()
    gate.open()
    do { try await continuing.value; XCTFail("Newer Pause must cancel old Continue intent") }
    catch { XCTAssertTrue(error is CancellationError) }
    await services.backup.waitUntilSettled()
    XCTAssertEqual(resumedScans, 0)
    XCTAssertTrue(try services.store.uploadsPaused())
    services.vault.lock()
  }

  @MainActor func testManualContinueWaitsForInflightJournalThenResumesQueue() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try await services.importFiles([context.sample])
    let gate = UploadRequestGate()
    PausedUploadProtocol.server.reservationGate = gate
    let oldUpload = Task { try await services.resumeTransfers() }
    while gate.count == 0 { await Task.yield() }
    services.pauseSync()
    let continuing = Task { try await services.continueSync() }
    while try services.store.uploadsPaused() { await Task.yield() }
    gate.release.signal()
    try await oldUpload.value
    try await continuing.value
    XCTAssertTrue(try services.journal.entries().isEmpty, "Continue must resume after the cancelled journal pass releases its running guard")
    XCTAssertFalse(try services.store.syncEnabled())
    services.vault.lock()
  }

  @MainActor func testExplicitUploadPauseIsIsolatedToItsAccount() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let first = try await context.enroll()
    try await first.importFiles([context.sample])
    let firstID = try XCTUnwrap(first.journal.entries().first).photo.id
    first.pauseSync()

    let second = try await context.enroll(accountId: Wire.id())
    XCTAssertFalse(try second.store.syncEnabled())
    try await second.importFiles([context.sample])
    try await second.resumeTransfers()
    XCTAssertTrue(try second.journal.entries().isEmpty)
    XCTAssertEqual(try second.store.photos().first?.transferState, "committed")
    XCTAssertEqual(try first.journal.entries().map { $0.photo.id }, [firstID])
    let writesBeforeFirstResume = PausedUploadProtocol.server.requests.filter { $0.method != "GET" }.count
    await first.resumeSavedAccount()
    XCTAssertEqual(try first.journal.entries().map { $0.photo.id }, [firstID])
    XCTAssertEqual(PausedUploadProtocol.server.requests.filter { $0.method != "GET" }.count, writesBeforeFirstResume)
    first.vault.lock()
    second.vault.lock()
  }

  @MainActor func testOnlyCompletedCurrentPicksCreateNewIntakeAndQueuedUploadsSurvive() async throws {
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let candidates = [BackupCandidate(id: "picked", sourceRevision: "1"), BackupCandidate(id: "not-picked", sourceRevision: "1"), BackupCandidate(id: "changed", sourceRevision: "2")]
    let pickSources = candidates.map { AutomaticPhotoPickCandidate(id: $0.id, sourceRevision: "1", capturedAt: nil, width: 100, height: 100, favorite: false, isScreenshot: false) }
    let snapshot = PhotoPicksSnapshot(candidates: pickSources, recommendations: AutomaticPhotoPickRecommendations(ids: ["picked", "changed"], reasons: [:], groupCount: 3, duplicateCount: 0, unassessed: 0))
    XCTAssertTrue(PhotoPicksBackupPolicy.select(candidates, snapshot: nil).isEmpty, "Incomplete analysis must never mean upload all")
    XCTAssertEqual(PhotoPicksBackupPolicy.select(candidates, snapshot: snapshot).map(\.id), ["picked"])
    var queued = try store.backupSource("previously-accepted")
    queued.phase = .queued
    try store.putBackupSource(queued)
    var previous = try store.backupSource("old-unselected-failure")
    previous.phase = .failed
    try store.putBackupSource(previous)
    let backup = try PhotosBackup(store: store)
    var staged: [String] = []
    var uploaded: [String] = []
    backup.start(snapshot: { PhotoPicksBackupPolicy.select(candidates, snapshot: snapshot) }, valid: { true },
      stage: { source, _ in staged.append(source.id) }, upload: { uploaded.append($0.id) }, checkCatalog: {})
    await backup.waitUntilSettled()
    XCTAssertEqual(staged, ["picked"])
    XCTAssertEqual(uploaded, ["previously-accepted", "picked"])
    XCTAssertEqual(try store.backupSources().map(\.id).sorted(), ["old-unselected-failure", "picked", "previously-accepted"])
    XCTAssertEqual(backup.status.sourceTotal, 2)
    XCTAssertEqual(backup.status.failed, 0)
    XCTAssertEqual(backup.status.phase, .complete)
    XCTAssertEqual(try store.backupSource(previous.id).phase, .failed, "Excluded historical work is preserved")
  }
  @MainActor func testNewBackupCannotStageAfterConsentChangesDuringOriginalRead() async throws {
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let gate = BackupGate()
    let bytes = try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let importer = PhotoImport(store: store, sourceReader: { _ in await gate.wait(); return (bytes, "source.jpg", false) })
    let source = try store.backupSource("source")
    let run = Task {
      try await importer.stageBackup(source, accountId: secret.accountId,
        bundle: AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey), valid: { await gate.allowed })
    }
    while !gate.entered { await Task.yield() }
    gate.allowed = false
    gate.open()
    do { _ = try await run.value; XCTFail("Stale consent cannot create durable ciphertext or queue") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
    let queuedCount = try await store.database.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM transfers") }
    XCTAssertEqual(queuedCount, 0)
  }
  func testPublicSeedAccountsNeverAcceptPrivatePhotoSync() {
    for id in ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] {
      XCTAssertFalse(NativeBackupPolicy.allowsPrivatePhotos(accountId: id, fixture: false))
    }
    XCTAssertFalse(NativeBackupPolicy.allowsPrivatePhotos(accountId: Wire.id(), fixture: true))
    XCTAssertFalse(NativeBackupPolicy.allowsPrivatePhotos(accountId: nil, fixture: false))
    XCTAssertTrue(NativeBackupPolicy.allowsPrivatePhotos(accountId: Wire.id(), fixture: false))
  }
  @MainActor func testLegacyPublicQueueRemainsBlockedAndPreservedAfterRecoveryMode() async throws {
    let services = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    services.session.accountId = "00000000-0000-4000-8000-000000000001"
    services.session.fixture = false
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bytes =
      try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let photo = try await services.importer.build(
      bytes: bytes, filename: "singapore.jpg", accountId: account.accountId,
      bundle: AccountBundle(
        vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
        signingSecretKey: account.signingSecretKey))
    try services.journal.enqueue(photo)
    do {
      try await services.resumeTransfers()
      XCTFail("Public queue must be blocked")
    } catch { XCTAssertTrue(error.localizedDescription.contains("paused")) }
    XCTAssertEqual(try services.journal.entries().count, 1)
    XCTAssertThrowsError(try services.startPhotosBackup())
  }
  @MainActor func testLegacyImportFencesStaleOriginalReadBeforeStaging() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let gate = BackupGate()
    let bytes = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let importer = PhotoImport(
      store: store,
      sourceReader: { _ in
        await gate.wait()
        return (bytes, "singapore.jpg", false)
      })
    let task = Task {
      try await importer.importResources(
        [SelectedResource(id: "asset", origin: .photos, resourceIdentifier: "asset")],
        accountId: account.accountId,
        bundle: AccountBundle(
          vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
          signingSecretKey: account.signingSecretKey), valid: { await gate.allowed })
    }
    while !gate.entered { await Task.yield() }
    gate.allowed = false
    gate.open()
    do {
      _ = try await task.value
      XCTFail("Stale import must cancel")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: store.root.appendingPathComponent("Pending").path))
  }
  @MainActor func testMovedAccountSandboxRebasesCatalogAndJournalOwnedPathsOnly() async throws {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let oldRoot = base.appendingPathComponent("old").appendingPathComponent(account.accountId)
    let newRoot = base.appendingPathComponent("new").appendingPathComponent(account.accountId)
    let old = try LibraryStore(root: oldRoot)
    let bytes = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let source = try old.backupSource("asset")
    let photo = try await PhotoImport(store: old).build(
      bytes: bytes, filename: "singapore.jpg", accountId: account.accountId,
      bundle: AccountBundle(
        vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
        signingSecretKey: account.signingSecretKey), photoId: source.photoId)
    try old.stageBackup(photo, source: source)
    try old.database.close()
    try FileManager.default.createDirectory(
      at: newRoot.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: oldRoot, to: newRoot)
    try FileManager.default.removeItem(at: oldRoot)
    let moved = try LibraryStore(root: newRoot)
    let loaded = try XCTUnwrap(moved.photos().first)
    XCTAssertEqual(loaded.photoId, photo.photoId)
    XCTAssertEqual(
      loaded.manifest.representations.map { $0.binding.representationId },
      photo.manifest.representations.map { $0.binding.representationId })
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(loaded.originalURL)), bytes)
    XCTAssertTrue(loaded.thumbnailURL!.path.hasPrefix(newRoot.path))
    let session = AccountSession()
    let api = APIClient(session: session, baseURL: URL(string: "http://127.0.0.1:8790")!)
    let journal = TransferJournal(
      store: moved, api: api, vault: VaultStore(session: session, api: api))
    let entry = try XCTUnwrap(journal.entries().first)
    XCTAssertTrue(
      entry.photo.staged.values.allSatisfy {
        $0.path.hasPrefix(newRoot.path) && FileManager.default.fileExists(atPath: $0.path)
      })
    var arbitrary = loaded
    arbitrary.originalURL = base.appendingPathComponent("external-original.jpg")
    XCTAssertEqual(moved.rebased(arbitrary).originalURL, arbitrary.originalURL)
    arbitrary.originalURL = base.appendingPathComponent("unowned").appendingPathComponent(
      account.accountId
    ).appendingPathComponent("Media/external.jpg")
    XCTAssertEqual(moved.rebased(arbitrary).originalURL, arbitrary.originalURL)
  }
  func testSourceIdentitySurvivesRestartAndDoesNotDuplicate() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let first = try LibraryStore(root: root)
    let source = try first.backupSource("photos-asset-1")
    let restarted = try LibraryStore(root: root)
    let same = try restarted.backupSource("photos-asset-1")
    XCTAssertEqual(source.photoId, same.photoId)
    XCTAssertEqual(try restarted.backupSources().count, 1)
  }
  func testSourceFailureAndSkipRemainVisibleAcrossRestart() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let store = try LibraryStore(root: root)
    var failed = try store.backupSource("unavailable")
    failed.phase = .failed
    failed.message = "Allow access and retry"
    try store.putBackupSource(failed)
    var skipped = try store.backupSource("live")
    skipped.phase = .skipped
    skipped.message = "Live Photo pairs are not backed up"
    try store.putBackupSource(skipped)
    let restored = try LibraryStore(root: root).backupSources()
    XCTAssertEqual(restored.first(where: { $0.id == "unavailable" })?.message, failed.message)
    XCTAssertEqual(restored.first(where: { $0.id == "live" })?.phase, .skipped)
  }
  func testAtomicStageAndRepeatedSourceProduceOneCatalogPhotoAndTransfer() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let bytes = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(
      vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
      signingSecretKey: account.signingSecretKey)
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "source.jpg", false) })
    let source = try store.backupSource("asset")
    let date = Date(timeIntervalSince1970: 1_700_000_000)
    let first = try await importer.stageBackup(
      source, accountId: account.accountId, bundle: bundle, capturedAt: date)
    let second = try await importer.stageBackup(
      source, accountId: account.accountId, bundle: bundle, capturedAt: date)
    XCTAssertEqual(first.photoId, second.photoId)
    let duplicate = try await importer.stageBackup(
      store.backupSource("second-asset"), accountId: account.accountId, bundle: bundle,
      capturedAt: date)
    XCTAssertEqual(duplicate.photoId, first.photoId)
    XCTAssertEqual(try store.backupSource("second-asset").phase, .queued)
    XCTAssertEqual(try store.photos().count, 1)
    XCTAssertEqual(first.metadata.dateSource, "photos")
    XCTAssertEqual(first.metadata.sourceDate, Wire.date(date))
    XCTAssertEqual(try store.backupSource("asset").phase, .queued)
    let count = try await store.database.read { db in
      try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM transfers")
    }
    XCTAssertEqual(count, 1)
    var wrong = source
    wrong.photoId = Wire.id()
    XCTAssertThrowsError(try store.stageBackup(first, source: wrong))
    XCTAssertEqual(try store.backupSource("asset").photoId, first.photoId)
  }
  func testAtomicStageRollsBackPhotoAndSourceWhenJournalInsertFails() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let bytes = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let source = try store.backupSource("asset")
    let photo = try await PhotoImport(store: store).build(
      bytes: bytes, filename: "source.jpg", accountId: account.accountId,
      bundle: AccountBundle(
        vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
        signingSecretKey: account.signingSecretKey), photoId: source.photoId)
    try await store.database.write { db in
      try db.execute(
        sql:
          "CREATE TRIGGER fail_transfer BEFORE INSERT ON transfers BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END"
      )
    }
    XCTAssertThrowsError(try store.stageBackup(photo, source: source))
    XCTAssertTrue(try store.photos().isEmpty)
    XCTAssertEqual(try store.backupSource("asset").phase, .pending)
  }
  @MainActor func testPauseKeepsRunGuardUntilAwaitSettlesAndCannotUpload() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let coordinator = try PhotosBackup(store: store)
    let gate = BackupGate()
    var scans = 0
    var uploads = 0
    let snapshot: () async throws -> [BackupCandidate] = {
      scans += 1
      return [BackupCandidate(id: "asset")]
    }
    coordinator.start(
      snapshot: snapshot, valid: { true }, stage: { _, _ in await gate.wait() },
      upload: { _ in uploads += 1 }, checkCatalog: {})
    while !gate.entered { await Task.yield() }
    coordinator.pause()
    coordinator.start(
      snapshot: snapshot, valid: { true }, stage: { _, _ in }, upload: { _ in uploads += 1 },
      checkCatalog: {})
    XCTAssertEqual(scans, 1)
    XCTAssertTrue(coordinator.isRunning)
    gate.open()
    await coordinator.waitUntilSettled()
    XCTAssertEqual(uploads, 0)
    XCTAssertEqual(coordinator.status.phase, .paused)
    XCTAssertNil(coordinator.status.lastChecked)
    XCTAssertEqual(try store.backupSource("asset").phase, .pending)
  }
  @MainActor func testStaleVaultCompletionCannotUploadOrClaimSuccessfulCheck() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let coordinator = try PhotosBackup(store: store)
    let gate = BackupGate()
    var valid = true
    var uploads = 0
    coordinator.start(
      snapshot: { [BackupCandidate(id: "asset")] }, valid: { valid },
      stage: { _, _ in await gate.wait() }, upload: { _ in uploads += 1 }, checkCatalog: {})
    while !gate.entered { await Task.yield() }
    valid = false
    gate.open()
    await coordinator.waitUntilSettled()
    XCTAssertEqual(uploads, 0)
    XCTAssertEqual(coordinator.status.phase, .paused)
    XCTAssertNil(coordinator.status.lastChecked)
  }
  @MainActor func testSkippedAndFailedSourcesNeverClaimFullySynced() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let coordinator = try PhotosBackup(store: store)
    coordinator.start(
      snapshot: {
        [
          BackupCandidate(id: "live", skipReason: "Live Photo pair skipped"),
          BackupCandidate(id: "unavailable"),
        ]
      }, valid: { true }, stage: { _, _ in throw FotoroError("iCloud unavailable") },
      upload: { _ in XCTFail("No upload expected") }, checkCatalog: {})
    await coordinator.waitUntilSettled()
    XCTAssertEqual(coordinator.status.skipped, 1)
    XCTAssertEqual(coordinator.status.failed, 1)
    XCTAssertEqual(coordinator.status.completed, 0)
    XCTAssertEqual(coordinator.status.phase, .failed)
    XCTAssertNotNil(coordinator.status.lastChecked)
  }

}

@MainActor private final class BackupGate {
  var entered = false
  var allowed = true
  var continuation: CheckedContinuation<Void, Never>?
  func wait() async {
    entered = true
    await withCheckedContinuation { continuation = $0 }
  }
  func open() {
    continuation?.resume()
    continuation = nil
  }
}

@MainActor private final class PausedUploadContext {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
  let sample = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
  private let accounts: FixtureAccounts
  private let savedSession: Data?
  private let savedDefaults: [String: Any]
  private var enrolled: [String] = []
  private let accountId = Wire.id()
  private let defaultsKeys = ["fotoro.api", "fotoro.fixtureAccount", "fotoro.pinnedCards"]
  init() throws {
    accounts = try fixture(FixtureAccounts.self, "accounts")
    savedSession = try? Keychain.read("session")
    savedDefaults = Dictionary(uniqueKeysWithValues: defaultsKeys.compactMap { key in
      UserDefaults.standard.object(forKey: key).map { (key, $0) }
    })
    UserDefaults.standard.set("https://pause-sync.test", forKey: "fotoro.api")
    PausedUploadProtocol.server.reset()
  }
  func restoredServices() throws -> AppServices {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PausedUploadProtocol.self]
    return try AppServices(root: root, networkConfiguration: configuration)
  }
  func enroll(accountId id: String? = nil) async throws -> AppServices {
    let services = try restoredServices()
    var card = accounts.accounts[0]
    card.accountId = id ?? accountId
    enrolled.append(card.accountId)
    services.session.accountId = card.accountId
    services.session.fixture = false
    services.session.bearerToken = "controlled-test-session"
    try services.session.pin(card)
    let secret = accounts.testSecrets[0]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
    return services
  }
  func persistSession(_ services: AppServices) throws {
    try Keychain.write(Wire.encode(SessionV1(version: 1, accountId: XCTUnwrap(services.session.accountId), deviceId: Wire.id(), expiresAt: Wire.date(Date().addingTimeInterval(3600)), token: services.session.bearerToken)), id: "session")
  }
  func restore() {
    for id in enrolled { Keychain.remove(id) }
    if let savedSession { try? Keychain.write(savedSession, id: "session") }
    else { Keychain.remove("session") }
    for key in defaultsKeys {
      if let value = savedDefaults[key] { UserDefaults.standard.set(value, forKey: key) }
      else { UserDefaults.standard.removeObject(forKey: key) }
    }
  }
}

private final class PausedUploadServer: @unchecked Sendable {
  struct Request {
    var method: String
    var path: String
  }
  private let lock = NSLock()
  private var recorded: [Request] = []
  private var reservations: [String: ReserveUploadV1] = [:]
  var reservationGate: UploadRequestGate?
  var requests: [Request] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }
  func reset() {
    lock.lock()
    defer { lock.unlock() }
    recorded = []
    reservations = [:]
    reservationGate = nil
  }
  func response(_ request: URLRequest) throws -> Data {
    if request.url?.path == "/v1/uploads/reserve" { reservationGate?.visit() }
    lock.lock()
    defer { lock.unlock() }
    let path = request.url!.path
    recorded.append(Request(method: request.httpMethod ?? "GET", path: path))
    switch path {
    case "/v1/changes":
      return try Wire.encode(ChangePageV1(version: 1, changes: [], nextCursor: nil, hasMore: false))
    case "/v1/grants":
      return try Wire.encode(GrantInboxV1(version: 1, grants: []))
    case "/v1/uploads/reserve":
      let input = try Wire.decode(ReserveUploadV1.self, body(request))
      let id = Wire.id()
      reservations[id] = input
      return try Wire.encode(UploadReservationV1(version: 1, uploadId: id, photoId: input.binding.photoId, representationId: input.binding.representationId, stagingUrl: "https://pause-sync.test/v1/staging/\(id)", expiresAt: Wire.date(Date().addingTimeInterval(3600))))
    case "/v1/photos":
      let signed = try Wire.decode(SignedPayloadV1.self, body(request))
      return try Data(b64: signed.body)
    default:
      if path.hasSuffix("/commit"), let input = reservations[request.url!.deletingLastPathComponent().lastPathComponent] {
        // A commit probe found a previously uploaded immutable representation.
        return try Wire.encode(UploadCommitV1(version: 1, uploadId: request.url!.deletingLastPathComponent().lastPathComponent, objectId: Wire.id(), ciphertextBytes: input.ciphertextBytes, ciphertextSha256: input.ciphertextSha256))
      }
      if path.hasSuffix("/annotations"), request.httpMethod == "PUT" { return Data("{}".utf8) }
      throw FotoroError("Unexpected controlled request: \(path)")
    }
  }
  private func body(_ request: URLRequest) throws -> Data {
    if let bytes = request.httpBody { return bytes }
    guard let stream = request.httpBodyStream else { throw FotoroError("Missing test request body") }
    stream.open()
    defer { stream.close() }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw stream.streamError ?? FotoroError("Cannot read test request body") }
      if count == 0 { return result }
      result.append(contentsOf: buffer.prefix(count))
    }
  }
}

private final class PausedUploadProtocol: URLProtocol, @unchecked Sendable {
  static let server = PausedUploadServer()
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pause-sync.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let data = try Self.server.response(request)
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class UploadRequestGate: @unchecked Sendable {
  private let lock = NSLock()
  private var visits = 0
  let release = DispatchSemaphore(value: 0)
  var count: Int { lock.lock(); defer { lock.unlock() }; return visits }
  func visit() {
    lock.lock(); visits += 1; let first = visits == 1; lock.unlock()
    if first { _ = release.wait(timeout: .now() + 10) }
  }
}
