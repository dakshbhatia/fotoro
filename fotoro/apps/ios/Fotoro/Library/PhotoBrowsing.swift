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
      $0.date == $1.date ? $0.item.source.id < $1.item.source.id : $0.date < $1.date
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
        joinsPrevious = grouping == .days
          || item.date.timeIntervalSince(last.start) <= maximumMomentSpan
      } else { joinsPrevious = false }
      if joinsPrevious {
        buckets[buckets.count - 1].items.append(item)
        buckets[buckets.count - 1].end = item.date
      } else {
        let dayID = "day:\(calendar.identifier):\(calendar.timeZone.identifier):\(day.start.timeIntervalSince1970)"
        let id = grouping == .days ? dayID : "moment:\(dayID):\(item.item.source.id)"
        buckets.append(Bucket(id: id, start: item.date, end: item.date, day: day, items: [item]))
      }
    }
    if order == .newestFirst { buckets.reverse() }
    var groups: [PhotoBrowseGroup] = []
    for bucket in buckets {
      var visible = bucket.items.filter { filter.includes($0.item.facts) }
      guard !visible.isEmpty else { continue }
      // Capture ties always use source ID order, independent of fetch order.
      if order == .newestFirst {
        visible.sort {
          $0.date == $1.date ? $0.item.source.id < $1.item.source.id : $0.date > $1.date
        }
      }
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
