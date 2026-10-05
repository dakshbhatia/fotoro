import CoreLocation
import Foundation
import ImageIO

struct PhotoLocationV1: Codable, Equatable, Sendable {
  var latitude: Double
  var longitude: Double
  var source: String
  var name: String?
  var accuracyMeters: Double?

  var isValid: Bool {
    latitude.isFinite && (-90...90).contains(latitude)
      && longitude.isFinite && (-180...180).contains(longitude)
      && ["exif", "photos", "google-timeline"].contains(source)
      && (name?.unicodeScalars.count ?? 0) <= 200
      && (accuracyMeters.map { $0.isFinite && (0...100000).contains($0) } ?? true)
  }
  var coordinates: String { String(format: "%.4f, %.4f", latitude, longitude) }
  var displayName: String {
    guard let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return coordinates }
    return name
  }
  var provenance: String {
    switch source {
    case "photos": return "Photos location"
    case "google-timeline": return "Google Timeline export"
    default: return "Original photo GPS"
    }
  }
  var searchTerms: [String] { isValid ? ["location gps", coordinates] + (name.map { [$0] } ?? []) : [] }

  static func photos(_ value: CLLocation?) -> Self? {
    guard let value else { return nil }
    let accuracy = value.horizontalAccuracy >= 0 && value.horizontalAccuracy <= 100000
      ? value.horizontalAccuracy : nil
    let location = Self(latitude: value.coordinate.latitude, longitude: value.coordinate.longitude,
      source: "photos", accuracyMeters: accuracy)
    return location.isValid ? location : nil
  }
  static func exif(_ bytes: Data) -> Self? {
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
      let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any]
    else { return nil }
    return exif(gps: gps)
  }
  static func exif(gps: [String: Any]) -> Self? {
    func coordinate(_ key: CFString, reference: CFString, positive: String, negative: String) -> Double? {
      guard let value = gps[key as String] as? NSNumber,
        CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
        value.doubleValue >= 0,
        let direction = gps[reference as String] as? String,
        [positive, negative].contains(direction.uppercased()) else { return nil }
      return value.doubleValue * (direction.uppercased() == negative ? -1 : 1)
    }
    guard let latitude = coordinate(kCGImagePropertyGPSLatitude, reference: kCGImagePropertyGPSLatitudeRef, positive: "N", negative: "S"),
      let longitude = coordinate(kCGImagePropertyGPSLongitude, reference: kCGImagePropertyGPSLongitudeRef, positive: "E", negative: "W")
    else { return nil }
    let accuracy = (gps["HPositioningError"] as? NSNumber)?.doubleValue
    let location = Self(latitude: latitude, longitude: longitude, source: "exif",
      accuracyMeters: accuracy.flatMap { $0.isFinite && (0...100000).contains($0) ? $0 : nil })
    return location.isValid ? location : nil
  }
}

enum PhotoLocationFacts {
  static let coordinatePrefix = "fotoro.location.v1:"
  static let placePrefix = "fotoro.place.v1:"
  static func isReserved(_ fact: String) -> Bool {
    fact.hasPrefix(coordinatePrefix) || fact.hasPrefix(placePrefix)
  }
  static func userFacts(_ facts: [String]?) -> [String] { (facts ?? []).filter { !isReserved($0) } }
  static func read(_ facts: [String]?) -> PhotoLocationV1? {
    let coordinates = (facts ?? []).filter { $0.hasPrefix(coordinatePrefix) }
    let names = (facts ?? []).filter { $0.hasPrefix(placePrefix) }
    guard coordinates.count == 1, names.count <= 1,
      let fact = coordinates.first, fact.unicodeScalars.count <= 240,
      let bytes = String(fact.dropFirst(coordinatePrefix.count)).data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      Set(object.keys).isSubset(of: ["latitude", "longitude", "source", "accuracyMeters"]),
      object.values.allSatisfy({ !($0 is NSNull) }),
      let latitude = object["latitude"] as? NSNumber, CFGetTypeID(latitude) != CFBooleanGetTypeID(),
      let longitude = object["longitude"] as? NSNumber, CFGetTypeID(longitude) != CFBooleanGetTypeID(),
      let source = object["source"] as? String else { return nil }
    // JSONSerialization collapses duplicate keys; reject them before interpreting GPS.
    let json = String(decoding: bytes, as: UTF8.self)
    guard let keys = try? NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"\s*:"#) else { return nil }
    let matches = keys.matches(in: json, range: NSRange(json.startIndex..., in: json))
    guard matches.count == object.count, matches.allSatisfy({ match in
      guard let range = Range(match.range, in: json) else { return false }
      return ["latitude", "longitude", "source", "accuracyMeters"].contains { String(json[range]).hasPrefix("\"" + $0 + "\"") }
    }) else { return nil }
    var accuracy: Double?
    if let value = object["accuracyMeters"] {
      guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
      accuracy = number.doubleValue
    }
    let name = names.first.map { String($0.dropFirst(placePrefix.count)) }
    let value = PhotoLocationV1(latitude: latitude.doubleValue, longitude: longitude.doubleValue,
      source: source, name: name, accuracyMeters: accuracy)
    return value.isValid ? value : nil
  }
  static func replacing(in facts: [String]?, with location: PhotoLocationV1?) throws -> [String]? {
    var result = userFacts(facts)
    if let location {
      guard location.isValid else { throw PhotoLocationError.invalid }
      var coordinates: [String: Any] = ["latitude": location.latitude, "longitude": location.longitude, "source": location.source]
      if let accuracy = location.accuracyMeters { coordinates["accuracyMeters"] = accuracy }
      let encoded = try JSONSerialization.data(withJSONObject: coordinates, options: [.sortedKeys, .withoutEscapingSlashes])
      let marker = coordinatePrefix + String(decoding: encoded, as: UTF8.self)
      guard marker.unicodeScalars.count <= 240 else { throw PhotoLocationError.invalid }
      result.append(marker)
      if let name = location.name { result.append(placePrefix + name) }
    }
    guard result.count <= 64 else { throw PhotoLocationError.capacity }
    return result.isEmpty && facts == nil ? nil : result
  }
}

enum PhotoLocationError: LocalizedError {
  case invalid, capacity
  var errorDescription: String? {
    switch self {
    case .invalid: return "Photo location is invalid."
    case .capacity: return "There is no room for location in this photo’s saved facts."
    }
  }
}
