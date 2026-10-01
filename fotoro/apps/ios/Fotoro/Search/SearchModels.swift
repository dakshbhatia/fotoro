import Foundation

enum SearchRelation: String, Codable, Sendable { case label, text, metadata }
enum SearchOCRStatus: String, Codable, Sendable { case pending, complete, failed, unavailable }
struct SearchRecord: Codable, Sendable {
  var version = 1
  var id: String
  var scope = "photos"
  var revision = "1"
  var filename = ""
  var capturedAt: Date?
  var favorite = false
  var currentMoment = false
  var labels: [String] = []
  var captions: [String] = []
  var keywords: [String] = []
  var facts: [String] = []
  var ocrText = ""
  var ocrConfidence: Double = 0
  var ocrStatus = SearchOCRStatus.pending
  var processor = "vision-text-v1"
  var previewAvailable = false
  var originalAvailable = true
  var burstID: String?
}
struct SearchScope: Equatable, Sendable {
  var source = "photos"
  var from: Date?
  var through: Date?
  var key: String {
    "\(source)|\(from?.timeIntervalSince1970.description ?? "")|\(through?.timeIntervalSince1970.description ?? "")"
  }
}
struct SearchMeaning: Identifiable, Equatable, Sendable {
  var id: String
  var term: String
  var display: String
  var relation: SearchRelation
  var evidenceClass: Int
  var eligibleCount: Int
  var reason: String {
    switch relation {
    case .label: return "Supplied label"
    case .text: return "Text mention"
    case .metadata: return "Photos metadata"
    }
  }
}
struct SearchHit: Identifiable, Equatable, Sendable {
  var id: String
  var evidenceClass: Int
  var reason: String
  var pinned = false
  var previewAvailable = false
  var children: [String] = []
}
struct SearchResponse: Sendable {
  var query = ""
  var generation: UInt64 = 0
  var meaning: SearchMeaning?
  var meanings: [SearchMeaning] = []
  var results: [SearchHit] = []
  var leading: SearchHit? { results.first }
  var alternatives: [SearchMeaning] { Array(meanings.filter { $0.id != meaning?.id }.prefix(3)) }
  var indexed = 0
  var total = 0
  var availablePreviews = 0
}
struct SearchWorkFence: Sendable {
  private(set) var generation: UInt64 = 0
  mutating func invalidate() { generation &+= 1 }
  func accepts(_ token: UInt64, revision: String, current: SearchRecord?) -> Bool {
    token == generation && current?.revision == revision
  }
}
enum SearchNormalization {
  static func text(_ value: String) -> String {
    value.folding(
      options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX")
    )
    .lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
  }
}
