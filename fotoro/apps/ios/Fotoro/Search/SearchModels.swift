import Foundation

enum SearchRelation: String, Codable, Sendable { case label, text, metadata, visual }
enum SearchOCRStatus: String, Codable, Sendable { case pending, complete, failed, unavailable }
enum SearchVisualStatus: String, Codable, Sendable { case pending, complete, failed, unavailable }
struct SearchVisualLabel: Codable, Equatable, Sendable {
  var label: String
  var identifier: String
  var confidence: Double
  var processor: String
}
struct SearchVisualResult: Sendable {
  var labels: [SearchVisualLabel]
  var processor: String
}
struct LocalSearchFields: Codable, Sendable {
  var labels: [String]
  var captions: [String]
  var keywords: [String]
  var facts: [String]
  var favorite: Bool
  var ocrText: String
  var ocrConfidence: Double
  var ocrStatus: SearchOCRStatus
}
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
  // Device-local image classification never replaces an owner's supplied labels.
  var visualLabels: [SearchVisualLabel] = []
  var visualStatus = SearchVisualStatus.pending
  var visualProcessor = SearchVisualPolicy.processor
  var previewAvailable = false
  var originalAvailable = true
  var burstID: String?
  var syncedAccountId: String?
  var beforeSync: LocalSearchFields?
}
extension SearchRecord {
  // Defaults on stored properties do not apply to synthesized Codable decoding.
  // Older indexes can therefore acquire visual fields without losing existing records.
  enum CodingKeys: String, CodingKey {
    case version, id, scope, revision, filename, capturedAt, favorite, currentMoment
    case labels, captions, keywords, facts, ocrText, ocrConfidence, ocrStatus, processor
    case visualLabels, visualStatus, visualProcessor, previewAvailable, originalAvailable
    case burstID, syncedAccountId, beforeSync
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    self.init(id: try values.decode(String.self, forKey: .id))
    version = try values.decodeIfPresent(Int.self, forKey: .version) ?? version
    scope = try values.decodeIfPresent(String.self, forKey: .scope) ?? scope
    revision = try values.decodeIfPresent(String.self, forKey: .revision) ?? revision
    filename = try values.decodeIfPresent(String.self, forKey: .filename) ?? filename
    capturedAt = try values.decodeIfPresent(Date.self, forKey: .capturedAt)
    favorite = try values.decodeIfPresent(Bool.self, forKey: .favorite) ?? favorite
    currentMoment = try values.decodeIfPresent(Bool.self, forKey: .currentMoment) ?? currentMoment
    labels = try values.decodeIfPresent([String].self, forKey: .labels) ?? labels
    captions = try values.decodeIfPresent([String].self, forKey: .captions) ?? captions
    keywords = try values.decodeIfPresent([String].self, forKey: .keywords) ?? keywords
    facts = try values.decodeIfPresent([String].self, forKey: .facts) ?? facts
    ocrText = try values.decodeIfPresent(String.self, forKey: .ocrText) ?? ocrText
    ocrConfidence = try values.decodeIfPresent(Double.self, forKey: .ocrConfidence) ?? ocrConfidence
    ocrStatus = try values.decodeIfPresent(SearchOCRStatus.self, forKey: .ocrStatus) ?? ocrStatus
    processor = try values.decodeIfPresent(String.self, forKey: .processor) ?? processor
    visualLabels = try values.decodeIfPresent([SearchVisualLabel].self, forKey: .visualLabels) ?? []
    visualStatus = try values.decodeIfPresent(SearchVisualStatus.self, forKey: .visualStatus) ?? .pending
    visualProcessor = try values.decodeIfPresent(String.self, forKey: .visualProcessor) ?? visualProcessor
    previewAvailable = try values.decodeIfPresent(Bool.self, forKey: .previewAvailable) ?? previewAvailable
    originalAvailable = try values.decodeIfPresent(Bool.self, forKey: .originalAvailable) ?? originalAvailable
    burstID = try values.decodeIfPresent(String.self, forKey: .burstID)
    syncedAccountId = try values.decodeIfPresent(String.self, forKey: .syncedAccountId)
    beforeSync = try values.decodeIfPresent(LocalSearchFields.self, forKey: .beforeSync)
  }
}

enum SearchVisualPolicy {
  static let processor = "vision-image-classification-r1-v1"
  static let minimumConfidence = 0.65
  static let maximumLabels = 6
  // Exact Vision identifiers only. No faces, identities, demographic traits, or
  // substring guesses (for example, hotdog and prairie_dog must not become dog).
  private static let categories: [String: String] = [
    "beach": "beach", "dog": "dog", "bulldog": "dog", "sheepdog": "dog",
    "bernese_mountain": "dog", "cat": "cat", "adult_cat": "cat", "bird": "bird",
    "hummingbird": "bird", "mountain": "mountain", "food": "food", "seafood": "food",
    "cake": "cake", "cake_regular": "cake", "birthday_cake": "cake", "wedding_cake": "cake",
    "flower": "flower", "flower_arrangement": "flower", "sunflower": "flower",
    "car": "car", "sportscar": "car", "boat": "boat", "rowboat": "boat", "sailboat": "boat",
    "houseboat": "boat", "speedboat": "boat", "snow": "snow", "forest": "forest",
    "tree": "tree", "palm_tree": "tree", "oak_tree": "tree", "maple_tree": "tree",
    "waterfall": "waterfall", "lake": "lake", "ocean": "ocean", "bicycle": "bicycle",
  ]
  static func labels(_ candidates: [(identifier: String, confidence: Double)]) -> [SearchVisualLabel] {
    var strongest: [String: SearchVisualLabel] = [:]
    for candidate in candidates {
      guard candidate.confidence.isFinite, candidate.confidence >= minimumConfidence,
        candidate.confidence <= 1, let label = categories[candidate.identifier]
      else { continue }
      let value = SearchVisualLabel(label: label, identifier: candidate.identifier,
        confidence: candidate.confidence, processor: processor)
      if let old = strongest[label], old.confidence > value.confidence
        || old.confidence == value.confidence && old.identifier < value.identifier { continue }
      strongest[label] = value
    }
    return Array(strongest.values.sorted {
      $0.confidence == $1.confidence ? $0.label < $1.label : $0.confidence > $1.confidence
    }.prefix(maximumLabels))
  }
  static func validated(_ values: [SearchVisualLabel], processor: String) -> [SearchVisualLabel] {
    guard processor == Self.processor else { return [] }
    return labels(values.filter {
      $0.processor == processor && categories[$0.identifier] == $0.label
    }.map { ($0.identifier, $0.confidence) })
  }
}
struct SearchScope: Equatable, Sendable {
  var source = "photos"
  var from: Date?
  var through: Date?
  var until: Date?
  var key: String {
    let base = "\(source)|\(from?.timeIntervalSince1970.description ?? "")|\(through?.timeIntervalSince1970.description ?? "")"
    return until.map { base + "|before:\($0.timeIntervalSince1970)" } ?? base
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
    case .visual: return "Inferred scene"
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
  var scope = SearchScope()
  var datePhrase: String?
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
