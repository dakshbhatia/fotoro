import Foundation
import ImageIO
import Observation
import Photos
import UIKit

@MainActor @Observable final class LocalSearchStore: NSObject, PHPhotoLibraryChangeObserver {
  private(set) var response = SearchResponse()
  private(set) var assets: [String: RecentPhoto] = [:]
  private(set) var indexing = false
  private(set) var libraryGeneration: UInt64 = 0
  private(set) var query = ""
  private(set) var acceptedMeaningID: String?
  private(set) var displayedID: String?
  var error: String?
  @ObservationIgnored var onRecordChanged: ((SearchRecord, Bool) throws -> Void)?
  @ObservationIgnored var onSnapshotReady: (() throws -> Void)?
  @ObservationIgnored private var index: SearchIndex?
  @ObservationIgnored private var opened = false
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var refreshTask: Task<Void, Never>?
  @ObservationIgnored private var queryTask: Task<Void, Never>?
  @ObservationIgnored private var work = SearchWorkFence()
  @ObservationIgnored private var queryGeneration: UInt64 = 0
  @ObservationIgnored private var priorPermittedResponse: SearchResponse?
  @ObservationIgnored private var sessionID = UUID().uuidString
  @ObservationIgnored private let images = PHImageManager()
  @ObservationIgnored private let processor = VisionTextProcessor()
  @ObservationIgnored private var imageRequest: PHImageRequestID?

  @ObservationIgnored private var root = FileManager.default.urls(
    for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(
      "FotoroLocalSearch", isDirectory: true)
  override init() { super.init() }
  init(index: SearchIndex) {
    self.index = index
    ready = true
    super.init()
  }
  init(root: URL) {
    self.root = root
    super.init()
  }
  func canEditLabels(_ photoID: String) -> Bool {
    ready && ((try? index?.record(photoID)) ?? nil) != nil
  }

  deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }

  func open(status: PHAuthorizationStatus) {
    if !opened {
      opened = true
      PHPhotoLibrary.shared().register(self)
    }
    refresh(status: status)
  }
  nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
    Task { @MainActor [weak self] in
      self?.refresh(status: PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }
  }
  func pause() {
    work.invalidate()
    queryGeneration &+= 1
    do { try index?.setWorkGeneration(work.generation) } catch {
      self.error = error.localizedDescription
    }
    refreshTask?.cancel()
    queryTask?.cancel()
    if let imageRequest { images.cancelImageRequest(imageRequest) }
    indexing = false
  }
  func refresh(status: PHAuthorizationStatus) {
    guard opened else { return }
    pause()
    let token = work.generation
    beginPermittedSnapshotRefresh()
    libraryGeneration &+= 1
    // Immediately remove public UI references before awaiting database work on withdrawal.
    guard RecentPhotosPolicy.canRead(status) else {
      assets = [:]
      response = SearchResponse()
      displayedID = nil
      acceptedMeaningID = nil
      priorPermittedResponse = nil
      indexing = true
      refreshTask = Task { await purgeDeniedRecords(token: token) }
      return
    }
    indexing = true
    refreshTask = Task { await runRefresh(token: token) }
  }
  func auditAuthorization(
    status: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
  ) {
    if opened {
      refresh(status: status)
    } else if !RecentPhotosPolicy.canRead(status) {
      pause()
      ready = false
      response = SearchResponse()
      assets = [:]
      displayedID = nil
      acceptedMeaningID = nil
      priorPermittedResponse = nil
      let token = work.generation
      indexing = true
      refreshTask = Task { await purgeDeniedRecords(token: token) }
    }
  }
  private func purgeDeniedRecords(token: UInt64) async {
    do {
      let localIndex: SearchIndex
      if let index {
        localIndex = index
      } else {
        let root = self.root
        guard
          FileManager.default.fileExists(atPath: root.appendingPathComponent("search.sqlite").path)
        else {
          indexing = false
          return
        }
        localIndex = try await Task.detached { try SearchIndex(root: root) }.value
        guard token == work.generation, !Task.isCancelled else { return }
        try localIndex.clearSyncedAnnotations()
        index = localIndex
        try localIndex.setWorkGeneration(token)
      }
      _ = try await Task.detached { try localIndex.replacePermitted([], generation: token) }.value
    } catch { if token == work.generation { self.error = error.localizedDescription } }
    if token == work.generation { indexing = false }
  }
  private func runRefresh(token: UInt64) async {
    do {
      let localIndex: SearchIndex
      if let index {
        localIndex = index
      } else {
        let root = self.root
        localIndex = try await Task.detached { try SearchIndex(root: root) }.value
        guard token == work.generation, !Task.isCancelled else { return }
        try localIndex.clearSyncedAnnotations()
        index = localIndex
        try localIndex.setWorkGeneration(token)
      }
      let scanned = await Task.detached(priority: .utility) { Self.scan() }.value
      guard token == work.generation, !Task.isCancelled,
        RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite))
      else { return }
      // DatabaseQueue serializes writes. The main-actor generation check fences the permitted snapshot.
      let applied = try await Task.detached {
        try localIndex.replacePermitted(scanned.records, generation: token)
      }.value
      guard applied, token == work.generation, !Task.isCancelled else { return }
      completePermittedSnapshotRefresh(photos: scanned.photos)
      try onSnapshotReady?()
      let pending = try await Task.detached { try localIndex.pendingRecords() }.value
      for record in pending {
        try Task.checkCancellation()
        guard token == work.generation, let photo = assets[record.id] else { break }
        let preview = await loadPreview(photo.asset)
        try Task.checkCancellation()
        guard token == work.generation, assets[record.id] != nil,
          RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        else { break }
        var result: SearchOCRResult? = nil
        var state: SearchOCRStatus = .unavailable
        if let preview {
          do {
            result = try await processor.recognize(preview)
            state = .complete
          } catch is CancellationError { throw CancellationError() } catch {
            result = nil
            state = .failed
          }
        } else {
          result = nil
          state = .unavailable
        }
        guard token == work.generation, !Task.isCancelled, assets[record.id] != nil else { break }
        // Revision is checked inside the write transaction; removed/edited records cannot be recreated.
        let ocrResult = result
        let ocrState = state
        _ = try await Task.detached {
          try localIndex.applyOCR(
            ocrResult, status: ocrState, photoID: record.id, revision: record.revision,
            generation: token)
        }.value
        guard token == work.generation, !Task.isCancelled else { break }
        if let current = try localIndex.record(record.id), current.revision == record.revision {
          try onRecordChanged?(current, false)
        }
        updateQuery(query)
      }
    } catch is CancellationError {} catch {
      if token == work.generation { self.error = error.localizedDescription }
    }
    if token == work.generation { indexing = false }
  }
  private struct Scan: @unchecked Sendable {
    var photos: [RecentPhoto]
    var records: [SearchRecord]
  }
  private nonisolated static func scan() -> Scan {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    options.includeHiddenAssets = false
    options.includeAllBurstAssets = true
    #if compiler(>=6.4)
      if #available(iOS 27, *) { options.prefetchAssetExtendedMetadata = true }
    #endif
    let fetched = PHAsset.fetchAssets(with: options)
    var photos: [RecentPhoto] = []
    var records: [SearchRecord] = []
    fetched.enumerateObjects { asset, _, _ in
      guard
        LocalSearchPhotosPolicy.includes(
          image: asset.mediaType == .image, hidden: asset.isHidden, capturedAt: asset.creationDate,
          authorized: true)
      else { return }
      let photo = RecentPhoto(asset: asset)
      photos.append(photo)
      var r = SearchRecord(id: asset.localIdentifier)
      r.revision = RecentPhoto.sourceRevision(asset)
      r.capturedAt = asset.creationDate
      r.favorite = asset.isFavorite
      r.burstID = asset.burstIdentifier
      r.filename =
        PHAssetResource.assetResources(for: asset).first(where: { $0.type == .photo })?
        .originalFilename ?? ""
      #if compiler(>=6.4)
        if #available(iOS 27, *) {
          let extended = asset.extendedMetadata
          r.filename = extended.originalFilename ?? r.filename
          r.captions = extended.caption.map { [$0] } ?? []
          r.keywords = extended.keywords
        }
      #endif
      if photo.isScreenshot { r.facts.append("screenshot") }
      if photo.isLivePhoto { r.facts.append("live photo") }
      if let location = photo.location { r.facts += ["location gps", location] }
      records.append(r)
    }
    return Scan(photos: photos, records: records)
  }
  private func loadPreview(_ asset: PHAsset) async -> SearchPreview? {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = false
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .exact
    options.version = .original
    return await withCheckedContinuation { continuation in
      imageRequest = images.requestImage(
        for: asset, targetSize: CGSize(width: 1600, height: 1600), contentMode: .aspectFit,
        options: options
      ) { image, info in
        let cancelled = (info?[PHImageCancelledKey] as? Bool) == true
        guard !cancelled, let image, let cg = image.cgImage else {
          continuation.resume(returning: nil)
          return
        }
        continuation.resume(
          returning: SearchPreview(image: cg, orientation: Self.orientation(image.imageOrientation))
        )
      }
    }
  }
  private nonisolated static func orientation(_ value: UIImage.Orientation)
    -> CGImagePropertyOrientation
  {
    switch value {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    case .upMirrored: return .upMirrored
    case .downMirrored: return .downMirrored
    case .leftMirrored: return .leftMirrored
    case .rightMirrored: return .rightMirrored
    @unknown default: return .up
    }
  }
  func beginPermittedSnapshotRefresh() {
    // Keep the prior tie choice private until the new index validates its permission and evidence.
    if response.meaning != nil {
      var prior = response
      if let displayedID, let at = prior.results.firstIndex(where: { $0.id == displayedID }) {
        prior.results.insert(prior.results.remove(at: at), at: 0)
      }
      priorPermittedResponse = prior
    }
    ready = false
    assets = [:]
    response = SearchResponse()
    displayedID = nil
  }
  func completePermittedSnapshotRefresh(photos: [RecentPhoto]) {
    ready = true
    assets = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
    updateQuery(query)
  }
  func updateQuery(_ value: String) {
    query = value
    queryGeneration &+= 1
    queryTask?.cancel()
    let generation = queryGeneration
    if SearchNormalization.text(value).isEmpty {
      acceptedMeaningID = nil
      displayedID = nil
      sessionID = UUID().uuidString
      priorPermittedResponse = nil
    }
    guard ready, let index else { return }
    var previous = response.meaning == nil ? (priorPermittedResponse ?? response) : response
    if let displayedID, let at = previous.results.firstIndex(where: { $0.id == displayedID }) {
      previous.results.insert(previous.results.remove(at: at), at: 0)
    }
    let accepted = acceptedMeaningID
    queryTask = Task {
      do {
        let next = try await Task.detached(priority: .userInitiated) {
          try index.search(
            value, acceptedMeaningID: accepted, previous: previous, generation: generation)
        }.value
        guard generation == queryGeneration, !Task.isCancelled else { return }
        if accepted != nil, next.meaning?.id != accepted { acceptedMeaningID = nil }
        response = next
        displayedID = next.leading?.id
        priorPermittedResponse = nil
      } catch { if generation == queryGeneration { self.error = error.localizedDescription } }
    }
  }
  var displayedHit: SearchHit? {
    response.results.first { $0.id == displayedID } ?? response.leading
  }
  var displayedPhoto: RecentPhoto? { displayedHit.flatMap { assets[$0.id] } }
  var matchingPhotos: [RecentPhoto] {
    response.results.flatMap { [$0.id] + $0.children }.compactMap { assets[$0] }
  }
  func move(_ delta: Int) {
    guard let id = displayedHit?.id, let at = response.results.firstIndex(where: { $0.id == id }),
      !response.results.isEmpty
    else { return }
    displayedID =
      response.results[(at + delta + response.results.count) % response.results.count].id
  }
  func accept(_ meaning: SearchMeaning) {
    guard let index else { return }
    do {
      try index.acceptMeaning(meaning.id, sessionID: sessionID, now: Date())
      acceptedMeaningID = meaning.id
      updateQuery(query)
    } catch { self.error = error.localizedDescription }
  }
  func confirm(_ photoID: String, meaningID: String? = nil) {
    guard let index, let meaning = meaningID ?? response.meaning?.id else { return }
    do { try index.confirmUse(meaning, photoID: photoID, sessionID: sessionID, now: Date()) } catch
    { self.error = error.localizedDescription }
  }
  func pin(_ photoID: String) {
    guard let index, let meaning = response.meaning else { return }
    do {
      try index.pinRepresentative(meaning.id, photoID: photoID)
      updateQuery(query)
    } catch { self.error = error.localizedDescription }
  }
  func clearSyncedAnnotations() {
    do { try index?.clearSyncedAnnotations(); updateQuery(query) }
    catch { self.error = error.localizedDescription }
  }
  func record(_ photoID: String) throws -> SearchRecord? { try index?.record(photoID) }
  func applyAnnotations(_ value: PhotoAnnotationsV1, source: BackupSource, accountId: String) throws {
    guard ready, let revision = source.sourceRevision,
      try index?.applyAnnotations(value, photoID: source.id, revision: revision, accountId: accountId) == true else { return }
    updateQuery(query)
  }
  func labels(_ photoID: String) -> [String] { (try? index?.record(photoID)?.labels) ?? [] }
  @discardableResult func setLabels(_ labels: [String], photoID: String) -> Bool {
    guard labels.count <= 64, labels.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 120 }) else {
      error = "Use up to 64 labels, each with up to 120 characters."
      return false
    }
    guard canEditLabels(photoID), let index else {
      error = "The local index is preparing this photo."
      return false
    }
    do {
      guard try index.setLabels(labels, photoID: photoID) else {
        error = "The photo is no longer permitted."
        return false
      }
      if let record = try index.record(photoID) { try onRecordChanged?(record, true) }
      updateQuery(query)
      return true
    } catch {
      self.error = error.localizedDescription
      return false
    }
  }
}
