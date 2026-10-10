import Foundation
import XCTest

@testable import Fotoro

final class PhotoBrowsingTests: XCTestCase {
  func testOverviewUsesDeduplicatedCurrentSourcesAndNewestCovers() {
    let groups = PhotoBrowsing.groups([
      photo("edited", at: date(10, 2), revision: "old"),
      photo("september", at: date(9, 30)),
      photo("edited", at: date(10, 4), revision: "current"),
      photo("newest", at: date(10, 5)), photo("unknown"),
    ], calendar: calendar)
    let months = PhotoBrowsing.overviewSnapshot(groups, granularity: .months, calendar: calendar)
    XCTAssertEqual(months.overview.map(\.cover.id), ["newest", "september", "unknown"])
    XCTAssertEqual(months.overview.map(\.loadedCount), [2, 1, 1])
    XCTAssertEqual(months.overview[0].interval?.start, date(10, 1))
    XCTAssertEqual(months.overview[0].interval?.end, date(11, 1))
    XCTAssertNil(months.overview.last?.interval)
    let years = PhotoBrowsing.overviewSnapshot(groups, granularity: .years, calendar: calendar)
    XCTAssertEqual(years.overview.map(\.loadedCount), [3, 1])
    XCTAssertEqual(years.overview.first?.cover.id, "newest")
    XCTAssertEqual(months.days.flatMap(\.sources).first(where: { $0.id == "edited" })?.revision, "current")
  }

  func testOverviewDrillUsesHalfOpenCalendarIntervalsAndKeepsUnknownDatesReachable() {
    let groups = PhotoBrowsing.groups([photo("before", at: date(9, 30, hour: 23, minute: 59)),
      photo("first", at: date(10, 1)), photo("last", at: date(10, 31, hour: 23, minute: 59)),
      photo("next", at: date(11, 1)), photo("unknown")], calendar: calendar)
    let selection = PhotoBrowseOverviewSelection(interval: DateInterval(start: date(10, 1), end: date(11, 1)), title: "October")
    let drill = PhotoBrowsing.overviewSnapshot(groups, granularity: .days, selection: selection, calendar: calendar)
    XCTAssertEqual(drill.days.flatMap(\.sources).map(\.id), ["last", "first"])
    XCTAssertTrue(drill.overview.isEmpty)
    let unknown = PhotoBrowsing.overviewSnapshot(groups, granularity: .days,
      selection: PhotoBrowseOverviewSelection(interval: nil, title: "Date unavailable"), calendar: calendar)
    XCTAssertEqual(unknown.days.flatMap(\.sources).map(\.id), ["unknown"])
  }

  func testYearDrillKeepsOnlyMonthsInSelectedYearAndHonorsLeapAndDSTBoundaries() {
    let yearStart = calendar.date(from: DateComponents(year: 2026, month: 1, day: 1))!
    let nextYear = calendar.date(from: DateComponents(year: 2027, month: 1, day: 1))!
    let groups = PhotoBrowsing.groups([photo("next-year", at: nextYear), photo("march", at: date(3, 8, hour: 23)),
      photo("november", at: date(11, 1, hour: 23))], calendar: calendar)
    let selection = PhotoBrowseOverviewSelection(interval: DateInterval(start: yearStart, end: nextYear), title: "2026")
    let drill = PhotoBrowsing.overviewSnapshot(groups, granularity: .months, selection: selection, calendar: calendar)
    XCTAssertEqual(drill.overview.map(\.cover.id), ["november", "march"])
    XCTAssertEqual(drill.overview.last?.interval?.end, date(4, 1))
    XCTAssertEqual(drill.overview.last?.interval?.duration, 31 * 86400 - 3600)
    let leapDay = calendar.date(from: DateComponents(year: 2024, month: 2, day: 29))!
    let leap = PhotoBrowsing.overviewSnapshot(PhotoBrowsing.groups([photo("leap", at: leapDay)], calendar: calendar),
      granularity: .months, calendar: calendar)
    XCTAssertEqual(leap.overview.first?.interval?.duration, 29 * 86400)
  }

  func testOverviewIdentityAndBucketsFollowCalendarAndTimeZone() {
    let groups = PhotoBrowsing.groups([photo("edge", at: date(9, 30, hour: 23, minute: 30))], calendar: calendar)
    let local = PhotoBrowsing.overviewSnapshot(groups, granularity: .months, calendar: calendar)
    var utc = calendar
    utc.timeZone = TimeZone(secondsFromGMT: 0)!
    let utcGroups = PhotoBrowsing.groups([photo("edge", at: date(9, 30, hour: 23, minute: 30))], calendar: utc)
    let universal = PhotoBrowsing.overviewSnapshot(utcGroups, granularity: .months, calendar: utc)
    XCTAssertNotEqual(local.overview.first?.id, universal.overview.first?.id)
    XCTAssertEqual(local.overview.first?.interval?.start, date(9, 1))
    XCTAssertEqual(utc.dateComponents([.month], from: universal.overview[0].interval!.start).month, 10)
    var buddhist = calendar
    buddhist = Calendar(identifier: .buddhist)
    buddhist.timeZone = calendar.timeZone
    let other = PhotoBrowsing.overviewSnapshot(groups, granularity: .months, calendar: buddhist)
    XCTAssertNotEqual(local.overview.first?.id, other.overview.first?.id)
    XCTAssertEqual(local.overview.first?.cover, other.overview.first?.cover)
  }

  @MainActor func testOverviewProjectionReusesWorkAndFencesDrillAccountAccessAndNewPages() {
    let projection = PhotoBrowseValueProjection<PhotoBrowseOverviewProjectionID, PhotoBrowseOverviewSnapshot>()
    var identity = PhotoBrowseOverviewProjectionID(browse: PhotoBrowseProjectionID(storePage: UUID(), account: "a", vault: UUID(),
      filter: .all, dates: .all, moments: false, scope: "Photos", calendar: calendar, day: date(10, 5)),
      granularity: .months, selection: nil)
    var groups = PhotoBrowsing.groups([photo("a", at: date(10, 4))], calendar: calendar)
    var builds = 0
    func snapshot() -> PhotoBrowseOverviewSnapshot {
      projection.value(for: identity) {
        builds += 1
        return PhotoBrowsing.overviewSnapshot(groups, granularity: identity.granularity,
          selection: identity.selection, calendar: identity.browse.calendar)
      }
    }
    for _ in 0..<100 { XCTAssertEqual(snapshot().overview.first?.loadedCount, 1) }
    XCTAssertEqual(builds, 1)
    groups = PhotoBrowsing.groups([photo("a", at: date(10, 4)), photo("b", at: date(10, 5))], calendar: calendar)
    identity.browse.storePage = UUID()
    XCTAssertEqual(snapshot().overview.first?.loadedCount, 2)
    identity.selection = PhotoBrowseOverviewSelection(interval: DateInterval(start: date(9, 1), end: date(10, 1)), title: "September")
    XCTAssertTrue(snapshot().overview.isEmpty)
    identity.granularity = .days
    XCTAssertTrue(snapshot().days.isEmpty)
    groups = []; identity.browse.account = nil; identity.browse.vault = UUID()
    XCTAssertTrue(snapshot().days.isEmpty, "Withdrawing access cannot reuse a former cover or count")
    identity.browse.account = "another"; identity.selection = nil; identity.granularity = .years
    groups = PhotoBrowsing.groups([photo("other", at: date(10, 2))], calendar: calendar)
    XCTAssertEqual(snapshot().overview.first?.cover.id, "other")
    identity.browse.calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    _ = snapshot()
    XCTAssertEqual(builds, 7)
  }

  func testSearchSuggestionsUseOnlyCurrentAvailableFactsAndGregorianMonthCompletion() {
    let items = [photo("favorite", at: date(10, 5), favorite: true), photo("screen", at: date(10, 1), screenshot: true),
      photo("old", at: date(9, 30)), photo("withdrawn", at: date(10, 6), favorite: true)]
    let groups = PhotoBrowsing.groups(items, calendar: calendar)
    let current = Dictionary(items.filter { $0.source.id != "withdrawn" }.map { ($0.source.id, $0.facts) }, uniquingKeysWith: { _, last in last })
    var buddhist = Calendar(identifier: .buddhist)
    buddhist.timeZone = calendar.timeZone
    let suggestions = PhotoBrowsing.searchSuggestions(groups, facts: { current[$0.id] }, calendar: buddhist)
    XCTAssertEqual(suggestions.map(\.query), ["favorite", "screenshot", "2026-10"])
    XCTAssertEqual(suggestions.map(\.loadedCount), [1, 1, 2])
    let parsed = NaturalDateQuery.parse(suggestions[2].query, calendar: buddhist)
    XCTAssertEqual(parsed.scope.from, date(10, 1))
    XCTAssertEqual(parsed.scope.until, date(11, 1))
    XCTAssertEqual(parsed.text, "")
    XCTAssertTrue(PhotoBrowsing.searchSuggestions(groups, facts: { _ in nil }, calendar: calendar).isEmpty)
  }

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
  #if !FOTORO_LOCAL_PREVIEW
  @MainActor func testSavedCatalogProjectionReusesArrayAndLookupAndFencesAccountVaultCatalogAndAccess() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let services = try AppServices(root: root, diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    let secondStore = NSObject()
    var binding = SavedLibraryOpenBinding(services)
    binding.account = "first"
    var identity = SavedPhotoCatalogProjectionID(binding: binding, permitted: true, catalog: 1)
    let projection = PhotoBrowseValueProjection<SavedPhotoCatalogProjectionID, SavedPhotoCatalogSnapshot>()
    var builds = 0
    var catalog = [savedPhoto("first-photo", account: "first"), savedPhoto("peer-photo", account: "second"),
      savedPhoto("pending-photo", account: "first", state: "pending")]
    func read() -> SavedPhotoCatalogSnapshot {
      projection.value(for: identity) {
        builds += 1
        return identity.permitted ? SavedPhotoCatalogSnapshot(photos: catalog, account: identity.binding?.account)
          : SavedPhotoCatalogSnapshot()
      }
    }
    for _ in 0..<100 {
      XCTAssertEqual(read().photos.map(\.id), ["first-photo"])
      XCTAssertEqual(read().lookup["saved:first-photo"]?.id, "first-photo")
      XCTAssertEqual(read().lookup.count, 1, "Peer and pending photos must stay outside both representations")
    }
    XCTAssertEqual(builds, 1, "Selection, filter and grouping renders reuse the unfiltered catalog and lookup")
    catalog.append(savedPhoto("added-photo", account: "first", state: "saved")); identity.catalog += 1
    XCTAssertEqual(read().lookup["saved:added-photo"]?.id, "added-photo")
    identity.permitted = false
    XCTAssertTrue(read().photos.isEmpty)
    XCTAssertTrue(read().lookup.isEmpty, "Withdrawn access must clear both representations")
    identity.permitted = true
    XCTAssertEqual(read().photos.count, 2)
    binding.account = "second"; identity.binding = binding
    XCTAssertNil(read().lookup["saved:first-photo"], "An account switch cannot reuse the former account's lookup")
    XCTAssertEqual(read().photos.map(\.id), ["peer-photo"])
    binding.vault = UUID(); identity.binding = binding; catalog = []
    XCTAssertTrue(read().lookup.isEmpty, "A new vault generation cannot retain the old snapshot")
    binding.catalog = ObjectIdentifier(secondStore); identity.binding = binding; catalog = [savedPhoto("replacement-photo", account: "second")]
    XCTAssertEqual(read().photos.map(\.id), ["replacement-photo"])
    identity.binding = nil; identity.permitted = false
    XCTAssertTrue(read().lookup.isEmpty, "Removing services must discard the prior catalog")
    XCTAssertEqual(builds, 8)
  }
  private func savedPhoto(_ id: String, account: String, state: String = "committed") -> LocalPhoto {
    let representation = RepresentationV1(binding: MediaBinding(photoId: id, representationId: "metadata", kind: "metadata"),
      objectId: "object", header: "", ciphertextBytes: 1, ciphertextSha256: "cipher")
    return LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: account,
      representations: [], metadataRepresentation: representation, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")),
      metadata: PhotoMetadataV1(filename: "photo.jpg", mediaType: "image/jpeg", sourceDate: "2026-10-02T00:00:00Z",
        dateSource: "photos", originalBytes: 1, originalSha256: "original", representationKeys: [:]), transferState: state)
  }
  @MainActor func testSavedProjectionReusesReadsAndInvalidatesCatalogFavoritesAccessAndCalendar() {
    let projection = PhotoBrowseValueProjection<SavedPhotoBrowseProjectionID, [String]>()
    var identity = SavedPhotoBrowseProjectionID(binding: nil, permitted: true, catalog: 1,
      favoritesOnly: false, calendar: calendar)
    var builds = 0
    func read() -> [String] {
      projection.value(for: identity) {
        builds += 1
        return identity.permitted ? ["snapshot-\(identity.catalog)-\(identity.favoritesOnly)"] : []
      }
    }
    for _ in 0..<100 { XCTAssertEqual(read(), ["snapshot-1-false"]) }
    XCTAssertEqual(builds, 1, "Cell appearance and selection reads reuse catalog derivation")
    identity.catalog += 1
    XCTAssertEqual(read(), ["snapshot-2-false"])
    identity.favoritesOnly = true
    XCTAssertEqual(read(), ["snapshot-2-true"])
    identity.permitted = false
    XCTAssertTrue(read().isEmpty, "Withdrawn saved-library access cannot reuse photos")
    identity.permitted = true
    XCTAssertEqual(read(), ["snapshot-2-true"])
    identity.calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    _ = read()
    XCTAssertEqual(builds, 6, "Day buckets must follow the current calendar")
  }
  #endif
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
