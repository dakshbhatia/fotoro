import Foundation
import ImageIO
import Observation
import NukeUI
import SwiftUI

enum NativeTripPickScope {
  static let limit = 200
  static func items(_ items: [NativeAlbumItem]) -> [NativeAlbumItem] {
    Array(NativeAlbumSearch.groups(items).map(\.representative).filter {
      $0.photo.metadata.mediaType.hasPrefix("image/") || $0.photo.metadata.mediaType == CameraMedia.liveType
    }.prefix(limit))
  }
  static func candidate(_ item: NativeAlbumItem, width: Int = 0, height: Int = 0) -> AutomaticPhotoPickCandidate {
    let metadata = item.photo.metadata
    return AutomaticPhotoPickCandidate(id: item.id, sourceRevision: item.signedManifest.signature,
      capturedAt: ["photos", "exif"].contains(metadata.dateSource) ? Wire.parseDate(metadata.sourceDate) : nil,
      width: width, height: height, favorite: false, isScreenshot: false)
  }
}

private struct NativeTripPickMeasurement: Sendable {
  let signals: AutomaticPhotoPickSignals
  let width: Int
  let height: Int
  nonisolated static func read(_ url: URL) throws -> Self? {
    try Task.checkCancellation()
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 256,
      ] as CFDictionary), let signals = try PhotoPickAnalyzer.measure(image) else { return nil }
    try Task.checkCancellation()
    return Self(signals: signals, width: image.width, height: image.height)
  }
}

@MainActor @Observable private final class NativeTripPickReview {
  private(set) var running = false
  private(set) var completed = 0
  private(set) var result: AutomaticPhotoPickRecommendations?
  private(set) var source: [SignedPayloadV1] = []
  private(set) var error: String?
  private(set) var previews: [String: URL] = [:]
  @ObservationIgnored private var token = UUID()
  @ObservationIgnored private var cache: [String: NativeTripPickMeasurement] = [:]
  @ObservationIgnored private var cacheAccess: PhotoAccountAccess?
  @ObservationIgnored private var cacheDefinition: SignedPayloadV1?
  func clear() { token = UUID(); running = false; completed = 0; result = nil; source = []; error = nil; cache = [:]; previews = [:]; cacheAccess = nil; cacheDefinition = nil }
  func run(_ items: [NativeAlbumItem], model: NativeAlbumService) async {
    guard let access = model.currentOpenedPhotoAccess, let definition = model.opened?.overview.definition else { clear(); return }
    token = UUID(); result = nil; error = nil; completed = 0
    if cacheAccess != access || cacheDefinition != definition { cache = [:]; previews = [:] }
    cacheAccess = access; cacheDefinition = definition
    let keys = Set(items.map { $0.id + "|" + $0.signedManifest.signature })
    cache = cache.filter { keys.contains($0.key) }
    previews = previews.filter { keys.contains($0.key) }
    let attempt = token
    source = items.map(\.signedManifest); running = true
    var checkedGeneration: UInt64?
    func check() throws {
      try Task.checkCancellation()
      guard attempt == token, model.currentOpenedPhotoAccess == access, model.opened?.overview.definition == definition else { throw CancellationError() }
      if checkedGeneration != model.itemsGeneration {
        let current = Dictionary(model.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard items.allSatisfy({ chosen in
          guard let latest = current[chosen.id] else { return false }
          return latest.entry == chosen.entry && latest.signedManifest == chosen.signedManifest && latest.photo.metadata == chosen.photo.metadata
        }) else { throw CancellationError() }
        checkedGeneration = model.itemsGeneration
      }
    }
    defer { if attempt == token { running = false } }
    do {
      try check(); try await model.checkOpenedAccess(); try check()
      var candidates: [AutomaticPhotoPickCandidate] = [], signals: [String: AutomaticPhotoPickSignals] = [:]
      for item in items {
        try check()
        let key = item.id + "|" + item.signedManifest.signature
        var measurement = cache[key]
        if measurement == nil {
          // Missing thumbnails remain unassessed; never fetch an original.
          if let rep = item.photo.manifest.representations.first(where: { $0.binding.kind == "thumbnail" }),
            rep.ciphertextBytes <= 4 * 1024 * 1024, let url = try? await model.thumbnail(item, preservingTransientFailure: true) {
            try check(); previews[key] = url
            let worker = Task.detached(priority: .utility) { try NativeTripPickMeasurement.read(url) }
            measurement = try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
            try check()
            if let measurement { cache[key] = measurement }
          }
        }
        candidates.append(NativeTripPickScope.candidate(item, width: measurement?.width ?? 0, height: measurement?.height ?? 0))
        if let measurement { signals[item.id] = measurement.signals }
        completed += 1
        await Task.yield()
      }
      try await model.checkOpenedAccess(); try check()
      let measuredCandidates = candidates, measuredSignals = signals
      let worker = Task.detached(priority: .utility) { AutomaticPhotoPickPolicy.recommend(measuredCandidates, signals: measuredSignals) }
      let recommendations = await worker.value
      try check(); result = recommendations
    } catch is CancellationError {
      if attempt == token { clear() }
    } catch {
      if attempt == token { result = nil; self.error = "Best shots couldn't finish. Try again." }
    }
  }
  func matches(access: PhotoAccountAccess?, definition: SignedPayloadV1?) -> Bool {
    access != nil && cacheAccess == access && cacheDefinition == definition
  }
}

struct NativeTripPicks: View {
  let model: NativeAlbumService
  private let candidates: [NativeAlbumItem]
  private let source: [SignedPayloadV1]
  let hasMore: Bool
  let open: (NativeAlbumItem) -> Void
  @Binding var reviewing: Bool
  @State private var review = NativeTripPickReview()
  @State private var retry = UUID()
  @Environment(\.scenePhase) private var scenePhase
  init(model: NativeAlbumService, items: [NativeAlbumItem], hasMore: Bool, reviewing: Binding<Bool>, open: @escaping (NativeAlbumItem) -> Void) {
    self.model = model; self.hasMore = hasMore; self._reviewing = reviewing; self.open = open
    candidates = NativeTripPickScope.items(items); source = candidates.map(\.signedManifest)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if reviewing, scenePhase == .active, model.currentOpenedPhotoAccess != nil {
        HStack {
          Text("Best shots").font(.headline)
          Spacer()
          Button("Close") { reviewing = false; review.clear() }
            .frame(minHeight: 44).accessibilityLabel("Close best shots").accessibilityIdentifier("albums.picks.close")
        }
        Text(hasMore ? "Up to \(NativeTripPickScope.limit) loaded photos; more available." : "Up to \(NativeTripPickScope.limit) photos.")
          .font(.caption).foregroundStyle(.secondary)
        if review.source == source, review.matches(access: model.currentOpenedPhotoAccess, definition: model.opened?.overview.definition) {
          if review.running { ProgressView("Reviewing \(review.completed) of \(candidates.count) photos…") }
          if let error = review.error { Text(error).font(.caption); Button("Try again") { retry = UUID() } }
          if let result = review.result {
            Text("\(result.ids.count) suggested photos\(result.unassessed > 0 ? " · \(result.unassessed) previews unavailable" : "")")
              .font(.subheadline)
            ForEach(candidates.filter { result.ids.contains($0.id) }) { item in
              Button { open(item) } label: {
                HStack(spacing: 12) {
                  LazyImage(url: review.previews[item.id + "|" + item.signedManifest.signature]) { state in
                    if let image = state.image { image.resizable().scaledToFill() }
                    else { Rectangle().fill(.quaternary) }
                  }.frame(width: 60, height: 60).clipped().accessibilityHidden(true)
                  VStack(alignment: .leading, spacing: 4) {
                    Text(item.photo.metadata.filename).lineLimit(1)
                    Text(result.reasons[item.id, default: []].joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                  }
                }
              }.buttonStyle(.bordered)
            }
          }
        }
      }
    }
    .task(id: NativeTripPickTaskKey(source: reviewing && scenePhase == .active ? source : [],
      access: model.currentOpenedPhotoAccess, definition: model.opened?.overview.definition, retry: retry)) {
      guard reviewing, scenePhase == .active else { review.clear(); return }
      await review.run(candidates, model: model)
    }
    .onDisappear { reviewing = false; review.clear() }
  }
}

private struct NativeTripPickTaskKey: Equatable {
  let source: [SignedPayloadV1]
  let access: PhotoAccountAccess?
  let definition: SignedPayloadV1?
  let retry: UUID
}
