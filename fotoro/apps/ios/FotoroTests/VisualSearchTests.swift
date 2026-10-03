import Foundation
import ImageIO
import Vision
import XCTest

@testable import Fotoro

final class VisualSearchTests: XCTestCase {
  private func result(_ candidates: [(String, Double)]) -> SearchVisualResult {
    SearchVisualResult(labels: SearchVisualPolicy.labels(candidates), processor: SearchVisualPolicy.processor)
  }
  func testThresholdExactCategoriesDeduplicationAndNoIdentityInference() {
    let labels = SearchVisualPolicy.labels([
      ("dog", 0.75), ("bulldog", 0.9), ("beach", 0.64), ("cat", 0.65),
      ("Ronald", 1), ("person", 1), ("hotdog", 1), ("prairie_dog", 1),
      ("dog", .nan), ("forest", 1.1), ("bird", .infinity),
    ])
    XCTAssertEqual(labels.map(\.label), ["dog", "cat"])
    XCTAssertEqual(labels.first?.identifier, "bulldog")
    XCTAssertEqual(labels.first?.processor, SearchVisualPolicy.processor)
    XCTAssertEqual(labels.first?.confidence, 0.9)
    let many = SearchVisualPolicy.labels(["dog", "cat", "beach", "forest", "mountain", "flower", "boat", "car"].map { ($0, 0.9) })
    XCTAssertEqual(many.count, SearchVisualPolicy.maximumLabels)
    XCTAssertEqual(many.map(\.label), many.map(\.label).sorted())
  }
  func testInferredScenesRemainDistinctFromSuppliedLabelsAndOCRMentions() throws {
    let index = try SearchIndex()
    var supplied = SearchRecord(id: "supplied")
    supplied.labels = ["beach"]
    var text = SearchRecord(id: "text")
    text.ocrStatus = .complete
    text.ocrText = "beach"
    let visual = SearchRecord(id: "visual")
    try index.replacePermitted([supplied, text, visual])
    XCTAssertTrue(try index.applyVisual(result([("beach", 0.92)]), status: .complete,
      photoID: visual.id, revision: visual.revision))
    let response = try index.search("beach")
    XCTAssertEqual(response.leading?.id, supplied.id)
    XCTAssertEqual(Set(response.meanings.map(\.relation)), [.label, .text, .visual])
    let meaning = try XCTUnwrap(response.meanings.first { $0.relation == .visual })
    XCTAssertEqual(meaning.reason, "Inferred scene")
    let selected = try index.search("beach", acceptedMeaningID: meaning.id)
    XCTAssertEqual(selected.leading?.id, visual.id)
    XCTAssertEqual(selected.leading?.reason, "Inferred scene")
    XCTAssertEqual(try index.record(visual.id)?.labels, [])
    XCTAssertNil(try index.search("Ronald").leading)
  }
  func testVisualLabelsSurviveOnlySameSourceRevisionAndProcessor() throws {
    let index = try SearchIndex()
    var photo = SearchRecord(id: "a")
    photo.ocrStatus = .complete
    try index.replacePermitted([photo])
    XCTAssertTrue(try index.applyVisual(result([("dog", 0.9)]), status: .complete,
      photoID: photo.id, revision: photo.revision))
    try index.setLabels(["Family dog"], photoID: photo.id)
    try index.replacePermitted([photo])
    XCTAssertEqual(try index.record(photo.id)?.visualStatus, .complete)
    XCTAssertTrue(try index.pendingAnalysisRecords().isEmpty)
    photo.revision = "edited"
    try index.replacePermitted([photo])
    XCTAssertEqual(try index.record(photo.id)?.visualStatus, .pending)
    XCTAssertEqual(try index.record(photo.id)?.visualLabels, [])
    XCTAssertEqual(try index.record(photo.id)?.labels, ["Family dog"])
    XCTAssertFalse(try index.applyVisual(result([("dog", 0.9)]), status: .complete,
      photoID: photo.id, revision: "1"))
    XCTAssertTrue(try index.applyVisual(result([("dog", 0.9)]), status: .complete,
      photoID: photo.id, revision: "edited"))
    photo.visualProcessor = "future-processor"
    try index.replacePermitted([photo])
    XCTAssertEqual(try index.record(photo.id)?.visualStatus, .pending)
    XCTAssertEqual(try index.record(photo.id)?.visualLabels, [])
    XCTAssertFalse(try index.applyVisual(result([("dog", 0.9)]), status: .complete,
      photoID: photo.id, revision: "edited"))
  }
  func testVisualWritesCannotResurrectRevokedAssetsOrBypassGeneration() throws {
    let index = try SearchIndex()
    try index.setWorkGeneration(1)
    try index.replacePermitted([SearchRecord(id: "a")], generation: 1)
    try index.setWorkGeneration(2)
    XCTAssertFalse(try index.applyVisual(result([("beach", 1)]), status: .complete,
      photoID: "a", revision: "1", generation: 1))
    try index.replacePermitted([], generation: 2)
    XCTAssertFalse(try index.applyVisual(result([("beach", 1)]), status: .complete,
      photoID: "a", revision: "1", generation: 2))
    XCTAssertNil(try index.search("beach").leading)
  }
  func testEmptyResultsCacheAndFailuresRetryOnlyOnRequestedRefresh() throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "a")
    record.ocrStatus = .complete
    try index.replacePermitted([record])
    XCTAssertEqual(try index.pendingAnalysisRecords().map(\.id), ["a"])
    try index.applyVisual(nil, status: .failed, photoID: "a", revision: "1")
    XCTAssertTrue(try index.pendingAnalysisRecords().isEmpty)
    XCTAssertEqual(try index.pendingAnalysisRecords(retryFailed: true).map(\.id), ["a"])
    try index.applyVisual(result([]), status: .complete, photoID: "a", revision: "1")
    XCTAssertTrue(try index.pendingAnalysisRecords(retryFailed: true).isEmpty)
    XCTAssertNil(try index.search("beach").leading)
  }
  func testClassifierFailureAndUnavailabilityPreserveOCRAndMetadata() throws {
    for state in [SearchVisualStatus.failed, .unavailable] {
      let index = try SearchIndex()
      var cached = SearchRecord(id: "cached")
      cached.capturedAt = Date(timeIntervalSince1970: 1_790_000_000)
      cached.favorite = true
      cached.labels = ["Family"]
      cached.ocrStatus = .complete
      cached.ocrText = "receipt cached"
      cached.ocrConfidence = 0.9
      cached.previewAvailable = true
      try index.replacePermitted([cached, SearchRecord(id: "new")])
      try index.applyVisual(nil, status: state, photoID: "cached", revision: "1")
      let record = try XCTUnwrap(index.record("cached"))
      XCTAssertEqual(record.ocrText, cached.ocrText)
      XCTAssertEqual(record.ocrStatus, .complete)
      XCTAssertEqual(record.labels, cached.labels)
      XCTAssertEqual(record.capturedAt, cached.capturedAt)
      XCTAssertTrue(record.favorite)
      XCTAssertTrue(record.previewAvailable)
      XCTAssertEqual(try index.search("receipt").leading?.id, "cached")
      try index.applyVisual(nil, status: state, photoID: "new", revision: "1")
      XCTAssertTrue(try index.applyOCR(SearchOCRResult(text: "boarding pass", confidence: 0.8),
        status: .complete, photoID: "new", revision: "1"))
      XCTAssertEqual(try index.search("boarding").leading?.id, "new")
      XCTAssertEqual(try index.record("new")?.visualStatus, state)
    }
  }
  func testOnlyKnownSimulatorInferenceContextFailureIsRecognizedAsUnsupported() {
    let unavailable = NSError(domain: VNErrorDomain, code: VNErrorCode.internalError.rawValue,
      userInfo: [NSLocalizedDescriptionKey: "Could not create inference context"])
    XCTAssertTrue(VisionTextProcessor.isUnsupportedSimulatorClassifier(unavailable, isSimulator: true))
    XCTAssertFalse(VisionTextProcessor.isUnsupportedSimulatorClassifier(unavailable, isSimulator: false))
    let unrelated = NSError(domain: VNErrorDomain, code: VNErrorCode.internalError.rawValue,
      userInfo: [NSLocalizedDescriptionKey: "An unexpected processing error"])
    XCTAssertFalse(VisionTextProcessor.isUnsupportedSimulatorClassifier(unrelated, isSimulator: true))
    let malformed = NSError(domain: VNErrorDomain, code: VNErrorCode.invalidImage.rawValue,
      userInfo: [NSLocalizedDescriptionKey: "Could not create inference context"])
    XCTAssertFalse(VisionTextProcessor.isUnsupportedSimulatorClassifier(malformed, isSimulator: true))
  }
  func testUntrustedPersistedLabelsNeedMatchingProvenanceAndConfidence() throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "a")
    record.visualStatus = .complete
    record.visualLabels = [
      SearchVisualLabel(label: "Ronald", identifier: "dog", confidence: 1, processor: SearchVisualPolicy.processor),
      SearchVisualLabel(label: "beach", identifier: "beach", confidence: 0.4, processor: SearchVisualPolicy.processor),
      SearchVisualLabel(label: "dog", identifier: "dog", confidence: 0.9, processor: "other"),
    ]
    try index.replacePermitted([record])
    XCTAssertNil(try index.search("Ronald").leading)
    XCTAssertNil(try index.search("beach").leading)
    XCTAssertNil(try index.search("dog").leading)
  }
  func testLegacyRecordDecodesWithoutNewVisualFieldsAndKeepsSuppliedText() throws {
    let data = Data(#"{"id":"legacy","labels":["Rónald"],"revision":"kept","ocrText":"receipt","ocrStatus":"complete","processor":"vision-text-v1"}"#.utf8)
    let record = try JSONDecoder().decode(SearchRecord.self, from: data)
    XCTAssertEqual(record.labels, ["Rónald"])
    XCTAssertEqual(record.ocrText, "receipt")
    XCTAssertEqual(record.revision, "kept")
    XCTAssertEqual(record.visualLabels, [])
    XCTAssertEqual(record.visualStatus, .pending)
    XCTAssertEqual(record.visualProcessor, SearchVisualPolicy.processor)
    let roundTrip = try JSONDecoder().decode(SearchRecord.self, from: JSONEncoder().encode(record))
    XCTAssertEqual(roundTrip.labels, record.labels)
    XCTAssertEqual(roundTrip.visualStatus, .pending)
  }
  func testLegacyDatabaseMigrationKeepsExistingEvidenceAndSchedulesVisualWork() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try SearchIndex(root: root)
    var record = SearchRecord(id: "legacy")
    record.labels = ["Receipt"]
    record.ocrStatus = .complete
    try index.replacePermitted([record])
    var encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as! [String: Any]
    for key in ["visualLabels", "visualStatus", "visualProcessor"] { encoded.removeValue(forKey: key) }
    let legacy = try JSONSerialization.data(withJSONObject: encoded)
    try index.database.write { db in
      try db.execute(sql: "UPDATE searchRecords SET value=? WHERE id='legacy'", arguments: [legacy])
      try db.execute(sql: "ALTER TABLE searchRecords DROP COLUMN visualState")
    }
    let reopened = try SearchIndex(root: root)
    XCTAssertEqual(try reopened.search("receipt").leading?.id, "legacy")
    XCTAssertEqual(try reopened.pendingAnalysisRecords().map(\.id), ["legacy"])
    XCTAssertEqual(try reopened.record("legacy")?.visualStatus, .pending)
  }
  func testVisionClassificationExecutesOnNeutralPublicFixtureAtBoundedResolution() async throws {
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png"))
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let processor = VisionTextProcessor()
    let result: SearchVisualResult
    do { result = try await processor.classify(SearchPreview(image: image)) }
    catch {
      #if targetEnvironment(simulator)
        if VisionTextProcessor.isUnsupportedSimulatorClassifier(error, isSimulator: true) {
          throw XCTSkip("This Simulator cannot create the Vision classifier inference context while attempting supported CPU configuration and classification. Policy and evidence tests run separately; physical-device classification remains unverified.")
        }
      #endif
      throw error
    }
    XCTAssertEqual(result.processor, SearchVisualPolicy.processor)
    XCTAssertLessThanOrEqual(result.labels.count, SearchVisualPolicy.maximumLabels)
    XCTAssertTrue(result.labels.allSatisfy { $0.confidence >= SearchVisualPolicy.minimumConfidence })
    XCTAssertEqual(VisionTextProcessor.boundedSize(width: 2400, height: 1600, maximumEdge: 768).0, 768)
  }
}
