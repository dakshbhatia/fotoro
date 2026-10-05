import Foundation
import ImageIO
import Observation
import Photos
import UIKit
import Vision

struct PhotoPicksSnapshot: Sendable {
  let candidates: [AutomaticPhotoPickCandidate]
  let recommendations: AutomaticPhotoPickRecommendations
  func revision(for id: String) -> String? {
    candidates.first { $0.id == id && recommendations.ids.contains(id) }?.sourceRevision
  }
  func matches(_ current: [AutomaticPhotoPickCandidate]) -> Bool {
    candidates.map(Self.identity) == current.map(Self.identity)
  }
  private static func identity(_ value: AutomaticPhotoPickCandidate) -> String {
    "\(value.id)|\(value.sourceRevision)|\(value.capturedAt.map { String($0.timeIntervalSince1970) } ?? "nil")|\(value.width)x\(value.height)|\(value.favorite)|\(value.isScreenshot)"
  }
}

// Only previews enter this service. Original reads, account keys and uploads belong to explicit Sync.
@MainActor @Observable final class PhotoPickAnalyzer {
  typealias Preview = @MainActor (AutomaticPhotoPickCandidate) async throws -> AutomaticPhotoPickSignals?
  private(set) var completed = 0
  private(set) var total = 0
  private(set) var analyzing = false
  @ObservationIgnored private let preview: Preview
  @ObservationIgnored private let isCurrent: @MainActor ([AutomaticPhotoPickCandidate]) -> Bool
  @ObservationIgnored private var cache: [String: AutomaticPhotoPickSignals] = [:]
  @ObservationIgnored private var generation = UUID()
  init(preview: @escaping Preview = PhotoPickAnalyzer.preview,
       isCurrent: @escaping @MainActor ([AutomaticPhotoPickCandidate]) -> Bool = PhotoPickAnalyzer.isCurrent) {
    self.preview = preview
    self.isCurrent = isCurrent
  }
  func invalidate() { generation = UUID(); analyzing = false }
  func snapshot(_ candidates: [AutomaticPhotoPickCandidate], valid: @escaping @MainActor () -> Bool = { true }) async throws -> PhotoPicksSnapshot {
    var signals: [String: AutomaticPhotoPickSignals] = [:]
    #if !FOTORO_LOCAL_PREVIEW
      let started = ProcessInfo.processInfo.systemUptime
      var outcome = NativeDiagnosticOutcome.failed
      defer {
        NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .picks,
          outcome: outcome,
          elapsed: ProcessInfo.processInfo.systemUptime - started,
          completed: signals.count, pending: candidates.count - signals.count))
      }
    #endif
    do {
    let token = UUID()
    generation = token
    func check(_ sources: [AutomaticPhotoPickCandidate]) throws {
      try Task.checkCancellation()
      guard generation == token, valid(), isCurrent(sources) else { throw CancellationError() }
    }
    try check(candidates)
    analyzing = true
    defer { if generation == token { analyzing = false } }
    total = candidates.count
    completed = 0
    // Discard removed sources and old revisions; this cache has no disk or account persistence.
    let keys = Set(candidates.map { $0.id + "|" + $0.sourceRevision })
    cache = cache.filter { keys.contains($0.key) }
    for candidate in candidates {
      try check([candidate])
      if candidate.isScreenshot && !candidate.favorite {
        completed += 1
        await Task.yield()
        continue
      }
      let key = candidate.id + "|" + candidate.sourceRevision
      if let cached = cache[key] { signals[candidate.id] = cached }
      else if let value = try await preview(candidate) {
        try check([candidate])
        signals[candidate.id] = value
        cache[key] = value
      }
      try check([candidate])
      completed += 1
      await Task.yield()
    }
    try check(candidates)
    #if !FOTORO_LOCAL_PREVIEW
      outcome = .completed
    #endif
    return PhotoPicksSnapshot(candidates: candidates, recommendations: AutomaticPhotoPickPolicy.recommend(candidates, signals: signals))
    } catch {
      #if !FOTORO_LOCAL_PREVIEW
        outcome = .failure(for: error, taskCancelled: Task.isCancelled)
      #endif
      throw error
    }
  }
  static func isCurrent(_ candidates: [AutomaticPhotoPickCandidate]) -> Bool {
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else { return false }
    let result = PHAsset.fetchAssets(withLocalIdentifiers: candidates.map(\.id), options: nil)
    var current: [String: PHAsset] = [:]
    result.enumerateObjects { asset, _, _ in current[asset.localIdentifier] = asset }
    return candidates.allSatisfy { value in
      guard let asset = current[value.id] else { return false }
      return !asset.isHidden && asset.mediaType == .image && RecentPhoto.sourceRevision(asset) == value.sourceRevision
        && asset.creationDate == value.capturedAt
        && asset.isFavorite == value.favorite && asset.mediaSubtypes.contains(.photoScreenshot) == value.isScreenshot
    }
  }
  static func preview(_ candidate: AutomaticPhotoPickCandidate) async throws -> AutomaticPhotoPickSignals? {
    try Task.checkCancellation()
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [candidate.id], options: nil).firstObject,
      RecentPhoto.sourceRevision(asset) == candidate.sourceRevision else { throw CancellationError() }
    let manager = PHImageManager()
    let request = PickImageRequest(manager: manager)
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = false
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .exact
    let image: UIImage? = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        request.begin(continuation)
        let id = manager.requestImage(for: asset, targetSize: CGSize(width: 256, height: 256), contentMode: .aspectFit, options: options) { image, info in
          if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
          request.finish(image, cancelled: (info?[PHImageCancelledKey] as? Bool) == true)
        }
        request.setID(id)
      }
    } onCancel: { request.cancel() }
    try Task.checkCancellation()
    guard let image else { return nil }
    // UIImage.draw normalizes EXIF orientation before extracting opaque RGBA pixels.
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let upright = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: format).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
      image.draw(in: CGRect(x: 0, y: 0, width: 256, height: 256))
    }
    guard let cgImage = upright.cgImage else { return nil }
    let worker = Task.detached(priority: .utility) { try enrichedSignals(cgImage) }
    return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
  }
  nonisolated static func enrichedSignals(_ image: CGImage) throws -> AutomaticPhotoPickSignals? {
    try Task.checkCancellation()
    guard var signals = try measure(image) else { return nil }
    let aesthetics = VNCalculateImageAestheticsScoresRequest()
    let faces = VNDetectFaceCaptureQualityRequest()
    // Runtime/model availability never turns a good preview into a failed pick.
    if (try? VNImageRequestHandler(cgImage: image).perform([aesthetics])) != nil,
      let result = aesthetics.results?.first {
      signals.aesthetics = Double(result.overallScore)
      signals.utility = result.isUtility
    }
    try Task.checkCancellation()
    if (try? VNImageRequestHandler(cgImage: image).perform([faces])) != nil {
      let qualities = (faces.results ?? []).compactMap { $0.faceCaptureQuality.map(Double.init) }
      if !qualities.isEmpty { signals.faceQuality = qualities.min() }
    }
    try Task.checkCancellation()
    return signals
  }
  nonisolated static func measure(_ cgImage: CGImage) throws -> AutomaticPhotoPickSignals? {
    var pixels = [UInt8](repeating: 0, count: 64 * 64 * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(data: buffer.baseAddress, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 64 * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
      context.setFillColor(UIColor.white.cgColor)
      context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 64, height: 64))
      return true
    }
    guard drawn else { return nil }
    return try AutomaticPhotoPickPolicy.analyzePixels(width: 64, height: 64, rgba: pixels)
  }
}

@MainActor @Observable final class FindBestShotsReview {
  static let maximumCandidates = 200
  private(set) var snapshot: PhotoPicksSnapshot?
  private(set) var reviewing = false
  private(set) var showing = false
  private(set) var matchCount = 0
  private(set) var error: String?
  private(set) var analyzer: PhotoPickAnalyzer?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var selectionIsCurrent: @MainActor ([AutomaticPhotoPickCandidate]) -> Bool = { _ in false }

  func showAll() {
    generation = UUID()
    task?.cancel(); task = nil
    analyzer?.invalidate(); analyzer = nil
    snapshot = nil; reviewing = false; showing = false; error = nil
    selectionIsCurrent = { _ in false }
  }

  func selectionCandidates() -> [AutomaticPhotoPickCandidate] {
    guard showing, !reviewing, let snapshot else { return [] }
    let recommended = Set(snapshot.recommendations.ids)
    let candidates = snapshot.candidates.filter { recommended.contains($0.id) }
    if selectionIsCurrent(candidates) { return candidates }
    return candidates.filter { selectionIsCurrent([$0]) }
  }

  func start(_ candidates: [AutomaticPhotoPickCandidate], matchCount: Int,
    preview: @escaping PhotoPickAnalyzer.Preview = PhotoPickAnalyzer.preview,
    isCurrent: @escaping @MainActor ([AutomaticPhotoPickCandidate]) -> Bool = PhotoPickAnalyzer.isCurrent,
    valid: @escaping @MainActor () -> Bool = { true }) {
    guard !Task.isCancelled, valid() else { return }
    showAll()
    let token = UUID()
    generation = token
    var seen: Set<String> = []
    var bounded: [AutomaticPhotoPickCandidate] = []
    for candidate in candidates where seen.insert(candidate.id).inserted {
      bounded.append(candidate)
      if bounded.count == Self.maximumCandidates { break }
    }
    self.matchCount = max(matchCount, bounded.count)
    let analyzer = PhotoPickAnalyzer(preview: preview, isCurrent: isCurrent)
    self.analyzer = analyzer
    selectionIsCurrent = { sources in valid() && isCurrent(sources) }
    showing = true; reviewing = true
    task = Task { [weak self] in
      guard let self else { return }
      defer { if generation == token { reviewing = false; task = nil } }
      do {
        let result = try await analyzer.snapshot(bounded, valid: { [weak self] in
          self?.generation == token && valid()
        })
        try Task.checkCancellation()
        guard generation == token, valid(), isCurrent(bounded), result.matches(bounded) else {
          throw CancellationError()
        }
        snapshot = result
      } catch is CancellationError {
        if generation == token { showAll() }
      } catch {
        if generation == token { self.error = error.localizedDescription }
      }
    }
  }

  func completedReview() async { await task?.value }
}

struct FindBestShotsCachedPreview: Sendable {
  let url: URL
  let width: Int
  let height: Int
  let revision: String
  private static let maximumBytes = 2 * 1024 * 1024

  init?(url: URL, root: URL) {
    guard url.isFileURL,
      url.deletingLastPathComponent().resolvingSymlinksInPath() == root.appendingPathComponent("Media").resolvingSymlinksInPath(),
      url.resolvingSymlinksInPath().deletingLastPathComponent() == root.appendingPathComponent("Media").resolvingSymlinksInPath(),
      let revision = Self.fileRevision(url),
      let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = props[kCGImagePropertyPixelWidth] as? Int,
      let height = props[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 1600, height <= 1600,
      Self.fileRevision(url) == revision else { return nil }
    self.url = url
    let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
    self.width = (5...8).contains(orientation) ? height : width
    self.height = (5...8).contains(orientation) ? width : height
    self.revision = revision
  }

  var isCurrent: Bool { Self.fileRevision(url) == revision }
  func signals() async throws -> AutomaticPhotoPickSignals? {
    let worker = Task.detached(priority: .userInitiated) { () throws -> AutomaticPhotoPickSignals? in
      try Task.checkCancellation()
      guard isCurrent else { throw CancellationError() }
      let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
      guard bytes.count <= Self.maximumBytes, isCurrent else { throw CancellationError() }
      guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 256,
          kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else { return nil }
      try Task.checkCancellation()
      let signals = try PhotoPickAnalyzer.enrichedSignals(image)
      guard isCurrent else { throw CancellationError() }
      return signals
    }
    return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
  }
  private static func fileRevision(_ url: URL) -> String? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
      (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
      attrs[.type] as? FileAttributeType == .typeRegular,
      let size = attrs[.size] as? NSNumber, size.intValue > 0, size.intValue <= maximumBytes,
      let modified = attrs[.modificationDate] as? Date,
      let number = attrs[.systemFileNumber] as? NSNumber else { return nil }
    return "\(number)|\(size)|\(modified.timeIntervalSince1970)"
  }
}

// A late PhotoKit result and cancellation may race; exactly one continuation completes.
private final class PickImageRequest: @unchecked Sendable {
  private let lock = NSLock()
  private let manager: PHImageManager
  private var id: PHImageRequestID?
  private var continuation: CheckedContinuation<UIImage?, Error>?
  private var cancelled = false
  init(manager: PHImageManager) { self.manager = manager }
  func begin(_ value: CheckedContinuation<UIImage?, Error>) {
    lock.lock()
    if cancelled { lock.unlock(); value.resume(throwing: CancellationError()); return }
    continuation = value
    lock.unlock()
  }
  func setID(_ value: PHImageRequestID) {
    lock.lock(); id = value; let stop = cancelled; lock.unlock()
    if stop { manager.cancelImageRequest(value) }
  }
  func finish(_ value: UIImage?, cancelled: Bool) {
    lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
    if cancelled { pending?.resume(throwing: CancellationError()) } else { pending?.resume(returning: value) }
  }
  func cancel() {
    lock.lock(); cancelled = true; let current = id; let pending = continuation; continuation = nil; lock.unlock()
    if let current { manager.cancelImageRequest(current) }
    pending?.resume(throwing: CancellationError())
  }
}
