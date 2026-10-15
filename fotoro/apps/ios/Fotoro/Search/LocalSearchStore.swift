import Foundation
import ImageIO
import Observation
import Photos
import UIKit

struct SearchAnalysisProgress: Equatable, Sendable {
  var processed: Int
  var total: Int
}

enum SearchMetadataIntake {
  static func run<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
  ) async throws -> Value {
    let worker = Task.detached(priority: .utility, operation: operation)
    return try await withTaskCancellationHandler {
      let value = try await worker.value
      try Task.checkCancellation()
      return value
    } onCancel: { worker.cancel() }
  }

  static func forEach(count: Int, batchSize: Int = 100, _ visit: (Int) throws -> Void) async throws {
    try Task.checkCancellation()
    for start in stride(from: 0, to: count, by: max(1, batchSize)) {
      try Task.checkCancellation()
      for offset in start..<min(count, start + max(1, batchSize)) {
        try visit(offset)
      }
      await Task.yield()
    }
    try Task.checkCancellation()
  }
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
  @ObservationIgnored var onOrganizationChanged: ((SearchRecord, PhotoOrganizationChange) throws -> Void)?
  @ObservationIgnored var onRecordChanged: ((SearchRecord, Bool) throws -> Void)?
  @ObservationIgnored var onSnapshotReady: (() throws -> Void)?
  @ObservationIgnored private var index: SearchIndex?
  @ObservationIgnored private var opened = false
  @ObservationIgnored private var ready = false
  @ObservationIgnored private var refreshTask: Task<Void, Never>?
  @ObservationIgnored private var automaticAnalysisTask: Task<Void, Never>?
  @ObservationIgnored private var automaticAnalysisRestartRequested = false
  @ObservationIgnored private var automaticAnalysisID = UUID()
  @ObservationIgnored private var automaticAnalysisScope: PhotoAnalysisScope?
  @ObservationIgnored private var automaticAnalysisCursor: PhotoAnalysisCursor?
  @ObservationIgnored private var idleAnalysisTask: Task<Void, Never>?
  @ObservationIgnored private var automaticRetryTask: Task<Void, Never>?
  @ObservationIgnored private var automaticRetryID = UUID()
  @ObservationIgnored var analysisNow: () -> Date = { Date() }
  @ObservationIgnored private var automaticAnalysisActive = true
  @ObservationIgnored private var browseInteractionActive = false
  @ObservationIgnored private var automaticRetryFailed = false
  #if !FOTORO_LOCAL_PREVIEW
    private func prepareSemantic() async throws {
      #if DEBUG
        if let analysisSemanticPreparation { try await analysisSemanticPreparation(); return }
      #endif
      try await PhotoSemanticProcessor.shared.prepare()
    }
    @ObservationIgnored private var semanticPreparationTask: Task<Void, Never>?
    @ObservationIgnored private var semanticPreparationID = UUID()
    @ObservationIgnored private var semanticRetryRequested = false
  #endif
  #if DEBUG
    private(set) var automaticAnalysisWorkerStarts = 0
    @ObservationIgnored var automaticAnalysisBatchLimit = 500
    @ObservationIgnored var analysisPreview: (@MainActor (PHAsset) async -> SearchPreview?)?
    #if !FOTORO_LOCAL_PREVIEW
      @ObservationIgnored var analysisSemanticPreparation: (@MainActor () async throws -> Void)?
      @ObservationIgnored var analysisSemanticReady: (@MainActor () async -> Bool)?
      @ObservationIgnored var analysisSemanticImage: (@MainActor (SearchPreview) async throws -> [Float])?
    #endif
  #endif
  @ObservationIgnored private var queryTask: Task<Void, Never>?
  @ObservationIgnored private var work = SearchWorkFence()
  @ObservationIgnored private var queryGeneration: UInt64 = 0
  @ObservationIgnored private var priorPermittedResponse: SearchResponse?
  @ObservationIgnored private var sessionID = UUID().uuidString
  @ObservationIgnored private let images = PHImageManager()
  @ObservationIgnored private let processor = VisionTextProcessor()
  @ObservationIgnored private var imageRequest: SearchImageRequest?
  @ObservationIgnored private var queryExecutor: QueryExecutor = { index, value, scope, accepted, previous, generation in
    try await index.searchAsync(value, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
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
    cancelAutomaticAnalysis()
    #if !FOTORO_LOCAL_PREVIEW
      semanticRetryRequested = false
    #endif
    automaticAnalysisScope = nil; automaticAnalysisCursor = nil
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
  func setAutomaticAnalysisActive(_ active: Bool) {
    guard automaticAnalysisActive != active else { return }
    automaticAnalysisActive = active
    if active { scheduleAutomaticAnalysis() } else { cancelAutomaticAnalysis() }
  }
  func setBrowseInteractionActive(_ active: Bool) {
    guard browseInteractionActive != active else { return }
    browseInteractionActive = active
    if active { cancelAutomaticAnalysis() } else { scheduleAutomaticAnalysis() }
  }
  private var automaticAnalysisAdmitted: Bool { automaticAnalysisActive && !browseInteractionActive }
  private var automaticAnalysisRunning: Bool {
    automaticAnalysisTask != nil && automaticAnalysisTask?.isCancelled == false
  }
  private func cancelAutomaticAnalysis() {
    idleAnalysisTask?.cancel(); idleAnalysisTask = nil
    automaticRetryTask?.cancel(); automaticRetryTask = nil; automaticRetryID = UUID()
    automaticAnalysisRestartRequested = false
    #if !FOTORO_LOCAL_PREVIEW
      semanticPreparationTask?.cancel()
    #endif
    if let task = automaticAnalysisTask, !task.isCancelled {
      task.cancel()
      imageRequest?.cancel(); imageRequest = nil
      indexing = false; analysisProgress = nil
    }
  }
  private func scheduleAutomaticAnalysis() {
    guard ready, index != nil, automaticAnalysisAdmitted, !indexing,
      (automaticAnalysisTask == nil || automaticAnalysisTask?.isCancelled == true), idleAnalysisTask == nil else { return }
    automaticRetryTask?.cancel(); automaticRetryTask = nil; automaticRetryID = UUID()
    idleAnalysisTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      idleAnalysisTask = nil
      automaticAnalysisRestartRequested = true
      startAutomaticAnalysis()
    }
  }
  private func scheduleAutomaticRetry(scope: PhotoAnalysisScope, token: UInt64) {
    guard ready, let index, automaticAnalysisAdmitted, !indexing, automaticRetryTask == nil else { return }
    let id = UUID(), now = analysisNow()
    automaticRetryID = id
    automaticRetryTask = Task { [weak self] in
      defer { if let self, automaticRetryID == id { automaticRetryTask = nil } }
      do {
        let due = try await Task.detached(priority: .utility) {
          try index.nextMetadataAnalysisRetry(scope: scope, now: now)
        }.value
        guard let due else { return }
        try Task.checkCancellation()
        try await Task.sleep(for: .seconds(max(0, due.timeIntervalSince(now))))
        guard let self, !Task.isCancelled, automaticRetryID == id,
          token == work.generation, automaticAnalysisAdmitted, ready else { return }
        automaticRetryTask = nil
        // Results and stage deadlines are durable; the traversal cursor is not.
        automaticAnalysisCursor = nil
        scheduleAutomaticAnalysis()
      } catch {}
    }
  }
  private func startAutomaticAnalysis() {
    guard ready, index != nil, automaticAnalysisAdmitted, !indexing, automaticAnalysisTask == nil else { return }
    let id = UUID(), token = work.generation
    automaticAnalysisRestartRequested = false
    automaticAnalysisID = id
    #if DEBUG
      automaticAnalysisWorkerStarts += 1
    #endif
    automaticAnalysisTask = Task(priority: .utility) { [weak self] in
      guard let self else { return }
      defer {
        if automaticAnalysisID == id {
          automaticAnalysisTask = nil
          // Withdrawal already cleared this worker's presentation. An explicit
          // analysis may now own it while waiting for this worker to drain.
          if !Task.isCancelled { indexing = false; analysisProgress = nil }
          if automaticAnalysisRestartRequested { startAutomaticAnalysis() }
          #if !FOTORO_LOCAL_PREVIEW
            if semanticRetryRequested { scheduleAutomaticAnalysis() }
          #endif
          if !Task.isCancelled, !automaticAnalysisRestartRequested {
            scheduleAutomaticRetry(scope: automaticAnalysisScope ?? PhotoAnalysisScope(includesOlder: true), token: token)
          }
        }
      }
      guard !Task.isCancelled, automaticAnalysisID == id, automaticAnalysisAdmitted,
        ready, token == work.generation else { return }
      indexing = true
      // Search covers every permitted photo. Prepare newest first, then continue
      // into older and undated sources in bounded batches while the home is idle.
      // A query cannot filter out photos whose text has not yet been read.
      let scope = automaticAnalysisScope ?? PhotoAnalysisScope(includesOlder: true)
      automaticAnalysisScope = scope
      var after = automaticAnalysisCursor
      #if !FOTORO_LOCAL_PREVIEW
        if await semanticReady(), let index {
          let released = try? await Task.detached(priority: .utility) {
            try index.releaseModelDeferredAnalysis(generation: token)
          }.value
          guard analysisIsCurrent(scope, token: token, explicit: false) else { return }
          if released == true { after = nil; automaticAnalysisCursor = nil }
        }
      #endif
      #if DEBUG
        let limit = max(1, min(500, automaticAnalysisBatchLimit))
      #else
        let limit = 500
      #endif
      while analysisIsCurrent(scope, token: token, explicit: false) {
        #if !FOTORO_LOCAL_PREVIEW
          if semanticRetryRequested {
            // OCR/classification has continued while public weights prepared.
            // Revisit missing vectors once; completed OCR is retained in SQLite.
            semanticRetryRequested = false
            after = nil; automaticAnalysisCursor = nil
          }
        #endif
        guard let next = await runScopedAnalysis(scope: scope, after: after,
          retryFailed: automaticRetryFailed, token: token, explicit: false, limit: limit), next != after
        else { break }
        after = next
        automaticAnalysisCursor = next
        do { try await Task.sleep(for: .milliseconds(50)) } catch { break }
      }
    }
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
      let scanned = try await SearchMetadataIntake.run { try await Self.scan() }
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
      automaticRetryFailed = retryFailedOCR
    } catch is CancellationError {} catch {
      if token == work.generation { self.error = error.localizedDescription }
    }
    if token == work.generation { indexing = false; analysisProgress = nil; scheduleAutomaticAnalysis() }
  }
  private func analysisSourceCurrent(_ record: SearchRecord) -> Bool {
    guard ready, assets[record.id]?.sourceRevision == record.revision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let current = PHAsset.fetchAssets(withLocalIdentifiers: [record.id], options: nil).firstObject,
      !current.isHidden else { return false }
    return RecentPhoto.sourceRevision(current) == record.revision
  }
  private func analysisIsCurrent(_ scope: PhotoAnalysisScope, token: UInt64, explicit: Bool) -> Bool {
    !Task.isCancelled && ready && token == work.generation && (explicit
      ? query == scope.query && peopleSelection == scope.scope.people : automaticAnalysisAdmitted)
  }
  var canAnalyzeMetadataMatches: Bool { ready }
  #if !FOTORO_LOCAL_PREVIEW
    private func semanticReady() async -> Bool {
      #if DEBUG
        if let analysisSemanticReady { return await analysisSemanticReady() }
      #endif
      return await PhotoSemanticProcessor.shared.ready
    }
    private func semanticImage(_ preview: SearchPreview) async throws -> [Float] {
      #if DEBUG
        if let analysisSemanticImage { return try await analysisSemanticImage(preview) }
      #endif
      return try await PhotoSemanticProcessor.shared.image(preview)
    }
    private func beginSemanticPreparation(token: UInt64) {
      guard semanticPreparationTask == nil else { return }
      let id = UUID(); semanticPreparationID = id
      semanticPreparationTask = Task(priority: .utility) { [weak self] in
        guard let self else { return }
        defer { if semanticPreparationID == id { semanticPreparationTask = nil } }
        do {
          try await prepareSemantic()
          try Task.checkCancellation()
          guard token == work.generation, ready, await semanticReady() else { return }
          guard let index else { return }
          let released = try await Task.detached(priority: .utility) {
            try index.releaseModelDeferredAnalysis(generation: token)
          }.value
          guard released else { return }
          try Task.checkCancellation()
          guard token == work.generation, ready else { return }
          semanticRetryRequested = true
          scheduleAutomaticAnalysis()
        } catch {}
      }
    }
  #endif
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
    let previousAutomatic = automaticAnalysisTask
    refreshTask = Task {
      await previousAutomatic?.value
      guard !Task.isCancelled, token == work.generation else { return }
      _ = await runScopedAnalysis(scope: scope, after: after, retryFailed: true, token: token, explicit: true)
      if token == work.generation { indexing = false; analysisProgress = nil }
    }
  }
  private func runScopedAnalysis(scope: PhotoAnalysisScope, after: PhotoAnalysisCursor?, retryFailed retryFailedOCR: Bool,
    token: UInt64, explicit: Bool, limit: Int = 500) async -> PhotoAnalysisCursor? {
    guard let localIndex = index else { return nil }
    analysisScope = scope
    do {
      let now = analysisNow()
      let batch = try await Task.detached(priority: .utility) {
        (try localIndex.pendingMetadataAnalysisCount(scope: scope, after: after, retryFailed: retryFailedOCR,
          now: now, bypassDeferred: explicit),
          try localIndex.pendingMetadataAnalysisWork(scope: scope, after: after, retryFailed: retryFailedOCR,
            now: now, bypassDeferred: explicit, limit: limit))
      }.value
      let pending = batch.1
      guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { return nil }
      analysisRemaining = max(0, batch.0 - pending.count)
      guard !pending.isEmpty else { return nil }
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
      analysisProgress = pending.isEmpty ? nil : SearchAnalysisProgress(processed: 0, total: pending.count)
      for job in pending {
        let record = job.record
        try Task.checkCancellation()
        guard analysisIsCurrent(scope, token: token, explicit: explicit), let photo = assets[record.id], analysisSourceCurrent(record) else { break }
        let preview = await loadPreview(photo.asset)
        try Task.checkCancellation()
        guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record),
          RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        else { break }
        let needsOCR = job.stages.contains(.ocr)
        let needsVisual = job.stages.contains(.visual)
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
          let attemptedAt = analysisNow()
          _ = try await Task.detached {
            try localIndex.applyVisual(visualResult, status: visualState, photoID: record.id,
              revision: record.revision, generation: token, attemptedAt: attemptedAt, expectedProcessor: record.visualProcessor)
          }.value
          guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
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
          let attemptedAt = analysisNow()
          _ = try await Task.detached {
            try localIndex.applyOCR(ocrResult, status: ocrState, photoID: record.id,
              revision: record.revision, generation: token, attemptedAt: attemptedAt, expectedProcessor: record.processor)
          }.value
        }
        guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
        guard let observed = try localIndex.record(record.id), observed.revision == record.revision else { break }
        try onRecordChanged?(observed, false)
        guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
        // Publish OCR/classification without waiting for a cold model download.
        updateQuery(query)
        #if !FOTORO_LOCAL_PREVIEW
        // Warm inference uses this derivative. Cold installation cannot hold
        // later photos' OCR/classification or retain a cancelled browse worker.
        if job.stages.contains(.semantic), try localIndex.needsSemantic(photoID: record.id, revision: record.revision) {
          let attemptedAt = analysisNow()
          guard let preview else {
            _ = try await Task.detached {
              try localIndex.deferSemantic(.unavailable, photoID: record.id, revision: record.revision,
                attemptedAt: attemptedAt, generation: token)
            }.value
            guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
            analysisUnavailableIDs.insert(record.id)
            attempted.append(record)
            if !explicit { automaticAnalysisCursor = PhotoAnalysisCursor(record) }
            analysisProgress?.processed += 1
            await Task.yield()
            continue
          }
          var modelReady = await semanticReady()
          if explicit && !modelReady {
            // Historical/query-scoped requests retain this derivative and their
            // explicit scope; the consumer wait cancels without owning install.
            try? await prepareSemantic()
            modelReady = await semanticReady()
          }
          try Task.checkCancellation()
          guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record) else { break }
          if modelReady, let vector = try? await semanticImage(preview)
          {
            guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
            let committed = try await Task.detached {
              try localIndex.applySemantic(vector, photoID: record.id, revision: record.revision, generation: token)
            }.value
            if !committed {
              try Task.checkCancellation()
              guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record) else { break }
              _ = try await Task.detached {
                try localIndex.deferSemantic(.failed, photoID: record.id, revision: record.revision,
                  attemptedAt: attemptedAt, generation: token)
              }.value
            }
            guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled else { break }
            updateQuery(query)
          } else {
            try Task.checkCancellation()
            guard analysisIsCurrent(scope, token: token, explicit: explicit), analysisSourceCurrent(record) else { break }
            let outcome: SearchAnalysisOutcome = modelReady ? .failed : .modelDeferred
            _ = try await Task.detached {
              try localIndex.deferSemantic(outcome, photoID: record.id, revision: record.revision,
                attemptedAt: attemptedAt, generation: token)
            }.value
            if !modelReady && !explicit { beginSemanticPreparation(token: token) }
          }
        }
        #endif
        guard analysisIsCurrent(scope, token: token, explicit: explicit), !Task.isCancelled, analysisSourceCurrent(record) else { break }
        guard let current = try localIndex.record(record.id), current.revision == record.revision else { break }
        var incomplete = current.ocrStatus != .complete || current.visualStatus != .complete
        #if !FOTORO_LOCAL_PREVIEW
        let missingVector = try localIndex.needsSemantic(photoID: record.id, revision: record.revision)
        incomplete = incomplete || missingVector
        #endif
        if incomplete { analysisUnavailableIDs.insert(record.id) }
        else { analysisUnavailableIDs.remove(record.id) }
        attempted.append(record)
        if !explicit { automaticAnalysisCursor = PhotoAnalysisCursor(record) }
        analysisProgress?.processed += 1
        await Task.yield()
      }
      guard analysisIsCurrent(scope, token: token, explicit: explicit),
        attempted.count == pending.count, let last = attempted.last
      else { return nil }
      return PhotoAnalysisCursor(last)
    } catch is CancellationError {} catch {
      if token == work.generation { self.error = error.localizedDescription }
    }
    return nil
  }
  private struct Scan: @unchecked Sendable {
    var photos: [RecentPhoto]
    var records: [SearchRecord]
  }
  private nonisolated static func scan() async throws -> Scan {
    try Task.checkCancellation()
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
    try await SearchMetadataIntake.forEach(count: fetched.count) { offset in
      let asset = fetched.object(at: offset)
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
    #if DEBUG
      if let analysisPreview { return await analysisPreview(asset) }
    #endif
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
  func consumerResults(_ value: String, includeVisual: Bool = true) async throws -> [SearchHit] {
    try Task.checkCancellation()
    guard ready, let index else { return [] }
    let token = work.generation
    let library = libraryGeneration
    let queryToken = queryGeneration
    let currentQuery = SearchNormalization.text(query)
    let previous = response
    let accepted = acceptedMeaningID
    let scope = SearchScope(people: peopleSelection)
    // The presentation already ran lexical retrieval. Reuse it rather than
    // enqueuing the same SQLite work again behind background analysis.
    var next = hasCurrentResponse && SearchNormalization.text(value) == currentQuery
      ? response : try await queryExecutor(index, value, scope, accepted, previous, queryToken)
    #if !FOTORO_LOCAL_PREVIEW
    let phrase = NaturalDateQuery.parse(value).text.trimmingCharacters(in: .whitespacesAndNewlines)
    if includeVisual, accepted == nil, next.permitsSemanticMatches, phrase.count >= 3,
      let vector = try? await PhotoSemanticProcessor.shared.textIfReady(phrase) {
      try Task.checkCancellation()
      let base = next
      let worker = Task.detached(priority: .userInitiated) {
        try Task.checkCancellation()
        return try index.addingSemantic(vector, to: base)
      }
      next = try await withTaskCancellationHandler { try await worker.value }
        onCancel: { worker.cancel() }
    }
    #endif
    try Task.checkCancellation()
    guard ready, token == work.generation, library == libraryGeneration else { return [] }
    guard currentQuery == SearchNormalization.text(query), accepted == acceptedMeaningID,
      scope.people == peopleSelection else { throw CancellationError() }
    let permitted = try await consumerRecords(next.results.flatMap { [$0.id] + $0.children })
    try Task.checkCancellation()
    guard currentQuery == SearchNormalization.text(query), accepted == acceptedMeaningID,
      scope.people == peopleSelection else { throw CancellationError() }
    return next.results.compactMap { hit in
      let current = ([hit.id] + hit.children).filter { permitted[$0] != nil }
      guard let first = current.first else { return nil }
      var permitted = hit
      permitted.id = first
      permitted.children = Array(current.dropFirst())
      return permitted
    }
  }
  func consumerRecords(_ ids: [String]) async throws -> [String: SearchRecord] {
    guard ready, let index else { return [:] }
    let token = work.generation, library = libraryGeneration, people = peopleSelection
    let worker = Task.detached(priority: .userInitiated) { try index.records(ids) }
    let records = try await withTaskCancellationHandler { try await worker.value }
      onCancel: { worker.cancel() }
    try Task.checkCancellation()
    guard ready, token == work.generation, library == libraryGeneration, people == peopleSelection else {
      throw CancellationError()
    }
    #if !FOTORO_LOCAL_PREVIEW
    if !people.isEmpty {
      return records.filter { _, record in
        canEditPeoplePhoto(record.id, revision: record.revision)
          && people.matches(Set(PhotoPeopleFacts.read(record.facts, enforceWireLimits: false).map(\.p)))
      }
    }
    #endif
    return records
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
    if changed, ready, indexing, !automaticAnalysisRunning { pause() }
    if changed, !automaticAnalysisRunning { analysisRemaining = 0; analysisScope = nil; analysisCursor = nil; analysisUnavailableIDs = [] }
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
      let started = ProcessInfo.processInfo.systemUptime
      do {
        try Task.checkCancellation()
        guard generation == queryGeneration else { return }
        let next = try await execute(index, value, scope, accepted, previous, generation)
        guard generation == queryGeneration, !Task.isCancelled else { return }
        if accepted != nil, next.meaning?.id != accepted { acceptedMeaningID = nil }
        response = next
        displayedID = next.leading?.id
        priorPermittedResponse = nil
        searching = false
        #if !FOTORO_LOCAL_PREVIEW
        NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .search, outcome: .completed,
          elapsed: ProcessInfo.processInfo.systemUptime - started,
          completed: next.results.count, pending: max(0, next.total - next.indexed),
          trace: NativeDiagnosticTrace(.search), step: .catalog))
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
    if ready, indexing, !automaticAnalysisRunning { pause() }
    if !automaticAnalysisRunning { analysisRemaining = 0; analysisScope = nil; analysisCursor = nil; analysisUnavailableIDs = [] }
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
  @discardableResult func setOrganization(_ change: PhotoOrganizationChange, photoID: String) -> Bool {
    guard canEditLabels(photoID), let index, let record = try? index.record(photoID),
      assets[photoID]?.sourceRevision == record.revision else { error = "Photo source changed"; return false }
    do {
      // A linked account mutation reads the latest ledger instead of copying stale local facts.
      try onOrganizationChanged?(record, change)
      guard try index.setOrganization(change, photoID: photoID) else { return false }
      updateQuery(query)
      return true
    } catch { self.error = error.localizedDescription; return false }
  }
  func labels(_ photoID: String) -> [String] { (try? index?.record(photoID)?.labels) ?? [] }
  @discardableResult func setLabels(_ labels: [String], photoID: String) -> Bool {
    guard labels.count <= 64, labels.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.count <= 120 }) else {
      error = "Use up to 64 tags, each with up to 120 characters."
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
