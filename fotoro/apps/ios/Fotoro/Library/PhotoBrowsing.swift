import Foundation

enum PhotoBrowseFilter: String, CaseIterable, Identifiable {
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

enum PhotoBrowsing {
  static let maximumMomentSpan: TimeInterval = 2 * 3600

  // Metadata only: no Photos fetch, reverse geocoding, identity inference, or
  // claim that nearby capture times establish a particular outing.
  static func groups(
    _ items: [PhotoBrowseItem], filter: PhotoBrowseFilter = .all,
    grouping: PhotoBrowseGrouping = .days, order: PhotoBrowseOrder = .newestFirst,
    calendar: Calendar = .current
  ) -> [PhotoBrowseGroup] {
    // A refreshed source snapshot replaces an earlier occurrence of the same
    // photo; its current revision and filter facts travel together.
    var unique: [String: PhotoBrowseItem] = [:]
    for item in items { unique[item.source.id] = item }
    var dated: [DatedItem] = []
    var undated: [PhotoBrowseItem] = []
    for item in unique.values {
      guard let date = item.facts.capturedAt, date.timeIntervalSince1970.isFinite,
        let day = calendar.dateInterval(of: .day, for: date)
      else { undated.append(item); continue }
      dated.append(DatedItem(item: item, date: date, day: day))
    }
    dated.sort {
      $0.date == $1.date ? $0.item.source.id < $1.item.source.id : $0.date < $1.date
    }
    var buckets: [Bucket] = []
    for item in dated {
      let joinsPrevious: Bool
      if let last = buckets.last, last.day.start == item.day.start {
        joinsPrevious = grouping == .days
          || item.date.timeIntervalSince(last.start) <= maximumMomentSpan
      } else { joinsPrevious = false }
      if joinsPrevious {
        buckets[buckets.count - 1].items.append(item)
        buckets[buckets.count - 1].end = item.date
      } else {
        let dayID = "day:\(calendar.identifier):\(calendar.timeZone.identifier):\(item.day.start.timeIntervalSince1970)"
        let id = grouping == .days ? dayID : "moment:\(dayID):\(item.item.source.id)"
        buckets.append(Bucket(id: id, start: item.date, end: item.date, day: item.day, items: [item]))
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
    var day: DateInterval
  }
  private struct Bucket {
    var id: String
    var start: Date
    var end: Date
    var day: DateInterval
    var items: [DatedItem]
  }
}
