import XCTest
@testable import Fotoro

final class SearchRetrievalHostTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1792152000)
  private func record(_ id: String, caption: String) -> SearchRecord {
    var value = SearchRecord(id: id)
    value.captions = [caption]; value.previewAvailable = true; value.capturedAt = now
    return value
  }
  func testExplicitNamingMetadataPagesAreBoundedAndPreserveOriginalsAndFacts() throws {
    let index = try SearchIndex()
    for number in 0..<205 {
      var value = record(String(format: "%04d", number), caption: "Untouched source")
      value.filename = "IMG_\(number).JPG"
      value.facts = ["Exact original words", "fotoro.name.v1:Reviewed \(number).jpg"]
      try index.put(value)
    }
    let first = try index.namingRecords(limit: 1000)
    XCTAssertEqual(first.count, 200)
    let last = try XCTUnwrap(first.last)
    let continuation = try index.namingRecords(after: last.id)
    XCTAssertEqual(continuation.count, 5)
    XCTAssertEqual(Set((first + continuation).map(\.id)).count, 205)
    XCTAssertEqual(first.first?.filename, "IMG_0.JPG")
    XCTAssertEqual(first.first?.facts, ["Exact original words", "fotoro.name.v1:Reviewed 0.jpg"])
    XCTAssertEqual(try index.record("0000")?.filename, "IMG_0.JPG")
    XCTAssertTrue(try index.namingRecords(after: "9999").isEmpty)
  }
  func testPrefixIncludesEveryCompletionAndExplicitChoiceNarrows() throws {
    let index = try SearchIndex()
    let names = ["Harbor", "Haven", "Harvest", "Hasty", "Hammock", "Happiness", "Habitat", "Hailstone"]
    for (i, name) in names.enumerated() { try index.put(record(String(i), caption: name)) }
    let result = try index.search("ha", now: now)
    XCTAssertEqual(Set(result.results.map(\.id)), Set((0..<8).map(String.init)))
    XCTAssertEqual(result.totalMatches, 8)
    let chosen = try XCTUnwrap(result.meanings.first)
    XCTAssertEqual(try index.search("ha", acceptedMeaningID: chosen.id, now: now).results.count, 1)
    for hit in result.results { XCTAssertNotNil(result.meaningID(for: hit.id)) }
  }
  func testMatchTotalRemainsTruthfulBeyondBoundedResults() throws {
    let index = try SearchIndex()
    for i in 0..<205 { try index.put(record(String(i), caption: "Harbor")) }
    let result = try index.search("Harbor", now: now)
    XCTAssertEqual(result.results.count, 200)
    XCTAssertEqual(result.totalMatches, 205)
    XCTAssertTrue(result.truncated)
  }
  func testUnionDeduplicatesEvidenceAndRecordsFeedbackUnderEachPhotosMeaning() throws {
    let index = try SearchIndex()
    var mixed = record("mixed", caption: "Harbor")
    mixed.labels = ["Harvest"]
    try index.put(mixed)
    try index.put(record("other", caption: "Hammock"))
    let result = try index.search("ha", now: now)
    XCTAssertEqual(result.totalMatches, 2)
    XCTAssertEqual(Set(result.results.map(\.id)), ["mixed", "other"])
    let otherMeaning = try XCTUnwrap(result.meaningID(for: "other"))
    try index.confirmUse(otherMeaning, photoID: "other", sessionID: "confirmed", now: now)
    try index.pinRepresentative(otherMeaning, photoID: "other")
    XCTAssertEqual(try index.historyCount(kind: "use", meaningID: otherMeaning, photoID: "other", now: now), 1)
    XCTAssertTrue(try index.search("ha", now: now).results.first(where: { $0.id == "other" })!.pinned)
    XCTAssertNil(result.meaningID(for: "unknown"))
  }
  func testFullTextResultsAlsoExposeTheirUncappedTotal() throws {
    let index = try SearchIndex()
    for i in 0..<205 { try index.put(record(String(i), caption: "Seattle boarding pass")) }
    let result = try index.search("Seattle pass", now: now)
    XCTAssertEqual(result.totalMatches, 205)
    XCTAssertTrue(result.truncated)
    XCTAssertEqual(result.results.count, 200)
  }
  func testIncompatibleAcceptedCompletionReturnsToUnionAndPinsStayWithinMeaningPrecedence() throws {
    let index = try SearchIndex()
    try index.put(record("old", caption: "Harbor"))
    try index.put(record("one", caption: "Happiness"))
    try index.put(record("two", caption: "Happy"))
    let old = try XCTUnwrap(index.search("Harbor", now: now).meaning)
    XCTAssertEqual(Set(try index.search("hap", acceptedMeaningID: old.id, now: now).results.map(\.id)), ["one", "two"])
    var portrait = record("portrait", caption: ""); portrait.labels = ["Ronald"]
    var document = record("document", caption: ""); document.ocrText = "Ronald"; document.ocrStatus = .complete; document.ocrConfidence = 0.94
    try index.put(portrait); try index.put(document)
    let meaning = try XCTUnwrap(index.search("ron", now: now).meaningID(for: "document"))
    try index.pinRepresentative(meaning, photoID: "document")
    XCTAssertEqual(try index.search("ron", now: now).leading?.id, "portrait")
    XCTAssertEqual(try index.search("ron", acceptedMeaningID: meaning, now: now).leading?.id, "document")
  }
  func testSavedSemanticRetrySurvivesReopenAndExpiresWithoutAffectingNewRevision() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try SearchIndex(root: root)
    var value = record("saved", caption: "Harbor"); value.scope = "saved"
    try index.put(value)
    XCTAssertTrue(try index.deferSemantic(.unavailable, photoID: value.id, revision: value.revision, attemptedAt: now))
    let reopened = try SearchIndex(root: root), scope = PhotoAnalysisWindow.tenDays.scope(now: now)
    XCTAssertTrue(try reopened.pendingSemanticRecords(scope: scope, now: now).isEmpty)
    let status = try reopened.savedSemanticRetryStatus(scope: scope, now: now)
    XCTAssertEqual(status.deferred, 1)
    XCTAssertEqual(status.nextRetry, now.addingTimeInterval(300))
    XCTAssertEqual(try reopened.pendingSemanticRecords(scope: scope, now: now.addingTimeInterval(300)).map(\.id), [value.id])
    XCTAssertEqual(try reopened.savedSemanticRetryStatus(scope: scope, now: now.addingTimeInterval(400)).nextRetry, now.addingTimeInterval(300))
    value.revision = "new"; try reopened.put(value)
    XCTAssertEqual(try reopened.pendingSemanticRecords(scope: scope, now: now).map(\.id), [value.id])
    XCTAssertEqual(try reopened.savedSemanticRetryStatus(scope: scope, now: now).deferred, 0)
  }
}
