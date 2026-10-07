import Foundation

struct PhotoPersonAssignment: Codable, Equatable, Sendable {
  var p: String
  var n: String
  var b: [Int]
  var valid: Bool {
    UUID(uuidString: p) != nil && !n.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && n.unicodeScalars.count <= 80 && !n.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
      && b.count == 4 && b.allSatisfy { (0...10000).contains($0) }
      && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= 10000 && b[1] + b[3] <= 10000
  }
}
enum PhotoPeopleFacts {
  static let sourcePrefix = "fotoro:people-source:v1:"
  static let personPrefix = "fotoro:person:v1:"
  static func isReserved(_ value: String) -> Bool { value.hasPrefix(sourcePrefix) || value.hasPrefix(personPrefix) }
  static func validDigest(_ value: String) -> Bool {
    value.range(of: #"^(?:[a-fA-F0-9]{64}|[A-Za-z0-9_-]{43})$"#, options: .regularExpression) != nil
  }
  static func read(_ facts: [String], originalSha256: String? = nil, enforceWireLimits: Bool = true) -> [PhotoPersonAssignment] {
    guard (!enforceWireLimits || facts.count <= 64), facts.allSatisfy({ $0.unicodeScalars.count <= 240 }) else { return [] }
    if let originalSha256 {
      guard validDigest(originalSha256), facts.filter({ $0.hasPrefix(sourcePrefix) }) == [sourcePrefix + originalSha256] else { return [] }
    }
    var result: [PhotoPersonAssignment] = []
    var boxes = Set<[Int]>()
    for fact in facts where fact.hasPrefix(personPrefix) {
      let json = String(fact.dropFirst(personPrefix.count))
      guard let bytes = json.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        Set(object.keys) == ["p", "n", "b"],
        let expression = try? NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"\s*:"#),
        expression.numberOfMatches(in: json, range: NSRange(json.startIndex..., in: json)) == 3,
        let item = try? JSONDecoder().decode(PhotoPersonAssignment.self, from: bytes), item.valid,
        boxes.insert(item.b).inserted else { return [] }
      result.append(item)
    }
    return result
  }
  static func replacing(_ facts: [String], with people: [PhotoPersonAssignment], originalSha256: String? = nil, enforceWireLimits: Bool = true) throws -> [String] {
    var result = facts.filter { !isReserved($0) }
    var boxes = Set<[Int]>()
    for person in people {
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      let encoded = personPrefix + String(decoding: try encoder.encode(person), as: UTF8.self)
      guard person.valid, boxes.insert(person.b).inserted, encoded.unicodeScalars.count <= 240 else {
        throw FotoroError("This person name exceeds the photo metadata capacity.")
      }
      result.append(encoded)
    }
    if let originalSha256, !people.isEmpty {
      guard validDigest(originalSha256) else { throw FotoroError("People require the original photo digest.") }
      result.append(sourcePrefix + originalSha256)
    }
    guard (!enforceWireLimits || result.count <= 64), result.allSatisfy({ $0.unicodeScalars.count <= 240 }) else {
      throw FotoroError("People exceed the photo metadata capacity. Existing facts are unchanged.")
    }
    return result
  }
}
