import Foundation
import XCTest

@testable import Fotoro

final class PhotoBrowsingTests: XCTestCase {
  private var calendar: Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(identifier: "America/New_York")!
    return value
  }
  private func date(_ month: Int, _ day: Int, hour: Int = 0, minute: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
  }
  private func photo(
    _ id: String, at: Date? = nil, revision: String = "1", favorite: Bool = false,
    screenshot: Bool = false, location: String? = nil
  ) -> PhotoBrowseItem {
    PhotoBrowseItem(source: RecentPhotoSource(id: id, revision: revision),
      facts: RecentPhotoFacts(capturedAt: at, favorite: favorite, screenshot: screenshot,
        livePhoto: false, location: location))
  }
  func testRecentDateScopeFiltersMetadataAndExplicitAllDatesKeepsUnknownDatesReachable() {
    let items = [photo("recent", at: date(10, 2), favorite: true), photo("old", at: date(3, 1), favorite: true),
      photo("undated", favorite: true), photo("future", at: date(11, 1), favorite: true)]
    let recent = PhotoBrowsing.groups(items, filter: .favorites, calendar: calendar, dates: .recent, now: date(10, 8))
    XCTAssertEqual(recent.flatMap(\.sources).map(\.id), ["recent"])
    let all = PhotoBrowsing.groups(items, filter: .favorites, calendar: calendar, dates: .all, now: date(10, 8))
    XCTAssertEqual(all.flatMap(\.sources).map(\.id), ["future", "recent", "old", "undated"])
  }
  @MainActor func testProjectionReusesMetadataWorkAndCannotKeepAnotherSourceOrAccount() {
    let projection = PhotoBrowseProjection()
    var identity = PhotoBrowseProjectionID(storePage: UUID(), account: "first", vault: UUID(),
      filter: .all, dates: .all, moments: false, scope: "Photos", calendar: calendar, day: date(10, 2))
    var items = [photo("a", at: date(10, 2), favorite: true), photo("b", at: date(10, 1))]
    var builds = 0
    func groups() -> [PhotoBrowseGroup] {
      projection.groups(for: identity) {
        builds += 1
        return PhotoBrowsing.groups(items, filter: identity.filter, calendar: identity.calendar,
          dates: identity.dates, now: identity.day)
      }
    }
    XCTAssertEqual(groups().flatMap(\.sources).map(\.id), ["a", "b"])
    for _ in 0..<20 { XCTAssertEqual(groups().count, 2) }
    XCTAssertEqual(builds, 1, "Unchanged render reads must not rebuild metadata")
    identity.filter = .favorites
    XCTAssertEqual(groups().flatMap(\.sources).map(\.id), ["a"])
    XCTAssertEqual(builds, 2)
    items = [photo("a", at: date(10, 2), revision: "edited")]
    identity.storePage = UUID()
    XCTAssertTrue(groups().isEmpty, "A correction must invalidate cached favorite facts")
    identity.account = "second"; identity.vault = UUID(); items = []
    XCTAssertTrue(groups().isEmpty, "Another account must not reuse the prior projection")
    XCTAssertEqual(builds, 4)
  }
  func testFiltersUseOnlyCurrentSuppliedFactsWithoutInferringPlaces() {
    let ordinary = photo("plain")
    let favorite = photo("favorite", favorite: true)
    let screenshot = photo("screen", screenshot: true)
    let located = photo("gps", location: "40.7128, -74.0060")
    let blank = photo("blank", location: " \n")
    let items = [ordinary, favorite, screenshot, located, blank]
    XCTAssertEqual(PhotoBrowsing.groups(items).flatMap(\.sources).count, 5)
    XCTAssertEqual(PhotoBrowsing.groups(items, filter: .favorites).flatMap(\.sources).map(\.id), ["favorite"])
    XCTAssertEqual(PhotoBrowsing.groups(items, filter: .screenshots).flatMap(\.sources).map(\.id), ["screen"])
    XCTAssertEqual(PhotoBrowsing.groups(items, filter: .withLocation).flatMap(\.sources).map(\.id), ["gps"])
  }
  func testLatestSourceSnapshotReplacesRevisionAndFilterFactsTogether() {
    let stale = photo("same", at: date(10, 1), favorite: true)
    let current = photo("same", at: date(10, 2), revision: "edited", screenshot: true)
    let groups = PhotoBrowsing.groups([stale, current], calendar: calendar)
    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual(groups.first?.sources, [current.source])
    XCTAssertEqual(groups.first?.start, date(10, 2))
    XCTAssertTrue(PhotoBrowsing.groups([stale, current], filter: .favorites, calendar: calendar).isEmpty)
    XCTAssertEqual(PhotoBrowsing.groups([stale, current], filter: .screenshots, calendar: calendar).first?.sources, [current.source])
  }
  func testChronologyAndTiesAreIndependentOfInputOrderAndUnknownDatesComeLast() {
    let items = [photo("z", at: date(10, 2, hour: 10)), photo("yesterday", at: date(10, 1)),
      photo("a", at: date(10, 2, hour: 10)), photo("early", at: date(10, 2, hour: 9)),
      photo("missing"), photo("invalid", at: Date(timeIntervalSince1970: .infinity))]
    let groups = PhotoBrowsing.groups(items, calendar: calendar)
    XCTAssertEqual(groups.map { $0.sources.map(\.id) }, [["a", "z", "early"], ["yesterday"], ["invalid", "missing"]])
    XCTAssertEqual(groups.map(\.id), PhotoBrowsing.groups(Array(items.reversed()), calendar: calendar).map(\.id))
    XCTAssertTrue(groups.last?.isUndated == true)
    XCTAssertNil(groups.last?.end)
    let oldest = PhotoBrowsing.groups(items, order: .oldestFirst, calendar: calendar)
    XCTAssertEqual(oldest.map { $0.sources.map(\.id) }, [["yesterday"], ["early", "a", "z"], ["invalid", "missing"]])
  }
  func testDayGroupingUsesLocalMidnightAndDaylightSavingBoundaries() {
    let spring = [photo("morning", at: date(3, 8, hour: 1)), photo("evening", at: date(3, 8, hour: 23))]
    let group = PhotoBrowsing.groups(spring, calendar: calendar)[0]
    XCTAssertEqual(group.start, date(3, 8))
    XCTAssertEqual(group.end, date(3, 9))
    XCTAssertEqual(group.end!.timeIntervalSince(group.start!), 23 * 3600)
    let autumn = PhotoBrowsing.groups([photo("fall", at: date(11, 1, hour: 12))], calendar: calendar)[0]
    XCTAssertEqual(autumn.end!.timeIntervalSince(autumn.start!), 25 * 3600)
    let beforeMidnight = photo("before", at: date(10, 1, hour: 23, minute: 59))
    let midnight = photo("midnight", at: date(10, 2))
    XCTAssertEqual(PhotoBrowsing.groups([beforeMidnight, midnight], calendar: calendar).count, 2)
  }
  func testChangingTimezoneRebucketsSourceIDsWithoutChangingSources() {
    let items = [photo("before", at: date(10, 1, hour: 23, minute: 30)), photo("after", at: date(10, 2, hour: 0, minute: 30))]
    var utc = calendar
    utc.timeZone = TimeZone(secondsFromGMT: 0)!
    let local = PhotoBrowsing.groups(items, calendar: calendar)
    let universal = PhotoBrowsing.groups(items, calendar: utc)
    XCTAssertEqual(local.count, 2)
    XCTAssertEqual(universal.count, 1)
    XCTAssertEqual(Set(local.flatMap(\.sources)), Set(universal.flatMap(\.sources)))
    XCTAssertNotEqual(local.first?.id, universal.first?.id)
  }
  func testMomentGroupsHaveBoundedAnchoredSpanAndNeverBridgeCalendarDays() {
    let items = [photo("anchor", at: date(10, 2, hour: 8)),
      photo("middle", at: date(10, 2, hour: 9, minute: 30)),
      photo("edge", at: date(10, 2, hour: 10)),
      photo("later", at: date(10, 2, hour: 11)),
      photo("night", at: date(10, 2, hour: 23, minute: 59)),
      photo("next", at: date(10, 3))]
    let groups = PhotoBrowsing.groups(items, grouping: .moments, calendar: calendar)
    XCTAssertEqual(groups.map { $0.sources.map(\.id) }, [["next"], ["night"], ["later"], ["edge", "middle", "anchor"]])
    XCTAssertTrue(groups.allSatisfy { $0.end!.timeIntervalSince($0.start!) <= PhotoBrowsing.maximumMomentSpan })
    XCTAssertEqual(groups.last?.start, date(10, 2, hour: 8))
    XCTAssertEqual(groups.last?.end, date(10, 2, hour: 10))
  }
  func testFilteringDoesNotChangeExistingDayOrMomentIDs() {
    let items = [photo("anchor", at: date(10, 2, hour: 8)),
      photo("favorite", at: date(10, 2, hour: 9), favorite: true)]
    for grouping in [PhotoBrowseGrouping.days, .moments] {
      let all = PhotoBrowsing.groups(items, grouping: grouping, calendar: calendar)
      let favorites = PhotoBrowsing.groups(items, filter: .favorites, grouping: grouping, calendar: calendar)
      XCTAssertEqual(all.first?.id, favorites.first?.id)
      XCTAssertEqual(favorites.first?.sources.map(\.id), ["favorite"])
    }
  }
  func testSourceRevocationAndRevisionChangesCannotRetainOldGroupMembers() {
    let a = photo("a", at: date(10, 2, hour: 8))
    let b = photo("b", at: date(10, 2, hour: 9))
    let initial = PhotoBrowsing.groups([a, b], calendar: calendar)
    let edited = photo("b", at: date(10, 2, hour: 9), revision: "2")
    let current = PhotoBrowsing.groups([edited], calendar: calendar)
    XCTAssertEqual(current.first?.id, initial.first?.id)
    XCTAssertEqual(current.first?.sources, [edited.source])
    XCTAssertTrue(PhotoBrowsing.groups([], calendar: calendar).isEmpty)
  }
}
