import Foundation
import Observation
import Photos
import UIKit

struct RecentPhotoFacts {
  var capturedAt: Date?
  var favorite: Bool
  var screenshot: Bool
  var livePhoto: Bool
  var location: String?
  var searchText: String {
    [
      capturedAt?.formatted(date: .complete, time: .omitted), favorite ? "favorite" : nil,
      screenshot ? "screenshot" : nil, livePhoto ? "live photo" : nil,
      location == nil ? nil : "location gps", location,
    ].compactMap { $0 }.joined(separator: " ")
  }
}

struct RecentPhoto: Identifiable {
  let asset: PHAsset
  var id: String { asset.localIdentifier }
  var sourceRevision: String { Self.sourceRevision(asset) }
  static func sourceRevision(_ asset: PHAsset) -> String {
    "\(asset.modificationDate?.timeIntervalSince1970 ?? 0)|\(asset.pixelWidth)x\(asset.pixelHeight)"
  }
  var capturedAt: Date? { asset.creationDate }
  var captureMetadata: PhotoCaptureMetadata { .photos(asset) }
  var isFavorite: Bool { asset.isFavorite }
  var isScreenshot: Bool { asset.mediaSubtypes.contains(.photoScreenshot) }
  var isLivePhoto: Bool { asset.mediaSubtypes.contains(.photoLive) }
  var isVideo: Bool { asset.mediaType == .video }
  var photoLocation: PhotoLocationV1? { PhotoLocationV1.photos(asset.location) }
  var location: String? { photoLocation?.coordinates }
  var searchText: String {
    RecentPhotoFacts(
      capturedAt: capturedAt, favorite: isFavorite, screenshot: isScreenshot,
      livePhoto: isLivePhoto, location: location
    ).searchText
  }
}

struct RecentPhotoSource: Hashable {
  let id: String
  let revision: String
  init(id: String, revision: String) { self.id = id; self.revision = revision }
  init(_ photo: RecentPhoto) { id = photo.id; revision = photo.sourceRevision }
}

struct PhotoBrowseContinuation: Hashable {
  let page: UUID
  let filter: PhotoBrowseFilter
  var dates: PhotoBrowseDateScope = .recent
  let isActive: Bool
}

struct RecentPhotosPresentationValidation {
  let viewerIsCurrent: Bool
  let selectedIDs: Set<String>
  let shareIsCurrent: Bool
}

enum RecentPhotosPolicy {
  static let browsePageSize = 200
  static let maximumPickCandidates = 500
  static func cutoff(now: Date, calendar: Calendar = .current) -> Date {
    calendar.date(byAdding: .day, value: -30, to: now)!
  }
  static func includes(_ date: Date?, now: Date, calendar: Calendar = .current) -> Bool {
    guard let date else { return false }
    return date >= cutoff(now: now, calendar: calendar) && date <= now
  }
  static func shouldLoadPage(_ index: Int, current: Int) -> Bool {
    abs(index - current) <= 1
  }
  static func adjacentPhotoID(_ ids: [String], current: String, forward: Bool) -> String? {
    guard let index = ids.firstIndex(of: current) else { return nil }
    let next = index + (forward ? 1 : -1)
    return ids.indices.contains(next) ? ids[next] : nil
  }
  static func canRead(_ status: PHAuthorizationStatus) -> Bool {
    status == .authorized || status == .limited
  }
  static func browseFetchOptions(dates: PhotoBrowseDateScope = .recent, now: Date = Date()) -> PHFetchOptions {
    let options = PHFetchOptions()
    #if FOTORO_LOCAL_PREVIEW
    options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    #else
    options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
      PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    #endif
    if dates == .recent, let media = options.predicate {
      options.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [media,
        NSPredicate(format: "creationDate >= %@ AND creationDate <= %@", cutoff(now: now) as NSDate, now as NSDate)])
    }
    options.includeHiddenAssets = false
    options.includeAllBurstAssets = true
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    return options
  }
  static func pickFetchOptions(now: Date) -> PHFetchOptions {
    let options = browseFetchOptions(dates: .all)
    options.predicate = NSPredicate(
      format: "mediaType == %d AND creationDate >= %@ AND creationDate <= %@",
      PHAssetMediaType.image.rawValue, cutoff(now: now) as NSDate, now as NSDate)
    options.fetchLimit = maximumPickCandidates
    return options
  }
}

@MainActor struct PhotoBrowseSource<Photo> {
  let count: Int
  private let read: (Range<Int>) -> [Photo]
  init(count: Int, read: @escaping (Range<Int>) -> [Photo]) {
    self.count = max(0, count)
    self.read = read
  }
  init(_ photos: [Photo]) {
    count = photos.count
    read = { Array(photos[$0]) }
  }
  func range(after offset: Int, limit: Int = RecentPhotosPolicy.browsePageSize) -> Range<Int> {
    let lower = min(count, max(0, offset))
    return lower..<(lower + min(count - lower, max(0, limit)))
  }
  func photos(in range: Range<Int>) -> [Photo] {
    guard !range.isEmpty, range.lowerBound >= 0, range.upperBound <= count else { return [] }
    return read(range)
  }
}

struct PhotoViewerZoom {
  private(set) var scale: CGFloat = 1
  private(set) var offset: CGSize = .zero
  private var settledScale: CGFloat = 1
  private var settledOffset: CGSize = .zero
  mutating func change(_ magnification: CGFloat) {
    scale = min(5, max(1, settledScale * magnification))
    if scale == 1 { offset = .zero; settledOffset = .zero }
  }
  mutating func settle(_ magnification: CGFloat) {
    change(magnification)
    settledScale = scale
  }
  mutating func toggle() {
    scale = scale == 1 ? 2 : 1
    settledScale = scale
    offset = .zero
    settledOffset = .zero
  }
  mutating func drag(_ translation: CGSize, viewport: CGSize) {
    offset = clamped(CGSize(width: settledOffset.width + translation.width,
      height: settledOffset.height + translation.height), viewport: viewport)
  }
  mutating func settleDrag(_ translation: CGSize, viewport: CGSize) {
    drag(translation, viewport: viewport)
    settledOffset = offset
  }
  mutating func constrain(to viewport: CGSize) {
    offset = clamped(offset, viewport: viewport)
    settledOffset = clamped(settledOffset, viewport: viewport)
  }
  private func clamped(_ value: CGSize, viewport: CGSize) -> CGSize {
    let horizontal = max(0, viewport.width * (scale - 1) / 2)
    let vertical = max(0, viewport.height * (scale - 1) / 2)
    return CGSize(width: min(horizontal, max(-horizontal, value.width)),
      height: min(vertical, max(-vertical, value.height)))
  }
  mutating func reset() {
    scale = 1
    settledScale = 1
    offset = .zero
    settledOffset = .zero
  }
}

struct PhotoPreviewProgress {
  private(set) var unavailable = false
  private(set) var receivedFinalImage = false
  private var finished = false
  mutating func receive(hasImage: Bool, degraded: Bool, cancelled: Bool = false, failed: Bool = false) -> Bool {
    guard !finished else { return false }
    if cancelled || failed { unavailable = true; finished = true; return false }
    if hasImage {
      unavailable = false
      receivedFinalImage = !degraded
      finished = !degraded
      return true
    }
    if !degraded { unavailable = true; finished = true }
    return false
  }
}

@MainActor @Observable final class RecentPhotosStore: NSObject, PHPhotoLibraryChangeObserver {
  private(set) var photos: [RecentPhoto] = []
  private(set) var recentPhotos: [RecentPhoto] = []
  private(set) var hasMorePhotos = false
  private(set) var browsePage = UUID()
  private(set) var browseDates = PhotoBrowseDateScope.recent
  private(set) var status = PHAuthorizationStatus.notDetermined
  private(set) var opened = false
  var error: String?
  var loading = false
  let picks: PhotoPickAnalyzer
  private(set) var picksSnapshot: PhotoPicksSnapshot?
  var pickedPhotos: [RecentPhoto] { recentPhotos.filter { picksSnapshot?.recommendations.ids.contains($0.id) == true } }
  var pickCandidates: [AutomaticPhotoPickCandidate] {
    recentPhotos.map { AutomaticPhotoPickCandidate(id: $0.id, sourceRevision: $0.sourceRevision, capturedAt: $0.capturedAt,
      width: $0.asset.pixelWidth, height: $0.asset.pixelHeight, favorite: $0.isFavorite, isScreenshot: $0.isScreenshot) }
  }
  @ObservationIgnored private var analysisTask: Task<Void, Never>?
  @ObservationIgnored private var settlingAnalysis: Task<Void, Never>?
  @ObservationIgnored private var analysisGeneration = UUID()
  @ObservationIgnored private var observing = false
  @ObservationIgnored private var analysisPermitted = true
  let images = PHCachingImageManager()
  @ObservationIgnored private let authorization: () -> PHAuthorizationStatus
  @ObservationIgnored private let requestAccess: () async -> PHAuthorizationStatus
  @ObservationIgnored private let readPhotos: (@MainActor (Date) -> [RecentPhoto])?
  @ObservationIgnored private let readBrowseSource: (@MainActor (Date) -> PhotoBrowseSource<RecentPhoto>)?
  @ObservationIgnored private let readRecentPhotos: @MainActor (Date) -> [RecentPhoto]
  @ObservationIgnored private var browseSource: PhotoBrowseSource<RecentPhoto>?
  @ObservationIgnored private var browseOffset = 0
  @ObservationIgnored private var browseGeneration = UUID()
  @ObservationIgnored private let validatesBrowsingSources: Bool
  @ObservationIgnored private let sourceRevisions: @MainActor ([String]) -> [String: String]
  init(
    authorization: @escaping () -> PHAuthorizationStatus = { PHPhotoLibrary.authorizationStatus(for: .readWrite) },
    requestAccess: @escaping () async -> PHAuthorizationStatus = { await PHPhotoLibrary.requestAuthorization(for: .readWrite) },
    readPhotos: (@MainActor (Date) -> [RecentPhoto])? = nil,
    readBrowseSource: (@MainActor (Date) -> PhotoBrowseSource<RecentPhoto>)? = nil,
    readRecentPhotos: @escaping @MainActor (Date) -> [RecentPhoto] = RecentPhotosStore.fetchRecentPhotos,
    sourceRevisions: (@MainActor ([String]) -> [String: String])? = nil,
    picks: PhotoPickAnalyzer? = nil
  ) {
    self.authorization = authorization
    self.requestAccess = requestAccess
    self.readPhotos = readPhotos
    self.readBrowseSource = readBrowseSource
    self.readRecentPhotos = readRecentPhotos
    self.sourceRevisions = sourceRevisions ?? RecentPhotosStore.currentSourceRevisions
    validatesBrowsingSources = readPhotos == nil || sourceRevisions != nil
    self.picks = picks ?? PhotoPickAnalyzer()
    super.init()
  }
  deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
  nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
    Task { @MainActor [weak self] in self?.refresh() }
  }
  func pauseAnalysis() {
    analysisPermitted = false
    cancelAnalysis()
  }
  private func cancelAnalysis() {
    analysisGeneration = UUID()
    analysisTask?.cancel()
    settlingAnalysis = analysisTask ?? settlingAnalysis
    analysisTask = nil
    picks.invalidate()
  }
  func restartAnalysis() { cancelAnalysis(); picksSnapshot = nil; if RecentPhotosPolicy.canRead(status) { beginAnalysis() } }
  private func beginAnalysis() {
    guard analysisPermitted, analysisTask == nil else { return }
    let candidates = pickCandidates
    let token = UUID()
    analysisGeneration = token
    let previous = settlingAnalysis
    analysisTask = Task { [weak self] in
      guard let self else { return }
      defer { if analysisGeneration == token { analysisTask = nil } }
      do {
        await previous?.value
        try Task.checkCancellation()
        guard analysisGeneration == token else { throw CancellationError() }
        let result = try await picks.snapshot(candidates, valid: { [weak self] in
          guard let self else { return false }
          return analysisGeneration == token && RecentPhotosPolicy.canRead(authorization())
        })
        try Task.checkCancellation()
        guard analysisGeneration == token, result.matches(pickCandidates) else { throw CancellationError() }
        picksSnapshot = result
      } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
  }
  func completedPicks() async throws -> PhotoPicksSnapshot {
    guard RecentPhotosPolicy.canRead(authorization()) else { throw FotoroError("Allow Photos access to find your picks.") }
    if let result = picksSnapshot, result.recommendations.unassessed == 0,
      result.matches(pickCandidates), PhotoPickAnalyzer.isCurrent(result.candidates) { return result }
    if analysisTask == nil { beginAnalysis() }
    while let task = analysisTask {
      let generation = analysisGeneration
      await task.value
      try Task.checkCancellation()
      // A Photos refresh can replace the task while this caller is waiting.
      // Finish its successor before validating the current snapshot.
      if analysisGeneration == generation { break }
    }
    try Task.checkCancellation()
    guard let result = picksSnapshot, result.matches(pickCandidates), PhotoPickAnalyzer.isCurrent(result.candidates) else {
      throw FotoroError("Your picks aren't ready. Open Photos and try again after analysis finishes.")
    }
    return result
  }
  func restoreAccess(now: Date = Date()) {
    analysisPermitted = true
    status = authorization()
    opened = status != .notDetermined
    if opened { refresh(now: now) }
  }

  func validatePresentation(viewer: [RecentPhotoSource], selection: [RecentPhotoSource],
    share: [RecentPhotoSource]) -> RecentPhotosPresentationValidation {
    guard RecentPhotosPolicy.canRead(authorization()) else {
      return RecentPhotosPresentationValidation(viewerIsCurrent: false, selectedIDs: [], shareIsCurrent: false)
    }
    let sources = viewer + selection + share
    let current = sources.isEmpty ? [:] : sourceRevisions(Array(Set(sources.map(\.id))))
    guard RecentPhotosPolicy.canRead(authorization()) else {
      return RecentPhotosPresentationValidation(viewerIsCurrent: false, selectedIDs: [], shareIsCurrent: false)
    }
    func available(_ source: RecentPhotoSource) -> Bool { current[source.id] == source.revision }
    return RecentPhotosPresentationValidation(viewerIsCurrent: viewer.allSatisfy(available),
      selectedIDs: Set(selection.filter(available).map(\.id)), shareIsCurrent: share.allSatisfy(available))
  }
  private static func currentSourceRevisions(_ ids: [String]) -> [String: String] {
    var result: [String: String] = [:]
    PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil).enumerateObjects { asset, _, _ in
      #if FOTORO_LOCAL_PREVIEW
      let supported = asset.mediaType == .image
      #else
      let supported = CameraMedia.supportedAsset(asset)
      #endif
      if !asset.isHidden, supported { result[asset.localIdentifier] = RecentPhoto.sourceRevision(asset) }
    }
    return result
  }

  func open() async {
    analysisPermitted = true
    status = authorization()
    if status == .notDetermined { status = await requestAccess() }
    opened = true
    guard RecentPhotosPolicy.canRead(status) else {
      pauseAnalysis()
      picksSnapshot = nil
      photos = []
      recentPhotos = []
      browseSource = nil
      browseOffset = 0
      hasMorePhotos = false
      return
    }
    refresh()
  }
  func setBrowseDates(_ dates: PhotoBrowseDateScope, now: Date = Date()) {
    guard dates != browseDates else { return }
    browseDates = dates
    browseOffset = 0
    refresh(now: now)
  }
  func refresh(now: Date = Date()) {
    guard opened else { return }
    browseGeneration = UUID()
    browsePage = UUID()
    status = authorization()
    images.stopCachingImagesForAllAssets()
    guard RecentPhotosPolicy.canRead(status) else {
      pauseAnalysis()
      picksSnapshot = nil
      photos = []
      recentPhotos = []
      browseSource = nil
      browseOffset = 0
      hasMorePhotos = false
      return
    }
    if !observing { PHPhotoLibrary.shared().register(self); observing = true }
    let loaded = max(RecentPhotosPolicy.browsePageSize, browseOffset)
    let supplied = readPhotos?(now)
    let source = supplied.map(PhotoBrowseSource.init) ?? readBrowseSource?(now) ?? Self.fetchBrowseSource(now: now, dates: browseDates)
    let recent = supplied ?? readRecentPhotos(now)
    let nextOffset = min(source.count, loaded)
    let first = source.photos(in: 0..<nextOffset)
    let candidates = Array(recent.filter { RecentPhotosPolicy.includes($0.capturedAt, now: now) }
      .prefix(RecentPhotosPolicy.maximumPickCandidates))
    let ids = Array(Set((first + candidates).map(\.id)))
    let revisions = !validatesBrowsingSources || ids.isEmpty ? [:] : sourceRevisions(ids)
    guard authorization() == status, RecentPhotosPolicy.canRead(status) else {
      status = authorization()
      pauseAnalysis(); picksSnapshot = nil
      photos = []; recentPhotos = []; browseSource = nil; browseOffset = 0; hasMorePhotos = false
      return
    }
    browseSource = source
    browseOffset = nextOffset
    photos = first.filter { !validatesBrowsingSources || revisions[$0.id] == $0.sourceRevision }
    hasMorePhotos = browseOffset < source.count
    recentPhotos = candidates.filter { !validatesBrowsingSources || revisions[$0.id] == $0.sourceRevision }
    if let snapshot = picksSnapshot, snapshot.recommendations.unassessed == 0,
      snapshot.matches(pickCandidates) { return }
    cancelAnalysis()
    picksSnapshot = nil
    beginAnalysis()
  }
  func loadMorePhotos() {
    guard opened, hasMorePhotos, let source = browseSource else { return }
    guard authorization() == status, RecentPhotosPolicy.canRead(status) else { refresh(); return }
    let range = source.range(after: browseOffset)
    let next = source.photos(in: range)
    guard authorization() == status, RecentPhotosPolicy.canRead(status) else { refresh(); return }
    let revisions = !validatesBrowsingSources || next.isEmpty ? [:] : sourceRevisions(next.map(\.id))
    guard authorization() == status, RecentPhotosPolicy.canRead(status) else { refresh(); return }
    let existing = Set(photos.map(\.id))
    photos.append(contentsOf: next.filter {
      !existing.contains($0.id) && (!validatesBrowsingSources || revisions[$0.id] == $0.sourceRevision)
    })
    browseOffset = range.upperBound
    hasMorePhotos = browseOffset < source.count
    browsePage = UUID()
  }
  func loadMorePhotos(matching filter: PhotoBrowseFilter, whileActive: @MainActor () -> Bool = { true }) async {
    let generation = browseGeneration
    while hasMorePhotos {
      // Sparse filters may need several metadata pages. Yield between them so
      // changing filters, leaving Photos, or permission withdrawal can stop work.
      await Task.yield()
      guard !Task.isCancelled, whileActive(), generation == browseGeneration else { return }
      let offset = browseOffset
      let count = photos.count
      loadMorePhotos()
      guard generation == browseGeneration, browseOffset > offset else { return }
      if photos.dropFirst(count).contains(where: { photo in
        filter.includes(RecentPhotoFacts(capturedAt: photo.capturedAt, favorite: photo.isFavorite,
          screenshot: photo.isScreenshot, livePhoto: photo.isLivePhoto, location: photo.location))
      }) { return }
    }
  }
  private static func fetchBrowseSource(now: Date, dates: PhotoBrowseDateScope) -> PhotoBrowseSource<RecentPhoto> {
    let options = RecentPhotosPolicy.browseFetchOptions(dates: dates, now: now)
    let result = PHAsset.fetchAssets(with: options)
    return PhotoBrowseSource(count: result.count) { range in
      range.map { RecentPhoto(asset: result.object(at: $0)) }
    }
  }
  private static func fetchRecentPhotos(now: Date) -> [RecentPhoto] {
    let options = RecentPhotosPolicy.pickFetchOptions(now: now)
    let result = PHAsset.fetchAssets(with: options)
    var values: [RecentPhoto] = []
    result.enumerateObjects { asset, _, _ in values.append(RecentPhoto(asset: asset)) }
    return values
  }
  func cache(_ assets: [PHAsset], start: Bool) {
    let target = CGSize(width: 360, height: 360)
    if start {
      images.startCachingImages(
        for: assets, targetSize: target, contentMode: .aspectFill, options: nil)
    } else {
      images.stopCachingImages(
        for: assets, targetSize: target, contentMode: .aspectFill, options: nil)
    }
  }
  func shareOriginals(_ photos: [RecentPhoto]) async throws -> [URL] {
    func checkAccess(_ photo: RecentPhoto) throws -> PHAsset {
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
        let current = PHAsset.fetchAssets(withLocalIdentifiers: [photo.id], options: nil).firstObject,
        !current.isHidden, [.image, .video].contains(current.mediaType),
        RecentPhoto.sourceRevision(current) == photo.sourceRevision else {
        throw FotoroError("This photo is no longer available. Choose it again from Photos.")
      }
      return current
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    do {
      var urls: [URL] = []
      for photo in photos {
        try Task.checkCancellation()
        let current = try checkAccess(photo)
        #if FOTORO_LOCAL_PREVIEW
        guard let resource = PHAssetResource.assetResources(for: current).first(where: { $0.type == .photo })
        else { throw FotoroError("The still original is unavailable in Photos.") }
        let resources = [resource]
        #else
        let resources = try CameraMedia.originalResources(for: current, requireSupportedType: false)
        #endif
        guard Set(resources.map(\.originalFilename)).count == resources.count,
          resources.allSatisfy({ RecentOriginalFilename.isSafe($0.originalFilename) }) else {
          throw FotoroError("The original filenames are unavailable. Choose another photo.")
        }
        let folder = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(
          at: folder, withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.complete])
        for resource in resources {
          try Task.checkCancellation()
          _ = try checkAccess(photo)
          let url = folder.appendingPathComponent(resource.originalFilename)
          let options = PHAssetResourceRequestOptions()
          options.isNetworkAccessAllowed = true
          try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) {
              error in
              if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
          }
          try Task.checkCancellation()
          _ = try checkAccess(photo)
          try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
          urls.append(url)
        }
      }
      return urls
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}

enum RecentOriginalFilename {
  static func isSafe(_ name: String) -> Bool {
    !["", ".", ".."].contains(name) && !name.contains("/") && !name.contains("\\")
      && name.rangeOfCharacter(from: .controlCharacters) == nil
  }
}

enum RecentShareExports {
  static func remove(_ urls: [URL]) {
    let temporary = FileManager.default.temporaryDirectory.standardizedFileURL
    for directory in Set(urls.map { $0.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL }) {
      guard UUID(uuidString: directory.lastPathComponent) != nil,
        directory.deletingLastPathComponent().path == temporary.path else { continue }
      try? FileManager.default.removeItem(at: directory)
    }
  }
}
