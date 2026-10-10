import GRDB
import Photos
import UIKit
import XCTest

@testable import Fotoro

final class SearchLifecycleTests: XCTestCase {
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
