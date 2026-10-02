import Foundation
import XCTest

@testable import Fotoro

final class SearchTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_791_288_000)
  func photo(
    _ id: String, labels: [String] = [], filename: String = "", captured: Date? = nil,
    favorite: Bool = false, scope: String = "photos", ocr: String = ""
  ) -> SearchRecord {
    var r = SearchRecord(id: id)
    r.labels = labels
    r.filename = filename
    r.capturedAt = captured
    r.favorite = favorite
    r.scope = scope
    r.ocrText = ocr
    r.ocrStatus = .complete
    r.previewAvailable = true
    return r
  }
  func index(_ records: [SearchRecord]) throws -> SearchIndex {
    let i = try SearchIndex()
    try i.replacePermitted(records)
    return i
  }
  func testLabelAndTextSameSpellingKeepDistinctMeanings() throws {
    let i = try index([
      photo("person", labels: ["Rónald"]), photo("receipt", filename: "Ronald.jpg", favorite: true),
    ])
    let r = try i.search("ronald", now: now)
    XCTAssertEqual(r.meaning?.relation, .label)
    XCTAssertEqual(r.leading?.id, "person")
    XCTAssertEqual(Set(r.meanings.map(\.relation)), [.label, .text])
    let text = try XCTUnwrap(r.meanings.first { $0.relation == .text })
    XCTAssertEqual(
      try i.search("ronald", acceptedMeaningID: text.id, now: now).leading?.id, "receipt")
  }
  func testExactTermAndContinuationReleaseIncompatibleAcceptedMeaning() throws {
    let i = try index([
      photo("ron", labels: ["Ron"]), photo("ronald", labels: ["Ronald"]),
      photo("rome", labels: ["Rome"]),
    ])
    let r = try i.search("ron", now: now)
    XCTAssertEqual(r.leading?.id, "ron")
    XCTAssertEqual(
      try i.search("rona", acceptedMeaningID: r.meaning?.id, previous: r, now: now).leading?.id,
      "ronald")
  }
  func testWholePrefixRangeAndScopeAreFilteredBeforeSixMeanings() throws {
    let records =
      (0..<12).map { photo("p\($0)", labels: ["Roa\($0)"], captured: now) } + [
        photo("older", labels: ["Rozebra"], captured: now.addingTimeInterval(-100 * 86400))
      ]
    let i = try index(records)
    XCTAssertEqual(
      try i.search("roz", previous: i.search("ro", now: now), now: now).leading?.id, "older")
    XCTAssertEqual(
      try i.search("ro", scope: SearchScope(through: now.addingTimeInterval(-31 * 86400)), now: now)
        .leading?.id, "older")
  }
  func testAcceptanceAndConfirmedUseAreSeparateDeduplicatedAndDecay() throws {
    let i = try index([photo("a", labels: ["Ronald"]), photo("b", labels: ["Ronald"])])
    let meaning = try XCTUnwrap(i.search("ron", now: now).meaning)
    for _ in 0..<2 { try i.acceptMeaning(meaning.id, sessionID: "one", now: now) }
    XCTAssertEqual(try i.historyCount(kind: "accept", meaningID: meaning.id, now: now), 1)
    XCTAssertEqual(
      try i.historyCount(kind: "use", meaningID: meaning.id, photoID: "b", now: now), 0)
    for _ in 0..<2 { try i.confirmUse(meaning.id, photoID: "b", sessionID: "one", now: now) }
    XCTAssertEqual(
      try i.historyCount(
        kind: "use", meaningID: meaning.id, photoID: "b", now: now.addingTimeInterval(30 * 86400)),
      0.5, accuracy: 0.00001)
    XCTAssertEqual(try i.search("ron", now: now).leading?.id, "b")
  }
  func testRoutineHistoryCannotDefeatStrongerTextEvidenceButCompatiblePinCan() throws {
    var caption = photo("caption", filename: "neutral.jpg")
    caption.captions = ["Ronald"]
    let i = try index([
      caption, photo("file", filename: "Ronald.jpg", captured: now, favorite: true),
    ])
    let m = try XCTUnwrap(i.search("ron", now: now).meaning)
    for n in 0..<5 { try i.confirmUse(m.id, photoID: "file", sessionID: "\(n)", now: now) }
    XCTAssertEqual(try i.search("ron", now: now).leading?.id, "caption")
    try i.pinRepresentative(m.id, photoID: "file")
    XCTAssertEqual(try i.search("ron", now: now).leading?.id, "file")
    XCTAssertEqual(
      try i.search("ron", now: now).leading?.reason, "Your representative · Filename mention")
  }
  func testPinsCannotCreateAssociationAndRevocationPurgesRecord() throws {
    let i = try index([photo("ron", labels: ["Ronald"]), photo("rome", labels: ["Rome"])])
    let m = try XCTUnwrap(i.search("ron", now: now).meaning)
    try i.pinRepresentative(m.id, photoID: "rome")
    XCTAssertEqual(try i.search("ron", now: now).leading?.id, "ron")
    try i.replacePermitted([photo("rome", labels: ["Rome"])])
    XCTAssertNil(try i.search("ron", now: now).leading)
    XCTAssertNil(try i.record("ron"))
  }
  func testPrefixStabilityAndStrongerEvidenceReplacement() throws {
    let i = try index([photo("a", labels: ["Ronald"]), photo("b", labels: ["Ronald"])])
    let old = try i.search("r", now: now)
    var b = try XCTUnwrap(i.record("b"))
    b.favorite = true
    try i.put(b)
    XCTAssertEqual(try i.search("ro", previous: old, now: now).leading?.id, old.leading?.id)
    try i.pinRepresentative(try XCTUnwrap(old.meaning?.id), photoID: "b")
    XCTAssertEqual(try i.search("ron", previous: old, now: now).leading?.id, "b")
  }
  func testDurableLabelsAndHistorySurviveReopenAndRevisionInvalidatesOCR() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let i = try SearchIndex(root: root)
    try i.replacePermitted([photo("a", ocr: "receipt")])
    try i.setLabels([" Rónald "], photoID: "a")
    let m = try XCTUnwrap(i.search("ron", now: now).meaning)
    try i.confirmUse(m.id, photoID: "a", sessionID: "one", now: now)
    let reopened = try SearchIndex(root: root)
    var revised = photo("a")
    revised.revision = "2"
    revised.ocrStatus = .pending
    try reopened.replacePermitted([revised])
    XCTAssertEqual(try reopened.record("a")?.labels, [" Rónald "])
    XCTAssertEqual(try reopened.record("a")?.ocrStatus, .pending)
    XCTAssertEqual(
      try reopened.historyCount(kind: "use", meaningID: m.id, photoID: "a", now: now), 1)
    XCTAssertNil(try reopened.search("receipt", now: now).leading)
    XCTAssertEqual(
      try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
  }
  func testBurstDoesNotMultiplyCompletionPopularityAndChildrenStayReachable() throws {
    var records = (0..<100).map { n -> SearchRecord in
      var r = photo("rome\(n)", labels: ["Rome"])
      r.burstID = "burst"
      return r
    }
    records.append(photo("ron", labels: ["Ronald"]))
    let i = try index(records)
    let r = try i.search("ro", now: now)
    XCTAssertEqual(r.meanings.count, 2)
    XCTAssertEqual(try i.search("rome", now: now).results.count, 1)
    XCTAssertEqual(try i.search("rome", now: now).leading?.children.count, 99)
  }
  func testNeutralFilenameOCRNoiseAndMissingPreviewCoverage() throws {
    var r = photo("doc", filename: "IMG_0021.PNG", ocr: "the planetarium a x 0021")
    r.previewAvailable = false
    let i = try index([r])
    XCTAssertEqual(try i.search("planet", now: now).leading?.reason, "Text in photo")
    XCTAssertNil(try i.search("png", now: now).leading)
    XCTAssertNil(try i.search("x", now: now).leading)
    XCTAssertEqual(try i.search("planet", now: now).availablePreviews, 0)
  }
  func testFutureAndMissingCaptureDatesDoNotWinRecency() throws {
    let i = try index([
      photo("a-future", labels: ["Ronald"], captured: now.addingTimeInterval(100 * 86400)),
      photo("b-missing", labels: ["Ronald"]),
      photo("z-verified", labels: ["Ronald"], captured: now.addingTimeInterval(-86400)),
    ])
    XCTAssertEqual(try i.search("ron", now: now).leading?.id, "z-verified")
  }
  func testPreviousBestEvidenceSurvivesMoreThanTwoHundredCandidates() throws {
    let i = try index([photo("previous", labels: ["Ronald"])])
    let old = try i.search("r", now: now)
    for n in 0..<260 {
      try i.put(photo("p\(n)", labels: ["Ronald"], captured: now, favorite: true))
    }
    let next = try i.search("ro", previous: old, now: now)
    XCTAssertEqual(next.leading?.id, "previous")
    XCTAssertLessThanOrEqual(next.results.count, 200)
  }
  func testMultiwordTextFeedbackAndPinsRemainPermissionConstrained() throws {
    let i = try index([
      photo("a", ocr: "boarding pass"), photo("b", ocr: "boarding pass"),
      photo("other", ocr: "receipt"),
    ])
    let m = try XCTUnwrap(i.search("boarding pass", now: now).meaning)
    try i.acceptMeaning(m.id, sessionID: "one", now: now)
    try i.confirmUse(m.id, photoID: "b", sessionID: "one", now: now)
    XCTAssertEqual(try i.historyCount(kind: "accept", meaningID: m.id, now: now), 1)
    XCTAssertEqual(try i.historyCount(kind: "use", meaningID: m.id, photoID: "b", now: now), 1)
    XCTAssertEqual(try i.search("boarding pass", now: now).leading?.id, "b")
    try i.pinRepresentative(m.id, photoID: "a")
    XCTAssertEqual(try i.search("boarding pass", now: now).leading?.id, "a")
    try i.pinRepresentative(m.id, photoID: "other")
    XCTAssertEqual(try i.search("boarding pass", now: now).leading?.id, "a")
    try i.replacePermitted([photo("b", ocr: "boarding pass")])
    XCTAssertEqual(try i.search("boarding pass", now: now).leading?.id, "b")
  }
  func testEditedAndRevokedLabelsUseOnlyCurrentVerbatimDisplay() throws {
    let i = try index([photo("a", labels: ["Rónald"]), photo("b", labels: ["Ronald"])])
    try i.setLabels(["Ronald"], photoID: "a")
    XCTAssertEqual(try i.search("ronald", now: now).meaning?.display, "Ronald")
    try i.setLabels(["Rónald"], photoID: "a")
    try i.replacePermitted([photo("b", labels: ["Ronald"])])
    XCTAssertEqual(try i.search("ronald", now: now).meaning?.display, "Ronald")
  }
  func testStructuredCoordinatesAndCaptureDateRemainSearchable() throws {
    var r = photo("located", captured: Date(timeIntervalSince1970: 1_577_880_000))
    r.facts = ["40.7128, -74.0060"]
    let i = try index([r])
    XCTAssertEqual(try i.search("40.7128", now: now).leading?.id, "located")
    XCTAssertEqual(try i.search("2020-01", now: now).leading?.id, "located")
    XCTAssertEqual(try i.search("40.7128", now: now).meaning?.relation, .metadata)
  }
  func testMultiwordOCRCompletionMatchesPartialFinalTokenWithProvenance() throws {
    let i = try index([
      photo("boarding", ocr: "boarding pass"), photo("other", ocr: "boarding receipt"),
    ])
    for query in ["boarding p", "boarding pa", "boarding pass"] {
      let response = try i.search(query, now: now)
      XCTAssertEqual(response.leading?.id, "boarding", query)
      XCTAssertEqual(response.leading?.reason, "Text in photo")
    }
  }
  func testLateWorkRejectedAfterGenerationOrRevisionChanges() {
    var fence = SearchWorkFence()
    let token = fence.generation
    let r = photo("a")
    XCTAssertTrue(fence.accepts(token, revision: "1", current: r))
    fence.invalidate()
    XCTAssertFalse(fence.accepts(token, revision: "1", current: r))
    XCTAssertFalse(fence.accepts(fence.generation, revision: "0", current: r))
    XCTAssertFalse(fence.accepts(fence.generation, revision: "1", current: nil))
  }
}
