import Foundation

struct NativeAlbumPersonChoice: Identifiable, Hashable {
  let contributor: String
  let name: String
  var id: String { contributor + ":" + Data(name.utf8).b64 }
  static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
struct NativeAlbumSearchFilter: Equatable {
  var query = ""
  var place = ""
  var people = Set<String>()
  var match = PeopleSearchMatch.any
  var from: Date?
  var until: Date?
  var hasFilters: Bool { !query.isEmpty || !place.isEmpty || !people.isEmpty || from != nil || until != nil }
  func includes(_ item: NativeAlbumItem, facts: AlbumPhotoFactsContentV1?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
    let parsed = NaturalDateQuery.parse(query, now: now, calendar: calendar)
    let starts = [from, parsed.scope.from].compactMap { $0 }
    let ends = [until, parsed.scope.until].compactMap { $0 }
    if !starts.isEmpty || !ends.isEmpty {
      guard ["photos", "exif"].contains(item.photo.metadata.dateSource),
        let date = Wire.parseDate(item.photo.metadata.sourceDate), date.timeIntervalSince1970.isFinite,
        starts.allSatisfy({ date >= $0 }), ends.allSatisfy({ date < $0 }) else { return false }
    }
    let present = Set((facts?.people ?? []).map { NativeAlbumPersonChoice(contributor: item.photo.manifest.ownerAccountId, name: $0).id })
    if !people.isEmpty, match == .everyone ? !people.isSubset(of: present) : people.isDisjoint(with: present) { return false }
    let locationTerms = SearchNormalization.text(facts?.location?.searchTerms.joined(separator: " ") ?? "")
    let placeQuery = SearchNormalization.text(place)
    guard placeQuery.isEmpty || locationTerms.contains(placeQuery) else { return false }
    let terms = SearchNormalization.text(([item.photo.metadata.filename, locationTerms] + (facts?.people ?? [])).joined(separator: " "))
    return parsed.text.split(separator: " ").allSatisfy { terms.contains($0) }
  }
}
struct NativeAlbumDuplicateGroup: Identifiable {
  let copies: [NativeAlbumItem]
  var id: String { copies[0].id }
  var representative: NativeAlbumItem { copies[0] }
}
enum NativeAlbumSearch {
  static func choices(items: [NativeAlbumItem], facts: [String: AlbumPhotoFactsContentV1]) -> [NativeAlbumPersonChoice] {
    Set(items.flatMap { item in (facts[item.id]?.people ?? []).map { NativeAlbumPersonChoice(contributor: item.photo.manifest.ownerAccountId, name: $0) } })
      .sorted { $0.name == $1.name ? $0.contributor < $1.contributor : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
  }
  static func groups(_ items: [NativeAlbumItem]) -> [NativeAlbumDuplicateGroup] {
    var positions: [String: Int] = [:], groups: [[NativeAlbumItem]] = []
    for item in items {
      let metadata = item.photo.metadata
      let key = metadata.originalSha256 + ":" + String(metadata.originalBytes) + ":" + metadata.mediaType
      if let index = positions[key] { groups[index].append(item) }
      else { positions[key] = groups.count; groups.append([item]) }
    }
    return groups.map { NativeAlbumDuplicateGroup(copies: $0) }
  }
}
