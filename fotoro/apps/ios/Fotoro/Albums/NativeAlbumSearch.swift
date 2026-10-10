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
  func compiled(now: Date = Date(), calendar: Calendar = .current) -> NativeAlbumCompiledSearchFilter {
    NativeAlbumCompiledSearchFilter(self, now: now, calendar: calendar)
  }
  func includes(_ item: NativeAlbumItem, facts: AlbumPhotoFactsContentV1?, now: Date = Date(), calendar: Calendar = .current) -> Bool {
    compiled(now: now, calendar: calendar).includes(item, facts: facts)
  }
}

// Parse query dates and normalize user input once for a whole trip snapshot.
struct NativeAlbumCompiledSearchFilter {
  private let from: Date?
  private let until: Date?
  private let people: Set<String>
  private let match: PeopleSearchMatch
  private let place: String
  private let terms: [String]
  init(_ filter: NativeAlbumSearchFilter, now: Date, calendar: Calendar) {
    let parsed = NaturalDateQuery.parse(filter.query, now: now, calendar: calendar)
    from = [filter.from, parsed.scope.from].compactMap { $0 }.max()
    until = [filter.until, parsed.scope.until].compactMap { $0 }.min()
    people = filter.people; match = filter.match
    place = SearchNormalization.text(filter.place)
    terms = parsed.text.split(separator: " ").map(String.init)
  }
  func includes(_ item: NativeAlbumItem, facts: AlbumPhotoFactsContentV1?) -> Bool {
    if from != nil || until != nil {
      guard ["photos", "exif"].contains(item.photo.metadata.dateSource),
        let date = Wire.parseDate(item.photo.metadata.sourceDate), date.timeIntervalSince1970.isFinite,
        from.map({ date >= $0 }) ?? true, until.map({ date < $0 }) ?? true else { return false }
    }
    if !people.isEmpty {
      let present = Set((facts?.people ?? []).map { NativeAlbumPersonChoice(contributor: item.photo.manifest.ownerAccountId, name: $0).id })
      if match == .everyone ? !people.isSubset(of: present) : people.isDisjoint(with: present) { return false }
    }
    guard !place.isEmpty || !terms.isEmpty else { return true }
    let locationTerms = SearchNormalization.text(facts?.location?.searchTerms.joined(separator: " ") ?? "")
    guard place.isEmpty || locationTerms.contains(place) else { return false }
    guard !terms.isEmpty else { return true }
    let text = SearchNormalization.text(([item.photo.metadata.filename, locationTerms] + (facts?.people ?? [])).joined(separator: " "))
    return terms.allSatisfy { text.contains($0) }
  }
}
struct NativeAlbumDuplicateGroup: Identifiable {
  let copies: [NativeAlbumItem]
  var id: String { copies[0].id }
  var representative: NativeAlbumItem { copies[0] }
}
struct NativeAlbumSearchSnapshot {
  let items: [NativeAlbumItem]
  let groups: [NativeAlbumDuplicateGroup]
}
enum NativeAlbumSearch {
  static func snapshot(items: [NativeAlbumItem], facts: [String: AlbumPhotoFactsContentV1],
    filter: NativeAlbumSearchFilter, groupDuplicates: Bool, now: Date = Date(), calendar: Calendar = .current
  ) -> NativeAlbumSearchSnapshot {
    let filtered: [NativeAlbumItem]
    if filter.hasFilters {
      let compiled = filter.compiled(now: now, calendar: calendar)
      filtered = items.filter { compiled.includes($0, facts: facts[$0.id]) }
    } else { filtered = items }
    return NativeAlbumSearchSnapshot(items: filtered,
      groups: groupDuplicates ? groups(filtered) : filtered.map { NativeAlbumDuplicateGroup(copies: [$0]) })
  }
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
