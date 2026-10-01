import GRDB
import XCTest

@testable import Fotoro

final class PhotosBackupTests: XCTestCase {
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
