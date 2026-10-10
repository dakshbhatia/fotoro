import Foundation

struct PhotoPlaceCoordinate: Equatable, Sendable {
  var latitude: Double
  var longitude: Double
  var isValid: Bool { latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude) && (-180...180).contains(longitude) }
}
struct PhotoPlacePoint: Equatable, Sendable {
  var id: String
  var revision: String
  var coordinate: PhotoPlaceCoordinate
  var capturedAt: Date?
  var name: String?
}
struct PhotoPlaceViewport: Equatable, Sendable {
  var center: PhotoPlaceCoordinate
  var latitudeSpan: Double
  var longitudeSpan: Double
  var isValid: Bool { center.isValid && latitudeSpan.isFinite && longitudeSpan.isFinite && latitudeSpan > 0 && longitudeSpan > 0 && latitudeSpan <= 180 && longitudeSpan <= 360 }
  func contains(_ coordinate: PhotoPlaceCoordinate) -> Bool {
    guard isValid, coordinate.isValid else { return false }
    let longitudeDistance = abs(PhotoPlaceGeometry.longitude(coordinate.longitude - center.longitude))
    return abs(coordinate.latitude - center.latitude) <= latitudeSpan / 2 + 1e-9 && longitudeDistance <= longitudeSpan / 2 + 1e-9
  }
  func padded(_ factor: Double = 1.2, minimum: Double = 0.004) -> Self {
    Self(center: center, latitudeSpan: min(180, max(minimum, latitudeSpan * factor)), longitudeSpan: min(360, max(minimum, longitudeSpan * factor)))
  }
}
enum PhotoPlaceScale: String, Sendable {
  case regions, cities, spots, photos
  var title: String {
    switch self { case .regions: return "Regions"; case .cities: return "City areas"; case .spots: return "Spots"; case .photos: return "Photos" }
  }
  var areaLabel: String {
    switch self { case .regions: return "Area"; case .cities: return "City area"; case .spots: return "Spot"; case .photos: return "Spot" }
  }
}
struct PhotoPlaceCluster: Equatable, Identifiable, Sendable {
  var id: String
  var photoIDs: [String]
  var coordinate: PhotoPlaceCoordinate
  var bounds: PhotoPlaceViewport
  var name: String?
  var count: Int { photoIDs.count }
}
struct PhotoPlaceMapSnapshot: Equatable, Sendable {
  var clusters: [PhotoPlaceCluster]
  var visiblePhotoIDs: [String]
  var scale: PhotoPlaceScale
  var visibleCount: Int { visiblePhotoIDs.count }
  static let empty = Self(clusters: [], visiblePhotoIDs: [], scale: .regions)
}
enum PhotoPlaceGeometry {
  static let maximumMarkers = 80
  static func longitude(_ value: Double) -> Double {
    guard value.isFinite else { return .nan }
    let wrapped = (value + 180).truncatingRemainder(dividingBy: 360)
    return (wrapped < 0 ? wrapped + 360 : wrapped) - 180
  }
  static func includes(_ point: PhotoPlacePoint, recentOnly: Bool, now: Date, calendar: Calendar = .current) -> Bool {
    guard !point.id.isEmpty, !point.revision.isEmpty, point.coordinate.isValid else { return false }
    guard recentOnly else { return true }
    guard let date = point.capturedAt, date.timeIntervalSince1970.isFinite,
      let cutoff = calendar.date(byAdding: .day, value: -30, to: now) else { return false }
    return date >= cutoff && date <= now
  }
  static func bounds(_ coordinates: [PhotoPlaceCoordinate]) -> PhotoPlaceViewport? {
    let valid = coordinates.filter(\.isValid)
    guard !valid.isEmpty else { return nil }
    let latitudes = valid.map(\.latitude), longitudes = valid.map { longitude($0.longitude) + 180 }.sorted()
    var widestGap = -Double.infinity, start = longitudes[0]
    for index in longitudes.indices {
      let next = index + 1 < longitudes.count ? longitudes[index + 1] : longitudes[0] + 360
      if next - longitudes[index] > widestGap { widestGap = next - longitudes[index]; start = next.truncatingRemainder(dividingBy: 360) }
    }
    let longitudeSpan = max(0, 360 - widestGap), low = latitudes.min()!, high = latitudes.max()!
    return PhotoPlaceViewport(center: PhotoPlaceCoordinate(latitude: (low + high) / 2, longitude: longitude(start + longitudeSpan / 2 - 180)), latitudeSpan: max(1e-9, high - low), longitudeSpan: max(1e-9, longitudeSpan))
  }
  static func scale(for viewport: PhotoPlaceViewport) -> PhotoPlaceScale {
    let extent = max(viewport.latitudeSpan, viewport.longitudeSpan)
    if extent >= 8 { return .regions }
    if extent >= 0.3 { return .cities }
    if extent >= 0.008 { return .spots }
    return .photos
  }
  static func snapshot(_ points: [PhotoPlacePoint], viewport: PhotoPlaceViewport, maximumMarkers: Int = maximumMarkers) -> PhotoPlaceMapSnapshot {
    guard viewport.isValid else { return .empty }
    var unique: [String: PhotoPlacePoint] = [:]
    for point in points where !point.id.isEmpty && !point.revision.isEmpty && point.coordinate.isValid && viewport.contains(point.coordinate) {
      if Task.isCancelled { return .empty }
      if let old = unique[point.id] {
        let oldKey = "\(old.revision)|\(old.coordinate.latitude)|\(old.coordinate.longitude)|\(old.name ?? "")"
        let nextKey = "\(point.revision)|\(point.coordinate.latitude)|\(point.coordinate.longitude)|\(point.name ?? "")"
        if oldKey >= nextKey { continue }
      }
      unique[point.id] = point
    }
    let visible = unique.values.sorted { $0.id < $1.id }, scale = scale(for: viewport), limit = min(Self.maximumMarkers, max(1, maximumMarkers))
    let angularCell = max(viewport.longitudeSpan / 8, viewport.latitudeSpan / 6, 0.000001)
    var level = min(24, max(0, Int(floor(log2(360 / angularCell))))), bins: [String: [PhotoPlacePoint]] = [:]
    while true {
      bins.removeAll(keepingCapacity: true)
      let count = 1 << level, longitudeCell = 360 / Double(count), latitudeCell = 180 / Double(count)
      for point in visible {
        if Task.isCancelled { return .empty }
        let x = (longitude(point.coordinate.longitude) + 180 + longitudeCell / 2).truncatingRemainder(dividingBy: 360)
        let column = min(count - 1, max(0, Int(floor(x / longitudeCell))))
        let row = min(count - 1, max(0, Int(floor((point.coordinate.latitude + 90) / latitudeCell + 0.5))))
        bins["\(level):\(column):\(row)", default: []].append(point)
      }
      if bins.count <= limit || level == 0 { break }
      level -= 1
    }
    let clusters = bins.keys.sorted().compactMap { key -> PhotoPlaceCluster? in
      guard let values = bins[key], let bounds = bounds(values.map(\.coordinate)) else { return nil }
      let names = Set(values.compactMap(\.name).filter { !$0.isEmpty })
      let name = names.count == 1 && values.allSatisfy({ $0.name == names.first }) ? names.first : nil
      return PhotoPlaceCluster(id: values.count == 1 ? "photo:" + values[0].id : "area:" + key,
        photoIDs: values.map(\.id), coordinate: bounds.center, bounds: bounds, name: name)
    }
    let ordered = visible.sorted { left, right in
      let a = left.capturedAt.flatMap { $0.timeIntervalSince1970.isFinite ? $0 : nil }
      let b = right.capturedAt.flatMap { $0.timeIntervalSince1970.isFinite ? $0 : nil }
      if a == b { return left.id < right.id }
      guard let a else { return false }; guard let b else { return true }
      return a > b
    }
    return PhotoPlaceMapSnapshot(clusters: clusters, visiblePhotoIDs: ordered.map(\.id), scale: scale)
  }
}
