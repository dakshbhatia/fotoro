import Photos
import UIKit
import XCTest

@testable import Fotoro

final class SearchLifecycleTests: XCTestCase {
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
      let search = LocalSearchStore()
      search.open(status: status)
      for _ in 0..<200 where search.indexing { try await Task.sleep(for: .milliseconds(50)) }
      XCTAssertFalse(search.indexing)
      XCTAssertNotNil(search.assets[assetID])
      XCTAssertFalse(RecentPhotosPolicy.includes(captured, now: Date()))
      let suppliedLabel = "Older public receipt \(assetID.prefix(8))"
      search.setLabels([suppliedLabel], photoID: assetID)
      search.updateQuery(suppliedLabel)
      for _ in 0..<100 where search.response.leading?.id != assetID {
        try await Task.sleep(for: .milliseconds(20))
      }
      XCTAssertEqual(search.response.leading?.id, assetID)
      search.pause()
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
