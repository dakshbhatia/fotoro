import Foundation
import XCTest

@testable import Fotoro

final class NaturalDateSearchTests: XCTestCase {
  private var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(identifier: "America/New_York")!
    value.firstWeekday = 2
    value.minimumDaysInFirstWeek = 4
    return value
  }
  private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
  }
  private var now: Date { date(2026, 10, 2, hour: 12) }
  private func photo(_ id: String, captured: Date?, source: String = "photos", labels: [String] = []) -> SearchRecord {
    var value = SearchRecord(id: id)
    value.capturedAt = captured
    value.scope = source
    value.labels = labels
    return value
  }
  func testRelativePeriodsHaveDeterministicCalendarBoundaries() {
    let expected: [(String, Date, Date)] = [
      ("today", date(2026, 10, 2), date(2026, 10, 3)),
      ("yesterday", date(2026, 10, 1), date(2026, 10, 2)),
      ("last week", date(2026, 9, 21), date(2026, 9, 28)),
      ("last month", date(2026, 9, 1), date(2026, 10, 1)),
      ("last year", date(2025, 1, 1), date(2026, 1, 1)),
      ("this week", date(2026, 9, 28), date(2026, 10, 5)),
      ("this month", date(2026, 10, 1), date(2026, 11, 1)),
      ("this year", date(2026, 1, 1), date(2027, 1, 1)),
    ]
    for (query, start, end) in expected {
      let parsed = NaturalDateQuery.parse(query, now: now, calendar: calendar)
      XCTAssertEqual(parsed.scope.from, start, query)
      XCTAssertEqual(parsed.scope.until, end, query)
      XCTAssertEqual(parsed.text, "", query)
    }
  }
  func testYesterdayUsesTheTwentyThreeHourDayAtDaylightSavingChange() {
    let parsed = NaturalDateQuery.parse("yesterday", now: date(2026, 3, 9, hour: 12), calendar: calendar)
    XCTAssertEqual(parsed.scope.from, date(2026, 3, 8))
    XCTAssertEqual(parsed.scope.until, date(2026, 3, 9))
    XCTAssertEqual(parsed.scope.until!.timeIntervalSince(parsed.scope.from!), 23 * 3600)
  }
  func testTodayIncludesSubsecondsBeforeMidnightAndExcludesMissingDatesAndNextDay() throws {
    let index = try SearchIndex()
    try index.replacePermitted([
      photo("first", captured: date(2026, 10, 2)),
      photo("last", captured: date(2026, 10, 3).addingTimeInterval(-0.001)),
      photo("next", captured: date(2026, 10, 3)),
      photo("previous", captured: date(2026, 10, 2).addingTimeInterval(-0.001)),
      photo("missing", captured: nil),
    ])
    let response = try index.search("today", now: now, calendar: calendar)
    XCTAssertEqual(Set(response.results.map(\.id)), ["first", "last"])
    XCTAssertEqual(response.total, 2)
    XCTAssertEqual(response.datePhrase, "today")
    XCTAssertEqual(response.meaning?.relation, .metadata)
  }
  func testSceneAndPersonWordsStillRequireEvidenceInsideTheDateAndSourceScope() throws {
    let index = try SearchIndex()
    try index.replacePermitted([
      photo("matching", captured: date(2026, 9, 24), labels: ["dog"]),
      photo("old", captured: date(2026, 9, 14), labels: ["dog"]),
      photo("other-source", captured: date(2026, 9, 24), source: "imports", labels: ["dog"]),
      photo("unlabelled", captured: date(2026, 9, 24)),
    ])
    XCTAssertEqual(try index.search("photos of dog from last week", now: now, calendar: calendar).results.map(\.id), ["matching"])
    XCTAssertEqual(try index.search("dog last week", scope: SearchScope(source: "imports"), now: now, calendar: calendar).results.map(\.id), ["other-source"])
    XCTAssertNil(try index.search("Ronald last week", now: now, calendar: calendar).leading)
    XCTAssertNil(try index.search("beach last week", now: now, calendar: calendar).leading)
  }
  func testDateScopesIntersectExistingBoundsAndKeepThroughInclusive() throws {
    let index = try SearchIndex()
    let start = date(2026, 9, 24)
    let last = date(2026, 9, 25)
    try index.replacePermitted([
      photo("before", captured: start.addingTimeInterval(-1), labels: ["dog"]),
      photo("first", captured: start, labels: ["dog"]),
      photo("inclusive", captured: last, labels: ["dog"]),
      photo("after", captured: last.addingTimeInterval(0.001), labels: ["dog"]),
    ])
    let response = try index.search("dog last week", scope: SearchScope(from: start, through: last), now: now, calendar: calendar)
    XCTAssertEqual(Set(response.results.map(\.id)), ["first", "inclusive"])
    XCTAssertEqual(response.scope.from, start)
    XCTAssertEqual(response.scope.through, last)
    XCTAssertEqual(response.scope.until, date(2026, 9, 28))
  }
  func testExplicitISOAndNamedDatesDoNotNormalizeInvalidDates() {
    for query in ["2026-10-02", "October 2, 2026", "photos on October 2 2026"] {
      let parsed = NaturalDateQuery.parse(query, now: now, calendar: calendar)
      XCTAssertEqual(parsed.scope.from, date(2026, 10, 2), query)
      XCTAssertEqual(parsed.scope.until, date(2026, 10, 3), query)
      XCTAssertEqual(parsed.text, "", query)
    }
    XCTAssertEqual(NaturalDateQuery.parse("October 2026", now: now, calendar: calendar).scope.until, date(2026, 11, 1))
    XCTAssertEqual(NaturalDateQuery.parse("2026", now: now, calendar: calendar).scope.until, date(2027, 1, 1))
    for query in ["2026-02-30", "2026-13", "2026-1", "February 30 2026", "10/2/2026", "last summer"] {
      XCTAssertNil(NaturalDateQuery.parse(query, now: now, calendar: calendar).datePhrase, query)
    }
  }
  func testBeforeAfterAndInclusiveDateRangeBoundaries() {
    let before = NaturalDateQuery.parse("dog before 2026-10-02", now: now, calendar: calendar)
    XCTAssertEqual(before.text, "dog")
    XCTAssertEqual(before.scope.until, date(2026, 10, 2))
    let after = NaturalDateQuery.parse("dog after 2026-10-02", now: now, calendar: calendar)
    XCTAssertEqual(after.scope.from, date(2026, 10, 3))
    let since = NaturalDateQuery.parse("dog since 2026-10-02", now: now, calendar: calendar)
    XCTAssertEqual(since.scope.from, date(2026, 10, 2))
    let range = NaturalDateQuery.parse("dog from 2026-09-01 to 2026-09-30", now: now, calendar: calendar)
    XCTAssertEqual(range.text, "dog")
    XCTAssertEqual(range.scope.from, date(2026, 9, 1))
    XCTAssertEqual(range.scope.until, date(2026, 10, 1))
  }
  func testDateOnlyFeedbackAndPinsRemainScopedAndPermissionConstrained() throws {
    let index = try SearchIndex()
    let a = photo("a", captured: date(2026, 10, 2, hour: 10))
    let b = photo("b", captured: date(2026, 10, 2, hour: 11))
    let outside = photo("outside", captured: date(2026, 10, 1))
    try index.replacePermitted([a, b, outside])
    let response = try index.search("today", now: now, calendar: calendar)
    let meaning = try XCTUnwrap(response.meaning)
    try index.pinRepresentative(meaning.id, photoID: "outside", scope: response.scope)
    XCTAssertEqual(try index.search("today", now: now, calendar: calendar).leading?.id, "b")
    try index.pinRepresentative(meaning.id, photoID: "a", scope: response.scope)
    XCTAssertEqual(try index.search("today", now: now, calendar: calendar).leading?.id, "a")
    try index.replacePermitted([b, outside])
    XCTAssertEqual(try index.search("today", now: now, calendar: calendar).leading?.id, "b")
  }
  func testQueryEnrichmentKeepsCurrentChoiceAndChangingDateOrSourceDropsIt() throws {
    let index = try SearchIndex()
    let a = photo("a", captured: date(2026, 10, 2, hour: 10), labels: ["dog"])
    let b = photo("b", captured: date(2026, 10, 2, hour: 11), labels: ["dog"])
    let yesterday = photo("yesterday", captured: date(2026, 10, 1, hour: 12), labels: ["dog"])
    let imported = photo("imported", captured: date(2026, 10, 2, hour: 12), source: "imports", labels: ["dog"])
    try index.replacePermitted([a, b, yesterday, imported])
    let old = try index.search("dog today", now: now, calendar: calendar)
    XCTAssertEqual(old.leading?.id, "b")
    var preferred = a
    preferred.favorite = true
    try index.put(preferred)
    let enriched = try index.search("dog today", previous: old, now: now, calendar: calendar)
    XCTAssertEqual(enriched.leading?.id, "b")
    XCTAssertEqual(try index.search("dog yesterday", previous: enriched, now: now, calendar: calendar).leading?.id, "yesterday")
    XCTAssertEqual(try index.search("dog today", scope: SearchScope(source: "imports"), previous: enriched, now: now, calendar: calendar).leading?.id, "imported")
  }
  func testExplicitDateConstraintsComposeAtEitherQueryEdge() {
    let cases: [(String, String, String)] = [
      ("beach 2026-09", "2026-09 beach", "beach"),
      ("beach September 2026", "September 2026 beach", "beach"),
      ("boarding pass September 24, 2026", "September 24, 2026 boarding pass", "boarding pass"),
      ("beach before 2026-10-02", "before 2026-10-02 beach", "beach"),
      ("beach after 2026-09-01", "after 2026-09-01 beach", "beach"),
      ("beach since 2026-09-01", "since 2026-09-01 beach", "beach"),
      ("beach from 2026-09-01 through 2026-09-30", "from 2026-09-01 through 2026-09-30 beach", "beach"),
      ("photos of beach last month", "last month photos of beach", "beach"),
    ]
    let scope = SearchScope(source: "imports", from: date(2026, 9, 10), through: date(2026, 9, 28))
    for (suffix, prefix, text) in cases {
      let expected = NaturalDateQuery.parse(suffix, scope: scope, now: now, calendar: calendar)
      let actual = NaturalDateQuery.parse(prefix, scope: scope, now: now, calendar: calendar)
      XCTAssertEqual(actual.text, text, prefix)
      XCTAssertEqual(actual.datePhrase, expected.datePhrase, prefix)
      XCTAssertEqual(actual.scope, expected.scope, prefix)
    }
    for query in ["February 30 2026 beach", "2026-02-30 beach", "2026-13 beach", "2026-1 beach",
      "beach from 2026-09-30 to 2026-09-01", "from 2026-09-30 to 2026-09-01 beach",
      "beach from 2026-02-30 to 2026-09-01", "from 2026-02-30 to 2026-09-01 beach"] {
      XCTAssertNil(NaturalDateQuery.parse(query, now: now, calendar: calendar).datePhrase, query)
    }
    let spring = NaturalDateQuery.parse("2026-03-08 beach", now: now, calendar: calendar)
    XCTAssertEqual(spring.scope.from, date(2026, 3, 8))
    XCTAssertEqual(spring.scope.until, date(2026, 3, 9))
    XCTAssertEqual(spring.scope.until!.timeIntervalSince(spring.scope.from!), 23 * 3600)
  }
  func testDateCompositionRetainsEachExistingEvidenceLane() throws {
    let index = try SearchIndex()
    var label = photo("label", captured: date(2026, 9, 24), labels: ["Holiday trip"])
    label.previewAvailable = true
    var keyword = photo("keyword", captured: date(2026, 9, 24)); keyword.keywords = ["sunset"]
    var scene = photo("scene", captured: date(2026, 9, 24))
    scene.visualStatus = .complete
    scene.visualLabels = SearchVisualPolicy.labels([("beach", 0.9)])
    var filename = photo("filename", captured: date(2026, 9, 24)); filename.filename = "Harbor.jpg"
    var ocr = photo("ocr", captured: date(2026, 9, 24)); ocr.ocrStatus = .complete
    ocr.ocrText = "boarding pass"; ocr.ocrConfidence = 0.8
    var old = scene; old.id = "old-scene"; old.capturedAt = date(2026, 8, 24)
    var missing = scene; missing.id = "missing-date"; missing.capturedAt = nil
    var other = scene; other.id = "other-source"; other.scope = "imports"
    try index.replacePermitted([label, keyword, scene, filename, ocr, old, missing, other])
    for (term, id, reason) in [("holiday trip", "label", "Supplied label"),
      ("sunset", "keyword", "Caption or keyword"), ("beach", "scene", "Inferred scene"),
      ("harbor", "filename", "Filename mention"), ("boarding p", "ocr", "Text in photo")]
    {
      for query in [term + " last month", "last month " + term, "September 2026 " + term, term + " 2026-09"] {
        let response = try index.search(query, now: now, calendar: calendar)
        XCTAssertEqual(response.results.map(\.id), [id], query)
        XCTAssertEqual(response.leading?.reason, reason, query)
        XCTAssertEqual(response.scope.from, date(2026, 9, 1), query)
        XCTAssertEqual(response.scope.until, date(2026, 10, 1), query)
      }
    }
    XCTAssertEqual(try index.search("beach last month", scope: SearchScope(source: "imports"), now: now, calendar: calendar).results.map(\.id), ["other-source"])
    XCTAssertNil(try index.search("Ronald last month", now: now, calendar: calendar).leading)
    XCTAssertNil(try index.search("dog last month", now: now, calendar: calendar).leading)
  }
  func testDateCompositionDoesNotExpandNumericOrMalformedDateTokens() throws {
    let index = try SearchIndex()
    var exact = photo("exact", captured: date(2026, 9, 24)); exact.ocrStatus = .complete
    exact.ocrText = "receipt 123 beach 2026 02 3"
    var longer = photo("longer", captured: date(2026, 9, 24)); longer.ocrStatus = .complete
    longer.ocrText = "receipt 1234 beach 2026 02 30"
    let supplied = photo("supplied-longer", captured: date(2026, 9, 24), labels: ["1234", "beach 2026-02-30"])
    try index.replacePermitted([exact, longer, supplied])
    for query in ["123 last month", "receipt 123 last month", "last month receipt 123"] {
      XCTAssertEqual(try index.search(query, now: now, calendar: calendar).results.map(\.id), ["exact"], query)
    }
    let malformed = try index.search("beach 2026-02-3", now: now, calendar: calendar)
    XCTAssertNil(malformed.datePhrase)
    XCTAssertEqual(malformed.results.map(\.id), ["exact"])
    XCTAssertEqual(malformed.leading?.reason, "Text in photo")
    XCTAssertNil(try index.search("12 last month", now: now, calendar: calendar).leading)
  }
  func testComposedFindCannotRecoverWithdrawnOrStaleSceneAndOCRWork() throws {
    let index = try SearchIndex()
    var scene = photo("scene", captured: date(2026, 9, 24))
    scene.visualStatus = .complete
    scene.visualLabels = SearchVisualPolicy.labels([("beach", 0.9)])
    var ocr = photo("ocr", captured: date(2026, 9, 24))
    ocr.ocrStatus = .complete; ocr.ocrText = "boarding pass"
    try index.replacePermitted([scene, ocr])
    let previous = try index.search("beach last month", now: now, calendar: calendar)
    XCTAssertEqual(previous.leading?.id, "scene")
    var changed = photo("scene", captured: date(2026, 9, 24)); changed.revision = "2"
    try index.setWorkGeneration(2)
    try index.replacePermitted([changed], generation: 2)
    XCTAssertFalse(try index.applyVisual(SearchVisualResult(labels: scene.visualLabels, processor: SearchVisualPolicy.processor),
      status: .complete, photoID: "scene", revision: "1", generation: 2))
    XCTAssertFalse(try index.applyOCR(SearchOCRResult(text: "boarding pass", confidence: 1),
      status: .complete, photoID: "ocr", revision: "1", generation: 2))
    XCTAssertNil(try index.search("beach last month", previous: previous, now: now, calendar: calendar).leading)
    XCTAssertNil(try index.search("boarding pass last month", now: now, calendar: calendar).leading)
    XCTAssertEqual(try index.search("last month", now: now, calendar: calendar).results.map(\.id), ["scene"])
  }
}
