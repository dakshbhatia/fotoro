import Foundation

struct AutomaticPhotoPickCandidate: Sendable {
  var id: String
  var sourceRevision: String
  var capturedAt: Date?
  var width: Int
  var height: Int
  var favorite: Bool
  var isScreenshot: Bool
  // Eligibility may be corrected in Fotoro. Source validation still checks
  // the unmodified PhotoKit subtype observed when this candidate was created.
  var photoKitScreenshot: Bool? = nil
  var sourceScreenshot: Bool { photoKitScreenshot ?? isScreenshot }
}
struct AutomaticPhotoPickSignals: Sendable {
  var hash: UInt64
  var luminance: Double
  var contrast: Double
  var sharpness: Double
  var color: [Double]
  var aesthetics: Double? = nil
  var faceQuality: Double? = nil
  var utility = false
}
struct AutomaticPhotoPickRecommendations: Sendable {
  var ids: Set<String> = []
  var reasons: [String: [String]] = [:]
  var groupCount = 0
  var duplicateCount = 0
  var unassessed = 0
}
enum AutomaticPhotoPickPolicy {
  static let processor = "moment-highlights-v4"
  enum MeasurementError: Error { case unavailable }
  static func analyzePixels(width: Int, height: Int, rgba: [UInt8]) throws
    -> AutomaticPhotoPickSignals
  {
    guard width > 0, height > 0, width <= 65536, height <= 65536 / width else {
      throw MeasurementError.unavailable
    }
    let count = width * height
    guard rgba.count == count * 4 else { throw MeasurementError.unavailable }
    var gray = [Float](repeating: 0, count: count)
    var color = [Double](repeating: 0, count: 3)
    var mean = 0.0
    var variance = 0.0
    for index in 0..<count {
      let offset = index * 4
      let alpha = Double(rgba[offset + 3]) / 255
      let red = Double(rgba[offset]) * alpha + 255 * (1 - alpha)
      let green = Double(rgba[offset + 1]) * alpha + 255 * (1 - alpha)
      let blue = Double(rgba[offset + 2]) * alpha + 255 * (1 - alpha)
      color[0] += red
      color[1] += green
      color[2] += blue
      let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      gray[index] = Float(luminance)
      let delta = luminance - mean
      mean += delta / Double(index + 1)
      variance += delta * (luminance - mean)
    }
    var detail = 0.0
    var measured = 0
    if width >= 3, height >= 3 {
      for y in 1..<(height - 1) {
        for x in 1..<(width - 1) {
          let index = y * width + x
          let laplacian =
            4 * Double(gray[index]) - Double(gray[index - 1])
            - Double(gray[index + 1]) - Double(gray[index - width]) - Double(gray[index + width])
          detail += laplacian * laplacian
          measured += 1
        }
      }
    }
    var hash: UInt64 = 0
    for y in 0..<8 {
      let row = Int((Double(y) * Double(height - 1) / 7).rounded()) * width
      for x in 0..<8 {
        let left = Int((Double(x) * Double(width - 1) / 8).rounded())
        let right = Int((Double(x + 1) * Double(width - 1) / 8).rounded())
        if gray[row + left] > gray[row + right] { hash |= UInt64(1) << (y * 8 + x) }
      }
    }
    return AutomaticPhotoPickSignals(
      hash: hash, luminance: mean / 255,
      contrast: sqrt(max(0, variance / Double(count))) / 255,
      sharpness: measured == 0 ? 0 : sqrt(detail / Double(measured)) / 1020,
      color: color.map { $0 / Double(count) })
  }
  static func recommend(
    _ candidates: [AutomaticPhotoPickCandidate], signals: [String: AutomaticPhotoPickSignals]
  ) -> AutomaticPhotoPickRecommendations {
    // Repeated identifiers retain their first tie position and their latest source metadata.
    var unique: [AutomaticPhotoPickCandidate] = []
    var positions: [String: Int] = [:]
    for photo in candidates {
      if let position = positions[photo.id] {
        unique[position] = photo
      } else {
        positions[photo.id] = unique.count
        unique.append(photo)
      }
    }
    var unassessed = 0
    var scored: [ScoredPhoto] = []
    for (order, photo) in unique.enumerated() {
      guard !photo.isScreenshot || photo.favorite else { continue }
      guard let signal = signals[photo.id], valid(signal) else {
        unassessed += 1
        continue
      }
      // Nearly uniform previews do not establish a useful suggested photo, regardless of color.
      guard signal.contrast >= 0.006, !signal.utility || photo.favorite else { continue }
      let time = photo.capturedAt?.timeIntervalSince1970
      scored.append(
        ScoredPhoto(
          photo: photo, signal: signal, order: order, time: time?.isFinite == true ? time : nil,
          score: (photo.favorite ? 2 : 0) + 0.45 * min(1, signal.sharpness * 6)
            + 0.2 * max(0, 1 - abs(signal.luminance - 0.5) * 2)
            + 0.15 * min(1, signal.contrast * 4)
            + 0.25 * (signal.aesthetics.map { ($0 + 1) / 2 } ?? 0)
            + 0.25 * (signal.faceQuality ?? 0)))
    }
    scored.sort { ($0.time ?? .infinity, $0.order) < ($1.time ?? .infinity, $1.order) }
    var groups: [Group] = []
    var recent: [Int] = []
    for candidate in scored {
      var match: Int?
      if let time = candidate.time {
        for index in recent.reversed() {
          let anchor = groups[index].anchor
          guard let anchorTime = anchor.time else { continue }
          if time - anchorTime > 30 { break }
          if similar(anchor, candidate) {
            match = index
            break
          }
        }
      }
      if let match {
        groups[match].count += 1
        if candidate.score > groups[match].representative.score {
          groups[match].representative = candidate
        }
      } else {
        groups.append(Group(anchor: candidate, representative: candidate, count: 1))
        if candidate.time != nil {
          recent.append(groups.count - 1)
          if recent.count > 24 { recent.removeFirst() }
        }
      }
    }
    // Two-hour capture windows match the existing Moments browser. Unknown dates
    // stay one unlabelled bucket; they never acquire an invented capture time.
    var moments: [[Int]] = []
    var start: Double?
    var day: Double?
    var unknown: [Int] = []
    for (index, group) in groups.enumerated() {
      guard let time = group.representative.time else { unknown.append(index); continue }
      let captureDay = floor(time / 86400)
      if let start, day == captureDay, time - start <= PhotoBrowsing.maximumMomentSpan {
        moments[moments.count - 1].append(index)
      } else { moments.append([index]); start = time; day = captureDay }
    }
    if !unknown.isEmpty { moments.append(unknown) }
    func better(_ a: Int, _ b: Int) -> Bool {
      let left = groups[a].representative, right = groups[b].representative
      return left.score == right.score ? left.order < right.order : left.score > right.score
    }
    var ids: Set<String> = []
    var reasons: [String: [String]] = [:]
    for moment in moments {
      let ranked = moment.sorted(by: better)
      // Small moments get a representative; larger ones have room for varied
      // views. Favorites survive the shortlist independently of this budget.
      let budget = min(6, max(1, Int(ceil(sqrt(Double(moment.count)) / 2))))
      let bestQuality = ranked.map { groups[$0].representative }.map { $0.score - ($0.photo.favorite ? 2 : 0) }.max() ?? 0
      var chosen: [Int] = []
      var suggestions = 0
      for index in ranked {
        let candidate = groups[index].representative
        let favorite = candidate.photo.favorite
        guard favorite || suggestions < budget && candidate.score >= bestQuality * 0.65 else { continue }
        if !favorite, chosen.contains(where: { similar(groups[$0].representative, candidate) }) { continue }
        chosen.append(index)
        if !favorite { suggestions += 1 }
      }
      for index in chosen {
        let group = groups[index], photo = group.representative.photo
        ids.insert(photo.id)
        var reason = [photo.favorite ? "Favorite" : "Moment highlight"]
        if group.count > 1 { reason.append("Representative of \(group.count) similar photos") }
        if moments.count > 1, group.representative.time != nil { reason.append("Variety across moments") }
        reasons[photo.id] = reason
      }
    }
    // Similarity chooses a representative, never overrides another explicit
    // favorite the owner expects in the suggested set.
    for candidate in scored where candidate.photo.favorite && !ids.contains(candidate.photo.id) {
      ids.insert(candidate.photo.id)
      reasons[candidate.photo.id] = ["Favorite"]
    }
    return AutomaticPhotoPickRecommendations(
      ids: ids, reasons: reasons, groupCount: groups.count,
      duplicateCount: scored.count - groups.count, unassessed: unassessed)
  }
  private struct ScoredPhoto {
    let photo: AutomaticPhotoPickCandidate
    let signal: AutomaticPhotoPickSignals
    let order: Int
    let time: Double?
    let score: Double
  }
  private struct Group {
    let anchor: ScoredPhoto
    var representative: ScoredPhoto
    var count: Int
  }
  private static func valid(_ signal: AutomaticPhotoPickSignals) -> Bool {
    (signal.aesthetics == nil || signal.aesthetics!.isFinite && (-1...1).contains(signal.aesthetics!))
      && (signal.faceQuality == nil || signal.faceQuality!.isFinite && (0...1).contains(signal.faceQuality!))
      && [signal.luminance, signal.contrast, signal.sharpness].allSatisfy {
      $0.isFinite && $0 >= 0 && $0 <= 1
    } && signal.color.count == 3
      && signal.color.allSatisfy {
        $0.isFinite && $0 >= 0 && $0 <= 255
      }
  }
  private static func similar(_ a: ScoredPhoto, _ b: ScoredPhoto) -> Bool {
    guard a.photo.width > 0, a.photo.height > 0, b.photo.width > 0, b.photo.height > 0 else {
      return false
    }
    let aspectA = Double(a.photo.width) / Double(a.photo.height)
    let aspectB = Double(b.photo.width) / Double(b.photo.height)
    guard abs(aspectA / aspectB - 1) <= 0.01,
      abs(a.signal.luminance - b.signal.luminance) <= 0.03,
      abs(a.signal.contrast - b.signal.contrast) <= 0.04,
      zip(a.signal.color, b.signal.color).allSatisfy({ abs($0 - $1) <= 8 })
    else { return false }
    return (a.signal.hash ^ b.signal.hash).nonzeroBitCount <= 2
  }
}

struct PhotoCleanupCandidate: Sendable {
  var id: String
  var digest: String
  var favorite: Bool
  var screenshot: Bool
  var eligible: Bool
}
struct PhotoCleanupRecommendations: Sendable {
  var reasons: [String: [String]] = [:]
  var unassessed = 0
}
enum PhotoCleanupPolicy {
  static func review(_ photos: [PhotoCleanupCandidate], signals: [String: AutomaticPhotoPickSignals]) -> PhotoCleanupRecommendations {
    let current = photos.filter(\.eligible)
    var keepers: [String: PhotoCleanupCandidate] = [:]
    for photo in current where !photo.digest.isEmpty {
      if keepers[photo.digest] == nil || photo.favorite && keepers[photo.digest]?.favorite != true {
        keepers[photo.digest] = photo
      }
    }
    var result = PhotoCleanupRecommendations()
    for photo in current {
      var why: [String] = []
      if !photo.digest.isEmpty && keepers[photo.digest]?.id != photo.id {
        why.append("Identical original · keep another copy")
      }
      if let signal = signals[photo.id], [signal.luminance, signal.contrast, signal.sharpness].allSatisfy({ $0.isFinite && (0...1).contains($0) }),
        signal.color.count == 3, signal.color.allSatisfy({ $0.isFinite && (0...255).contains($0) }) {
        if !photo.favorite && !photo.screenshot {
          if signal.luminance < 0.025 || signal.luminance > 0.985 { why.append("Possibly too dark or bright") }
          else if signal.contrast < 0.012 { why.append("Very little visible detail") }
          else if signal.sharpness < 0.008 && signal.contrast > 0.025 { why.append("Possibly blurry") }
        }
      } else { result.unassessed += 1 }
      if !why.isEmpty { result.reasons[photo.id] = why }
    }
    return result
  }
}

#if !FOTORO_LOCAL_PREVIEW
struct PhotoCleanupSourceIdentity: Sendable {
  var id: String
  var metadata: PhotoMetadataV1
  var manifest: PhotoManifestV1
  var transferState: String
  func matches(_ published: PhotoCleanupSourceIdentity?, account: String?) -> Bool {
    guard let published, let account else { return false }
    return published.id == id && published.manifest.photoId == id && published.manifest.ownerAccountId == account
      && ["committed", "saved"].contains(published.transferState)
      && published.metadata == metadata && published.manifest == manifest
  }
}
#endif
