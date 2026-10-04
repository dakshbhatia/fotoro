import GRDB
import Photos
import XCTest

@testable import Fotoro

final class PhotosBackupTests: XCTestCase {
  @MainActor func testChosenSaveColdReopensPaddedSelectionWithoutRescanningOrUploading() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    let bytes = try Data(contentsOf: context.sample)
    services.importer = PhotoImport(store: services.store, sourceReader: { _ in (bytes, "public-sample.jpg", false) },
      sourceRevision: { id in id == "chosen" ? "reviewed" : nil })
    var scans = 0
    services.photosBackupSnapshot = { _ in
      scans += 1
      return [BackupCandidate(id: "chosen", sourceRevision: "reviewed")]
    }
    try services.startPhotosBackup(selection: [RecentPhotoSource(id: "chosen", revision: "reviewed")])
    await services.backup.waitUntilSettled()
    XCTAssertEqual(services.backup.status.phase, .complete)
    XCTAssertEqual(try services.store.consumerCommittedCount(accountId: XCTUnwrap(services.session.accountId)), 1)
    let encoded = try await services.store.database.read { db in
      try XCTUnwrap(String.fetchOne(db, sql: "SELECT value FROM state WHERE key='backupSelection'"))
    }
    XCTAssertTrue(encoded.contains("="), "Exercise the padded local format that previously blocked cold startup")
    try context.persistSession(services)
    let before = PausedUploadProtocol.server.requests.count
    let scansBeforeReopen = scans
    let reopened = try context.restoredServices()
    defer { reopened.vault.lock() }
    await reopened.resumeSavedAccount(initialRestoration: true)
    XCTAssertNotNil(reopened.photoAccountAccess)
    XCTAssertEqual(reopened.photos.count, 1)
    XCTAssertEqual(reopened.backup.status.phase, .complete)
    XCTAssertEqual(reopened.backup.status.completed, 1)
    XCTAssertTrue(try reopened.journal.entries().isEmpty)
    XCTAssertFalse(try reopened.store.syncEnabled())
    XCTAssertGreaterThan(scansBeforeReopen, 0)
    XCTAssertEqual(scans, scansBeforeReopen)
    XCTAssertEqual(PausedUploadProtocol.server.requests.count, before)
  }
  @MainActor func testBackupSelectionRestoresStandardAndLegacyURLFormatsWithoutWideningSelection() throws {
    for encoded in [try Wire.encode(["chosen"]).base64EncodedString(), try Wire.encode(["chosen"]).b64] {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      defer { try? FileManager.default.removeItem(at: root) }
      let store = try LibraryStore(root: root)
      var selected = try store.backupSource("chosen")
      selected.phase = .failed
      try store.putBackupSource(selected)
      try store.putBackupSource(store.backupSource("unselected"))
      try store.database.write { db in
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('backupSelection',?)", arguments: [encoded])
      }
      let reopened = try PhotosBackup(store: LibraryStore(root: root))
      XCTAssertEqual(try reopened.unpreparedSources().map(\.id), ["chosen"])
      XCTAssertEqual(reopened.status.failed, 1)
      XCTAssertEqual(reopened.status.pending, 0)
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root)
    try store.database.write { db in
      try db.execute(sql: "INSERT INTO state(key,value) VALUES('backupSelection','invalid@@')")
    }
    XCTAssertThrowsError(try PhotosBackup(store: store))
  }
  func testReviewedPhotoSelectionRequiresEveryOriginalRevisionAndKeepsReviewOrder() throws {
    let candidates = [BackupCandidate(id: "other", sourceRevision: "1"),
      BackupCandidate(id: "chosen", capturedAt: Date(timeIntervalSince1970: 0), sourceRevision: "2")]
    let chosen = RecentPhotoSource(id: "chosen", revision: "2")
    XCTAssertEqual(try ReviewedPhotosBackupPolicy.select(candidates, selection: [chosen]).map(\.id), ["chosen"])
    XCTAssertEqual(try ReviewedPhotosBackupPolicy.select(candidates, selection: [chosen, RecentPhotoSource(id: "other", revision: "1")]).map(\.id), ["chosen", "other"])
    XCTAssertThrowsError(try ReviewedPhotosBackupPolicy.select(candidates, selection: []))
    XCTAssertThrowsError(try ReviewedPhotosBackupPolicy.select(candidates, selection: [chosen, chosen]))
    XCTAssertThrowsError(try ReviewedPhotosBackupPolicy.select(candidates, selection: [RecentPhotoSource(id: "chosen", revision: "1")]))
    XCTAssertThrowsError(try ReviewedPhotosBackupPolicy.select(candidates, selection: [RecentPhotoSource(id: "missing-or-hidden", revision: "1")]))
    XCTAssertThrowsError(try ReviewedPhotosBackupPolicy.select([BackupCandidate(id: "chosen")], selection: [chosen]))
  }
  @MainActor func testReviewedSubsetSavesOnlyChosenPhotoWithoutCompletedAIPicksOrRecentCutoff() async throws {
    let candidate = BackupCandidate(id: "chosen", sourceRevision: "reviewed")
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    let bytes = try Data(contentsOf: context.sample)
    services.importer = PhotoImport(store: services.store, sourceReader: { source in
      XCTAssertEqual(source.resourceIdentifier, candidate.id)
      return (bytes, "source.jpg", false)
    }, sourceRevision: { id in id == candidate.id ? candidate.sourceRevision : nil })
    var oldCandidate = candidate
    oldCandidate.capturedAt = Date(timeIntervalSince1970: 0)
    services.photosBackupSnapshot = { _ in
      [BackupCandidate(id: "not-reviewed", sourceRevision: "1"), oldCandidate]
    }
    try services.startPhotosBackup(selection: [RecentPhotoSource(id: candidate.id, revision: candidate.sourceRevision!)])
    await services.backup.waitUntilSettled()
    XCTAssertEqual(try services.store.backupSources().map(\.id), [candidate.id])
    XCTAssertEqual(try services.store.consumerCommittedCount(accountId: services.session.accountId!), 1)
    XCTAssertEqual(services.backup.status.phase, .complete)
    XCTAssertFalse(try services.store.syncEnabled())
    services.vault.lock()
  }
  @MainActor func testReviewedSelectionCannotStageAfterRevisionPauseOrAccountChangesDuringOriginalRead() async throws {
    let candidate = BackupCandidate(id: "chosen", sourceRevision: "reviewed")
    for interruption in ["revision", "pause", "account"] {
      let context = try PausedUploadContext()
      defer { context.restore() }
      let services = try await context.enroll()
      let gate = BackupGate()
      let bytes = try Data(contentsOf: context.sample)
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in
        await gate.wait()
        return (bytes, "source.jpg", false)
      }, sourceRevision: { id in id == candidate.id ? candidate.sourceRevision : nil })
      var current = candidate
      services.photosBackupSnapshot = { _ in [current] }
      try services.startPhotosBackup(selection: [RecentPhotoSource(id: candidate.id, revision: candidate.sourceRevision!)])
      while !gate.entered { await Task.yield() }
      if interruption == "revision" { current.sourceRevision = "changed" }
      else if interruption == "pause" { services.pauseSync() }
      else { services.session.accountId = Wire.id() }
      gate.open()
      await services.backup.waitUntilSettled()
      let expectedPhase: BackupStatus.Phase = interruption == "revision" ? .failed : .paused
      XCTAssertEqual(services.backup.status.phase, expectedPhase, interruption)
      if interruption == "revision" {
        XCTAssertEqual(try services.store.backupSource(candidate.id).phase, .failed)
        XCTAssertEqual(services.backup.status.failed, 1)
      }
      XCTAssertTrue(try services.store.photos().isEmpty, interruption)
      XCTAssertTrue(try services.journal.entries().isEmpty, interruption)
      XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" }, "Invalid reviewed sources cannot reserve, upload, commit, or publish photos")
      services.vault.lock()
    }
  }
  @MainActor func testUnpausedLegacyEnrollmentAndLocalEditsNeverSendOnForegroundOrRelaunch() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try await services.importFiles([context.sample])
    let queued = try XCTUnwrap(services.journal.entries().first)
    var source = try services.store.backupSource("controlled-photos-source")
    source.photoId = queued.photo.id
    source.phase = .queued
    source.sourceRevision = "current"
    try services.store.putBackupSource(source)
    let index = try SearchIndex()
    try index.replacePermitted([SearchRecord(id: source.id, revision: "current")])
    let search = LocalSearchStore(index: index)
    services.bindLocalSearch(search)
    try services.setLabels(["Saved on this device"], photo: queued.photo)
    XCTAssertTrue(search.setLabels(["Edited while browsing"], photoID: source.id))
    try search.onSnapshotReady?()
    var scans = 0
    services.photosBackupSnapshot = { _ in scans += 1; return [] }
    try services.store.setSyncIntent(enabled: true, uploadsPaused: false)
    await services.resumeSavedAccount()
    XCTAssertEqual(scans, 0)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertFalse(try services.store.uploadsPaused())
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
    XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertEqual(try services.annotations.ledger.pendingIDs(), [queued.photo.id])
    XCTAssertEqual(try services.annotations.ledger.state(queued.photo.id)?.revision, 0)
    try context.persistSession(services)
    try services.store.setSyncEnabled(true)
    let restored = try context.restoredServices()
    await restored.resumeSavedAccount(initialRestoration: true)
    XCTAssertTrue(restored.vault.isUnlocked)
    XCTAssertFalse(try restored.store.syncEnabled())
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
    XCTAssertEqual(try restored.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertEqual(try restored.annotations.ledger.pendingIDs(), [queued.photo.id])
    try await restored.sync()
    XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" }, "Explicit catalog refresh must not flush queued photo or annotation writes")
    XCTAssertEqual(try restored.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertEqual(try restored.annotations.ledger.pendingIDs(), [queued.photo.id])
    services.vault.lock()
    restored.vault.lock()
  }
  @MainActor func testManualSaveTakesOneSnapshotAndLaterPicksWaitForAnotherTap() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    let bytes = try Data(contentsOf: context.sample)
    services.importer = PhotoImport(store: services.store, sourceReader: { selected in
      (selected.resourceIdentifier == "later-pick" ? bytes + Data([0]) : bytes, "source.jpg", false)
    })
    var current = [BackupCandidate(id: "first-pick")]
    var scans = 0
    services.photosBackupSnapshot = { _ in scans += 1; return current }
    try services.startPhotosBackup()
    XCTAssertThrowsError(try services.startPhotosBackup(), "Repeated taps must not create concurrent batches")
    await services.backup.waitUntilSettled()
    XCTAssertEqual(scans, 1)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertEqual(try services.store.consumerCommittedCount(accountId: services.session.accountId!), 1)
    current.append(BackupCandidate(id: "later-pick"))
    let requestsBeforeForeground = PausedUploadProtocol.server.requests.count
    await services.resumeSavedAccount()
    XCTAssertEqual(PausedUploadProtocol.server.requests.count, requestsBeforeForeground)
    try await services.continueSync()
    XCTAssertEqual(scans, 1, "Continue cannot scan new picks, even after a successful batch")
    XCTAssertEqual(try services.store.backupSources().map(\.id), ["first-pick"])
    XCTAssertEqual(services.consumerSyncSummary.action, .start)
    try services.startPhotosBackup()
    await services.backup.waitUntilSettled()
    XCTAssertEqual(scans, 2)
    XCTAssertEqual(try services.store.backupSources().map(\.id), ["first-pick", "later-pick"])
    XCTAssertEqual(try services.store.consumerCommittedCount(accountId: services.session.accountId!), 2)
    XCTAssertFalse(try services.store.syncEnabled())
    services.vault.lock()
  }
  @MainActor func testPausedManualBatchReportsUnpreparedPicksWithoutRescanningOnContinue() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    let bytes = try Data(contentsOf: context.sample)
    let gate = BackupGate()
    services.importer = PhotoImport(store: services.store, sourceReader: { selected in
      if selected.resourceIdentifier != "pick-0" { await gate.wait() }
      return (bytes, "source.jpg", false)
    })
    var scans = 0
    services.photosBackupSnapshot = { _ in
      scans += 1
      return (0..<5).map { BackupCandidate(id: "pick-\($0)") }
    }
    try services.startPhotosBackup()
    while !gate.entered { await Task.yield() }
    services.pauseSync()
    gate.open()
    await services.backup.waitUntilSettled()
    services.refreshConsumerSyncSummary()
    XCTAssertEqual(services.consumerSyncSummary.completedPhotos, 1)
    XCTAssertEqual(services.consumerSyncSummary.totalPhotos, 5)
    XCTAssertEqual(services.consumerSyncSummary.state, .needsAttention)
    XCTAssertEqual(services.consumerSyncSummary.action, .start)
    XCTAssertEqual(try services.backup.unpreparedSources().count, 4)
    try await services.continueSync()
    XCTAssertEqual(scans, 1)
    XCTAssertEqual(try services.backup.unpreparedSources().count, 4)
    XCTAssertEqual(services.consumerSyncSummary.totalPhotos, 5)
    services.vault.lock()
  }
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
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty, "Foreground restoration must not read or write the server")
    do {
      try await services.resumeTransfers()
      XCTFail("Retrying an upload must respect explicit Pause")
    } catch { XCTAssertTrue(error.localizedDescription.contains("paused")) }

    try context.persistSession(services)
    let restarted = try context.restoredServices()
    await restarted.resumeSavedAccount(initialRestoration: true)
    XCTAssertTrue(restarted.vault.isUnlocked)
    XCTAssertEqual(try restarted.journal.entries().map { $0.photo.id }, [queued.photo.id])
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty, "Process restoration must not resume uploads or catalog refresh")
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

  @MainActor func testLegacyAutomaticIntentIsNeutralizedAndContinueDoesNotScanPhotos() async throws {
    let context = try PausedUploadContext()
    defer { context.restore() }
    let services = try await context.enroll()
    try services.store.setSyncIntent(enabled: true, uploadsPaused: false)
    services.pauseSync()
    XCTAssertFalse(try services.store.syncEnabled(), "An old automatic enrollment must not survive Pause")
    XCTAssertTrue(try services.store.uploadsPaused())
    var observedCutoff: Date?
    services.photosBackupSnapshot = { cutoff in observedCutoff = cutoff; return [] }
    try await services.continueSync()
    await services.backup.waitUntilSettled()
    XCTAssertFalse(try services.store.uploadsPaused())
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertNil(observedCutoff, "Continue resumes only encrypted queued work")
    services.vault.lock()
  }

  @MainActor func testContinueWaitsForCancelledRunWithoutScanningPhotosAgain() async throws {
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
    XCTAssertEqual(resumedScans, 0, "Continue must not discover or stage any Photos sources")
    XCTAssertEqual(try services.store.backupSource("cancelled-source").phase, .pending)
    XCTAssertFalse(try services.store.syncEnabled())
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

final class AutomaticPhotoSyncTests: XCTestCase {
  @MainActor func testEmptyAutomaticScanKeepsFailedReadVisibleUntilExplicitRetryReadsAgain() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    services.automaticPhotosAuthorization = { .limited }
    services.photosBackupSnapshot = { _ in [] }
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    PausedUploadProtocol.server.failCatalogReads(1)
    do { try await services.sync(); XCTFail("The controlled catalog read must fail") }
    catch { XCTAssertTrue(error is URLError) }
    XCTAssertEqual(services.automaticPhotoSync.phase, .needsAttention)
    let reads = PausedUploadProtocol.server.requests.filter { $0.path == "/v1/changes" }.count
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    XCTAssertEqual(PausedUploadProtocol.server.requests.filter { $0.path == "/v1/changes" }.count, reads)
    XCTAssertEqual(services.automaticPhotoSync.phase, .needsAttention, "A no-work scan cannot pretend a failed read recovered")
    try await services.retryAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    XCTAssertEqual(PausedUploadProtocol.server.requests.filter { $0.path == "/v1/changes" }.count, reads + 1)
    XCTAssertEqual(services.automaticPhotoSync.phase, .ready)
    XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" }, "Empty retry never publishes an edit or original")
  }
  @MainActor func testQueuedRevisionAndPermissionReturnSyncCurrentDigestWithoutPublishingRetainedCopy() async throws {
    for changedDigest in [false, true] {
      let context = try PausedUploadContext()
      defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
      let services = try await context.enroll()
      defer { services.vault.lock() }
      let original = try Data(contentsOf: context.sample)
      let gate = UploadRequestGate()
      PausedUploadProtocol.server.reservationGate = gate
      var permission = PHAuthorizationStatus.limited
      var revision = "before-edit"
      services.automaticPhotosAuthorization = { permission }
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "source", sourceRevision: revision)] }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in (original, "public-sample.jpg", false) }, sourceRevision: { _ in "before-edit" })
      try services.enableAutomaticPhotoSync()
      while gate.count == 0 { await Task.yield() }
      let queued = try services.store.backupSource("source")
      XCTAssertEqual(queued.phase, .queued, "Interrupt after ciphertext and its job are durably staged")
      let olderPhoto = try XCTUnwrap(services.store.backupPhoto(queued.photoId))
      let oldCiphertext = try olderPhoto.staged.mapValues { try Data(contentsOf: $0) }
      permission = .denied
      revision = "after-edit"
      services.kickAutomaticPhotoSync(sourcesChanged: true)
      gate.release.signal()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.photoId])
      XCTAssertTrue(PausedUploadProtocol.server.publishedPhotoIDs.isEmpty)
      let oldReservations = PausedUploadProtocol.server.reservedPhotoIDs.filter { $0 == queued.photoId }.count
      PausedUploadProtocol.server.reservationGate = nil
      permission = .limited
      let currentBytes = changedDigest ? original + Data("controlled-original-change".utf8) : original
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in (currentBytes, "public-sample.jpg", false) }, sourceRevision: { _ in "after-edit" })
      services.kickAutomaticPhotoSync(sourcesChanged: true)
      await services.waitForAutomaticPhotoSync()
      let current = try services.store.backupSource("source")
      XCTAssertEqual(current.phase, .committed)
      XCTAssertEqual(current.sourceRevision, "after-edit")
      XCTAssertEqual(current.originalSha256, currentBytes.digest)
      XCTAssertEqual(services.automaticPhotoSync.phase, .ready)
      XCTAssertEqual(services.backup.status.pending, 0)
      XCTAssertEqual(services.backup.status.failed, 0)
      let requests = PausedUploadProtocol.server.requests.count
      services.kickAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(PausedUploadProtocol.server.requests.count, requests, "A retained earlier copy cannot trigger automatic retries")
      if changedDigest {
        XCTAssertNotEqual(current.photoId, queued.photoId)
        XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.photoId])
        XCTAssertEqual(PausedUploadProtocol.server.reservedPhotoIDs.filter { $0 == queued.photoId }.count, oldReservations)
        XCTAssertEqual(PausedUploadProtocol.server.publishedPhotoIDs, [current.photoId])
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(olderPhoto.originalURL)), original)
        for (id, url) in olderPhoto.staged { XCTAssertEqual(try Data(contentsOf: url), oldCiphertext[id]) }
        services.refreshConsumerSyncSummary()
        XCTAssertEqual(services.consumerSyncSummary.totalPhotos, services.consumerSyncSummary.completedPhotos)
        XCTAssertEqual(services.consumerSyncSummary.state, .upToDate)
        try services.disableAutomaticPhotoSync()
        XCTAssertTrue(try services.store.uploadsPaused())
        XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.photoId])
        services.refreshConsumerSyncSummary()
        XCTAssertEqual(services.consumerSyncSummary.action, .continue, "The older job stays available only through explicit manual Continue")
      } else {
        XCTAssertEqual(current.photoId, queued.photoId, "A metadata-only edit can safely resume identical bytes")
        XCTAssertTrue(try services.journal.entries().isEmpty)
        XCTAssertEqual(PausedUploadProtocol.server.publishedPhotoIDs, [queued.photoId])
      }
    }
  }

  @MainActor func testQuotaFailureStopsAfterOnePreparedOriginalAndKeepsRemainingSourcesRetryable() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root)
    let backup = try PhotosBackup(store: store)
    var prepared: [String] = []
    var uploaded: [String] = []
    backup.start(snapshot: {
      (0..<5).map { BackupCandidate(id: "source-\($0)", sourceRevision: "current") }
    }, valid: { true }, stage: { source, _ in
      prepared.append(source.id)
      var queued = source
      queued.phase = .queued
      try store.putBackupSource(queued)
    }, upload: { source in
      uploaded.append(source.id)
      throw FotoroError("STORAGE_QUOTA_EXCEEDED")
    }, checkCatalog: { XCTFail("A failed batch cannot claim a successful catalog check") },
      checkCatalogOnlyAfterWork: true, restrictQueuedToSnapshot: true)
    await backup.waitUntilSettled()
    XCTAssertEqual(prepared.count, 1)
    XCTAssertEqual(uploaded, prepared)
    XCTAssertEqual(try store.backupSources().filter { $0.phase == .pending }.count, 4)
    XCTAssertEqual(try store.backupSources().filter { $0.phase == .queued }.count, 1)
    XCTAssertEqual(backup.status.phase, .failed)
    XCTAssertNil(backup.status.lastChecked)
  }
  @MainActor func testAutomaticSyncDefaultsOffWithoutLibraryScanOrNetwork() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    var scans = 0
    services.automaticPhotosAuthorization = { .authorized }
    services.photosBackupSnapshot = { _ in scans += 1; return [] }
    services.setPhotoSyncForeground(true)
    await services.resumeSavedAccount()
    await services.waitForAutomaticPhotoSync()
    XCTAssertFalse(services.automaticPhotoSync.enabled)
    XCTAssertEqual(services.automaticPhotoSync.phase, .off)
    XCTAssertEqual(scans, 0)
    XCTAssertTrue(try services.store.backupSources().isEmpty)
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
    XCTAssertFalse(try services.store.automaticPhotoSyncPreference().enabled)
  }

  @MainActor func testOptInCoversOldAndUndatedStillsAndDoesNotRetryUnchangedCopiesOrAnnotations() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    let bytes = try Data(contentsOf: context.sample)
    let reads = AutomaticSourceReads()
    services.automaticPhotosAuthorization = { .limited }
    services.importer = PhotoImport(store: services.store, sourceReader: { source in
      await reads.record(source.resourceIdentifier)
      return (bytes, "public-sample.jpg", false)
    }, sourceRevision: { _ in "current" })
    let candidates = [BackupCandidate(id: "old", capturedAt: Date(timeIntervalSince1970: 0), sourceRevision: "current"),
      BackupCandidate(id: "undated", sourceRevision: "current"),
      BackupCandidate(id: "recent", capturedAt: Date(), sourceRevision: "current"),
      BackupCandidate(id: "video", skipReason: "Video is not backed up.", sourceRevision: "current"),
      BackupCandidate(id: "live", skipReason: "Live Photo pairs are not backed up.", sourceRevision: "current")]
    services.photosBackupSnapshot = { cutoff in
      XCTAssertEqual(cutoff, .distantPast, "Automatic sync cannot use the recent Picks cutoff")
      return candidates
    }
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    let firstReads = await reads.values()
    XCTAssertEqual(Set(firstReads), ["old", "undated", "recent"])
    XCTAssertEqual(services.backup.status.completed, 3)
    XCTAssertEqual(services.backup.status.skipped, 2)
    XCTAssertEqual(services.automaticPhotoSync.phase, .ready)
    XCTAssertEqual(try services.store.consumerCommittedCount(accountId: XCTUnwrap(services.session.accountId)), 1,
      "Identical originals share the existing committed photo, not another upload")
    XCTAssertEqual(Set(try services.store.backupSources().filter { $0.phase == .committed }.map(\.photoId)).count, 1)
    let photo = try XCTUnwrap(services.store.photos().first)
    try services.setLabels(["  My exact label  "], photo: photo)
    let requests = PausedUploadProtocol.server.requests.count
    services.kickAutomaticPhotoSync()
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    let secondReads = await reads.values()
    XCTAssertEqual(secondReads.count, 3)
    XCTAssertEqual(PausedUploadProtocol.server.requests.count, requests, "Unchanged idle scans need no HTTP")
    XCTAssertEqual(try services.annotations.ledger.pendingIDs(), [photo.id], "Photo opt-in cannot publish unsaved annotation edits")
    XCTAssertEqual(services.annotation(photo).labels, ["  My exact label  "])
  }

  @MainActor func testAutomaticOptInWithoutCompletedAnalysisNeverCreatesAnEmptySidecar() async throws {
    for status in [SearchOCRStatus.pending, .unavailable] {
      let context = try PausedUploadContext()
      defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
      let services = try await context.enroll()
      defer { services.vault.lock() }
      let bytes = try Data(contentsOf: context.sample)
      services.automaticPhotosAuthorization = { .limited }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in (bytes, "public-sample.jpg", false) }, sourceRevision: { _ in "current" })
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "asset", sourceRevision: "current")] }
      let index = try SearchIndex()
      var record = SearchRecord(id: "asset"); record.revision = "current"
      record.ocrStatus = status; record.visualStatus = .unavailable
      try index.replacePermitted([record])
      let search = LocalSearchStore(index: index)
      services.bindLocalSearch(search)
      defer { withExtendedLifetime(search) {} }
      try services.enableAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(try search.record("asset")?.ocrStatus, status)
      XCTAssertEqual(services.backup.status.completed, 1)
      XCTAssertTrue(try services.annotations.ledger.pendingIDs().isEmpty)
      XCTAssertTrue(PausedUploadProtocol.server.requests.filter { $0.path.hasSuffix("/annotations") }.isEmpty)
    }
  }

  @MainActor func testFreshAutomaticOptInPublishesCompletedAnalysisWithoutSuppliedFieldsOrManualSave() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    let bytes = try Data(contentsOf: context.sample)
    services.automaticPhotosAuthorization = { .limited }
    services.importer = PhotoImport(store: services.store, sourceReader: { _ in (bytes, "public-sample.jpg", false) }, sourceRevision: { _ in "current" })
    services.photosBackupSnapshot = { _ in [BackupCandidate(id: "asset", sourceRevision: "current")] }
    let index = try SearchIndex()
    var record = SearchRecord(id: "asset"); record.revision = "current"
    record.labels = ["Unpublished label"]; record.captions = ["Unpublished caption"]
    record.keywords = ["Unpublished keyword"]; record.facts = ["PhotoKit fact"]; record.favorite = true
    record.ocrStatus = .complete; record.ocrText = "public fixture receipt"; record.ocrConfidence = 0.9
    record.visualStatus = .complete; record.visualLabels = SearchVisualPolicy.labels([("beach", 0.9)])
    try index.replacePermitted([record])
    let search = LocalSearchStore(index: index)
    services.bindLocalSearch(search)
    defer { withExtendedLifetime(search) {} }
    PausedUploadProtocol.server.failAnnotationWrites(1)
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    XCTAssertEqual(try search.record("asset")?.ocrStatus, .complete)
    let photo = try XCTUnwrap(services.store.photos().first)
    let value = try XCTUnwrap(services.annotations.ledger.current(photo: photo, bundle: services.vault.requireBundle(), card: services.session.requireCard(XCTUnwrap(services.session.accountId))))
    XCTAssertNil(value.labels); XCTAssertNil(value.caption); XCTAssertNil(value.keywords)
    XCTAssertNil(value.facts); XCTAssertNil(value.favorite)
    XCTAssertEqual(value.ocr?.text, "public fixture receipt")
    XCTAssertNil(value.visual, "Reader-first rollout keeps scenes local until installed readers are qualified")
    XCTAssertEqual(try services.annotations.ledger.pendingIDs(), [photo.id], "Offline analysis remains in the same durable outbox")
    XCTAssertFalse(services.annotations.errors.isEmpty)
    XCTAssertEqual(services.automaticPhotoSync.phase, .needsAttention,
      "Completed originals cannot hide a failed search-data write")
    XCTAssertEqual(services.automaticPhotoSync.detail, "Some photo changes could not sync. Use Sync changes to try again.")
    let failedRequest = try XCTUnwrap(services.annotations.ledger.state(photo.id)?.pending)
    services.setPhotoSyncForeground(false)
    services.setPhotoSyncForeground(true)
    await services.waitForAutomaticPhotoSync()
    XCTAssertTrue(try services.annotations.ledger.pendingIDs().isEmpty, "Foreground retries analysis even when original work is empty")
    XCTAssertEqual(try services.annotations.ledger.state(photo.id)?.accepted, failedRequest)
    XCTAssertTrue(services.annotations.errors.isEmpty)
    XCTAssertEqual(services.automaticPhotoSync.phase, .ready, "A successful retry clears the attention state")
    let requests = PausedUploadProtocol.server.requests.count
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    await services.syncAnnotations(derivedOnly: true)
    XCTAssertEqual(PausedUploadProtocol.server.requests.count, requests, "Completed unchanged analysis never needs another write")
  }

  @MainActor func testPauseSurvivesReopenAndExplicitOptInResumesOnlyAfterConsent() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    let bytes = try Data(contentsOf: context.sample)
    let gate = BackupGate()
    services.automaticPhotosAuthorization = { .authorized }
    services.photosBackupSnapshot = { _ in [BackupCandidate(id: "old", sourceRevision: "current")] }
    services.importer = PhotoImport(store: services.store, sourceReader: { _ in
      await gate.wait(); return (bytes, "public-sample.jpg", false)
    }, sourceRevision: { _ in "current" })
    try services.enableAutomaticPhotoSync()
    while !gate.entered { await Task.yield() }
    services.pauseAutomaticPhotoSync()
    gate.open()
    await services.waitForAutomaticPhotoSync()
    XCTAssertTrue(try services.store.automaticPhotoSyncPreference().enabled)
    XCTAssertTrue(try services.store.automaticPhotoSyncPreference().paused)
    XCTAssertTrue(try services.store.photos().isEmpty)
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
    try context.persistSession(services)
    let reopened = try context.restoredServices()
    defer { reopened.vault.lock() }
    var scans = 0
    reopened.automaticPhotosAuthorization = { .authorized }
    reopened.photosBackupSnapshot = { _ in scans += 1; return [BackupCandidate(id: "old", sourceRevision: "current")] }
    reopened.importer = PhotoImport(store: reopened.store, sourceReader: { _ in (bytes, "public-sample.jpg", false) }, sourceRevision: { _ in "current" })
    reopened.setPhotoSyncForeground(true)
    await reopened.resumeSavedAccount(initialRestoration: true)
    await reopened.waitForAutomaticPhotoSync()
    XCTAssertEqual(reopened.automaticPhotoSync.phase, .paused)
    XCTAssertEqual(scans, 0)
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
    // Account activation owns a new importer; install the public synthetic source afterward.
    reopened.importer = PhotoImport(store: reopened.store, sourceReader: { _ in (bytes, "public-sample.jpg", false) }, sourceRevision: { _ in "current" })
    try reopened.enableAutomaticPhotoSync()
    await reopened.waitForAutomaticPhotoSync()
    XCTAssertFalse(try reopened.store.automaticPhotoSyncPreference().paused)
    XCTAssertEqual(reopened.backup.status.completed, 1)
    XCTAssertFalse(try reopened.store.syncEnabled(), "Legacy enrollment does not become consent")
  }

  @MainActor func testAutomaticSyncOriginalReadCannotStageAfterScopeWithdrawal() async throws {
    for interruption in ["lock", "account", "origin", "permission", "background", "revision", "disable"] {
      let context = try PausedUploadContext()
      defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
      let services = try await context.enroll()
      defer { services.vault.lock() }
      let bytes = try Data(contentsOf: context.sample)
      let gate = BackupGate()
      var permission = PHAuthorizationStatus.authorized
      var revision = "current"
      services.automaticPhotosAuthorization = { permission }
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "old", sourceRevision: revision)] }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in
        await gate.wait(); return (bytes, "public-sample.jpg", false)
      }, sourceRevision: { _ in "current" })
      try services.enableAutomaticPhotoSync()
      while !gate.entered { await Task.yield() }
      switch interruption {
      case "lock": services.vault.lock()
      case "account": services.session.accountId = Wire.id()
      case "origin": services.api.baseURL = URL(string: "https://another-origin.test")!
      case "permission": permission = .denied; services.kickAutomaticPhotoSync()
      case "background": services.setPhotoSyncForeground(false)
      case "revision": revision = "changed"
      default: try services.disableAutomaticPhotoSync()
      }
      gate.open()
      await services.waitForAutomaticPhotoSync()
      XCTAssertTrue(try services.store.photos().isEmpty, interruption)
      XCTAssertTrue(try services.journal.entries().isEmpty, interruption)
      XCTAssertTrue(PausedUploadProtocol.server.requests.allSatisfy { $0.method == "GET" }, interruption)
      if interruption == "background" {
        XCTAssertTrue(try services.store.automaticPhotoSyncPreference().enabled)
        XCTAssertFalse(try services.store.automaticPhotoSyncPreference().paused)
      }
    }
  }

  @MainActor func testConsentIsPerAccountOriginAndPrivatePermissionNotLegacyFlag() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let first = try LibraryStore(root: root.appendingPathComponent(Wire.id()))
    try first.setSyncEnabled(true)
    XCTAssertFalse(try first.automaticPhotoSyncPreference().enabled)
    let preference = AutomaticPhotoSyncPreference(enabled: true, paused: true, origin: "https://pause-sync.test:443")
    try first.setAutomaticPhotoSyncPreference(preference, uploadsPaused: true)
    XCTAssertEqual(try LibraryStore(root: first.root).automaticPhotoSyncPreference(), preference)
    XCTAssertFalse(try LibraryStore(root: root.appendingPathComponent(Wire.id())).automaticPhotoSyncPreference().enabled)
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    services.photosBackupSnapshot = { _ in [] }
    services.automaticPhotosAuthorization = { .denied }
    XCTAssertThrowsError(try services.enableAutomaticPhotoSync())
    XCTAssertFalse(try services.store.automaticPhotoSyncPreference().enabled)
    services.automaticPhotosAuthorization = { .authorized }
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    services.api.baseURL = URL(string: "https://other.test")!
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    XCTAssertEqual(services.automaticPhotoSync.phase, .off)
    services.session.fixture = true
    XCTAssertThrowsError(try services.enableAutomaticPhotoSync())
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
  }

  @MainActor func testOptedAccountColdRestorationStartsOnlyWhenForegroundPermitted() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    services.automaticPhotosAuthorization = { .authorized }
    services.photosBackupSnapshot = { _ in [] }
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    try context.persistSession(services)
    let reopened = try context.restoredServices()
    defer { reopened.vault.lock() }
    var scans = 0
    reopened.automaticPhotosAuthorization = { .authorized }
    reopened.photosBackupSnapshot = { _ in scans += 1; return [] }
    await reopened.resumeSavedAccount(initialRestoration: true)
    await reopened.waitForAutomaticPhotoSync()
    XCTAssertTrue(reopened.automaticPhotoSync.enabled)
    XCTAssertEqual(reopened.automaticPhotoSync.phase, .background)
    XCTAssertEqual(scans, 0)
    reopened.setPhotoSyncForeground(true)
    await reopened.waitForAutomaticPhotoSync()
    XCTAssertGreaterThan(scans, 0)
    XCTAssertEqual(reopened.automaticPhotoSync.phase, .ready)
    XCTAssertTrue(PausedUploadProtocol.server.requests.isEmpty)
  }
}

private actor AutomaticSourceReads {
  private var sources: [String] = []
  func record(_ id: String) { sources.append(id) }
  func values() -> [String] { sources }
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
  private var published: [String] = []
  var reservedPhotoIDs: [String] { lock.lock(); defer { lock.unlock() }; return reservations.values.map { $0.binding.photoId } }
  var publishedPhotoIDs: [String] { lock.lock(); defer { lock.unlock() }; return published }
  var reservationGate: UploadRequestGate?
  private var annotationFailures = 0
  private var catalogFailures = 0
  func failCatalogReads(_ count: Int) { lock.lock(); defer { lock.unlock() }; catalogFailures = count }
  func failAnnotationWrites(_ count: Int) { lock.lock(); defer { lock.unlock() }; annotationFailures = count }
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
    published = []
    reservationGate = nil
    annotationFailures = 0
    catalogFailures = 0
  }
  func response(_ request: URLRequest) throws -> Data {
    if request.url?.path == "/v1/uploads/reserve" { reservationGate?.visit() }
    lock.lock()
    defer { lock.unlock() }
    let path = request.url!.path
    recorded.append(Request(method: request.httpMethod ?? "GET", path: path))
    switch path {
    case "/v1/changes":
      if catalogFailures > 0 { catalogFailures -= 1; throw URLError(.notConnectedToInternet) }
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
      let bytes = try Data(b64: signed.body)
      published.append(try Wire.decode(PhotoManifestV1.self, bytes).photoId)
      return bytes
    default:
      if path.hasSuffix("/commit"), let input = reservations[request.url!.deletingLastPathComponent().lastPathComponent] {
        // A commit probe found a previously uploaded immutable representation.
        return try Wire.encode(UploadCommitV1(version: 1, uploadId: request.url!.deletingLastPathComponent().lastPathComponent, objectId: Wire.id(), ciphertextBytes: input.ciphertextBytes, ciphertextSha256: input.ciphertextSha256))
      }
      if path.hasSuffix("/annotations"), request.httpMethod == "PUT" {
        if annotationFailures > 0 { annotationFailures -= 1; throw URLError(.notConnectedToInternet) }
        return Data("{}".utf8)
      }
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
