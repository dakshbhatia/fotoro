import Foundation
import ImageIO
import Observation
import Photos
import UIKit

struct SearchAnalysisProgress: Equatable, Sendable {
  var processed: Int
  var total: Int
}

@MainActor @Observable final class LocalSearchStore: NSObject, PHPhotoLibraryChangeObserver {
  typealias QueryExecutor = @Sendable (SearchIndex, String, SearchScope, String?, SearchResponse, UInt64) async throws -> SearchResponse
  private(set) var response = SearchResponse()
  private(set) var assets: [String: RecentPhoto] = [:]
  private(set) var indexing = false
  private(set) var searching = false
  private(set) var analysisProgress: SearchAnalysisProgress?
  private(set) var analysisRemaining = 0
  private var analysisUnavailableIDs: Set<String> = []
  var analysisUnavailable: Int { analysisUnavailableIDs.count }
  @ObservationIgnored private var analysisScope: PhotoAnalysisScope?
  @ObservationIgnored private var analysisCursor: PhotoAnalysisCursor?
  private(set) var libraryGeneration: UInt64 = 0
  private(set) var query = ""
  private(set) var peopleSelection = PeopleSearchSelection()
  private(set) var selectedPeopleNames: [String: String] = [:]
  var hasSearch: Bool { !SearchNormalization.text(query).isEmpty || !peopleSelection.isEmpty }
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
  @ObservationIgnored private var imageRequest: SearchImageRequest?
  @ObservationIgnored private var queryExecutor: QueryExecutor = { index, value, scope, accepted, previous, generation in
    let lexical = try await Task.detached(priority: .userInitiated) {
      try index.search(value, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
    }.value
    #if FOTORO_LOCAL_PREVIEW
      return lexical
    #else
    let phrase = NaturalDateQuery.parse(value).text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard accepted == nil, phrase.count >= 3, let vector = try? await PhotoSemanticProcessor.shared.textIfReady(phrase) else { return lexical }
    try Task.checkCancellation()
    return try await Task.detached(priority: .userInitiated) { try index.addingSemantic(vector, to: lexical) }.value
    #endif
  }

  static func defaultIndexRoot(in directory: URL) -> URL {
    #if FOTORO_LOCAL_PREVIEW
      directory.appendingPathComponent("FotoroLocalPreviewSearch", isDirectory: true)
    #else
      directory.appendingPathComponent("FotoroLocalSearch", isDirectory: true)
    #endif
  }
  @ObservationIgnored private(set) var root = LocalSearchStore.defaultIndexRoot(in: FileManager.default.urls(
    for: .applicationSupportDirectory, in: .userDomainMask)[0])
  override init() { super.init() }
  init(index: SearchIndex, queryExecutor: QueryExecutor? = nil) {
    self.index = index
    if let queryExecutor { self.queryExecutor = queryExecutor }
    ready = true
    super.init()
  }
  init(applicationSupportDirectory: URL) {
    self.root = Self.defaultIndexRoot(in: applicationSupportDirectory)
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
      self?.refresh(status: PHPhotoLibrary.authorizationStatus(for: .readWrite), retryFailedOCR: false)
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
    imageRequest?.cancel()
    imageRequest = nil
    indexing = false
    searching = false
    analysisProgress = nil
    analysisRemaining = 0; analysisScope = nil; analysisCursor = nil; analysisUnavailableIDs = []
  }
  func refresh(status: PHAuthorizationStatus, retryFailedOCR: Bool = true) {
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
    refreshTask = Task { await runRefresh(token: token, retryFailedOCR: retryFailedOCR) }
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
  private func runRefresh(token: UInt64, retryFailedOCR: Bool) async {
    #if !FOTORO_LOCAL_PREVIEW
    let diagnosticStarted = ProcessInfo.processInfo.systemUptime
    #endif
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
      #if !FOTORO_LOCAL_PREVIEW
      NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .metadata, outcome: .completed,
        elapsed: ProcessInfo.processInfo.systemUptime - diagnosticStarted,
        completed: scanned.records.count, trace: NativeDiagnosticTrace(.metadata), step: .scan))
      #endif
      completePermittedSnapshotRefresh(photos: scanned.photos)
      try onSnapshotReady?()
      await runScopedAnalysis(scope: PhotoAnalysisScope(query: query, people: peopleSelection), after: nil, retryFailed: retryFailedOCR, token: token, explicit: false)
    } catch is CancellationError {} catch {
      if token == work.generation { self.error = error.localizedDescription }
    }
    if token == work.generation { indexing = false; analysisProgress = nil }
  }
  private func analysisSourceCurrent(_ record: SearchRecord) -> Bool {
    guard ready, assets[record.id]?.sourceRevision == record.revision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let current = PHAsset.fetchAssets(withLocalIdentifiers: [record.id], options: nil).firstObject,
      !current.isHidden else { return false }
    return RecentPhoto.sourceRevision(current) == record.revision
  }
  private func analysisIsCurrent(_ scope: PhotoAnalysisScope, token: UInt64, explicit: Bool) -> Bool {
    ready && token == work.generation && (!explicit || (query == scope.query && peopleSelection == scope.scope.people))
  }
  var canAnalyzeMetadataMatches: Bool { ready }
  func analyzeMetadataMatches(nextBatch: Bool = false) {
    guard ready, index != nil, !indexing else { return }
    let priorScope = analysisScope
    let priorCursor = analysisCursor
    let priorUnavailable = analysisUnavailableIDs
    pause()
    let scope = nextBatch && priorScope?.query == query && priorScope?.scope.people == peopleSelection
      ? priorScope! : PhotoAnalysisScope(query: query, people: peopleSelection, includesOlder: hasSearch)
    let after = nextBatch && priorScope == scope ? priorCursor : nil
    analysisScope = scope
    if after != nil { analysisUnavailableIDs = priorUnavailable }
    let token = work.generation
    indexing = true
    updateQuery(query)
    refreshTask = Task {
      await runScopedAnalysis(scope: scope, after: after, retryFailed: true, token: token, explicit: true)
      if token == work.generation { indexing = false; analysisProgress = nil }
    }
  }
  private func runScopedAnalysis(scope: PhotoAnalysisScope, after: PhotoAnalysisCursor?, retryFailed retryFailedOCR: Bool,
    token: UInt64, explicit: Bool) async {
    guard let localIndex = index else { return }
    analysisScope = scope
    do {
      let batch = try await Task.detached(priority: .utility) {
        (try localIndex.pendingMetadataAnalysisCount(scope: scope, after: after, retryFailed: retryFailedOCR),
          try localIndex.pendingMetadataAnalysisRecords(scope: scope, after: after, retryFailed: retryFailedOCR))
      }.value
      let pending = batch.1
      guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { return }
      analysisRemaining = max(0, batch.0 - pending.count)
      guard !pending.isEmpty else { return }
      var attempted: [SearchRecord] = []
      #if !FOTORO_LOCAL_PREVIEW
      let diagnosticTrace = NativeDiagnosticTrace(.search)
      let diagnosticStarted = ProcessInfo.processInfo.systemUptime
      NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .search, outcome: .started,
        pending: batch.0, trace: diagnosticTrace, step: .analysis))
      #endif
      defer {
        if analysisIsCurrent(scope, token: token, explicit: explicit) {
          analysisRemaining += pending.count - attempted.count
          if let last = attempted.last { analysisCursor = PhotoAnalysisCursor(last) }
          for record in attempted {
            guard let current = try? localIndex.record(record.id), current.revision == record.revision else { continue }
            var incomplete = current.ocrStatus != .complete || current.visualStatus != .complete
            #if !FOTORO_LOCAL_PREVIEW
            incomplete = incomplete || ((try? localIndex.needsSemantic(photoID: record.id, revision: record.revision)) ?? true)
            #endif
            if incomplete { analysisUnavailableIDs.insert(record.id) }
            else { analysisUnavailableIDs.remove(record.id) }
          }
        }
        #if !FOTORO_LOCAL_PREVIEW
        let cancelled = Task.isCancelled || !analysisIsCurrent(scope, token: token, explicit: explicit) || attempted.count < pending.count
        let incomplete = attempted.filter { analysisUnavailableIDs.contains($0.id) }.count
        NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .search, outcome: cancelled ? .cancelled : .completed,
          elapsed: ProcessInfo.processInfo.systemUptime - diagnosticStarted,
          completed: cancelled ? nil : max(0, attempted.count - incomplete), pending: max(0, batch.0 - attempted.count) + incomplete,
          attempted: attempted.count, trace: diagnosticTrace, step: .analysis,
          reason: cancelled ? .contextChanged : (incomplete > 0 ? .sourceUnavailable : nil)))
        #endif
      }
      #if !FOTORO_LOCAL_PREVIEW
        let semanticPreparation = Task { try? await PhotoSemanticProcessor.shared.prepare() }
      #endif
      analysisProgress = pending.isEmpty ? nil : SearchAnalysisProgress(processed: 0, total: pending.count)
      for record in pending {
        try Task.checkCancellation()
        guard analysisIsCurrent(scope, token: token, explicit: explicit), let photo = assets[record.id], analysisSourceCurrent(record) else { break }
        let preview = await loadPreview(photo.asset)
        try Task.checkCancellation()
        guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record),
          RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        else { break }
        let needsOCR = record.ocrStatus == .pending || record.ocrStatus == .unavailable
          || retryFailedOCR && record.ocrStatus == .failed
        let needsVisual = record.visualStatus == .pending || record.visualStatus == .unavailable
          || retryFailedOCR && record.visualStatus == .failed
        if needsVisual {
          var result: SearchVisualResult?
          var state: SearchVisualStatus = .unavailable
          if let preview {
            do { result = try await processor.classify(preview); state = .complete }
            catch is CancellationError { throw CancellationError() }
            catch {
              #if targetEnvironment(simulator)
                state = VisionTextProcessor.isUnsupportedSimulatorClassifier(error, isSimulator: true)
                  ? .unavailable : .failed
              #else
                state = .failed
              #endif
            }
          }
          guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
          let visualResult = result
          let visualState = state
          _ = try await Task.detached {
            try localIndex.applyVisual(visualResult, status: visualState, photoID: record.id,
              revision: record.revision, generation: token)
          }.value
          guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
          updateQuery(query)
        }
        if needsOCR {
          var result: SearchOCRResult?
          var state: SearchOCRStatus = .unavailable
          if let preview {
            do { result = try await processor.recognize(preview); state = .complete }
            catch is CancellationError { throw CancellationError() }
            catch { state = .failed }
          }
          guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
          // Both writes verify the revision and permitted generation inside the transaction.
          let ocrResult = result
          let ocrState = state
          _ = try await Task.detached {
            try localIndex.applyOCR(ocrResult, status: ocrState, photoID: record.id,
              revision: record.revision, generation: token)
          }.value
        }
        guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
        if let current = try localIndex.record(record.id), current.revision == record.revision {
          try onRecordChanged?(current, false)
        }
        attempted.append(record)
        analysisProgress?.processed += 1
        updateQuery(query)
      }
      #if !FOTORO_LOCAL_PREVIEW
      await semanticPreparation.value
      try Task.checkCancellation()
      guard analysisIsCurrent(scope, token: token, explicit: explicit) else { return }
      if await PhotoSemanticProcessor.shared.ready {
        let remaining = try attempted.filter { try localIndex.needsSemantic(photoID: $0.id, revision: $0.revision) }
        for record in remaining {
          try Task.checkCancellation()
          guard analysisIsCurrent(scope, token: token, explicit: explicit), let photo = assets[record.id], analysisSourceCurrent(record),
            RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else { break }
          guard let preview = await loadPreview(photo.asset) else { continue }
          try Task.checkCancellation()
          guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record) else { break }
          if let vector = try? await PhotoSemanticProcessor.shared.image(preview) {
            guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
            _ = try await Task.detached {
              try localIndex.applySemantic(vector, photoID: record.id, revision: record.revision, generation: token)
            }.value
            guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
            updateQuery(query)
          }
          await Task.yield()
        }
      }
      #endif
    } catch is CancellationError {} catch {
      if token == work.generation { self.error = error.localizedDescription }
    }
  }
  private struct Scan: @unchecked Sendable {
    var photos: [RecentPhoto]
    var records: [SearchRecord]
  }
  private nonisolated static func scan() -> Scan {
    let options = PHFetchOptions()
    #if FOTORO_LOCAL_PREVIEW
    options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    #else
    options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
    #endif
    options.includeHiddenAssets = false
    options.includeAllBurstAssets = true
    #if compiler(>=6.4)
      if #available(iOS 27, *) { options.prefetchAssetExtendedMetadata = true }
    #endif
    let fetched = PHAsset.fetchAssets(with: options)
    var photos: [RecentPhoto] = []
    var records: [SearchRecord] = []
    fetched.enumerateObjects { asset, _, _ in
      #if FOTORO_LOCAL_PREVIEW
        let searchableMedia = asset.mediaType == .image
      #else
        let searchableMedia = asset.mediaType == .image || asset.mediaType == .video
      #endif
      guard
        LocalSearchPhotosPolicy.includes(
          image: searchableMedia, hidden: asset.isHidden, capturedAt: asset.creationDate,
          authorized: true)
      else { return }
      let photo = RecentPhoto(asset: asset)
      photos.append(photo)
      var r = SearchRecord(id: asset.localIdentifier)
      r.revision = RecentPhoto.sourceRevision(asset)
      r.capturedAt = asset.creationDate
      r.favorite = asset.isFavorite
      r.burstID = asset.burstIdentifier
      r.captureMetadata = photo.captureMetadata
      #if compiler(>=6.4)
        if #available(iOS 27, *) {
          let extended = asset.extendedMetadata
          r.filename = extended.originalFilename ?? ""
          r.captions = extended.caption.map { [$0] } ?? []
          r.keywords = extended.keywords
        }
      #endif
      if r.filename.isEmpty {
        r.filename = PHAssetResource.assetResources(for: asset)
          .first(where: { $0.type == .photo || $0.type == .video })?.originalFilename ?? ""
      }
      if photo.isScreenshot { r.facts.append("screenshot") }
      if photo.isLivePhoto { r.facts.append("live photo") }
      if asset.mediaType == .video { r.facts.append("video") }
      if let location = photo.location { r.facts += ["location gps", location] }
      records.append(r)
    }
    return Scan(photos: photos, records: records)
  }
  func recordCaptureMetadata(_ metadata: PhotoCaptureMetadata, for photo: RecentPhoto) throws {
    guard ready, let index, assets[photo.id]?.sourceRevision == photo.sourceRevision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [photo.id], options: nil).firstObject,
      !asset.isHidden, RecentPhoto.sourceRevision(asset) == photo.sourceRevision else { throw CancellationError() }
    try index.applyCaptureMetadata(metadata, photoID: photo.id, revision: photo.sourceRevision, generation: work.generation)
    updateQuery(query)
  }
  private func loadPreview(_ asset: PHAsset) async -> SearchPreview? {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = false
    options.deliveryMode = .highQualityFormat
    options.resizeMode = .exact
    options.version = .current
    let request = SearchImageRequest(manager: images)
    imageRequest = request
    let preview = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        request.start(continuation)
        let id = images.requestImage(for: asset, targetSize: CGSize(width: 1600, height: 1600),
          contentMode: .aspectFit, options: options) { image, info in
          guard (info?[PHImageResultIsDegradedKey] as? Bool) != true else { return }
          guard (info?[PHImageCancelledKey] as? Bool) != true, let image, let cg = image.cgImage else {
            request.complete(nil)
            return
          }
          request.complete(SearchPreview(image: cg, orientation: Self.orientation(image.imageOrientation)))
        }
        request.setID(id)
      }
    } onCancel: { request.cancel() }
    if imageRequest === request { imageRequest = nil }
    return preview
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
    queryGeneration &+= 1
    queryTask?.cancel()
    searching = false
    analysisProgress = nil
    assets = [:]
    response = SearchResponse()
    displayedID = nil
  }
  func completePermittedSnapshotRefresh(photos: [RecentPhoto]) {
    ready = true
    assets = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
    updateQuery(query)
  }
  // Uses the same ranking and accepted meaning without recording a new choice or query history.
  func consumerResults(_ value: String) async throws -> [SearchHit] {
    guard ready, let index else { return [] }
    let token = work.generation
    let library = libraryGeneration
    let queryToken = queryGeneration
    let previous = response
    let accepted = acceptedMeaningID
    let scope = SearchScope(people: peopleSelection)
    let next = try await queryExecutor(index, value, scope, accepted, previous, queryToken)
    try Task.checkCancellation()
    guard ready, token == work.generation, library == libraryGeneration else { return [] }
    guard queryToken == queryGeneration else { throw CancellationError() }
    return next.results.compactMap { hit in
      let current = ([hit.id] + hit.children).filter { (try? consumerRecord($0)) != nil }
      guard let first = current.first else { return nil }
      var permitted = hit
      permitted.id = first
      permitted.children = Array(current.dropFirst())
      return permitted
    }
  }
  func consumerRecord(_ id: String) throws -> SearchRecord? {
    guard ready, let record = try index?.record(id) else { return nil }
    #if !FOTORO_LOCAL_PREVIEW
    if !peopleSelection.isEmpty {
      guard canEditPeoplePhoto(id, revision: record.revision),
        peopleSelection.matches(Set(PhotoPeopleFacts.read(record.facts, enforceWireLimits: false).map(\.p))) else { return nil }
    }
    #endif
    return record
  }
  func updateQuery(_ value: String) {
    let normalized = SearchNormalization.text(value)
    let changed = normalized != SearchNormalization.text(query)
    if changed, ready, indexing { pause() }
    if changed { analysisRemaining = 0; analysisScope = nil; analysisCursor = nil; analysisUnavailableIDs = [] }
    query = value
    queryGeneration &+= 1
    queryTask?.cancel()
    let generation = queryGeneration
    var previous = response.meaning == nil ? (priorPermittedResponse ?? response) : response
    if let displayedID, let at = previous.results.firstIndex(where: { $0.id == displayedID }) {
      previous.results.insert(previous.results.remove(at: at), at: 0)
    }
    if normalized.isEmpty && peopleSelection.isEmpty {
      acceptedMeaningID = nil
      displayedID = nil
      sessionID = UUID().uuidString
      priorPermittedResponse = nil
      response = SearchResponse()
      searching = false
      return
    }
    if changed {
      // Retain tie evidence privately; a previous query must never look like the current answer.
      priorPermittedResponse = previous.meaning == nil ? nil : previous
      response = SearchResponse()
      displayedID = nil
      error = nil
    }
    guard ready, let index else { searching = false; return }
    searching = true
    let accepted = acceptedMeaningID
    let execute = queryExecutor
    let scope = SearchScope(people: peopleSelection)
    queryTask = Task {
      do {
        let next = try await execute(index, value, scope, accepted, previous, generation)
        guard generation == queryGeneration, !Task.isCancelled else { return }
        if accepted != nil, next.meaning?.id != accepted { acceptedMeaningID = nil }
        response = next
        displayedID = next.leading?.id
        priorPermittedResponse = nil
        searching = false
        #if !FOTORO_LOCAL_PREVIEW
        NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .search, outcome: .completed,
          completed: next.results.count, trace: NativeDiagnosticTrace(.search), step: .catalog))
        #endif
      } catch {
        guard generation == queryGeneration, !Task.isCancelled else { return }
        searching = false
        if !(error is CancellationError) { self.error = error.localizedDescription }
      }
    }
  }
  var hasCurrentResponse: Bool {
    response.generation != 0 && SearchNormalization.text(response.query) == SearchNormalization.text(query)
      && response.scope.people == peopleSelection
  }
  func setPeopleSelection(_ selection: PeopleSearchSelection, names: [String: String] = [:]) {
    guard selection != peopleSelection else {
      if !names.isEmpty { selectedPeopleNames = names.filter { selection.personIDs.contains($0.key) } }
      return
    }
    if ready, indexing { pause() }
    analysisRemaining = 0; analysisScope = nil; analysisCursor = nil; analysisUnavailableIDs = []
    peopleSelection = selection
    selectedPeopleNames = names.filter { selection.personIDs.contains($0.key) }
    acceptedMeaningID = nil
    displayedID = nil
    priorPermittedResponse = nil
    response = SearchResponse()
    sessionID = UUID().uuidString
    updateQuery(query)
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
      try index.acceptMeaning(meaning.id, scope: response.scope, sessionID: sessionID, now: Date())
      acceptedMeaningID = meaning.id
      updateQuery(query)
    } catch { self.error = error.localizedDescription }
  }
  func confirm(_ photoID: String, meaningID: String? = nil) {
    guard let index, let meaning = meaningID ?? response.meaning?.id else { return }
    do { try index.confirmUse(meaning, photoID: photoID, scope: response.scope, sessionID: sessionID, now: Date()) } catch
    { self.error = error.localizedDescription }
  }
  func pin(_ photoID: String) {
    guard let index, let meaning = response.meaning else { return }
    do {
      try index.pinRepresentative(meaning.id, photoID: photoID, scope: response.scope)
      updateQuery(query)
    } catch { self.error = error.localizedDescription }
  }
  func clearSyncedAnnotations() {
    do { try index?.clearSyncedAnnotations(); updateQuery(query) }
    catch { self.error = error.localizedDescription }
  }
  func record(_ photoID: String) throws -> SearchRecord? { try index?.record(photoID) }
  #if !FOTORO_LOCAL_PREVIEW
  func applyAnnotations(_ value: PhotoAnnotationsV1, source: BackupSource, accountId: String) throws {
    guard ready, let revision = source.sourceRevision,
      try index?.applyAnnotations(value, photoID: source.id, revision: revision, accountId: accountId) == true else { return }
    updateQuery(query)
  }
  #endif
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

// PhotoKit can finish or cancel around the same time as a refresh. Resume the
// continuation exactly once, including cancellation before request registration.
private final class SearchImageRequest: @unchecked Sendable {
  private let manager: PHImageManager
  private let lock = NSLock()
  private var id: PHImageRequestID?
  private var continuation: CheckedContinuation<SearchPreview?, Never>?
  private var finished = false
  private var cancelled = false
  init(manager: PHImageManager) { self.manager = manager }
  func start(_ continuation: CheckedContinuation<SearchPreview?, Never>) {
    lock.lock()
    let alreadyFinished = finished
    if !alreadyFinished { self.continuation = continuation }
    lock.unlock()
    if alreadyFinished { continuation.resume(returning: nil) }
  }
  func setID(_ id: PHImageRequestID) {
    lock.lock()
    self.id = id
    let shouldCancel = cancelled
    lock.unlock()
    if shouldCancel { manager.cancelImageRequest(id) }
  }
  func complete(_ preview: SearchPreview?) {
    lock.lock()
    guard !finished else { lock.unlock(); return }
    finished = true
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: preview)
  }
  func cancel() {
    lock.lock()
    cancelled = true
    let requestID = id
    let pending = finished ? nil : continuation
    finished = true
    continuation = nil
    lock.unlock()
    pending?.resume(returning: nil)
    if let requestID { manager.cancelImageRequest(requestID) }
  }
}

#if !FOTORO_LOCAL_PREVIEW
extension LocalSearchStore {
  var peopleSnapshotReady: Bool { ready }
  var peopleIndex: SearchIndex? { index }
  func canEditPeoplePhoto(_ id: String, revision: String) -> Bool {
    guard ready, assets[id]?.sourceRevision == revision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let current = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
      !current.isHidden else { return false }
    return RecentPhoto.sourceRevision(current) == revision
  }
  func publishPeopleEdit(_ record: SearchRecord) throws {
    guard canEditPeoplePhoto(record.id, revision: record.revision) else { throw FotoroError("This photo changed or is no longer permitted.") }
    try onRecordChanged?(record, true)
    updateQuery(query)
  }
  func analyzePeople(_ record: SearchRecord, scanScope: PhotoPeopleScanScope? = nil) async throws -> Bool {
    let token = work.generation
    guard scanScope.map({ $0.query == query && $0.scope.people == peopleSelection }) ?? true,
      canEditPeoplePhoto(record.id, revision: record.revision),
      let index, let photo = assets[record.id], photo.sourceRevision == record.revision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else { return false }
    // An independent PhotoKit request cannot displace metadata/OCR indexing's cancellation handle.
    let manager = PHImageManager()
    let request = SearchImageRequest(manager: manager)
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = false; options.deliveryMode = .highQualityFormat; options.resizeMode = .exact; options.version = .current
    let preview = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        request.start(continuation)
        let id = manager.requestImage(for: photo.asset, targetSize: CGSize(width: 1600, height: 1600), contentMode: .aspectFit, options: options) { image, info in
          guard (info?[PHImageResultIsDegradedKey] as? Bool) != true else { return }
          guard (info?[PHImageCancelledKey] as? Bool) != true, let image, let cg = image.cgImage else { request.complete(nil); return }
          request.complete(SearchPreview(image: cg, orientation: Self.orientation(image.imageOrientation)))
        }
        request.setID(id)
      }
    } onCancel: { request.cancel() }
    guard let preview, token == work.generation,
      scanScope.map({ $0.query == query && $0.scope.people == peopleSelection }) ?? true,
      canEditPeoplePhoto(record.id, revision: record.revision) else { return false }
    let faces = try await PhotoFaceProcessor.shared.analyze(preview)
    try Task.checkCancellation()
    guard token == work.generation, scanScope.map({ $0.query == query && $0.scope.people == peopleSelection }) ?? true,
      assets[record.id]?.sourceRevision == record.revision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let current = PHAsset.fetchAssets(withLocalIdentifiers: [record.id], options: nil).firstObject,
      !current.isHidden, RecentPhoto.sourceRevision(current) == record.revision else { return false }
    let worker = Task.detached(priority: .utility) {
      try index.applyPeople(faces, photoID: record.id, revision: record.revision, generation: token)
    }
    return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
  }
}
#endif
