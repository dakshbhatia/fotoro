import Foundation

enum PhotoBrowseDateScope: String, CaseIterable, Identifiable, Hashable {
  case recent, all
  var id: String { rawValue }
  func includes(_ date: Date?, now: Date, calendar: Calendar = .current) -> Bool {
    self == .all || RecentPhotosPolicy.includes(date, now: now, calendar: calendar)
  }
}

enum PhotoBrowseFilter: String, CaseIterable, Identifiable, Hashable {
  case all, favorites, screenshots, withLocation
  var id: String { rawValue }
  func includes(_ facts: RecentPhotoFacts) -> Bool {
    switch self {
    case .all: return true
    case .favorites: return facts.favorite
    case .screenshots: return facts.screenshot
    case .withLocation:
      return facts.location?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
  }
}

struct PhotoBrowseItem {
  var source: RecentPhotoSource
  var facts: RecentPhotoFacts
}
enum PhotoBrowseGrouping { case days, moments }
enum PhotoBrowseOrder { case newestFirst, oldestFirst }
struct PhotoBrowseGroup: Identifiable {
  var id: String
  var start: Date?
  var end: Date?
  var sources: [RecentPhotoSource]
  var isUndated: Bool { start == nil }
}

struct PhotoBrowseProjectionID: Equatable {
  var storePage: UUID
  var picks: UInt64 = 0
  var catalog: UInt64 = 0
  var sources: UInt64 = 0
  var account: String? = nil
  var vault: UUID? = nil
  var filter: PhotoBrowseFilter
  var dates: PhotoBrowseDateScope
  var moments: Bool
  var scope: String
  var calendar: Calendar = .current
  var day: Date
}

// The view supplies generation bindings before the expensive metadata closure.
@MainActor final class PhotoBrowseProjection {
  private var identity: PhotoBrowseProjectionID?
  private var value: [PhotoBrowseGroup] = []
  func groups(for identity: PhotoBrowseProjectionID, makeGroups: () -> [PhotoBrowseGroup]) -> [PhotoBrowseGroup] {
    if self.identity == identity { return value }
    value = makeGroups()
    self.identity = identity
    return value
  }
  func clear() { identity = nil; value = [] }
}

// Keep catalog derivation outside repeated cell and selection render reads.
@MainActor final class PhotoBrowseValueProjection<Identity: Equatable, Value> {
  private var cached: (identity: Identity, value: Value)?
  func value(for identity: Identity, makeValue: () -> Value) -> Value {
    if let cached, cached.identity == identity { return cached.value }
    let value = makeValue()
    cached = (identity, value)
    return value
  }
}

#if !FOTORO_LOCAL_PREVIEW
struct SavedPhotoCatalogProjectionID: Equatable {
  var binding: SavedLibraryOpenBinding?
  var permitted: Bool
  var catalog: UInt64
}
struct SavedPhotoCatalogSnapshot {
  let photos: [LocalPhoto]
  let lookup: [String: LocalPhoto]
  init(photos: [LocalPhoto] = [], account: String? = nil) {
    self.photos = photos.filter {
      $0.manifest.ownerAccountId == account && ["committed", "saved"].contains($0.transferState)
    }
    lookup = Dictionary(self.photos.map { (ConsumerPhotoReference.saved($0.id).id, $0) }, uniquingKeysWith: { _, last in last })
  }
}
struct SavedPhotoBrowseProjectionID: Equatable {
  var binding: SavedLibraryOpenBinding?
  var permitted: Bool
  var catalog: UInt64
  var favoritesOnly: Bool
  var calendar: Calendar
}
struct SavedPhotoBrowseSnapshot {
  var photos: [LocalPhoto] = []
  var days: [(String, [LocalPhoto])] = []
}
#endif

enum PhotoBrowseOverviewGranularity: String, CaseIterable, Identifiable, Hashable {
  case days, months, years
  var id: String { rawValue }
}

struct PhotoBrowseOverviewGroup: Identifiable {
  var id: String
  var interval: DateInterval?
  var title: String
  var cover: RecentPhotoSource
  var loadedCount: Int
}

// Drill-down state retains dates, never photo metadata from a withdrawn snapshot.
struct PhotoBrowseOverviewSelection: Equatable {
  var interval: DateInterval?
  var title: String
}

struct PhotoBrowseOverviewProjectionID: Equatable {
  var browse: PhotoBrowseProjectionID
  var granularity: PhotoBrowseOverviewGranularity
  var selection: PhotoBrowseOverviewSelection?
}

struct PhotoBrowseOverviewSnapshot {
  var days: [PhotoBrowseGroup]
  var overview: [PhotoBrowseOverviewGroup]
}

struct PhotoBrowseSearchSuggestion: Identifiable {
  var id: String { query }
  var title: String
  var query: String
  var symbol: String
  var loadedCount: Int
}

enum PhotoBrowsing {
  static let maximumMomentSpan: TimeInterval = 2 * 3600

  // Metadata only: no Photos fetch, reverse geocoding, identity inference, or
  // claim that nearby capture times establish a particular outing.
  static func groups(
    _ items: [PhotoBrowseItem], filter: PhotoBrowseFilter = .all,
    grouping: PhotoBrowseGrouping = .days, order: PhotoBrowseOrder = .newestFirst,
    calendar: Calendar = .current, dates: PhotoBrowseDateScope = .all, now: Date = Date()
  ) -> [PhotoBrowseGroup] {
    // A refreshed source snapshot replaces an earlier occurrence of the same
    // photo; its current revision and filter facts travel together.
    var unique: [String: PhotoBrowseItem] = [:]
    unique.reserveCapacity(items.count)
    for item in items { unique[item.source.id] = item }
    let cutoff = dates == .recent ? RecentPhotosPolicy.cutoff(now: now, calendar: calendar) : nil
    var dated: [DatedItem] = []
    dated.reserveCapacity(unique.count)
    var undated: [PhotoBrowseItem] = []
    for item in unique.values {
      if let cutoff {
        guard let date = item.facts.capturedAt, date >= cutoff, date <= now else { continue }
      }
      guard let date = item.facts.capturedAt, date.timeIntervalSince1970.isFinite
      else { undated.append(item); continue }
      dated.append(DatedItem(item: item, date: date))
    }
    dated.sort {
      if $0.date == $1.date { return $0.item.source.id < $1.item.source.id }
      return order == .newestFirst ? $0.date > $1.date : $0.date < $1.date
    }
    var buckets: [Bucket] = []
    for item in dated {
      let day: DateInterval
      if let previous = buckets.last, item.date >= previous.day.start, item.date < previous.day.end {
        day = previous.day
      } else if let interval = calendar.dateInterval(of: .day, for: item.date) {
        day = interval
      } else { undated.append(item.item); continue }
      let joinsPrevious: Bool
      if let last = buckets.last, last.day.start == day.start {
        // Anchor in browsing order so appending older pages cannot repartition
        // already loaded newest-first moments or replace their identities.
        let span = order == .newestFirst
          ? last.end.timeIntervalSince(item.date) : item.date.timeIntervalSince(last.start)
        joinsPrevious = grouping == .days
          || span <= maximumMomentSpan
      } else { joinsPrevious = false }
      if joinsPrevious {
        buckets[buckets.count - 1].items.append(item)
        buckets[buckets.count - 1].start = min(buckets[buckets.count - 1].start, item.date)
        buckets[buckets.count - 1].end = max(buckets[buckets.count - 1].end, item.date)
      } else {
        let dayID = "day:\(calendar.identifier):\(calendar.timeZone.identifier):\(day.start.timeIntervalSince1970)"
        // Photos pages can split capture-time ties. A newly loaded tied source
        // may sort before this source without changing the moment's time anchor.
        let id = grouping == .days ? dayID : "moment:\(dayID):\(item.date.timeIntervalSince1970)"
        buckets.append(Bucket(id: id, start: item.date, end: item.date, day: day, items: [item]))
      }
    }
    var groups: [PhotoBrowseGroup] = []
    for bucket in buckets {
      let visible = bucket.items.filter { filter.includes($0.item.facts) }
      guard !visible.isEmpty else { continue }
      let start = grouping == .days ? bucket.day.start : bucket.start
      let end = grouping == .days ? bucket.day.end : bucket.end
      groups.append(PhotoBrowseGroup(id: bucket.id, start: start, end: end,
        sources: visible.map(\.item.source)))
    }
    let unknown = undated.filter { filter.includes($0.facts) }.sorted { $0.source.id < $1.source.id }
    if !unknown.isEmpty {
      groups.append(PhotoBrowseGroup(id: "unknown-date", start: nil, end: nil,
        sources: unknown.map(\.source)))
    }
    return groups
  }

  static func overviewSnapshot(_ groups: [PhotoBrowseGroup],
    granularity: PhotoBrowseOverviewGranularity, selection: PhotoBrowseOverviewSelection? = nil,
    calendar: Calendar = .current) -> PhotoBrowseOverviewSnapshot {
    let days = groups.filter { group in
      guard let selection else { return true }
      guard let interval = selection.interval else { return group.isUndated }
      guard let start = group.start else { return false }
      return start >= interval.start && start < interval.end
    }
    guard granularity != .days else { return PhotoBrowseOverviewSnapshot(days: days, overview: []) }
    let component: Calendar.Component = granularity == .years ? .year : .month
    var buckets: [String: PhotoBrowseOverviewGroup] = [:]
    // Existing groups and sources already use newest-first order and deduplicated identities.
    for group in days {
      guard let cover = group.sources.first else { continue }
      let interval = group.start.flatMap { calendar.dateInterval(of: component, for: $0) }
      let id = interval.map {
        "\(granularity.rawValue):\(calendar.identifier):\(calendar.timeZone.identifier):\($0.start.timeIntervalSince1970)"
      } ?? "\(granularity.rawValue):unknown-date"
      if var bucket = buckets[id] {
        bucket.loadedCount += group.sources.count
        buckets[id] = bucket
      } else {
        let title: String
        if let interval {
          let formatter = DateFormatter()
          formatter.calendar = calendar
          formatter.timeZone = calendar.timeZone
          formatter.setLocalizedDateFormatFromTemplate(granularity == .years ? "yyyy" : "MMMM yyyy")
          title = formatter.string(from: interval.start)
        } else { title = "Date unavailable" }
        buckets[id] = PhotoBrowseOverviewGroup(id: id, interval: interval, title: title,
          cover: cover, loadedCount: group.sources.count)
      }
    }
    let overview = buckets.values.sorted {
      if $0.interval?.start == $1.interval?.start { return $0.id < $1.id }
      return ($0.interval?.start ?? .distantPast) > ($1.interval?.start ?? .distantPast)
    }
    return PhotoBrowseOverviewSnapshot(days: days, overview: overview)
  }

  static func searchSuggestions(_ groups: [PhotoBrowseGroup],
    facts: (RecentPhotoSource) -> RecentPhotoFacts?, calendar: Calendar = .current
  ) -> [PhotoBrowseSearchSuggestion] {
    var favorites = 0, screenshots = 0
    var dated: [Date] = []
    for group in groups {
      for source in group.sources {
        guard let value = facts(source) else { continue }
        if value.favorite { favorites += 1 }
        if value.screenshot { screenshots += 1 }
        if let date = value.capturedAt, date.timeIntervalSince1970.isFinite { dated.append(date) }
      }
    }
    var suggestions: [PhotoBrowseSearchSuggestion] = []
    if favorites > 0 {
      suggestions.append(PhotoBrowseSearchSuggestion(title: "Favorites", query: "favorite",
        symbol: "heart", loadedCount: favorites))
    }
    if screenshots > 0 {
      suggestions.append(PhotoBrowseSearchSuggestion(title: "Screenshots", query: "screenshot",
        symbol: "rectangle.on.rectangle", loadedCount: screenshots))
    }
    // NaturalDateQuery parses ISO months in the Gregorian calendar, in local time.
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = calendar.timeZone
    if let newest = dated.max(), let month = gregorian.dateInterval(of: .month, for: newest) {
      let components = gregorian.dateComponents([.year, .month], from: newest)
      if let year = components.year, let number = components.month, year > 0, year <= 9999 {
        let formatter = DateFormatter()
        formatter.calendar = gregorian; formatter.timeZone = gregorian.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMM yyyy")
        suggestions.append(PhotoBrowseSearchSuggestion(title: formatter.string(from: newest),
          query: String(format: "%04d-%02d", year, number), symbol: "calendar",
          loadedCount: dated.filter { $0 >= month.start && $0 < month.end }.count))
      }
    }
    return suggestions
  }

  private struct DatedItem {
    var item: PhotoBrowseItem
    var date: Date
  }
  private struct Bucket {
    var id: String
    var start: Date
    var end: Date
    var day: DateInterval
    var items: [DatedItem]
  }
}

#if !FOTORO_LOCAL_PREVIEW
struct PhotoTimelineSavedItem {
  let photo: LocalPhoto
  let facts: RecentPhotoFacts
}

enum PhotoTimelinePolicy {
  static func groups(device: [PhotoBrowseItem], saved: [PhotoTimelineSavedItem], sources: [BackupSource],
    account: String?, filter: PhotoBrowseFilter = .all, grouping: PhotoBrowseGrouping = .days,
    calendar: Calendar = .current, dates: PhotoBrowseDateScope = .all, now: Date = Date()) -> [PhotoBrowseGroup] {
    // Only current, permitted device revisions can hide their verified saved copy.
    // A saved favorite still appears when its device counterpart fails this filter.
    let cutoff = dates == .recent ? RecentPhotosPolicy.cutoff(now: now, calendar: calendar) : nil
    let records = Dictionary(device.filter { item in
      guard filter.includes(item.facts) else { return false }
      guard let cutoff else { return true }
      guard let date = item.facts.capturedAt else { return false }
      return date >= cutoff && date <= now
    }.map {
      ($0.source.id, SearchRecord(id: $0.source.id, revision: $0.source.revision))
    }, uniquingKeysWith: { _, current in current })
    let copies = ConsumerSearchBinding.verifiedCopies(sources: sources, records: records)
    var items = device.map { item in
      PhotoBrowseItem(source: RecentPhotoSource(id: ConsumerPhotoReference.device(item.source.id).id,
        revision: item.source.revision), facts: item.facts)
    }
    for item in saved {
      let photo = item.photo
      guard let account, photo.manifest.ownerAccountId == account,
        photo.manifest.photoId == photo.id, ["committed", "saved"].contains(photo.transferState),
        !ConsumerSearchBinding.duplicate(saved: photo, copies: copies) else { continue }
      items.append(PhotoBrowseItem(source: RecentPhotoSource(id: ConsumerPhotoReference.saved(photo.id).id,
        revision: photo.metadata.originalSha256 + "|" + photo.manifest.metadataRepresentation.ciphertextSha256), facts: item.facts))
    }
    return PhotoBrowsing.groups(items, filter: filter, grouping: grouping, calendar: calendar, dates: dates, now: now)
  }
}
#endif
