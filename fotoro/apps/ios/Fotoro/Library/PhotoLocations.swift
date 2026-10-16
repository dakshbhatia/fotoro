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
    guard let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Location on map" }
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
  var mapURL: URL? {
    guard isValid else { return nil }
    var url = URLComponents(string: "https://maps.apple.com/")
    url?.queryItems = [URLQueryItem(name: "ll", value: "\(latitude),\(longitude)"),
      URLQueryItem(name: "q", value: "Photo location")]
    return url?.url
  }

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

// Private organization records use the released annotation facts envelope.
enum PhotoOrganizationChange { case name(String?), trash(Bool), screenshot(Bool?) }
// Incoming annotations may update the saved name while its editor is open.
// Only an explicit successful name operation acknowledges an edited draft.
struct PhotoNameDraft: Equatable {
  private(set) var savedName: String
  private(set) var value: String
  private(set) var savedNameChanged = false
  init(savedName: String) { self.savedName = savedName; value = savedName }
  mutating func edit(_ value: String) {
    self.value = value
    savedNameChanged = savedNameChanged && value != savedName
  }
  mutating func receive(_ name: String) {
    guard name != savedName else { return }
    if value == savedName || value == name { self = Self(savedName: name) }
    else { savedName = name; savedNameChanged = true }
  }
  mutating func acknowledge(_ name: String) { self = Self(savedName: name) }
}

enum PhotoTagEdits {
  // A retained row action identifies the tag, never its former array position.
  static func remove(_ tag: String, current: () -> [String], save: ([String]) throws -> Void) rethrows {
    let labels = current()
    let updated = labels.filter { $0 != tag }
    guard updated.count != labels.count else { return }
    try save(updated)
  }
}

enum PhotoOrganizationFacts {
  static let namePrefix = "fotoro.name.v1:"
  static let trashPrefix = "fotoro.trash.v1:"
  static let screenshotPrefix = "fotoro.screenshot.v1:"
  static let prefixes = [namePrefix, trashPrefix, screenshotPrefix]
  static func category(_ fact: String) -> String? {
    if fact.hasPrefix(namePrefix) { return "name" }
    if fact.hasPrefix(trashPrefix) { return "trash" }
    if fact.hasPrefix(screenshotPrefix) { return "screenshot" }
    return nil
  }
  static func one(_ facts: [String]?, prefix: String) -> String? {
    let values = (facts ?? []).filter { $0.hasPrefix(prefix) }
    return values.count == 1 ? String(values[0].dropFirst(prefix.count)) : nil
  }
  static func validName(_ name: String) -> Bool {
    !name.isEmpty && name.unicodeScalars.count <= 160 && name.utf8.count <= 240 && name == name.trimmingCharacters(in: .whitespacesAndNewlines)
      && !name.hasPrefix(".") && !name.hasSuffix(".") && !name.hasSuffix(" ")
      && name.range(of: #"[\\/<>:"|?*\p{C}]"#, options: .regularExpression) == nil
      && name.range(of: #"^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)"#, options: [.regularExpression, .caseInsensitive]) == nil
  }
  static func name(_ facts: [String]?, original: String) -> String {
    guard let name = one(facts, prefix: namePrefix), validName(name) else { return original }
    return name
  }
  static func trashed(_ facts: [String]?) -> Bool { one(facts, prefix: trashPrefix) == "true" }
  static func screenshot(_ facts: [String]?, originalSha256: String? = nil, detected: Bool = false) -> Bool {
    if let value = one(facts, prefix: screenshotPrefix), ["true", "false"].contains(value) { return value == "true" }
    let capture = originalSha256.flatMap { PhotoCaptureFacts.read(facts, originalSha256: $0) }
    return detected || facts?.contains("screenshot") == true || capture?.items.contains { $0.p == .photos && $0.k == "subtypes" && $0.v.split(separator: ",").contains("screenshot") } == true
  }
  static func replacing(_ facts: [String]?, change: PhotoOrganizationChange) throws -> [String] {
    let prefix: String, value: String?
    switch change {
    case .name(let name):
      guard name.map(validName) ?? true else { throw PhotoOrganizationError.invalid }
      prefix = namePrefix; value = name
    case .trash(let trash): prefix = trashPrefix; value = trash ? "true" : nil
    case .screenshot(let screenshot): prefix = screenshotPrefix; value = screenshot.map { $0 ? "true" : "false" }
    }
    if let value, one(facts, prefix: prefix) == value { return facts ?? [] }
    var result = (facts ?? []).filter { !$0.hasPrefix(prefix) }
    if let value { result.append(prefix + value) }
    guard result.count <= 64 else { throw PhotoOrganizationError.capacity }
    return result
  }
  static func suggestedName(original: String, digest: String?, capturedAt: Date?, labels: [String], place: String?, screenshot: Bool) -> String {
    func slug(_ value: String) -> String {
      value.precomposedStringWithCanonicalMapping.replacingOccurrences(of: #"[^\p{L}\p{N}]+"#, with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withFullDate]; formatter.timeZone = TimeZone(secondsFromGMT: 0)
    var parts = capturedAt.flatMap { $0.timeIntervalSince1970.isFinite ? [formatter.string(from: $0)] : nil } ?? []
    var seen = Set<String>()
    func add(_ text: String?) -> Bool {
      guard let text else { return false }
      let word = slug(text)
      guard !word.isEmpty && seen.insert(word.lowercased()).inserted else { return false }
      parts.append(word); return true
    }
    _ = add(screenshot ? "Screenshot" : nil); _ = add(place)
    var tags = 0
    for label in labels where tags < 2 { if add(label) { tags += 1 } }
    var identity: String?
    if let digest {
      var hex = digest.lowercased()
      if digest.range(of: #"^[a-fA-F0-9]{64}$"#, options: .regularExpression) == nil {
        let encoded = digest.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        hex = Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)).flatMap { $0.count == 32 ? $0.map { String(format: "%02x", $0) }.joined() : nil } ?? ""
      }
      if !hex.isEmpty { identity = String(hex.prefix(10)) }
    }
    var evidence = String(parts.joined(separator: "_").unicodeScalars.prefix(120))
    while evidence.utf8.count > 210 { evidence.removeLast() }
    let named = [evidence.isEmpty ? nil : evidence, identity].compactMap { $0 }.joined(separator: "_")
    var stem = named.isEmpty ? "Photo" : named
    if stem.range(of: #"^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$"#, options: [.regularExpression, .caseInsensitive]) != nil { stem = "Photo_" + stem }
    let ext = (original as NSString).pathExtension
    return stem + (ext.range(of: #"^[a-zA-Z0-9]{1,10}$"#, options: .regularExpression) == nil ? "" : "." + ext.lowercased())
  }
}
enum PhotoOrganizationError: LocalizedError {
  case invalid, capacity
  var errorDescription: String? {
    switch self {
    case .invalid: return "Use a filename without slashes or special file characters. Keep the original extension."
    case .capacity: return "This photo’s saved facts are full. Remove an unused fact before changing it."
    }
  }
}
