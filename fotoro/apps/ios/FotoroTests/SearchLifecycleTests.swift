import GRDB
import Photos
import UIKit
import XCTest

@testable import Fotoro

private actor AdmissionQueryProbe {
  private(set) var queries: [String] = []
  func record(_ query: String) { queries.append(query) }
}
@MainActor private final class AdmissionPreviewGate {
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { await withCheckedContinuation { continuation = $0 } }
  func open() { continuation?.resume(); continuation = nil }
}

final class SearchLifecycleTests: XCTestCase {
  @MainActor func testOCRIsDurableAndSearchableWhileClassificationIsHeldOrCancelled() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit an existing public Simulator photo for OCR priority.")
    }
    let photo = RecentPhoto(asset: asset)
    let image = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
      UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    }.cgImage)
    for cancelClassification in [false, true] {
      let index = try SearchIndex(), gate = AdmissionPreviewGate()
      var record = SearchRecord(id: photo.id); record.revision = photo.sourceRevision; record.capturedAt = Date()
      try index.replacePermitted([record])
      #if !FOTORO_LOCAL_PREVIEW
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      XCTAssertTrue(try index.applySemantic(vector, photoID: record.id, revision: record.revision))
      #endif
      let store = LocalSearchStore(index: index, analysisWindow: .tenDays)
      store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: [photo])
      store.analysisQueryRefreshDelay = {}
      store.analysisPreview = { _ in SearchPreview(image: image) }
      store.analysisRecognize = { _ in SearchOCRResult(text: "Public ticket fixture", confidence: 0.95) }
      var publications: [SearchRecord] = []
      store.onRecordChanged = { observed, _ in publications.append(observed) }
      let held = expectation(description: "Classification is held after text checkpoint")
      let classificationReturned = expectation(description: "Held classifier returns")
      store.analysisClassify = { _ in
        held.fulfill(); await gate.wait()
        classificationReturned.fulfill()
        return SearchVisualResult(labels: [], processor: SearchVisualPolicy.processor)
      }
      defer { store.pause(); gate.open() }
      store.updateQuery("ticket")
      store.setAutomaticAnalysisActive(true)
      await fulfillment(of: [held], timeout: 3)
      XCTAssertEqual(try index.record(record.id)?.ocrStatus, .complete,
        "Optional scene inference cannot hold the durable OCR checkpoint")
      XCTAssertEqual(publications.first?.ocrStatus, .complete,
        "Completed text must reach the encrypted-annotation capture boundary before classification")
      XCTAssertEqual(publications.first?.visualStatus, .pending)
      XCTAssertEqual(publications.first?.revision, record.revision)
      for _ in 0..<200 where store.response.leading?.id != record.id {
        try await Task.sleep(for: .milliseconds(10))
      }
      XCTAssertEqual(store.response.leading?.id, record.id, "Text results must publish before classification completes")
      if cancelClassification { store.pause() }
      gate.open()
      await fulfillment(of: [classificationReturned], timeout: 2)
      await Task.yield()
      for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
      XCTAssertEqual(try index.record(record.id)?.ocrStatus, .complete)
      if cancelClassification {
        XCTAssertEqual(try index.record(record.id)?.visualStatus, .pending)
        XCTAssertEqual(publications.count, 1, "Cancellation cannot retract text or publish the unfinished scene")
        let work = try index.pendingMetadataAnalysisWork(scope: PhotoAnalysisWindow.tenDays.scope())
        XCTAssertEqual(work.first?.stages, [.visual], "Resume retains OCR and retries only the unfinished classifier")
      } else {
        XCTAssertEqual(try index.record(record.id)?.visualStatus, .complete)
        XCTAssertEqual(publications.last?.visualStatus, .complete, "The finished scene enriches the already captured text")
      }
    }
  }
  @MainActor func testManualNextBatchKeepsItsCursorAndPreemptsAutomaticWork() async throws {
    let fetched = PHAsset.fetchAssets(with: .image, options: nil)
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), fetched.count >= 2 else {
      throw XCTSkip("Permit two public Simulator photos for manual analysis priority.")
    }
    let photos = (0..<2).map { RecentPhoto(asset: fetched.object(at: $0)) }, index = try SearchIndex()
    try index.replacePermitted(photos.map { photo in
      var record = SearchRecord(id: photo.id); record.revision = photo.sourceRevision
      record.capturedAt = Date(); record.labels = ["public fixture"]; return record
    })
    let store = LocalSearchStore(index: index), gate = AdmissionPreviewGate()
    store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: photos)
    defer { store.pause(); gate.open() }
    let automaticHeld = expectation(description: "Automatic preview held after explicit batch")
    let nextFinished = expectation(description: "Explicit next batch publishes")
    var previews = 0, publications = 0
    store.analysisPreview = { _ in
      previews += 1
      if previews == 2 { automaticHeld.fulfill(); await gate.wait() }
      return nil
    }
    store.onRecordChanged = { _, _ in
      publications += 1
      if publications == 2 { nextFinished.fulfill() }
    }
    store.updateQuery("public fixture"); store.analyzeMetadataMatches(batchLimit: 1)
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [automaticHeld], timeout: 5)
    XCTAssertEqual(store.analysisRemaining, 1)
    XCTAssertTrue(store.canAnalyzeMetadataMatches)
    store.analyzeMetadataMatches(nextBatch: true, batchLimit: 1)
    gate.open()
    await fulfillment(of: [nextFinished], timeout: 5)
    store.setAutomaticAnalysisActive(false)
    for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(previews, 3); XCTAssertEqual(store.analysisRemaining, 0)
  }
  @MainActor func testAutomaticRangeChangePreservesHeldExplicitBatchRemainingCount() async throws {
    let fetched = PHAsset.fetchAssets(with: .image, options: nil)
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), fetched.count >= 2 else {
      throw XCTSkip("Permit two public Simulator photos for explicit-batch range controls.")
    }
    let photos = (0..<2).map { RecentPhoto(asset: fetched.object(at: $0)) }, index = try SearchIndex()
    try index.replacePermitted(photos.map { photo in
      var record = SearchRecord(id: photo.id); record.revision = photo.sourceRevision
      record.capturedAt = Date(); record.labels = ["public fixture"]; return record
    })
    let store = LocalSearchStore(index: index), gate = AdmissionPreviewGate()
    store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: photos)
    defer { store.pause(); gate.open() }
    let held = expectation(description: "Explicit preview is held")
    store.analysisPreview = { _ in held.fulfill(); await gate.wait(); return nil }
    store.updateQuery("public fixture"); store.analyzeMetadataMatches(batchLimit: 1)
    await fulfillment(of: [held], timeout: 3)
    XCTAssertEqual(store.analysisRemaining, 1)
    store.setAutomaticAnalysisWindow(.tenDays)
    XCTAssertTrue(store.indexing); XCTAssertEqual(store.analysisRemaining, 1)
    gate.open()
    for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(store.indexing); XCTAssertEqual(store.analysisRemaining, 1)
    XCTAssertEqual(store.analysisUnavailable, 1)
  }
  @MainActor func testExplicitScopedCheckResumesAutomaticWorkWithoutAnotherScrollOrForegroundEvent() async throws {
    let fetched = PHAsset.fetchAssets(with: .image, options: nil)
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), fetched.count >= 2 else {
      throw XCTSkip("Permit two public Simulator photos for analysis continuation.")
    }
    let photos = (0..<2).map { RecentPhoto(asset: fetched.object(at: $0)) }
    let index = try SearchIndex()
    let records = photos.enumerated().map { offset, photo -> SearchRecord in
      var record = SearchRecord(id: photo.id); record.revision = photo.sourceRevision
      record.capturedAt = Date(); record.labels = [offset == 0 ? "scoped fixture" : "other fixture"]
      return record
    }
    try index.replacePermitted(records)
    let store = LocalSearchStore(index: index)
    store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: photos)
    defer { store.pause() }
    store.analysisPreview = { _ in nil }
    let continued = expectation(description: "Unmatched photo analyzed after explicit work")
    store.onRecordChanged = { record, _ in if record.id == records[1].id { continued.fulfill() } }
    store.updateQuery("scoped fixture"); store.analyzeMetadataMatches()
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [continued], timeout: 5)
    XCTAssertEqual(try index.record(records[0].id)?.ocrStatus, .unavailable)
    XCTAssertEqual(try index.record(records[1].id)?.ocrStatus, .unavailable)
  }
  #if !FOTORO_LOCAL_PREVIEW
  func testAnnotationBatchAcceptsUnchangedRowsWithoutRebuildingPostingsAndRejectsStaleSources() throws {
    let index = try SearchIndex(), records = [SearchRecord(id: "a"), SearchRecord(id: "b")]
    try index.replacePermitted(records)
    try index.database.write { db in
      try db.execute(sql: """
        CREATE TABLE annotationWrites(count INTEGER NOT NULL);
        INSERT INTO annotationWrites VALUES(0);
        CREATE TRIGGER count_annotation_writes AFTER UPDATE ON searchRecords
        BEGIN UPDATE annotationWrites SET count=count+1; END;
        """)
    }
    let updates = records.map { record in
      SearchIndex.AnnotationUpdate(value: PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("public fixture".utf8).digest,
        labels: ["Batch receipt"], facts: [PhotoOrganizationFacts.screenshotPrefix + "true"]),
        photoID: record.id, revision: record.revision, accountId: "fixture-owner")
    }
    let first = try index.applyAnnotationsBatch(updates)
    XCTAssertEqual(first.acceptedPhotoIDs, Set(["a", "b"]))
    XCTAssertEqual(first.changedRecords.count, 2); XCTAssertTrue(first.organizationChanged)
    let unchanged = try index.applyAnnotationsBatch(updates)
    XCTAssertEqual(unchanged.acceptedPhotoIDs, first.acceptedPhotoIDs)
    XCTAssertTrue(unchanged.changedRecords.isEmpty); XCTAssertFalse(unchanged.organizationChanged)
    XCTAssertTrue(try index.applyAnnotations(updates[0].value, photoID: "a", revision: "1", accountId: "fixture-owner"),
      "The existing single-photo API accepts current unchanged overlays")
    XCTAssertEqual(try index.database.read { try Int.fetchOne($0, sql: "SELECT count FROM annotationWrites") }, 2)
    let stale = SearchIndex.AnnotationUpdate(value: updates[0].value, photoID: "a", revision: "obsolete", accountId: "fixture-owner")
    let missing = SearchIndex.AnnotationUpdate(value: updates[0].value, photoID: "missing", revision: "1", accountId: "fixture-owner")
    XCTAssertTrue(try index.applyAnnotationsBatch([stale, missing]).acceptedPhotoIDs.isEmpty)
    XCTAssertThrowsError(try index.applyAnnotationsBatch(Array(repeating: updates[0], count: 201)))
    XCTAssertEqual(try index.database.read { try Int.fetchOne($0, sql: "SELECT count FROM annotationWrites") }, 2)
  }
  func testAnnotationBatchRollsBackRecordsBaselinesAndSearchPostingsWhenALaterWriteFails() throws {
    let index = try SearchIndex(), records = [SearchRecord(id: "a"), SearchRecord(id: "b")]
    try index.replacePermitted(records)
    try index.database.write { db in
      try db.execute(sql: """
        CREATE TRIGGER reject_second_annotation BEFORE UPDATE ON searchRecords WHEN NEW.id='b'
        BEGIN SELECT RAISE(ABORT,'injected annotation failure'); END;
        """)
    }
    let updates = records.map { record in
      SearchIndex.AnnotationUpdate(value: PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("public fixture".utf8).digest,
        labels: ["Batch receipt"]), photoID: record.id, revision: record.revision, accountId: "fixture-owner")
    }
    XCTAssertThrowsError(try index.applyAnnotationsBatch(updates))
    for record in records { XCTAssertEqual(try index.record(record.id), record) }
    XCTAssertNil(try index.search("batch receipt").leading, "Earlier posting writes roll back with the later failed record")
  }
  func testAnnotationBatchReadsTheLatestCompletedOCRAndRetainsItsBeforeSyncBaseline() throws {
    let index = try SearchIndex()
    var local = SearchRecord(id: "a"); local.labels = ["Local label"]
    try index.replacePermitted([local])
    var value = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("public fixture".utf8).digest,
      labels: ["Saved label"], ocr: PhotoAnnotationsV1.OCR(text: "Saved receipt", confidence: 0.8, processor: local.processor))
    XCTAssertTrue(try index.applyAnnotations(value, photoID: local.id, revision: local.revision, accountId: "fixture-owner"))
    let incoming = SearchIndex.AnnotationUpdate(value: value, photoID: local.id, revision: local.revision, accountId: "fixture-owner")
    XCTAssertTrue(try index.applyOCR(SearchOCRResult(text: "Newest device receipt", confidence: 0.9), status: .complete,
      photoID: local.id, revision: local.revision))
    value.ocr = nil
    let update = SearchIndex.AnnotationUpdate(value: value, photoID: incoming.photoID, revision: incoming.revision, accountId: incoming.accountId)
    _ = try index.applyAnnotationsBatch([update])
    let hydrated = try XCTUnwrap(index.record(local.id))
    XCTAssertEqual(hydrated.ocrText, "Newest device receipt")
    XCTAssertEqual(hydrated.beforeSync?.ocrText, "Newest device receipt")
    XCTAssertEqual(hydrated.ocrStatus, .complete); XCTAssertTrue(hydrated.previewAvailable)
    try index.clearSyncedAnnotations()
    let restored = try XCTUnwrap(index.record(local.id))
    XCTAssertEqual(restored.labels, ["Local label"])
    XCTAssertEqual(restored.ocrText, "Newest device receipt"); XCTAssertEqual(restored.ocrStatus, .complete)
  }
  @MainActor func testAnnotationBatchPublishesOneOrganizationAndQueryChangeOnlyAfterCommit() throws {
    let index = try SearchIndex(), records = [SearchRecord(id: "a"), SearchRecord(id: "b")]
    try index.replacePermitted(records)
    let store = LocalSearchStore(index: index)
    store.setAutomaticAnalysisActive(false)
    defer { store.pause() }
    var publications = 0
    store.onOrganizationSnapshotChanged = { publications += 1 }
    let organization = store.organizationGeneration, query = store.consumerContextGeneration
    let updates = records.map { record in
      SearchIndex.AnnotationUpdate(value: PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("public fixture".utf8).digest,
        facts: [PhotoOrganizationFacts.screenshotPrefix + "true"]), photoID: record.id, revision: record.revision, accountId: "fixture-owner")
    }
    try store.applyAnnotationsBatch(updates)
    XCTAssertEqual(publications, 1); XCTAssertEqual(store.organizationGeneration, organization + 1)
    XCTAssertEqual(store.consumerContextGeneration, query + 1)
    try store.applyAnnotationsBatch(updates)
    XCTAssertEqual(publications, 1); XCTAssertEqual(store.consumerContextGeneration, query + 1)
    try index.database.write { db in
      try db.execute(sql: """
        CREATE TRIGGER reject_annotation_publication BEFORE UPDATE ON searchRecords WHEN NEW.id='b'
        BEGIN SELECT RAISE(ABORT,'injected annotation failure'); END;
        """)
    }
    let failed = updates.map { update in
      var value = update.value; value.facts = [PhotoOrganizationFacts.screenshotPrefix + "false"]
      return SearchIndex.AnnotationUpdate(value: value, photoID: update.photoID, revision: update.revision, accountId: update.accountId)
    }
    XCTAssertThrowsError(try store.applyAnnotationsBatch(failed))
    XCTAssertEqual(publications, 1); XCTAssertEqual(store.consumerContextGeneration, query + 1)
    for record in records { XCTAssertTrue(PhotoOrganizationFacts.screenshot(try index.record(record.id)?.facts)) }
  }
  @MainActor func testDiagnosticSnapshotDoesNotPublishCoverageAcrossSourceWithdrawal() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else {
      throw XCTSkip("Permit public Simulator Photos for the current-index status export.")
    }
    let index = try SearchIndex()
    try index.replacePermitted([SearchRecord(id: "public-source")])
    let store = LocalSearchStore(index: index)
    store.setAutomaticAnalysisActive(false)
    store.completePermittedSnapshotRefresh(photos: [])
    defer { store.pause() }
    let current = await store.diagnosticIndexSnapshot()
    XCTAssertEqual(current.first?.analysisActivity, .inactive)
    XCTAssertEqual(current.first?.total, 1)
    let gate = AdmissionPreviewGate(), started = expectation(description: "Snapshot read held")
    store.diagnosticCoverageRead = { index, now in
      let coverage = try index.analysisCoverage(now: now)
      started.fulfill(); await gate.wait(); return coverage
    }
    let export = Task { await store.diagnosticIndexSnapshot() }
    await fulfillment(of: [started], timeout: 3)
    store.pause()
    gate.open()
    let withdrawn = await export.value
    XCTAssertEqual(withdrawn.count, 1)
    XCTAssertEqual(withdrawn.first?.reason, .contextChanged)
    XCTAssertNil(withdrawn.first?.total); XCTAssertNil(withdrawn.first?.analysisStage)
  }
  @MainActor func testOrganizationPublicationIgnoresOCRProgressAndPublishesScreenshotCorrections() throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit an existing public Simulator photo for organization publication.")
    }
    let photo = RecentPhoto(asset: asset), index = try SearchIndex()
    var record = SearchRecord(id: photo.id); record.revision = photo.sourceRevision
    try index.replacePermitted([record])
    let store = LocalSearchStore(index: index)
    defer { store.pause() }
    store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: [photo])
    let source = BackupSource(id: photo.id, photoId: Wire.id(), sourceRevision: photo.sourceRevision)
    var value = PhotoAnnotationsV1(photoId: source.photoId, originalSha256: Data("public-fixture".utf8).digest)
    value.ocr = PhotoAnnotationsV1.OCR(text: "Public receipt", confidence: 0.9, processor: "vision-text-v1")
    var publications = 0
    store.onOrganizationSnapshotChanged = { publications += 1 }
    let generation = store.organizationGeneration
    try store.applyAnnotations(value, source: source, accountId: "fixture-owner")
    store.updateQuery("receipt")
    XCTAssertEqual(store.organizationGeneration, generation)
    XCTAssertEqual(publications, 0, "OCR and query progress must not rebuild browse/Picks facts")
    value.facts = [PhotoOrganizationFacts.screenshotPrefix + "true"]
    try store.applyAnnotations(value, source: source, accountId: "fixture-owner")
    XCTAssertEqual(publications, 1)
    XCTAssertTrue(PhotoOrganizationFacts.screenshot(try store.record(photo.id)?.facts))
    value.ocr?.text = "Updated public receipt"
    try store.applyAnnotations(value, source: source, accountId: "fixture-owner")
    XCTAssertEqual(publications, 1)
    store.clearSyncedAnnotations()
    XCTAssertEqual(publications, 2)
    XCTAssertFalse(PhotoOrganizationFacts.screenshot(try store.record(photo.id)?.facts))
  }
  @MainActor func testColdSemanticPreparationCannotHoldRecentBatchesOrScrollResume() async throws {
    let fetched = PHAsset.fetchAssets(with: .image, options: nil)
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), fetched.count >= 3 else {
      throw XCTSkip("Permit three existing public Simulator photos for cold indexing admission.")
    }
    let photos = (0..<3).map { RecentPhoto(asset: fetched.object(at: $0)) }
    guard photos.allSatisfy({ !$0.asset.isHidden }) else { throw XCTSkip("Use visible permitted public photos.") }
    let index = try SearchIndex()
    let records = photos.map { photo -> SearchRecord in
      var record = SearchRecord(id: photo.id)
      record.revision = photo.sourceRevision; record.capturedAt = Date()
      record.ocrStatus = .complete; record.visualStatus = .complete
      return record
    }
    try index.replacePermitted(records)
    let image = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
      UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    }.cgImage)
    let preparationGate = AdmissionPreviewGate(), previewGate = AdmissionPreviewGate()
    let installationStarted = expectation(description: "Public model installation is held")
    let installation = Task<URL, Error> { @MainActor in
      installationStarted.fulfill(); await preparationGate.wait()
      return URL(fileURLWithPath: "/public-model-fixture")
    }
    let store = LocalSearchStore(index: index)
    store.setAutomaticAnalysisActive(false); store.automaticAnalysisBatchLimit = 2
    store.completePermittedSnapshotRefresh(photos: photos)
    let held = expectation(description: "Second preview is unfinished during cold preparation")
    let prepared = expectation(description: "Every source reaches its cold checkpoint")
    let embedded = expectation(description: "Ready model revisits every missing vector")
    var ready = false, reads: [String: Int] = [:], previews = 0, publications = 0, vectors = 0
    store.analysisSemanticPreparation = {
      _ = try await PhotoSemanticProcessor.awaitInstallation(installation)
      ready = true
    }
    store.analysisSemanticReady = { ready }
    store.analysisSemanticImage = { _ in
      vectors += 1
      if vectors == records.count { embedded.fulfill() }
      var result = [Float](repeating: 0, count: 512); result[0] = 1
      return result
    }
    store.analysisPreview = { asset in
      previews += 1; reads[asset.localIdentifier, default: 0] += 1
      if previews == 2 { held.fulfill(); await previewGate.wait() }
      return SearchPreview(image: image)
    }
    store.onRecordChanged = { _, _ in
      publications += 1
      if publications == records.count { prepared.fulfill() }
    }
    defer { store.pause(); preparationGate.open(); previewGate.open() }
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [installationStarted, held], timeout: 5)
    store.setBrowseInteractionActive(true); previewGate.open(); store.setBrowseInteractionActive(false)
    await fulfillment(of: [prepared], timeout: 5)
    XCTAssertFalse(ready, "OCR checkpoints and the replacement worker cannot await installation")
    XCTAssertFalse(installation.isCancelled, "Scrolling cannot cancel the shared public installation")
    XCTAssertEqual(store.automaticAnalysisWorkerStarts, 2)
    XCTAssertEqual(reads.values.sorted(), [1, 1, 2], "Only the unfinished preview is reread before readiness")
    XCTAssertEqual(vectors, 0)
    for record in records { XCTAssertTrue(try index.needsSemantic(photoID: record.id, revision: record.revision)) }
    preparationGate.open()
    await fulfillment(of: [embedded], timeout: 5)
    for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    for record in records { XCTAssertFalse(try index.needsSemantic(photoID: record.id, revision: record.revision)) }
    XCTAssertEqual(vectors, records.count)
    XCTAssertEqual(store.analysisUnavailable, 0)
  }
  @MainActor func testCancelledModelConsumerLeavesSharedInstallationAvailableForNextConsumer() async throws {
    let gate = AdmissionPreviewGate()
    let began = expectation(description: "Installation began"), cancelled = expectation(description: "Consumer cancels before installation ends")
    let installation = Task<URL, Error> { @MainActor in
      began.fulfill(); await gate.wait(); return URL(fileURLWithPath: "/public-model-fixture")
    }
    defer { gate.open() }
    let consumer = Task {
      do { _ = try await PhotoSemanticProcessor.awaitInstallation(installation); XCTFail("Cancelled consumer cannot admit a model") }
      catch { XCTAssertTrue(error is CancellationError); cancelled.fulfill() }
    }
    await fulfillment(of: [began], timeout: 1)
    consumer.cancel()
    await fulfillment(of: [cancelled], timeout: 1)
    XCTAssertFalse(installation.isCancelled)
    gate.open()
    let admitted = try await PhotoSemanticProcessor.awaitInstallation(installation)
    XCTAssertEqual(admitted, URL(fileURLWithPath: "/public-model-fixture"))
    await consumer.value
  }
  @MainActor func testColdExplicitHistoricalAnalysisKeepsItsScopeAndCancelsPromptly() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit an existing public Simulator photo for historical analysis.")
    }
    for withdraw in [false, true] {
      let photo = RecentPhoto(asset: asset), index = try SearchIndex()
      var record = SearchRecord(id: photo.id)
      record.revision = photo.sourceRevision; record.capturedAt = Date().addingTimeInterval(-90 * 86400)
      record.labels = ["historical fixture"]; record.ocrStatus = .complete; record.visualStatus = .complete
      try index.replacePermitted([record])
      let image = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
        UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
      }.cgImage)
      let gate = AdmissionPreviewGate(), began = expectation(description: "Historical model consumer awaits readiness")
      let installation = Task<URL, Error> { @MainActor in
        await gate.wait(); return URL(fileURLWithPath: "/public-model-fixture")
      }
      let store = LocalSearchStore(index: index)
      store.setAutomaticAnalysisActive(false); store.completePermittedSnapshotRefresh(photos: [photo])
      var ready = false, vectors = 0, previews = 0
      store.analysisPreview = { _ in previews += 1; return SearchPreview(image: image) }
      store.analysisSemanticPreparation = {
        began.fulfill(); _ = try await PhotoSemanticProcessor.awaitInstallation(installation); ready = true
      }
      store.analysisSemanticReady = { ready }
      store.analysisSemanticImage = { _ in
        vectors += 1; var result = [Float](repeating: 0, count: 512); result[0] = 1; return result
      }
      defer { store.pause(); gate.open() }
      store.updateQuery("historical fixture"); store.analyzeMetadataMatches()
      await fulfillment(of: [began], timeout: 3)
      XCTAssertTrue(store.indexing)
      if withdraw {
        store.updateQuery("different scope")
        for _ in 0..<100 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(store.indexing, "Query withdrawal must not await installation")
        XCTAssertFalse(installation.isCancelled)
      }
      gate.open()
      for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
      XCTAssertEqual(previews, 1, "Explicit inference retains the same derivative")
      XCTAssertEqual(vectors, withdraw ? 0 : 1)
      XCTAssertEqual(try index.needsSemantic(photoID: record.id, revision: record.revision), withdraw)
    }
  }
  #endif
  @MainActor func testAutomaticAnalysisReachesOlderAndUndatedPhotosAcrossQueryChangesAndScrollResume() async throws {
    let fetched = PHAsset.fetchAssets(with: .image, options: nil)
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), fetched.count >= 4 else {
      throw XCTSkip("Permit four existing public Simulator photos for bounded analysis continuation.")
    }
    let photos = (0..<4).map { RecentPhoto(asset: fetched.object(at: $0)) }
    guard photos.allSatisfy({ !$0.asset.isHidden }) else { throw XCTSkip("Use permitted visible public photos.") }
    let index = try SearchIndex()
    let records = photos.enumerated().map { offset, photo -> SearchRecord in
      var record = SearchRecord(id: photo.id)
      record.revision = photo.sourceRevision
      record.capturedAt = offset == 0 ? Date().addingTimeInterval(-90 * 86400) : offset == 1 ? nil : Date()
      record.visualStatus = .complete
      return record
    }
    try index.replacePermitted(records)
    #if !FOTORO_LOCAL_PREVIEW
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      for record in records {
        XCTAssertTrue(try index.applySemantic(vector, photoID: record.id, revision: record.revision))
      }
    #endif
    let store = LocalSearchStore(index: index), gate = AdmissionPreviewGate()
    store.setAutomaticAnalysisActive(false)
    store.automaticAnalysisBatchLimit = 2
    store.completePermittedSnapshotRefresh(photos: photos)
    let completed = expectation(description: "Idle preparation reaches every bounded batch")
    let held = expectation(description: "Second source holds its unfinished preview")
    var previews = 0, published = 0
    var reads: [String: Int] = [:]
    store.analysisPreview = { asset in
      previews += 1; reads[asset.localIdentifier, default: 0] += 1
      if previews == 2 { held.fulfill(); await gate.wait() }
      return nil
    }
    store.onRecordChanged = { _, _ in
      published += 1
      if published == 1 {
        store.updateQuery("unindexed beach")
        store.setPeopleSelection(PeopleSearchSelection(personIDs: ["reviewed-person"]))
      }
      if published == records.count { completed.fulfill() }
    }
    defer { store.pause(); gate.open() }
    let generation = store.libraryGeneration
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [held], timeout: 5)
    XCTAssertEqual(published, 1)
    store.setBrowseInteractionActive(true)
    gate.open()
    store.setBrowseInteractionActive(false)
    await fulfillment(of: [completed], timeout: 5)
    for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(store.indexing)
    XCTAssertEqual(previews, records.count + 1)
    XCTAssertEqual(reads.values.sorted(), [1, 1, 1, 2], "Only the unfinished source may be reread after scrolling")
    XCTAssertEqual(store.automaticAnalysisWorkerStarts, 2)
    XCTAssertEqual(store.analysisRemaining, 0)
    XCTAssertEqual(store.analysisUnavailable, records.count)
    XCTAssertEqual(store.query, "unindexed beach")
    for record in records { XCTAssertEqual(try index.record(record.id)?.ocrStatus, .unavailable) }
    store.setBrowseInteractionActive(true)
    store.setBrowseInteractionActive(false)
    try await Task.sleep(for: .milliseconds(700))
    XCTAssertEqual(previews, records.count + 1, "Idle must retain its cursor instead of retrying unavailable sources")
    XCTAssertEqual(store.libraryGeneration, generation, "Query and batch progress cannot restart metadata intake")
  }
  @MainActor func testQueuedQueryUpdatesInvokeOnlyNewestExecutor() async throws {
    let probe = AdmissionQueryProbe()
    let store = LocalSearchStore(index: try SearchIndex(), queryExecutor: { index, query, scope, accepted, previous, generation in
      await probe.record(query)
      return try index.search(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
    })
    for number in 0..<100 { store.updateQuery("receipt \(number)") }
    for _ in 0..<200 where store.searching { try await Task.sleep(for: .milliseconds(10)) }
    let invoked = await probe.queries
    XCTAssertEqual(invoked, ["receipt 99"])
    XCTAssertFalse(store.searching)
    XCTAssertEqual(store.response.query, "receipt 99")
  }
  @MainActor func testRepeatedScrollIdleRetainsOneHeldAutomaticWorkerAndResumesWithoutMetadataRefresh() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit a public Simulator photo for automatic analysis admission.")
    }
    let photo = RecentPhoto(asset: asset), index = try SearchIndex()
    var record = SearchRecord(id: photo.id)
    record.revision = photo.sourceRevision; record.capturedAt = Date(); record.visualStatus = .complete
    try index.replacePermitted([record])
    #if !FOTORO_LOCAL_PREVIEW
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      XCTAssertTrue(try index.applySemantic(vector, photoID: record.id, revision: record.revision))
    #endif
    let store = LocalSearchStore(index: index), gate = AdmissionPreviewGate()
    store.setAutomaticAnalysisActive(false)
    store.completePermittedSnapshotRefresh(photos: [photo])
    let held = expectation(description: "Automatic OCR holds one preview")
    let cancelled = expectation(description: "Scrolling cancels automatic preview")
    let resumed = expectation(description: "Idle resumes pending cached metadata")
    var previews = 0, published = 0
    store.analysisPreview = { _ in
      previews += 1
      if previews == 1 {
        return await withTaskCancellationHandler {
          held.fulfill(); await gate.wait(); return nil
        } onCancel: { cancelled.fulfill() }
      }
      resumed.fulfill(); return nil
    }
    store.onRecordChanged = { _, _ in published += 1 }
    defer { store.pause(); gate.open() }
    let library = store.libraryGeneration
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [held], timeout: 2)
    store.setBrowseInteractionActive(true)
    await fulfillment(of: [cancelled], timeout: 1)
    for _ in 0..<4 {
      store.setBrowseInteractionActive(false)
      try await Task.sleep(for: .milliseconds(550))
      XCTAssertEqual(previews, 1, "Idle cannot read another preview until the canceled worker actually drains")
      XCTAssertEqual(store.automaticAnalysisWorkerStarts, 1, "Repeated idle cycles cannot accumulate waiting worker tasks")
      store.setBrowseInteractionActive(true)
    }
    store.setBrowseInteractionActive(false)
    try await Task.sleep(for: .milliseconds(550))
    XCTAssertEqual(store.automaticAnalysisWorkerStarts, 1)
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .pending)
    XCTAssertEqual(published, 0)
    XCTAssertEqual(store.assets[photo.id]?.sourceRevision, photo.sourceRevision)
    gate.open()
    await fulfillment(of: [resumed], timeout: 2)
    for _ in 0..<100 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(previews, 2)
    XCTAssertEqual(store.automaticAnalysisWorkerStarts, 2)
    try await Task.sleep(for: .milliseconds(600))
    XCTAssertEqual(previews, 2, "An unavailable completion must not restart itself")
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .unavailable)
    XCTAssertEqual(store.libraryGeneration, library, "Idle resume cannot rescan or invalidate permitted metadata")
  }
  @MainActor func testExplicitAnalysisRemainsAvailableWhileAutomaticAdmissionIsHidden() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit a public Simulator photo for explicit analysis admission.")
    }
    let photo = RecentPhoto(asset: asset), index = try SearchIndex()
    var record = SearchRecord(id: photo.id)
    record.revision = photo.sourceRevision; record.capturedAt = Date(); record.visualStatus = .complete
    try index.replacePermitted([record])
    #if !FOTORO_LOCAL_PREVIEW
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      XCTAssertTrue(try index.applySemantic(vector, photoID: record.id, revision: record.revision))
    #endif
    let store = LocalSearchStore(index: index)
    store.setAutomaticAnalysisActive(false); store.setBrowseInteractionActive(true)
    store.completePermittedSnapshotRefresh(photos: [photo])
    var previews = 0
    store.analysisPreview = { _ in previews += 1; return nil }
    defer { store.pause() }
    try await Task.sleep(for: .milliseconds(600))
    XCTAssertEqual(previews, 0)
    store.analyzeMetadataMatches()
    for _ in 0..<100 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(previews, 1)
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .unavailable)
  }
  @MainActor func testExplicitAnalysisWaitsForCanceledAutomaticWorkerWithoutScrollCancelingItsPreview() async throws {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(with: .image, options: nil).firstObject, !asset.isHidden else {
      throw XCTSkip("Permit a public Simulator photo for analysis ownership.")
    }
    let photo = RecentPhoto(asset: asset), index = try SearchIndex()
    var record = SearchRecord(id: photo.id)
    record.revision = photo.sourceRevision; record.capturedAt = Date(); record.visualStatus = .complete
    try index.replacePermitted([record])
    #if !FOTORO_LOCAL_PREVIEW
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      XCTAssertTrue(try index.applySemantic(vector, photoID: record.id, revision: record.revision))
    #endif
    let store = LocalSearchStore(index: index), automaticGate = AdmissionPreviewGate(), explicitGate = AdmissionPreviewGate()
    store.setAutomaticAnalysisActive(false)
    store.completePermittedSnapshotRefresh(photos: [photo])
    let automaticHeld = expectation(description: "Automatic preview held")
    let explicitHeld = expectation(description: "Explicit preview held after automatic drain")
    let explicitCanceled = expectation(description: "Scrolling must preserve explicit preview")
    explicitCanceled.isInverted = true
    var previews = 0
    store.analysisPreview = { _ in
      previews += 1
      if previews == 1 { automaticHeld.fulfill(); await automaticGate.wait(); return nil }
      return await withTaskCancellationHandler {
        explicitHeld.fulfill(); await explicitGate.wait(); return nil
      } onCancel: { explicitCanceled.fulfill() }
    }
    defer { store.pause(); automaticGate.open(); explicitGate.open() }
    store.setAutomaticAnalysisActive(true)
    await fulfillment(of: [automaticHeld], timeout: 2)
    store.setAutomaticAnalysisActive(false)
    store.analyzeMetadataMatches()
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(previews, 1, "Explicit work must await the same retained worker")
    XCTAssertTrue(store.indexing)
    automaticGate.open()
    await fulfillment(of: [explicitHeld], timeout: 2)
    store.setBrowseInteractionActive(true)
    store.setBrowseInteractionActive(false)
    await fulfillment(of: [explicitCanceled], timeout: 0.1)
    XCTAssertTrue(store.indexing, "The drained automatic worker cannot clear explicit progress")
    explicitGate.open()
    for _ in 0..<100 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(previews, 2)
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .unavailable)
  }
  @MainActor func testHiddenMetadataRefreshCannotReadPreviewsAndPermissionWithdrawalStillPurges() async throws {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard RecentPhotosPolicy.canRead(permission), PHAsset.fetchAssets(with: .image, options: nil).count > 0 else {
      throw XCTSkip("Permit public Simulator Photos for hidden metadata refresh admission.")
    }
    let store = LocalSearchStore(index: try SearchIndex())
    store.setAutomaticAnalysisActive(false)
    var previews = 0
    store.analysisPreview = { _ in previews += 1; return nil }
    let snapshot = expectation(description: "Hidden metadata remains available")
    store.onSnapshotReady = { snapshot.fulfill() }
    defer { store.pause(); PHPhotoLibrary.shared().unregisterChangeObserver(store) }
    store.open(status: permission)
    PHPhotoLibrary.shared().unregisterChangeObserver(store)
    await fulfillment(of: [snapshot], timeout: 10)
    try await Task.sleep(for: .milliseconds(600))
    XCTAssertFalse(store.assets.isEmpty)
    XCTAssertEqual(previews, 0, "Refresh entrypoints cannot bypass hidden automatic admission")
    store.refresh(status: .denied)
    XCTAssertTrue(store.assets.isEmpty, "Denied access must withdraw the presentation immediately")
    for _ in 0..<200 where store.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(previews, 0)
    XCTAssertFalse(store.canAnalyzeMetadataMatches)
  }
  func testUnchangedMetadataIntakeRetainsSearchableAnalysisWithoutRebuildingPostings() throws {
    let index = try SearchIndex()
    var incoming = SearchRecord(id: "kept")
    incoming.filename = "gallery.jpg"
    incoming.keywords = ["Exhibition"]
    try index.replacePermitted([incoming, SearchRecord(id: "withdrawn")])
    XCTAssertTrue(try index.setLabels(["Museum"], photoID: incoming.id))
    XCTAssertTrue(try index.applyOCR(SearchOCRResult(text: "admission ticket", confidence: 0.9),
      status: .complete, photoID: incoming.id, revision: incoming.revision))
    try index.database.write { db in
      try db.execute(sql: """
        CREATE TEMP TABLE intakeWrites(kind TEXT);
        CREATE TEMP TRIGGER countIntakeUpdates AFTER UPDATE ON searchRecords
          WHEN NEW.id='kept' BEGIN INSERT INTO intakeWrites VALUES('record'); END;
        CREATE TEMP TRIGGER countIntakePostingDeletes AFTER DELETE ON searchPostings
          WHEN OLD.photo='kept' BEGIN INSERT INTO intakeWrites VALUES('posting'); END;
        """)
    }
    try index.setWorkGeneration(2)
    XCTAssertTrue(try index.replacePermitted([incoming], generation: 2))
    let writes = try index.database.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM intakeWrites") }
    XCTAssertEqual(writes, 0, "Unchanged merged records must leave their postings and FTS untouched")
    XCTAssertEqual(try index.search("Exhibition").leading?.id, incoming.id)
    XCTAssertEqual(try index.search("Museum").leading?.id, incoming.id)
    XCTAssertEqual(try index.search("admission ticket").leading?.id, incoming.id)
    XCTAssertEqual(try index.record(incoming.id)?.ocrStatus, .complete)
    XCTAssertNil(try index.record("withdrawn"), "Skipping unchanged writes must still prune withdrawn sources")
  }
  func testChangedMetadataOnSameRevisionRebuildsTermsAndPreservesCachedOCR() throws {
    let index = try SearchIndex()
    var incoming = SearchRecord(id: "edited")
    incoming.filename = "seaside.jpg"
    incoming.keywords = ["Coast"]
    try index.replacePermitted([incoming])
    XCTAssertTrue(try index.applyOCR(SearchOCRResult(text: "admission ticket", confidence: 0.9),
      status: .complete, photoID: incoming.id, revision: incoming.revision))
    incoming.filename = "mountain.jpg"
    incoming.keywords = ["Summit"]
    incoming.favorite = true
    XCTAssertTrue(try index.replacePermitted([incoming]))
    XCTAssertNil(try index.search("seaside").leading)
    XCTAssertNil(try index.search("Coast").leading)
    XCTAssertEqual(try index.search("mountain").leading?.id, incoming.id)
    XCTAssertEqual(try index.search("Summit").leading?.id, incoming.id)
    XCTAssertEqual(try index.search("favorite").leading?.id, incoming.id)
    XCTAssertEqual(try index.search("admission ticket").leading?.id, incoming.id)
    XCTAssertEqual(try index.record(incoming.id)?.revision, incoming.revision)
    XCTAssertEqual(try index.record(incoming.id)?.ocrStatus, .complete)
  }
  func testObsoleteMetadataScanCancellationStopsWithinCurrentBatch() async throws {
    let index = try SearchIndex()
    try index.setWorkGeneration(1)
    XCTAssertTrue(try index.replacePermitted([SearchRecord(id: "kept")], generation: 1))
    let began = expectation(description: "metadata scanner entered its first batch")
    let probe = MetadataIntakeProbe(began: began)
    let parent = Task {
      try await SearchMetadataIntake.run {
        try await SearchMetadataIntake.forEach(count: 10_000) { _ in probe.visit() }
        return try index.replacePermitted([SearchRecord(id: "obsolete")], generation: 1)
      }
    }
    await fulfillment(of: [began], timeout: 10)
    parent.cancel()
    probe.resume.signal()
    do {
      _ = try await parent.value
      XCTFail("An obsolete scan cannot return a publishable metadata snapshot")
    } catch is CancellationError {}
    XCTAssertGreaterThan(probe.count, 0)
    XCTAssertLessThanOrEqual(probe.count, 100, "Canceling the parent must stop its detached scanner within one batch")
    XCTAssertNotNil(try index.record("kept"))
    XCTAssertNil(try index.record("obsolete"))
    XCTAssertTrue(try index.replacePermitted([SearchRecord(id: "current")], generation: 1),
      "Worker cancellation must not change database generation acceptance")
  }
  #if !FOTORO_LOCAL_PREVIEW
  func testReplacingSyncedOCRRemovesObsoleteTextAndRestoresOnlyLocalEvidence() throws {
    for replacement in [nil, PhotoAnnotationsV1.OCR(text: "unsupported text", confidence: 1, processor: "future-ocr")] {
      let index = try SearchIndex()
      var local = SearchRecord(id: "local")
      local.ocrText = "device receipt"
      local.ocrConfidence = 0.8
      local.ocrStatus = .complete
      let pending = SearchRecord(id: "pending")
      try index.replacePermitted([local, pending])
      for record in [local, pending] {
        var annotation = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("photo".utf8).digest,
          ocr: PhotoAnnotationsV1.OCR(text: "obsolete boarding pass", confidence: 0.9, processor: "vision-text-v1"))
        XCTAssertTrue(try index.applyAnnotations(annotation, photoID: record.id, revision: record.revision, accountId: "owner"))
        XCTAssertEqual(try index.record(record.id)?.ocrText, "obsolete boarding pass")
        annotation.ocr = replacement
        XCTAssertTrue(try index.applyAnnotations(annotation, photoID: record.id, revision: record.revision, accountId: "owner"))
      }
      XCTAssertNil(try index.search("obsolete").leading)
      XCTAssertNil(try index.search("unsupported").leading)
      XCTAssertEqual(try index.search("device receipt").results.map(\.id), ["local"])
      XCTAssertEqual(try index.record("local")?.ocrConfidence, 0.8)
      XCTAssertEqual(try index.record("local")?.ocrStatus, .complete)
      XCTAssertEqual(try index.record("pending")?.ocrText, "")
      XCTAssertEqual(try index.record("pending")?.ocrStatus, .pending)
      XCTAssertEqual(try index.pendingRecords().map(\.id), ["pending"])
    }
  }
  #endif
  func testAllAgePolicyAllowsOlderAndMissingCaptureDatesOnlyWithinAuthorization() {
    for date in [Date(timeIntervalSince1970: 0), nil] {
      XCTAssertTrue(
        LocalSearchPhotosPolicy.includes(
          image: true, hidden: false, capturedAt: date, authorized: true))
      XCTAssertFalse(
        LocalSearchPhotosPolicy.includes(
          image: true, hidden: false, capturedAt: date, authorized: false))
      XCTAssertFalse(
        LocalSearchPhotosPolicy.includes(
          image: true, hidden: true, capturedAt: date, authorized: true))
      XCTAssertFalse(
        LocalSearchPhotosPolicy.includes(
          image: false, hidden: false, capturedAt: date, authorized: true))
    }
  }
  func testOCRCannotResurrectRemovedRecordsOrOverwriteNewRevision() throws {
    let i = try SearchIndex()
    var r = SearchRecord(id: "a")
    try i.replacePermitted([r])
    XCTAssertTrue(
      try i.applyOCR(
        SearchOCRResult(text: "receipt", confidence: 0.9), status: .complete, photoID: "a",
        revision: "1"))
    XCTAssertEqual(try i.search("receipt").leading?.id, "a")
    r.revision = "2"
    try i.replacePermitted([r])
    XCTAssertFalse(
      try i.applyOCR(
        SearchOCRResult(text: "stale", confidence: 1), status: .complete, photoID: "a",
        revision: "1"))
    try i.replacePermitted([])
    XCTAssertFalse(
      try i.applyOCR(
        SearchOCRResult(text: "resurrect", confidence: 1), status: .complete, photoID: "a",
        revision: "2"))
    XCTAssertNil(try i.search("resurrect").leading)
  }
  func testEmptyAndUnavailableOCRPreserveCoverageWithoutInventingLabel() throws {
    let i = try SearchIndex()
    try i.replacePermitted([SearchRecord(id: "a")])
    XCTAssertTrue(try i.applyOCR(nil, status: .unavailable, photoID: "a", revision: "1"))
    XCTAssertEqual(try i.record("a")?.ocrStatus, .unavailable)
    XCTAssertEqual(try i.search("anything").indexed, 0)
    XCTAssertTrue(
      try i.applyOCR(
        SearchOCRResult(text: "", confidence: 0), status: .complete, photoID: "a", revision: "1"))
    XCTAssertEqual(try i.record("a")?.labels, [])
    XCTAssertEqual(try i.search("anything").indexed, 1)
  }
  func testFailedOCRRetriesOnSameRevisionRefreshAndSuccessfulTextBecomesSearchable() throws {
    let i = try SearchIndex()
    let record = SearchRecord(id: "unchanged")
    try i.setWorkGeneration(1)
    XCTAssertTrue(try i.replacePermitted([record], generation: 1))
    XCTAssertTrue(try i.applyOCR(nil, status: .failed, photoID: record.id, revision: record.revision, generation: 1))
    XCTAssertTrue(try i.pendingRecords().isEmpty, "A failure must not immediately reenter the work queue")
    XCTAssertNil(try i.search("receipt").leading)

    try i.setWorkGeneration(2)
    XCTAssertTrue(try i.replacePermitted([record], generation: 2))
    XCTAssertEqual(try i.record(record.id)?.ocrStatus, .failed)
    let firstRetry = try i.pendingRecords(retryFailed: true)
    XCTAssertEqual(firstRetry.map(\.id), [record.id])
    XCTAssertEqual(firstRetry.first?.revision, record.revision)
    XCTAssertTrue(try i.applyOCR(nil, status: .failed, photoID: record.id, revision: record.revision, generation: 2))
    XCTAssertTrue(try i.pendingRecords().isEmpty, "Another failure waits for the next requested refresh")

    try i.setWorkGeneration(3)
    XCTAssertTrue(try i.replacePermitted([record], generation: 3))
    let retry = try XCTUnwrap(i.pendingRecords(retryFailed: true).first)
    XCTAssertTrue(try i.applyOCR(SearchOCRResult(text: "receipt recovered", confidence: 0.9), status: .complete,
      photoID: retry.id, revision: retry.revision, generation: 3))
    XCTAssertEqual(try i.search("receipt").leading?.id, record.id)
    XCTAssertEqual(try i.record(record.id)?.revision, record.revision)
    XCTAssertTrue(try i.pendingRecords(retryFailed: true).isEmpty, "Completed OCR stays cached on later refreshes")
  }
  func testDatabaseGenerationRejectsLateSnapshotAndOCRAfterWithdrawal() throws {
    let i = try SearchIndex()
    try i.setWorkGeneration(1)
    XCTAssertTrue(try i.replacePermitted([SearchRecord(id: "allowed")], generation: 1))
    try i.setWorkGeneration(2)
    XCTAssertFalse(try i.replacePermitted([SearchRecord(id: "stale")], generation: 1))
    XCTAssertNotNil(try i.record("allowed"))
    XCTAssertNil(try i.record("stale"))
    XCTAssertFalse(
      try i.applyOCR(
        SearchOCRResult(text: "stale", confidence: 1), status: .complete, photoID: "allowed",
        revision: "1", generation: 1))
    XCTAssertTrue(try i.replacePermitted([], generation: 2))
    XCTAssertFalse(try i.replacePermitted([SearchRecord(id: "allowed")], generation: 1))
    XCTAssertNil(try i.record("allowed"))
  }
  func testCancellingActiveMetadataTransactionDoesNotWaitOnMainActorAndRollsBack() async throws {
    let i = try SearchIndex()
    try i.replacePermitted([SearchRecord(id: "kept")])
    try i.setWorkGeneration(1)
    let records = (0..<4000).map { n -> SearchRecord in
      var r = SearchRecord(id: "new\(n)")
      r.labels = ["Ronald"]
      return r
    }
    let begun = expectation(description: "first record processed inside active transaction")
    let write = Task.detached {
      try i.replacePermitted(
        records, generation: 1, progress: { count in if count == 1 { begun.fulfill() } })
    }
    await fulfillment(of: [begun], timeout: 10)
    let start = Date()
    try i.setWorkGeneration(2)
    XCTAssertLessThan(
      Date().timeIntervalSince(start), 0.1,
      "Invalidation must not wait for the database transaction")
    let applied = try await write.value
    XCTAssertFalse(applied)
    XCTAssertNotNil(try i.record("kept"))
    XCTAssertNil(try i.record("new0"))
  }
  func testVisionRecognizesNeutralPublicFixtureAndRotationAtBoundedResolution() async throws {
    let processor = VisionTextProcessor()
    XCTAssertEqual(VisionTextProcessor.boundedSize(width: 2400, height: 1600).0, 1600)
    for name in ["neutral-a", "neutral-c"] {
      let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "png"))
      let cg = try XCTUnwrap(UIImage(contentsOfFile: url.path)?.cgImage)
      let result = try await processor.recognize(SearchPreview(image: cg))
      XCTAssertTrue(
        result.text.lowercased().contains(name == "neutral-a" ? "seattle" : "boston"), result.text)
      XCTAssertTrue(
        result.text.lowercased().contains(name == "neutral-a" ? "invoice" : "boarding"), result.text
      )
    }
  }
  @MainActor func testSimulatorOlderPublicPhotoSearchOutsideRecentCanvas() async throws {
    #if targetEnvironment(simulator)
      let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      guard RecentPhotosPolicy.canRead(status) else {
        throw XCTSkip(
          "Open Photos once in the public Simulator library to permit this interaction check.")
      }
      let fixtureURL = try XCTUnwrap(
        Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png"))
      let image = try XCTUnwrap(UIImage(contentsOfFile: fixtureURL.path))
      let captured = Date(timeIntervalSince1970: 1_577_880_000)
      var assetID = ""
      try await PHPhotoLibrary.shared().performChanges {
        let request = PHAssetChangeRequest.creationRequestForAsset(from: image)
        request.creationDate = captured
        assetID = request.placeholderForCreatedAsset?.localIdentifier ?? ""
      }
      // The app host restores its own durable search on launch; this interaction test owns its index.
      let search = LocalSearchStore(root: FileManager.default.temporaryDirectory.appendingPathComponent("PhotoKitSearch-" + UUID().uuidString))
      defer { search.pause() }
      search.open(status: status)
      // Metadata scanning can outlast 10 seconds in a reused public fixture library.
      // Wait for readiness; do not let a timeout cascade into unsaved label assertions.
      let clock = ContinuousClock()
      let deadline = clock.now.advanced(by: .seconds(30))
      while !search.canEditLabels(assetID), clock.now < deadline {
        try await Task.sleep(for: .milliseconds(50))
      }
      try XCTUnwrap(search.assets[assetID], "Metadata snapshot did not publish the created fixture")
      guard search.canEditLabels(assetID) else { return XCTFail("Metadata snapshot did not become editable") }
      XCTAssertFalse(RecentPhotosPolicy.includes(captured, now: Date()))
      let suppliedLabel = "Older public receipt \(assetID.prefix(8))"
      guard search.setLabels([suppliedLabel], photoID: assetID) else { return XCTFail("Fixture label was not saved") }
      search.updateQuery(suppliedLabel)
      for _ in 0..<100 where search.response.leading?.id != assetID {
        try await Task.sleep(for: .milliseconds(20))
      }
      XCTAssertEqual(search.response.leading?.id, assetID)
      print("Simulator all-age public asset verified outside recent canvas: \(assetID)")
    #else
      throw XCTSkip("Public fixture injection is Simulator-only.")
    #endif
  }
  func testSharedThirtyFrozenRetrievalTasks() throws {
    let url = try XCTUnwrap(
      Bundle(for: Self.self).url(forResource: "search-cases", withExtension: "json"))
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    let iso = ISO8601DateFormatter()
    let now = try XCTUnwrap(iso.date(from: fixture["clock"] as! String))
    let records = (fixture["records"] as! [[String: Any]]).map { v -> SearchRecord in
      var r = SearchRecord(id: v["id"] as! String)
      r.scope = v["scope"] as! String
      r.filename = v["filename"] as! String
      r.labels = v["labels"] as? [String] ?? []
      r.keywords = v["keywords"] as? [String] ?? []
      r.facts = v["facts"] as? [String] ?? []
      r.favorite = v["favorite"] as? Bool ?? false
      r.previewAvailable = v["previewAvailable"] as? Bool ?? false
      if v["captureVerified"] as? Bool == true, let date = v["capturedAt"] as? String {
        r.capturedAt = iso.date(from: date)
      }
      if let ocr = v["ocr"] as? [String: Any] {
        r.ocrText = ocr["text"] as? String ?? ""
        r.ocrConfidence = ocr["confidence"] as? Double ?? 0
        r.ocrStatus = SearchOCRStatus(rawValue: ocr["status"] as? String ?? "pending") ?? .pending
      }
      return r
    }
    let i = try SearchIndex()
    try i.replacePermitted(records)
    let tasks = fixture["retrievalTasks"] as! [[String: Any]]
    XCTAssertEqual(tasks.count, 30)
    var covered = 0
    var passed = 0
    for task in tasks {
      let query = task["query"] as! String
      let expected = task["acceptablePhotoIDs"] as! [String]
      let response = try i.search(query, scope: SearchScope(source: "local"), now: now)
      if expected.isEmpty {
        XCTAssertNil(response.leading, query)
      } else {
        covered += 1
        if let id = response.leading?.id, expected.contains(id) { passed += 1 }
        XCTAssertTrue(
          expected.contains(response.leading?.id ?? ""),
          query + ": " + (response.leading?.id ?? "none"))
      }
    }
    print(
      "Frozen native retrieval: \(passed)/\(covered) covered completed-word first results; 10 absent/uncovered cases checked"
    )
    XCTAssertEqual(covered, 20)
  }
}

private final class MetadataIntakeProbe: @unchecked Sendable {
  let resume = DispatchSemaphore(value: 0)
  private let began: XCTestExpectation
  private let lock = NSLock()
  private var visited = 0
  init(began: XCTestExpectation) { self.began = began }
  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return visited
  }
  func visit() {
    lock.lock()
    visited += 1
    let first = visited == 1
    lock.unlock()
    if first {
      began.fulfill()
      _ = resume.wait(timeout: .now() + 10)
    }
  }
}
