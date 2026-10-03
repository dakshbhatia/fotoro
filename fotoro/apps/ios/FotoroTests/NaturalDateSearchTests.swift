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
}
