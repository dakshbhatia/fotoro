import Foundation
import ImageIO
import GRDB
import Nuke
import Observation
import Photos

extension NativeDiagnosticOutcome {
  static func failure(for error: Error, taskCancelled: Bool) -> Self {
    taskCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled
      || (error as? NativePasskeyError)?.isCancelled == true ? .cancelled : .failed
  }
}

struct PendingSave: Codable {
  var request: SaveRequestV1
  var local: LocalPhoto
}

private struct SharingOperationAccess {
  let photo: PhotoAccountAccess
  let cards: [String: AccountCardV1]
  var account: String { photo.account }
}

enum PhotoPicksBackupPolicy {
  static func select(_ candidates: [BackupCandidate], snapshot: PhotoPicksSnapshot?) -> [BackupCandidate] {
    guard let snapshot else { return [] }
    return candidates.filter { candidate in
      guard let expected = snapshot.revision(for: candidate.id) else { return false }
      return candidate.sourceRevision == expected
    }
  }
}

enum ReviewedPhotosBackupPolicy {
  static func select(_ candidates: [BackupCandidate], selection: [RecentPhotoSource]) throws -> [BackupCandidate] {
    guard !selection.isEmpty, Set(selection.map(\.id)).count == selection.count else {
      throw FotoroError("Choose photos to save.")
    }
    let current = Dictionary(candidates.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return try selection.map { source in
      guard !source.revision.isEmpty, let candidate = current[source.id],
        candidate.sourceRevision == source.revision else {
        throw FotoroError("Selected photos changed or are unavailable. Review your selection and try again.")
      }
      return candidate
    }
  }
}

@MainActor @Observable final class AppServices: Identifiable {
  let id = UUID()
  let deviceTrust: DeviceTrust
  let auth: NativeAuth
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  @ObservationIgnored private let diagnostics: NativeDiagnostics
  var store: LibraryStore
  var importer: PhotoImport
  var backup: PhotosBackup
  var journal: TransferJournal
  var annotations: AnnotationSync
  var photoAnnotations: [String: PhotoAnnotationsV1] = [:]
  @ObservationIgnored private weak var recentPhotos: RecentPhotosStore?
  func bindRecentPhotos(_ recent: RecentPhotosStore) { recentPhotos = recent }
  func requestPhotosAccessForSync() async throws {
    guard let recentPhotos else { throw FotoroError("Open Photos before syncing.") }
    let started = ProcessInfo.processInfo.systemUptime
    await recentPhotos.open()
    diagnostics.record(NativeDiagnosticEvent(phase: .consent,
      outcome: RecentPhotosPolicy.canRead(recentPhotos.status) ? .completed : .failed,
      elapsed: ProcessInfo.processInfo.systemUptime - started))
  }
  @ObservationIgnored private weak var localSearch: LocalSearchStore?
  @ObservationIgnored private var savedVisualIndex: SearchIndex?
  @ObservationIgnored private var savedVisualRoot: URL?
  @ObservationIgnored private var savedVisualTask: Task<Void, Never>?
  @ObservationIgnored private var savedVisualWork = UUID()
  @ObservationIgnored private var savedVisualCatalogGeneration: UInt64?
  @ObservationIgnored private var savedVisualFence: UInt64 = 0
  let storageRoot: URL
  var photos: [LocalPhoto] = []
  var received: [LocalPhoto] = []
  var grants: [GrantV1] = []
  var error: String?
  var notices: [String] = []
  var busy = false
  var fixtureAccounts: FixtureAccounts?
  var selectedGrant: GrantV1?
  @ObservationIgnored private var sharedInboxRead: (id: UUID, access: SharingOperationAccess, task: Task<GrantInboxV1, Error>)?
  #if DEBUG
    @ObservationIgnored var consumerShareDidWrite: ((URL) -> Void)?
    @ObservationIgnored var catalogSearchWillRead: (@Sendable () -> Void)?
    @ObservationIgnored var photosBackupSnapshot: ((Date) throws -> [BackupCandidate])?
    @ObservationIgnored var automaticPhotosAuthorization: (() -> PHAuthorizationStatus)?
  #endif
  private(set) var consumerSyncSummary = ConsumerSyncSummary()
  private(set) var consumerCatalogGeneration: UInt64 = 0
  private var activatedPhotoAccount: PhotoAccountAccess?
  @ObservationIgnored private var diagnosticAccountState: NativeDiagnosticAccountState?
  @ObservationIgnored private var consumerObservation = UUID()
  @ObservationIgnored private var syncIntent = UUID()
  private var automaticSyncPreference = AutomaticPhotoSyncPreference()
  private var photoSyncForeground = false
  private var automaticSyncFailure: String?
  private var automaticSyncTask: Task<Void, Never>?
  @ObservationIgnored private var automaticSyncSettling: Task<Void, Never>?
  @ObservationIgnored private var automaticSyncGeneration = UUID()
  @ObservationIgnored private var automaticSyncNeedsScan = false
  @ObservationIgnored private var automaticSyncObserver: AutomaticPhotoSyncObserver?
  private var consumerChecking = false
  private var consumerOffline = false
  private var consumerFailure: String?
  func consumerSearch(_ query: String, local: LocalSearchStore) async throws -> [ConsumerSearchHit] {
    guard !SearchNormalization.text(query).isEmpty else { return [] }
    let account = vault.isUnlocked ? session.accountId : nil
    let generation = vault.generation
    let catalog = store
    let libraryGeneration = local.libraryGeneration
    let deviceHits = try await local.consumerResults(query)
    try Task.checkCancellation()
    let saved: [LocalPhoto]
    var visualSavedIDs = Set<String>()
    if let account {
      guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { throw CancellationError() }
      let lexical = try await searchCatalog(query).filter { ["committed", "saved"].contains($0.transferState) }
      let visual = local.acceptedMeaningID == nil ? try await consumerSavedVisualSearch(query) : []
      let matched = Set(lexical.map(\.id))
      saved = lexical + visual.filter { !matched.contains($0.id) }
      visualSavedIDs = Set(visual.map(\.id)).subtracting(matched)
      guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { throw CancellationError() }
    } else { saved = [] }
    try Task.checkCancellation()
    // Recheck local permission/revision after the cloud lookup; a withdrawn device source cannot hide an owned saved copy.
    var records: [String: SearchRecord] = [:]
    var result: [ConsumerSearchHit] = []
    for hit in deviceHits {
      for id in [hit.id] + hit.children {
        guard records[id] == nil, local.libraryGeneration == libraryGeneration,
          let record = try local.consumerRecord(id) else { continue }
        records[id] = record
        result.append(ConsumerSearchHit(photo: .device(id), evidence: hit.reason))
      }
    }
    let sources = account == nil ? [] : try catalog.backupSources()
    let copies = ConsumerSearchBinding.verifiedCopies(sources: sources, records: records)
    for photo in saved {
      if !ConsumerSearchBinding.duplicate(saved: photo, copies: copies) {
        result.append(ConsumerSearchHit(photo: .saved(photo.id), evidence: visualSavedIDs.contains(photo.id) ? "Visual similarity" : "Saved photo"))
      }
    }
    return result
  }
  func consumerSavedPhoto(_ id: String) throws -> LocalPhoto? {
    guard vault.isUnlocked, let account = session.accountId,
      store.root.lastPathComponent == account, let photo = try store.backupPhoto(id),
      photo.manifest.ownerAccountId == account, photo.manifest.photoId == id,
      ["committed", "saved"].contains(photo.transferState) else { return nil }
    return photo
  }
  private func consumerSavedVisualSearch(_ query: String) async throws -> [LocalPhoto] {
    let phrase = NaturalDateQuery.parse(query).text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard phrase.count >= 3, vault.isUnlocked, let account = session.accountId else { return [] }
    let catalog = store, generation = vault.generation
    let root = catalog.root.appendingPathComponent("VisualSearch", isDirectory: true)
    if savedVisualRoot != root {
      invalidateSavedVisualSearch()
      savedVisualIndex = try SearchIndex(root: root); savedVisualRoot = root
      savedVisualCatalogGeneration = nil
    }
    guard let index = savedVisualIndex else { return [] }
    let catalogSnapshotGeneration = consumerCatalogGeneration
    if savedVisualCatalogGeneration != catalogSnapshotGeneration {
      let candidates = try await searchCatalog("").filter { ["committed", "saved"].contains($0.transferState) }
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account,
        consumerCatalogGeneration == catalogSnapshotGeneration else {
        throw CancellationError()
      }
      let records = candidates.map { photo -> SearchRecord in
        var record = SearchRecord(id: photo.id)
        record.scope = "saved"; record.revision = photo.metadata.originalSha256
        record.filename = photo.metadata.filename
        record.capturedAt = ["photos", "exif"].contains(photo.metadata.dateSource) ? Wire.parseDate(photo.metadata.sourceDate) : nil
        record.ocrStatus = .complete; record.visualStatus = .complete
        return record
      }
      _ = try await Task.detached(priority: .utility) { try index.replacePermitted(records) }.value
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account,
        consumerCatalogGeneration == catalogSnapshotGeneration else {
        throw CancellationError()
      }
      savedVisualCatalogGeneration = catalogSnapshotGeneration
    }
    if savedVisualTask == nil, photoSyncForeground {
      let work = UUID(); savedVisualWork = work
      savedVisualFence &+= 1
      let fence = savedVisualFence
      try index.setWorkGeneration(fence)
      savedVisualTask = Task { [weak self] in
        guard let self else { return }
        defer { if savedVisualWork == work { savedVisualTask = nil } }
        @MainActor func current() -> Bool {
          !Task.isCancelled && savedVisualWork == work && vault.isUnlocked && vault.generation == generation
            && store === catalog && session.accountId == account && photoSyncForeground
        }
        @MainActor func notifyProgress() {
          let snapshotWasCurrent = savedVisualCatalogGeneration == consumerCatalogGeneration
          consumerCatalogGeneration &+= 1
          if snapshotWasCurrent { savedVisualCatalogGeneration = consumerCatalogGeneration }
        }
        do {
          try await PhotoSemanticProcessor.shared.prepare()
          guard current() else { return }
          let pending = try await Task.detached { try index.pendingSemanticRecords() }.value
          var completed = 0
          for record in pending {
            guard current(), let photo = try consumerSavedPhoto(record.id),
              photo.metadata.originalSha256 == record.revision else { continue }
            do {
              try await ensurePreview(photo)
              guard current(), let updated = try consumerSavedPhoto(photo.id),
                updated.metadata == photo.metadata, updated.manifest == photo.manifest,
                let url = updated.previewURL,
                let preview = try await Self.semanticPreview(url) else { continue }
              guard current() else { return }
              let vector = try await PhotoSemanticProcessor.shared.image(preview)
              guard current() else { return }
              _ = try await Task.detached {
                try index.applySemantic(vector, photoID: record.id, revision: record.revision, generation: fence)
              }.value
              guard current() else { return }
              completed += 1
              if completed % 8 == 0 { notifyProgress() }
            } catch is CancellationError { return } catch { continue }
            await Task.yield()
          }
          if current(), completed > 0 { notifyProgress() }
        } catch {}
      }
    }
    guard let vector = try? await PhotoSemanticProcessor.shared.textIfReady(phrase) else { return [] }
    let response = try await Task.detached(priority: .userInitiated) {
      let base = try index.search(query, scope: SearchScope(source: "saved"))
      return try index.addingSemantic(vector, to: base)
    }.value
    guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else {
      throw CancellationError()
    }
    return try response.results.compactMap { try consumerSavedPhoto($0.id) }
  }
  private func invalidateSavedVisualSearch() {
    savedVisualWork = UUID(); savedVisualTask?.cancel(); savedVisualTask = nil
    savedVisualFence &+= 1
    try? savedVisualIndex?.setWorkGeneration(savedVisualFence)
    Task { await PhotoSemanticProcessor.shared.clearQueryCache() }
  }
  private nonisolated static func semanticPreview(_ url: URL) async throws -> SearchPreview? {
    let worker = Task.detached(priority: .utility) { () throws -> SearchPreview? in
      try Task.checkCancellation()
      let data = try Data(contentsOf: url, options: .mappedIfSafe)
      guard data.count <= 2 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceCreateThumbnailWithTransform: true,
          kCGImageSourceThumbnailMaxPixelSize: 512,
        ] as CFDictionary) else { return nil }
      try Task.checkCancellation()
      return SearchPreview(image: image)
    }
    return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
  }
  func consumerShareOriginal(_ photo: LocalPhoto) async throws -> URL {
    guard let current = try consumerSavedPhoto(photo.id),
      current.metadata.originalSha256 == photo.metadata.originalSha256,
      try Wire.encode(current.manifest) == Wire.encode(photo.manifest) else { throw FotoroError("Photo access changed") }
    let generation = vault.generation
    let account = session.accountId
    let catalog = store
    func check() throws {
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, session.accountId == account, store === catalog,
        let now = try consumerSavedPhoto(photo.id), now.metadata.originalSha256 == photo.metadata.originalSha256,
        try Wire.encode(now.manifest) == Wire.encode(photo.manifest) else { throw CancellationError() }
    }
    func verify(_ bytes: Data) throws {
      guard bytes.count == current.metadata.originalBytes, bytes.digest == current.metadata.originalSha256 else { throw FotoroError("Original could not be verified") }
    }
    func export(_ bytes: Data) throws -> URL {
      try check()
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let component = URL(fileURLWithPath: current.metadata.filename).lastPathComponent
        let filename = ["", ".", "..", "/"].contains(component) ? "photo." + PhotoImport.originalExtension(for: current.metadata.mediaType) : component
        let output = directory.appendingPathComponent(filename)
        try bytes.write(to: output, options: [.atomic, .completeFileProtection])
        #if DEBUG
          consumerShareDidWrite?(output)
        #endif
        try check()
        return output
      } catch {
        try? FileManager.default.removeItem(at: directory)
        throw error
      }
    }
    if let url = current.originalURL, FileManager.default.fileExists(atPath: url.path) {
      let bytes = try await Task.detached { try Data(contentsOf: url) }.value
      try check(); try verify(bytes)
      return try export(bytes)
    }
    guard let rep = current.manifest.representations.first(where: { $0.binding.kind == "original" }),
      let key = current.metadata.representationKeys[rep.binding.representationId] else { throw FotoroError("Original is unavailable") }
    let ciphertext = try await api.request("/v1/objects/\(rep.objectId)")
    try check()
    let secret = try Data(b64: key)
    let bytes = try await Task.detached { try CryptoAdapter().decrypt(ciphertext, key: secret, representation: rep) }.value
    try check(); try verify(bytes)
    var updated = current
    let url = try catalog.write(bytes, name: "cache-" + current.id + "-original." + PhotoImport.originalExtension(for: current.metadata.mediaType))
    updated.originalURL = url
    try catalog.put(updated)
    if let at = photos.firstIndex(where: { $0.id == current.id }) { photos[at] = updated }
    return try export(bytes)
  }
  func consumerMediaOriginal(_ photo: LocalPhoto, grant: GrantV1?) async throws -> URL {
    guard let grant else { return try await consumerShareOriginal(photo) }
    let generation = vault.generation, account = session.accountId, catalog = store
    let origin = BackgroundUploadPolicy.origin(api.baseURL), cards = session.pinnedCards
    @MainActor func check() throws {
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, session.accountId == account,
        store === catalog, BackgroundUploadPolicy.origin(api.baseURL) == origin,
        session.pinnedCards == cards, isReceivedGrantCurrent(grant),
        received.contains(where: { $0.id == photo.id && $0.metadata == photo.metadata && $0.manifest == photo.manifest }) else { throw CancellationError() }
    }
    try check()
    guard let rep = photo.manifest.representations.first(where: { $0.binding.kind == "original" }),
      let encoded = photo.metadata.representationKeys[rep.binding.representationId] else { throw FotoroError("Original is unavailable") }
    let cipher = try await api.request("/v1/objects/\(rep.objectId)")
    try check()
    let key = try Data(b64: encoded)
    let bytes = try await Task.detached { try CryptoAdapter().decrypt(cipher, key: key, representation: rep) }.value
    try check()
    guard bytes.count == photo.metadata.originalBytes, bytes.digest == photo.metadata.originalSha256 else { throw FotoroError("Original could not be verified") }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
    do {
      let urls = try CameraMedia.exportOriginals(bytes, metadata: photo.metadata, directory: directory)
      try check()
      if photo.metadata.mediaType == CameraMedia.liveType {
        let archive = directory.appendingPathComponent("original.fotoro-live")
        try bytes.write(to: archive, options: [.atomic, .completeFileProtection])
        return archive
      }
      return urls[0]
    } catch { try? FileManager.default.removeItem(at: directory); throw error }
  }
  func refreshConsumerSyncSummary() {
    let accountState: NativeDiagnosticAccountState
    if !session.isSignedIn { accountState = .signedOut }
    else if session.fixture { accountState = .demo }
    else if vault.isUnlocked { accountState = .unlocked }
    else if auth.needsRecovery { accountState = .recoveryRequired }
    else { accountState = .locked }
    if diagnosticAccountState != accountState {
      diagnosticAccountState = accountState
      diagnostics.record(NativeDiagnosticEvent(phase: .app, outcome: .changed, accountState: accountState))
    }
    let previous = consumerSyncSummary.state
    defer {
      if consumerSyncSummary.state != previous {
        diagnostics.record(NativeDiagnosticEvent(phase: .sync, outcome: .changed,
          state: consumerSyncSummary.state, completed: consumerSyncSummary.completedPhotos,
          pending: consumerSyncSummary.totalPhotos.flatMap { total in
            consumerSyncSummary.completedPhotos.map { max(0, total - $0 - consumerSyncSummary.skippedPhotos) }
          }))
      }
    }
    guard session.isSignedIn, vault.isUnlocked, let account = session.accountId, store.root.lastPathComponent == account else {
      consumerSyncSummary = ConsumerSyncSummary()
      return
    }
    do {
      let automatic = automaticSyncPreference.enabled && automaticSyncPreference.origin == BackgroundUploadPolicy.origin(api.baseURL)
      let allSources = try store.backupSources()
      let retainedIDs = Set(allSources.filter(\.isRetainedOriginal).map(\.photoId))
      let sources = allSources.filter { !automatic || !$0.isRetainedOriginal }
      let entries = try journal.entries().filter {
        $0.photo.manifest.ownerAccountId == account && (!automatic || !retainedIDs.contains($0.photo.id))
      }
      var pendingIDs = Set<String>()
      for id in entries.map({ $0.photo.id }) {
        if let photo = try store.backupPhoto(id), photo.manifest.ownerAccountId == account,
          ["committed", "saved"].contains(photo.transferState) { continue }
        pendingIDs.insert(id)
      }
      let unpreparedIDs = Set(try backup.unpreparedSources().map(\.photoId)).subtracting(pendingIDs)
      let completed = try store.consumerCommittedCount(accountId: account)
      let skipped = sources.filter { $0.phase == .skipped }.count
      var facts = ConsumerSyncFacts()
      facts.unlocked = true
      facts.paused = try store.uploadsPaused()
      facts.uploading = journal.running && !entries.isEmpty
      facts.checking = consumerChecking || annotations.busy
      facts.preparing = backup.isRunning && !facts.uploading && !facts.checking
      facts.offline = consumerOffline
      facts.completed = completed
      facts.total = backup.status.sourceTotal == nil ? nil : completed + pendingIDs.count + unpreparedIDs.count + skipped
      facts.pending = pendingIDs.count
      facts.unprepared = unpreparedIDs.count
      facts.failed = backup.status.failed + journal.errors.filter { !automatic || !retainedIDs.contains($0.key) }.count
        + annotations.errors.count + (consumerFailure == nil ? 0 : 1)
      if sources.contains(where: { $0.phase == .committed && $0.message != nil }) { facts.failed += 1 }
      facts.skipped = skipped
      facts.annotationsPending = try store.consumerPendingAnnotations(accountId: account)
      facts.lastChecked = try store.consumerLastChecked() ?? backup.status.lastChecked
      facts.detail = consumerFailure ?? sources.first(where: { $0.message != nil })?.message
      if facts.paused && !pendingIDs.isEmpty { facts.detail = "Your queued photos are kept. Continue when you’re ready." }
      else if !unpreparedIDs.isEmpty { facts.detail = "Some picks weren't saved. Save picks to try again." }
      else if !NativeBackupPolicy.allowsPrivatePhotos(accountId: account, fixture: session.fixture) {
        facts.detail = "Public demo accounts cannot back up your private photos."
      }
      consumerSyncSummary = ConsumerSyncSummary.derive(facts)
    } catch {
      consumerSyncSummary = ConsumerSyncSummary(state: .needsAttention, detail: "Sync status could not be read. Your originals are unchanged.", action: .retry)
    }
  }
  private func observeConsumerSync() {
    let token = consumerObservation
    withObservationTracking {
      _ = session.isSignedIn
      _ = session.fixture
      _ = vault.isUnlocked
      _ = auth.needsRecovery
      _ = backup.status
      _ = backup.isRunning
      _ = journal.running
      _ = journal.errors
      _ = annotations.busy
      _ = annotations.errors
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.consumerObservation == token else { return }
        self.refreshConsumerSyncSummary()
        self.observeConsumerSync()
      }
    }
  }
  private func resetConsumerSyncObservation() {
    consumerObservation = UUID()
    consumerChecking = false
    consumerOffline = false
    consumerFailure = nil
    refreshConsumerSyncSummary()
    observeConsumerSync()
  }
  private func recordConsumerSyncFailure(_ error: Error) {
    guard !(error is CancellationError), vault.isUnlocked else { return }
    consumerOffline = (error as? URLError)?.code == .notConnectedToInternet
    consumerFailure = consumerOffline ? "You’re offline. Your queued photos are kept." : "Sync needs attention. Your originals are unchanged."
    refreshConsumerSyncSummary()
  }
  let crypto = CryptoAdapter()
  init(root: URL? = nil, networkConfiguration: URLSessionConfiguration = .ephemeral,
    diagnostics: NativeDiagnostics = .shared) throws {
    self.diagnostics = diagnostics
    session = AccountSession()
    api = APIClient(
      session: session,
      baseURL: APIURLPolicy.restored(UserDefaults.standard.string(forKey: "fotoro.api"),
        development: APIURLPolicy.developmentBuild),
      networkConfiguration: networkConfiguration, diagnostics: diagnostics)
    vault = VaultStore(session: session, api: api)
    auth = NativeAuth(session: session, api: api, vault: vault)
    deviceTrust = DeviceTrust(session: session, api: api, vault: vault)
    let path =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Fotoro")
    storageRoot = path
    let initialStore = try LibraryStore(
      root: path.appendingPathComponent(session.accountId ?? "locked"))
    try initialStore.setSyncEnabled(false)
    backup = try PhotosBackup(store: initialStore)
    store = initialStore
    automaticSyncPreference = try initialStore.automaticPhotoSyncPreference()
    importer = PhotoImport(store: initialStore)
    journal = TransferJournal(store: initialStore, api: api, vault: vault)
    annotations = AnnotationSync(ledger: AnnotationLedger(store: initialStore, accountId: session.accountId ?? "locked"))
    if session.accountId != nil {
      try BackgroundUploadTransport.shared.configure(accountId: session.accountId, fixture: session.fixture, baseURL: api.baseURL)
    }
    ImageCache.shared.costLimit = 48 * 1024 * 1024
    vault.onLock = { [weak self] in
      self?.invalidateSavedVisualSearch()
      self?.cancelSharedMomentRefresh()
      self?.suspendAutomaticPhotoSync()
      self?.activatedPhotoAccount = nil
      self?.consumerObservation = UUID()
      self?.consumerSyncSummary = ConsumerSyncSummary()
      self?.backup.pause()
      self?.journal.pause()
      self?.photoAnnotations = [:]
      self?.localSearch?.clearSyncedAnnotations()
      self?.photos = []
      self?.received = []
      self?.grants = []
      self?.selectedGrant = nil
      self?.auth.pending = nil
      self?.auth.cancelStart()
      self?.deviceTrust.pending = nil
      ImageCache.shared.removeAll()
    }
    resetConsumerSyncObservation()
    diagnostics.record(NativeDiagnosticEvent(phase: .app, outcome: .started))
  }
  var photoAccountAccess: PhotoAccountAccess? {
    guard session.isSignedIn || session.fixture, vault.isUnlocked,
      let account = session.accountId, store.root.lastPathComponent == account else { return nil }
    let access = PhotoAccountAccess(account: account, vault: vault.generation, catalog: ObjectIdentifier(store))
    return access == activatedPhotoAccount ? access : nil
  }
  func activateAccount() throws {
    suspendAutomaticPhotoSync()
    activatedPhotoAccount = nil
    backup.pause()
    guard let id = session.accountId else { throw FotoroError("Authenticate first") }
    if store.root.lastPathComponent != id { localSearch?.clearSyncedAnnotations() }
    journal.pause(cancelBackground: store.root.lastPathComponent != id)
    let catalog = try LibraryStore(root: storageRoot.appendingPathComponent(id))
    try catalog.setSyncEnabled(false)
    let nextBackup = try PhotosBackup(store: catalog)
    let nextImporter = PhotoImport(store: catalog)
    let nextJournal = TransferJournal(store: catalog, api: api, vault: vault)
    let nextAnnotations = AnnotationSync(ledger: AnnotationLedger(store: catalog, accountId: id))
    try BackgroundUploadTransport.shared.configure(accountId: id, fixture: session.fixture, baseURL: api.baseURL)
    store = catalog
    automaticSyncPreference = try catalog.automaticPhotoSyncPreference()
    automaticSyncFailure = nil
    backup = nextBackup
    importer = nextImporter
    journal = nextJournal
    annotations = nextAnnotations
    UserDefaults.standard.removeObject(forKey: "fotoro.manualLock." + id)
    photoAnnotations = [:]
    try reload()
    try hydrateLocalAnnotations()
    resetConsumerSyncObservation()
    activatedPhotoAccount = PhotoAccountAccess(account: id, vault: vault.generation, catalog: ObjectIdentifier(store))
    kickAutomaticPhotoSync()
  }
  func startPhotosBackup(selection: [RecentPhotoSource]? = nil) throws {
    try startPhotosBackup(selection: selection, automatic: false)
  }
  private var automaticPhotosPermission: PHAuthorizationStatus {
    #if DEBUG
      if let automaticPhotosAuthorization { return automaticPhotosAuthorization() }
    #endif
    return PHPhotoLibrary.authorizationStatus(for: .readWrite)
  }
  private var automaticPhotoSyncAdmitted: Bool {
    guard automaticSyncPreference.enabled, !automaticSyncPreference.paused, photoSyncForeground,
      let origin = BackgroundUploadPolicy.origin(api.baseURL), automaticSyncPreference.origin == origin,
      let access = photoAccountAccess, session.isSignedIn,
      NativeBackupPolicy.allowsPrivatePhotos(accountId: access.account, fixture: session.fixture),
      session.pinnedCards[access.account]?.accountId == access.account,
      RecentPhotosPolicy.canRead(automaticPhotosPermission), (try? store.uploadsPaused()) == false else { return false }
    return true
  }
  var automaticPhotoSync: AutomaticPhotoSyncStatus {
    let enabled = automaticSyncPreference.enabled && automaticSyncPreference.origin == BackgroundUploadPolicy.origin(api.baseURL)
    func status(_ phase: AutomaticPhotoSyncStatus.Phase, _ detail: String) -> AutomaticPhotoSyncStatus {
      AutomaticPhotoSyncStatus(enabled: enabled, paused: automaticSyncPreference.paused, phase: phase, detail: detail)
    }
    guard enabled else { return status(.off, "Automatic photo sync is off.") }
    if automaticSyncPreference.paused { return status(.paused, "Automatic photo sync is paused. Your originals are unchanged.") }
    guard photoAccountAccess != nil, session.isSignedIn else { return status(.locked, "Open Fotoro to continue automatic photo sync.") }
    guard RecentPhotosPolicy.canRead(automaticPhotosPermission) else { return status(.permissionRequired, "Allow Photos access to continue automatic photo sync.") }
    guard photoSyncForeground else { return status(.background, "iOS can finish scheduled encrypted uploads. Open Fotoro to sync more photos.") }
    if automaticSyncTask != nil || backup.isRunning || annotations.busy { return status(.syncing, "Syncing permitted photos and videos. Your originals stay in Photos.") }
    if let automaticSyncFailure { return status(.needsAttention, automaticSyncFailure) }
    if let consumerFailure { return status(.needsAttention, consumerFailure) }
    if backup.status.phase == .failed {
      return status(.needsAttention, backup.status.message ?? "Some originals could not sync. Originals larger than 50 MiB stay in Photos.")
    }
    if !annotations.errors.isEmpty {
      return status(.needsAttention, "Some photo changes could not sync. Use Sync changes to try again.")
    }
    if backup.status.skipped > 0 {
      return status(.ready, "Supported photos, videos and complete Live Photos are synced. Originals larger than 50 MiB stay in Photos.")
    }
    return status(.ready, "Automatic sync is on for permitted photos and videos while Fotoro is open. Complete originals must fit within 50 MiB.")
  }
  func enableAutomaticPhotoSync() throws {
    try Task.checkCancellation()
    guard let access = photoAccountAccess, session.isSignedIn,
      NativeBackupPolicy.allowsPrivatePhotos(accountId: access.account, fixture: session.fixture),
      session.pinnedCards[access.account]?.accountId == access.account,
      let origin = BackgroundUploadPolicy.origin(api.baseURL) else {
      throw FotoroError("Open your private Fotoro account before enabling automatic sync.")
    }
    guard RecentPhotosPolicy.canRead(automaticPhotosPermission) else { throw FotoroError("Allow Photos access to enable automatic sync.") }
    let preference = AutomaticPhotoSyncPreference(enabled: true, paused: false, origin: origin)
    try store.setAutomaticPhotoSyncPreference(preference, uploadsPaused: false)
    automaticSyncPreference = preference
    automaticSyncFailure = nil
    photoSyncForeground = true
    kickAutomaticPhotoSync()
  }
  func pauseAutomaticPhotoSync() { pauseSync() }
  func retryAutomaticPhotoSync() async throws {
    try await sync()
    try Task.checkCancellation()
    kickAutomaticPhotoSync()
  }
  func disableAutomaticPhotoSync() throws {
    suspendAutomaticPhotoSync(cancelBackground: true)
    let preference = AutomaticPhotoSyncPreference()
    try store.setAutomaticPhotoSyncPreference(preference, uploadsPaused: true)
    automaticSyncPreference = preference
    automaticSyncFailure = nil
    refreshConsumerSyncSummary()
  }
  func setPhotoSyncForeground(_ active: Bool) {
    photoSyncForeground = active
    if active { kickAutomaticPhotoSync() }
    else {
      invalidateSavedVisualSearch()
      suspendAutomaticPhotoSync()
      backup.pause()
      journal.pause()
    }
  }
  private func suspendAutomaticPhotoSync(cancelBackground: Bool = false) {
    automaticSyncGeneration = UUID()
    automaticSyncNeedsScan = false
    automaticSyncObserver = nil
    if let task = automaticSyncTask {
      task.cancel()
      automaticSyncSettling = task
      automaticSyncTask = nil
      backup.pause()
      journal.pause(cancelBackground: cancelBackground)
    } else if cancelBackground {
      journal.pause(cancelBackground: true)
    }
  }
  func kickAutomaticPhotoSync(sourcesChanged: Bool = false) {
    if sourcesChanged { suspendAutomaticPhotoSync() }
    guard automaticPhotoSyncAdmitted else { suspendAutomaticPhotoSync(); return }
    if automaticSyncObserver == nil {
      #if DEBUG
        let observesLibrary = photosBackupSnapshot == nil
      #else
        let observesLibrary = true
      #endif
      if observesLibrary {
        automaticSyncObserver = AutomaticPhotoSyncObserver { [weak self] in
          self?.kickAutomaticPhotoSync(sourcesChanged: true)
        }
      }
    }
    automaticSyncNeedsScan = true
    guard automaticSyncTask == nil else { return }
    let token = UUID()
    automaticSyncGeneration = token
    let catalog = store
    let account = session.accountId
    let card = account.flatMap { session.pinnedCards[$0] }
    let generation = vault.generation
    let origin = BackgroundUploadPolicy.origin(api.baseURL)
    let previous = automaticSyncSettling
    automaticSyncSettling = nil
    automaticSyncTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.automaticSyncGeneration == token {
          self.automaticSyncTask = nil
          self.refreshConsumerSyncSummary()
        }
      }
      @MainActor func check() throws {
        try Task.checkCancellation()
        guard self.automaticSyncGeneration == token, self.automaticPhotoSyncAdmitted,
          self.store === catalog, self.session.accountId == account,
          account.flatMap({ self.session.pinnedCards[$0] }) == card,
          self.vault.generation == generation, BackgroundUploadPolicy.origin(self.api.baseURL) == origin else { throw CancellationError() }
      }
      do {
        await previous?.value
        await self.backup.waitUntilSettled()
        try await self.journal.waitUntilSettled()
        try check()
        while self.automaticSyncNeedsScan {
          self.automaticSyncNeedsScan = false
          try check()
          // Another device may already own these originals under different Photos identifiers.
          // Hydrate verified account records before the importer resolves their original digests.
          try await self.sync()
          try check()
          try self.startPhotosBackup(selection: nil, automatic: true)
          await self.backup.waitUntilSettled()
          try check()
          try self.captureLocalAnnotations(derivedOnly: true)
          await self.syncAnnotations(derivedOnly: true)
          try check()
          if self.backup.status.phase == .failed { break }
        }
        try check()
        if self.backup.status.phase != .failed && self.annotations.errors.isEmpty {
          self.automaticSyncFailure = nil
        }
      } catch is CancellationError {
      } catch {
        if self.automaticSyncGeneration == token { self.automaticSyncFailure = error.localizedDescription }
      }
    }
  }
  func waitForAutomaticPhotoSync() async { await automaticSyncTask?.value; await automaticSyncSettling?.value }
  private func startPhotosBackup(selection: [RecentPhotoSource]?, automatic: Bool) throws {
    guard session.isSignedIn else { throw FotoroError("Sign in to save your picks.") }
    guard !backup.isRunning, !journal.running else { throw FotoroError("Saving is already in progress.") }
    guard
      NativeBackupPolicy.allowsPrivatePhotos(accountId: session.accountId, fixture: session.fixture)
    else {
      throw FotoroError("Public test accounts cannot sync your Photos library. Use a real account.")
    }
    if let selection {
      guard !selection.isEmpty, Set(selection.map(\.id)).count == selection.count,
        selection.allSatisfy({ !$0.id.isEmpty && !$0.revision.isEmpty }) else {
        throw FotoroError("Choose photos to save.")
      }
    }
    guard let account = session.accountId else { throw FotoroError("Sign in first") }
    guard store.root.lastPathComponent == account else { throw FotoroError("Open this account before saving photos.") }
    let bundle = try vault.requireBundle()
    try store.setSyncIntent(enabled: false, uploadsPaused: false)
    if !automatic {
      consumerOffline = false
      consumerFailure = nil
    }
    refreshConsumerSyncSummary()
    let generation = vault.generation
    let origin = BackgroundUploadPolicy.origin(api.baseURL)
    let catalog = store
    let importWorker = importer
    let uploadJournal = journal
    let trustedCard = session.pinnedCards[account]
    var acceptedPicks: PhotoPicksSnapshot?
    @MainActor func sourceCurrent(_ source: BackupSource) -> Bool {
      guard automatic else { return true }
      guard self.automaticPhotoSyncAdmitted else { return false }
      #if DEBUG
        if let snapshot = self.photosBackupSnapshot {
          return (try? snapshot(.distantPast).contains(where: {
            $0.id == source.id && $0.sourceRevision == source.sourceRevision && $0.skipReason == nil
          })) == true
        }
      #endif
      guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
        !asset.isHidden, CameraMedia.sourceSkipReason(asset) == nil else { return false }
      return RecentPhoto.sourceRevision(asset) == source.sourceRevision
    }
    @MainActor func reconcile(_ candidates: [BackupCandidate]) async throws -> [BackupCandidate] {
      let existing = Dictionary(try catalog.backupSources().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      for (index, candidate) in candidates.enumerated() where candidate.skipReason == nil {
        if index.isMultiple(of: 128) { await Task.yield(); try Task.checkCancellation() }
        guard var source = existing[candidate.id] else { continue }
          if source.phase == .committed || (automatic && source.phase == .queued),
            source.sourceRevision != candidate.sourceRevision || source.originalSha256 == nil,
            let photo = try catalog.backupPhoto(source.photoId) {
            var digest: String?
            var oversized: CameraMediaAdmissionError?
            do { digest = try await importWorker.sourceDigest(candidate.id) }
            catch let error as CameraMediaAdmissionError { oversized = error }
            try Task.checkCancellation()
            guard self.vault.generation == generation, self.session.accountId == account,
              self.store === catalog, BackgroundUploadPolicy.origin(self.api.baseURL) == origin,
              self.session.pinnedCards[account] == trustedCard,
              !automatic || self.automaticPhotoSyncAdmitted else { throw CancellationError() }
            #if DEBUG
              let current: Bool
              if let snapshot = self.photosBackupSnapshot {
                current = (try? snapshot(automatic ? .distantPast : RecentPhotosPolicy.cutoff(now: Date())).contains(where: {
                  $0.id == candidate.id && $0.sourceRevision == candidate.sourceRevision && $0.skipReason == nil
                })) == true
              } else {
                current = PHAsset.fetchAssets(withLocalIdentifiers: [candidate.id], options: nil).firstObject.map {
                  RecentPhoto.sourceRevision($0) == candidate.sourceRevision && !($0.isHidden)
                } == true
              }
            #else
              let current = PHAsset.fetchAssets(withLocalIdentifiers: [candidate.id], options: nil).firstObject.map {
                RecentPhoto.sourceRevision($0) == candidate.sourceRevision && !($0.isHidden)
              } == true
            #endif
            guard current else { throw FotoroError("Photo changed during sync. Try again.") }
            if let oversized {
              if source.phase == .queued { source = try catalog.retainQueuedBackup(source, currentRevision: candidate.sourceRevision) }
              else { source.photoId = Wire.id() }
              source.phase = .skipped
              source.sourceRevision = candidate.sourceRevision
              source.originalSha256 = nil
              source.skipProcessor = "camera-original-v1"
              source.message = oversized.localizedDescription
              try catalog.putBackupSource(source)
              continue
            }
            guard let digest else { throw FotoroError("Original could not be verified") }
            if digest == photo.metadata.originalSha256 {
              source.sourceRevision = candidate.sourceRevision
              source.originalSha256 = digest
              source.message = nil
            } else {
              if automatic && source.phase == .queued {
                _ = try catalog.retainQueuedBackup(source, currentRevision: candidate.sourceRevision)
                continue
              }
              source.sourceRevision = automatic ? candidate.sourceRevision : nil
              source.message = "This Photos original changed. Its earlier backup is kept separately."
              if automatic {
                source.photoId = Wire.id()
                source.phase = .pending
                source.originalSha256 = nil
              }
            }
            try catalog.putBackupSource(source)
          }
        }
      return candidates
    }
    backup.start(
      snapshot: {
        if !automatic { await uploadJournal.resumePending() }
        try Task.checkCancellation()
        guard self.session.isSignedIn, self.vault.generation == generation, self.session.accountId == account,
          self.store === catalog, BackgroundUploadPolicy.origin(self.api.baseURL) == origin,
          !automatic || self.automaticPhotoSyncAdmitted else {
          throw CancellationError()
        }
        if !automatic, try !uploadJournal.entries().isEmpty {
          throw FotoroError(
            "An existing upload remains pending. Retry it before syncing more photos.")
        }
        #if DEBUG
          if let snapshot = self.photosBackupSnapshot {
            let candidates = try snapshot(automatic ? .distantPast : RecentPhotosPolicy.cutoff(now: Date()))
            if let selection { return try await reconcile(ReviewedPhotosBackupPolicy.select(candidates, selection: selection)) }
            return try await reconcile(candidates)
          }
        #endif
        let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard RecentPhotosPolicy.canRead(permission) else {
          throw FotoroError("Allow Photos access to sync.")
        }
        let assets: PHFetchResult<PHAsset>
        if let selection {
          assets = PHAsset.fetchAssets(withLocalIdentifiers: selection.map(\.id), options: nil)
        } else if automatic {
          let options = PHFetchOptions()
          options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
          assets = PHAsset.fetchAssets(with: options)
        } else {
          guard let recent = self.recentPhotos else {
            throw FotoroError("Open Photos to find your picks before syncing.")
          }
          let picks = try await recent.completedPicks()
          try Task.checkCancellation()
          guard self.vault.generation == generation, self.session.accountId == account,
            self.store === catalog, picks.matches(recent.pickCandidates),
            PhotoPickAnalyzer.isCurrent(picks.candidates) else { throw CancellationError() }
          acceptedPicks = picks
          let now = Date()
          let options = PHFetchOptions()
          options.predicate = NSPredicate(
            format: "creationDate >= %@ AND creationDate <= %@",
            RecentPhotosPolicy.cutoff(now: now) as NSDate, now as NSDate)
          options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
          assets = PHAsset.fetchAssets(with: options)
        }
        var candidates: [BackupCandidate] = []
        for index in 0..<assets.count {
          if index.isMultiple(of: 128) {
            await Task.yield()
            try Task.checkCancellation()
            guard self.vault.generation == generation, self.session.accountId == account,
              self.store === catalog, BackgroundUploadPolicy.origin(self.api.baseURL) == origin,
              RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
              !automatic || self.automaticPhotoSyncAdmitted else { throw CancellationError() }
          }
          let asset = assets.object(at: index)
          if (selection != nil || automatic) && asset.isHidden { continue }
          let skip = CameraMedia.sourceSkipReason(asset)
          candidates.append(
            BackupCandidate(
              id: asset.localIdentifier, capturedAt: asset.creationDate, skipReason: skip,
              sourceRevision: RecentPhoto.sourceRevision(asset)))
        }
        if let selection { candidates = try ReviewedPhotosBackupPolicy.select(candidates, selection: selection) }
        else if !automatic { candidates = PhotoPicksBackupPolicy.select(candidates, snapshot: acceptedPicks) }
        return try await reconcile(candidates)
      },
      valid: { [weak self] in
        guard let self else { return false }
        return self.session.isSignedIn && self.vault.isUnlocked && self.vault.generation == generation
          && self.session.accountId == account && self.store === catalog
          && self.session.pinnedCards[account] == trustedCard
          && BackgroundUploadPolicy.origin(self.api.baseURL) == origin
          && (!automatic || self.automaticPhotoSyncAdmitted)
      },
      stage: { [weak self] source, date in
        _ = try await importWorker.stageBackup(
          source, accountId: account, bundle: bundle, capturedAt: date,
          valid: { @MainActor [weak self] in
            guard let self, self.session.isSignedIn, self.vault.isUnlocked, self.vault.generation == generation,
              self.session.accountId == account, self.store === catalog,
              self.session.pinnedCards[account] == trustedCard,
              BackgroundUploadPolicy.origin(self.api.baseURL) == origin,
              !automatic || self.automaticPhotoSyncAdmitted,
              (try? catalog.uploadsPaused()) == false else { return false }
            #if DEBUG
              if let snapshot = self.photosBackupSnapshot {
                if automatic { return sourceCurrent(source) }
                guard let selection else { return true }
                guard let selected = selection.first(where: { $0.id == source.id }),
                  selected.revision == source.sourceRevision else { return false }
                return (try? ReviewedPhotosBackupPolicy.select(snapshot(RecentPhotosPolicy.cutoff(now: Date())), selection: [selected])) != nil
              }
            #endif
            if automatic {
              return sourceCurrent(source)
            }
            if let selection {
              guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
                let selected = selection.first(where: { $0.id == source.id }),
                selected.revision == source.sourceRevision,
                let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
                !asset.isHidden, CameraMedia.sourceSkipReason(asset) == nil else { return false }
              return RecentPhoto.sourceRevision(asset) == selected.revision
            }
            guard let picks = acceptedPicks, let recent = self.recentPhotos,
              picks.matches(recent.pickCandidates),
              let candidate = picks.candidates.first(where: { $0.id == source.id }),
              picks.revision(for: source.id) == source.sourceRevision else { return false }
            return PhotoPickAnalyzer.isCurrent([candidate])
          })
      },
      upload: { source in
        guard sourceCurrent(source) else { throw CancellationError() }
        await uploadJournal.resumePending(only: automatic ? [source.photoId] : nil)
        try Task.checkCancellation()
        guard let photo = try catalog.backupPhoto(source.photoId),
          ["committed", "saved"].contains(photo.transferState)
        else {
          throw FotoroError(
            uploadJournal.errors[source.photoId] ?? "Upload remains pending. Retry while online.")
        }
      },
      checkCatalog: { [weak self] in
        guard let self, self.store === catalog, self.vault.generation == generation else {
          throw CancellationError()
        }
        if !automatic {
          try self.captureLocalAnnotations()
          await self.syncAnnotations()
        }
        try await self.sync()
      }, checkCatalogOnlyAfterWork: automatic, restrictQueuedToSnapshot: automatic)
  }
  func resumeSavedAccount(initialRestoration: Bool = false) async {
    guard !session.fixture, let account = session.accountId else { return }
    var generation = vault.generation
    do {
      if !session.isSignedIn {
        guard initialRestoration, !UserDefaults.standard.bool(forKey: "fotoro.manualLock." + account),
          auth.hasRememberedPassword, !auth.isOpeningRememberedAccount else { return }
        generation = try await auth.openRememberedAccount()
        try Task.checkCancellation()
        guard session.accountId == account, vault.generation == generation, session.isSignedIn,
          !UserDefaults.standard.bool(forKey: "fotoro.manualLock." + account) else { throw CancellationError() }
        try activateAccount()
      } else if !vault.isUnlocked {
        guard initialRestoration, !UserDefaults.standard.bool(forKey: "fotoro.manualLock." + account) else { return }
        try await vault.unlock(.localKeychain)
        generation = vault.generation
        try activateAccount()
      }
      try store.setSyncEnabled(false)
      try reload()
      kickAutomaticPhotoSync()
    } catch {
      guard !Task.isCancelled, !(error is CancellationError), (error as? URLError)?.code != .cancelled,
        session.accountId == account, vault.generation == generation else { return }
      self.error = "Sign in to open your saved photos."
    }
  }
  func lockAccount() {
    if let account = session.accountId { UserDefaults.standard.set(true, forKey: "fotoro.manualLock." + account) }
    vault.lock()
    resetConsumerSyncObservation()
  }
  func pauseSync() {
    if automaticSyncPreference.enabled {
      automaticSyncPreference.paused = true
      do { try store.setAutomaticPhotoSyncPreference(automaticSyncPreference, uploadsPaused: true) }
      catch { self.error = error.localizedDescription }
    }
    suspendAutomaticPhotoSync(cancelBackground: true)
    syncIntent = UUID()
    do { try store.setSyncIntent(enabled: false, uploadsPaused: true) }
    catch { self.error = error.localizedDescription }
    backup.pause()
    journal.pause(cancelBackground: true)
    refreshConsumerSyncSummary()
  }
  func continueSync() async throws {
    guard session.isSignedIn || session.fixture else { throw FotoroError("Sign in to continue saving.") }
    guard vault.isUnlocked, let account = session.accountId else { throw FotoroError("Sign in first") }
    let generation = vault.generation
    let catalog = store
    let coordinator = backup
    let uploads = journal
    let intent = UUID()
    syncIntent = intent
    try catalog.setSyncIntent(enabled: false, uploadsPaused: false)
    consumerOffline = false
    consumerFailure = nil
    refreshConsumerSyncSummary()
    func check() throws {
      try Task.checkCancellation()
      guard session.isSignedIn || session.fixture,
        vault.isUnlocked, vault.generation == generation, store === catalog,
        backup === coordinator, journal === uploads, session.accountId == account,
        syncIntent == intent, try !catalog.uploadsPaused() else { throw CancellationError() }
    }
    await coordinator.waitUntilSettled()
    try check()
    try await uploads.waitUntilSettled()
    try check()
    try await resumeTransfers()
    try check()
    for var source in try catalog.backupSources() where source.phase == .queued {
      guard let photo = try catalog.backupPhoto(source.photoId), photo.manifest.ownerAccountId == account,
        ["committed", "saved"].contains(photo.transferState) else { continue }
      source.phase = .committed
      source.message = nil
      source.originalSha256 = photo.metadata.originalSha256
      try catalog.putBackupSource(source)
    }
    try coordinator.refreshCounts()
    await syncAnnotations()
    try check()
    try await sync()
  }
  func configureAPI(_ value: String) throws {
    guard let url = APIURLPolicy.configured(value, development: APIURLPolicy.developmentBuild)
    else { throw FotoroError("Use HTTPS or a loopback API") }
    journal.pause(cancelBackground: true)
    try BackgroundUploadTransport.shared.configure(accountId: nil, fixture: false, baseURL: api.baseURL)
    vault.lock()
    session.fixture = false
    session.bearerToken = nil
    api.baseURL = url
    UserDefaults.standard.set(url.absoluteString, forKey: "fotoro.api")
  }
  func loadMore() throws {
    guard let last = photos.last else { return }
    let page = try store.photos(after: last.id, limit: 1000)
    photos += page.filter { $0.manifest.ownerAccountId == session.accountId }
    try reloadAnnotations()
  }
  func reload() throws {
    guard vault.isUnlocked else { return }
    photos = try store.photos(limit: 1000).filter {
      $0.manifest.ownerAccountId == session.accountId
    }
    try reloadAnnotations()
    refreshConsumerSyncSummary()
  }
  #if DEBUG
    func fixtureUnlock(index: Int) async throws {
      journal.pause(cancelBackground: true)
      try BackgroundUploadTransport.shared.configure(accountId: nil, fixture: false, baseURL: api.baseURL)
      vault.lock()
      api.baseURL = URL(string: "http://127.0.0.1:8790")!
      let accounts: FixtureAccounts = try await api.get("/__fixtures/accounts")
      fixtureAccounts = accounts
      // Explicit public fixture account cards, never production server trust.
      for card in accounts.accounts { try session.pin(card) }
      session.fixture = true
      session.accountId = accounts.accounts[index].accountId
      UserDefaults.standard.set(session.accountId, forKey: "fotoro.fixtureAccount")
      try await vault.recover(secret: Data(b64: accounts.testSecrets[index].recoverySecret))
      try activateAccount()
      try await sync()
    }
  #endif
  func signOut(discardPending: Bool) throws {
    if try !discardPending && (!journal.entries().isEmpty || !annotations.ledger.pendingIDs().isEmpty) {
      throw FotoroError("Pending unsent imports will be removed. Confirm sign-out to discard them.")
    }
    journal.pause(cancelBackground: true)
    try BackgroundUploadTransport.shared.configure(accountId: nil, fixture: false, baseURL: api.baseURL)
    let root = store.root
    if let id = session.accountId {
      Keychain.remove("device-request-" + id)
      UserDefaults.standard.removeObject(forKey: "fotoro.manualLock." + id)
    }
    try vault.signOut()
    Keychain.remove("session")
    UserDefaults.standard.removeObject(forKey: "fotoro.account")
    UserDefaults.standard.removeObject(forKey: "fotoro.fixtureAccount")
    try? FileManager.default.removeItem(at: root)
  }
  func load(_ manifest: PhotoManifestV1, key: Data, original: Bool = false) async throws
    -> LocalPhoto
  {
    let authorizedAccount = session.accountId
    let generation = vault.generation
    let catalog = store
    guard manifest.version == 1 else { throw FotoroError("Unsupported photo version") }
    let meta = try await api.request("/v1/objects/\(manifest.metadataRepresentation.objectId)")
    try Task.checkCancellation()
    guard vault.isUnlocked, vault.generation == generation, store === catalog,
      session.accountId == authorizedAccount else { throw CancellationError() }
    let metadata = try Wire.decode(
      PhotoMetadataV1.self,
      crypto.decrypt(meta, key: key, representation: manifest.metadataRepresentation))
    guard metadata.version == 1,
      CameraMedia.supportedTypes.contains(metadata.mediaType),
      metadata.originalBytes > 0, metadata.originalBytes <= 50 * 1024 * 1024,
      try Data(b64: metadata.originalSha256).count == 32
    else { throw FotoroError("Unsupported original metadata") }
    var result = LocalPhoto(
      photoId: manifest.photoId, manifest: manifest, metadata: metadata,
      transferState: manifest.ownerAccountId == session.accountId ? "committed" : "received")
    for rep in manifest.representations {
      if (rep.binding.kind == "original" || rep.binding.kind == "preview") && !original { continue }
      guard let encoded = metadata.representationKeys[rep.binding.representationId] else {
        throw FotoroError("Representation key missing")
      }
      let bytes = try await api.request("/v1/objects/\(rep.objectId)")
      try Task.checkCancellation()
      let representationKey = try Data(b64: encoded)
      let plain = try await Task.detached {
        try CryptoAdapter().decrypt(bytes, key: representationKey, representation: rep)
      }.value
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, store === catalog,
        session.accountId == authorizedAccount
      else { throw CancellationError() }
      if rep.binding.kind == "original" {
        guard plain.digest == metadata.originalSha256, plain.count == metadata.originalBytes else {
          throw FotoroError("Original digest mismatch")
        }
        if metadata.mediaType == CameraMedia.liveType { _ = try CameraMedia.decodeLivePhoto(plain) }
        result.originalURL = try catalog.write(
          plain,
          name: "cache-" + manifest.photoId + "-original."
            + PhotoImport.originalExtension(for: metadata.mediaType))
      }
      if rep.binding.kind == "thumbnail" {
        result.thumbnailURL = try catalog.write(
          plain, name: "cache-" + manifest.photoId + "-thumbnail.jpg")
      }
      if rep.binding.kind == "preview" {
        result.previewURL = try catalog.write(
          plain, name: "cache-" + manifest.photoId + "-preview.jpg")
      }
    }
    return result
  }
  func ensurePreview(_ photo: LocalPhoto) async throws {
    if let url = photo.previewURL, FileManager.default.fileExists(atPath: url.path) { return }
    guard let rep = photo.manifest.representations.first(where: { $0.binding.kind == "preview" }),
      let key = photo.metadata.representationKeys[rep.binding.representationId]
    else { return }
    let account = session.accountId
    let generation = vault.generation
    let catalog = store
    let bytes = try await api.request("/v1/objects/\(rep.objectId)")
    let secret = try Data(b64: key)
    let plain = try await Task.detached {
      try CryptoAdapter().decrypt(bytes, key: secret, representation: rep)
    }.value
    try Task.checkCancellation()
    guard vault.isUnlocked, vault.generation == generation, store === catalog,
      session.accountId == account
    else {
      throw CancellationError()
    }
    let current: LocalPhoto?
    if photo.transferState == "received" {
      current = received.first { $0.id == photo.id && $0.transferState == "received" }
    } else {
      current = try consumerSavedPhoto(photo.id)
    }
    guard var updated = current, updated.manifest.photoId == photo.id,
      updated.metadata == photo.metadata, updated.manifest == photo.manifest else {
      throw CancellationError()
    }
    updated.previewURL = try catalog.write(plain, name: "cache-" + photo.photoId + "-preview.jpg")
    try catalog.put(updated)
    if let i = photos.firstIndex(where: { $0.id == photo.id }) { photos[i] = updated }
    else if photo.manifest.ownerAccountId == session.accountId { photos.append(updated) }
    if let i = received.firstIndex(where: { $0.id == photo.id }) { received[i] = updated }
    try reloadAnnotations()
  }
  func sync() async throws {
    guard photoAccountAccess != nil else { throw FotoroError("Open Fotoro before loading saved photos.") }
    let bundle = try vault.requireBundle()
    let started = ProcessInfo.processInfo.systemUptime
    var outcome = NativeDiagnosticOutcome.failed
    defer {
      diagnostics.record(NativeDiagnosticEvent(phase: .sync,
        outcome: outcome,
        elapsed: ProcessInfo.processInfo.systemUptime - started))
    }
    let authorizedAccount = session.accountId
    let generation = vault.generation
    let catalog = store
    let authorizedOrigin = api.origin
    let authorizedCard = authorizedAccount.flatMap { session.pinnedCards[$0] }
    func fence() throws {
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation,
        session.accountId == authorizedAccount, store === catalog, api.origin == authorizedOrigin,
        authorizedAccount.flatMap({ session.pinnedCards[$0] }) == authorizedCard
      else { throw CancellationError() }
    }
    consumerChecking = true
    refreshConsumerSyncSummary()
    defer {
      if vault.generation == generation, store === catalog, session.accountId == authorizedAccount {
        consumerChecking = false
        refreshConsumerSyncSummary()
      }
    }
    do {
    var more = true
    while more {
      try fence()
      let cursor = try catalog.cursor()
      let page: ChangePageV1 = try await api.get(
        "/v1/changes?limit=100&media=1" + (cursor.map { "&cursor=\($0)" } ?? ""))
      try fence()
      guard page.mediaVersion == 1 else {
        throw FotoroError("The photo service needs an update before sync can continue. Try again shortly.")
      }
      var verified: [String: LocalPhoto] = [:]
      var ownedChanges: [ChangeV1] = []
      for c in page.changes where c.entity == "photo" && !c.deleted {
        guard let signed = c.payload else { throw FotoroError("Missing signed change") }
        let card = try session.requireCard(signed.accountId)
        let manifest = try Wire.decode(
          PhotoManifestV1.self, crypto.verify(signed, card: card, kind: CameraMedia.acceptedManifestKind(signed)))
        guard manifest.photoId == c.entityId else { throw FotoroError("Catalog binding mismatch") }
        if manifest.ownerAccountId != session.accountId { continue }
        try fence()
        ownedChanges.append(c)
        verified[c.entityId] = try await load(
          manifest,
          key: crypto.unwrap(manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)))
      }
      try fence()
      let ownedPage = ChangePageV1(
        version: page.version,
        mediaVersion: page.mediaVersion,
        changes: ownedChanges + page.changes.filter { $0.deleted || $0.entity != "photo" },
        nextCursor: page.nextCursor, hasMore: page.hasMore)
      for change in page.changes where change.entity == "annotation" && !change.deleted {
        guard let signed = change.payload, let photo = try verified[change.entityId] ?? catalog.backupPhoto(change.entityId),
          photo.manifest.ownerAccountId == authorizedAccount else { throw FotoroError("Labels have no verified original") }
        try annotations.ledger.receive(signed, photo: photo, bundle: bundle, card: session.requireCard(signed.accountId))
      }
      try catalog.apply(ownedPage, verified: verified)
      more = page.hasMore
    }
    try fence()
    try reload()
    try hydrateLocalAnnotations()
    try fence()
    try await refreshSharedMoments()
    try fence()
    try catalog.setConsumerLastChecked(Date())
    consumerOffline = false
    consumerFailure = nil
    outcome = .completed
    } catch {
      outcome = .failure(for: error, taskCancelled: Task.isCancelled)
      if vault.generation == generation, store === catalog, session.accountId == authorizedAccount { recordConsumerSyncFailure(error) }
      throw error
    }
  }
  func bindLocalSearch(_ search: LocalSearchStore) {
    localSearch = search
    search.onRecordChanged = { [weak self] record, labelsChanged in
      guard let self else { return }
      let derivedOnly = self.automaticSyncPreference.enabled && !labelsChanged
      try self.captureLocalAnnotation(record, labelsChanged: labelsChanged, derivedOnly: derivedOnly)
      if derivedOnly, self.automaticPhotoSyncAdmitted {
        Task { [weak self] in await self?.syncAnnotations(derivedOnly: true) }
      }
    }
    search.onSnapshotReady = { [weak self] in
      try self?.hydrateLocalAnnotations()
      try self?.captureLocalAnnotations(derivedOnly: self?.automaticSyncPreference.enabled == true)
    }
  }
  private func reloadAnnotations() throws {
    guard vault.isUnlocked, let account = session.accountId else { photoAnnotations = [:]; return }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    var values: [String: PhotoAnnotationsV1] = [:]
    for photo in photos {
      if let value = try annotations.ledger.current(photo: photo, bundle: bundle, card: card) { values[photo.id] = value }
    }
    photoAnnotations = values
    consumerCatalogGeneration &+= 1
    refreshConsumerSyncSummary()
  }
  func annotation(_ photo: LocalPhoto) -> PhotoAnnotationsV1 {
    if let cached = photoAnnotations[photo.id] { return cached }
    if vault.isUnlocked, let account = session.accountId, let card = try? session.requireCard(account),
      let bundle = try? vault.requireBundle(),
      let current = try? annotations.ledger.current(photo: photo, bundle: bundle, card: card) { return current }
    return PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
  }
  func setLabels(_ labels: [String], photo: LocalPhoto) throws {
    guard let account = session.accountId else { throw FotoroError("Sign in first") }
    let bundle = try vault.requireBundle()
    var value = try annotations.ledger.current(photo: photo, bundle: bundle, card: session.requireCard(account)) ?? PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    value.labels = labels
    try annotations.ledger.edit(value, photo: photo, bundle: bundle, card: session.requireCard(account))
    try reloadAnnotations()
    try hydrateLocalAnnotations()
  }
  func searchCatalog(_ query: String, now: Date = Date(), calendar: Calendar = .current) async throws -> [LocalPhoto] {
    let generation = vault.generation
    let catalog = store
    guard let account = session.accountId else { throw FotoroError("Sign in first") }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    let ledger = annotations.ledger
    let parsed = NaturalDateQuery.parse(query, now: now, calendar: calendar)
    #if DEBUG
      let willRead = catalogSearchWillRead
    #endif
    let worker = Task.detached(priority: .userInitiated) {
      var matches: [LocalPhoto] = []
      var after: String?
      while true {
        try Task.checkCancellation()
        let page = try catalog.photos(after: after, limit: 1000)
        for photo in page where photo.manifest.ownerAccountId == account {
          #if DEBUG
            willRead?()
          #endif
          try Task.checkCancellation()
          if parsed.scope.from != nil || parsed.scope.until != nil {
            guard ["photos", "exif"].contains(photo.metadata.dateSource),
              let date = Wire.parseDate(photo.metadata.sourceDate), date.timeIntervalSince1970.isFinite,
              parsed.scope.from.map({ date >= $0 }) ?? true,
              parsed.scope.until.map({ date < $0 }) ?? true else { continue }
          }
          let value = try ledger.current(photo: photo, bundle: bundle, card: card)
          let scenes = SearchVisualPolicy.validated(value?.visual).map(\.label)
          let terms = [photo.metadata.filename] + (value?.labels ?? []) + (value?.keywords ?? []) + PhotoLocationFacts.userFacts(value?.facts) + (value?.location?.searchTerms ?? []) + [value?.caption ?? "", value?.ocr?.text ?? ""]
          if parsed.text.isEmpty || terms.contains(where: { SearchNormalization.text($0).contains(parsed.text) })
            || scenes.contains(where: { SearchNormalization.text($0).hasPrefix(parsed.text) }) { matches.append(photo) }
        }
        guard page.count == 1000, let last = page.last else { break }
        after = last.id
      }
      return matches
    }
    let result = try await withTaskCancellationHandler {
      try await worker.value
    } onCancel: {
      worker.cancel()
    }
    try Task.checkCancellation()
    guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { throw CancellationError() }
    return result
  }
  func matches(_ photo: LocalPhoto, query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let value = photoAnnotations[photo.id]
    return SearchVisualPolicy.validated(value?.visual).contains { SearchNormalization.text($0.label).hasPrefix(SearchNormalization.text(query)) }
      || ([photo.metadata.filename] + (value?.labels ?? []) + (value?.keywords ?? []) + PhotoLocationFacts.userFacts(value?.facts) + (value?.location?.searchTerms ?? []) + [value?.caption ?? "", value?.ocr?.text ?? ""])
      .contains { $0.localizedCaseInsensitiveContains(query) }
  }
  private func automaticDerivedSourceCurrent(_ source: BackupSource) -> Bool {
    #if DEBUG
      if let snapshot = photosBackupSnapshot {
        return (try? snapshot(.distantPast).contains(where: {
          $0.id == source.id && $0.sourceRevision == source.sourceRevision && $0.skipReason == nil
        })) == true
      }
    #endif
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
      !asset.isHidden, asset.mediaType == .image, !asset.mediaSubtypes.contains(.photoLive) else { return false }
    return RecentPhoto.sourceRevision(asset) == source.sourceRevision
      && AnnotationSourceBinding.permitsAutomaticDerived(resourceTypes: PHAssetResource.assetResources(for: asset).map(\.type))
  }
  private func automaticLocationSourceCurrent(_ source: BackupSource) -> Bool {
    #if DEBUG
      if let snapshot = photosBackupSnapshot {
        return (try? snapshot(.distantPast).contains(where: {
          $0.id == source.id && $0.sourceRevision == source.sourceRevision && $0.skipReason == nil
        })) == true
      }
    #endif
    guard RecentPhotosPolicy.canRead(automaticPhotosPermission),
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
      !asset.isHidden, CameraMedia.sourceSkipReason(asset) == nil else { return false }
    return source.sourceRevision != nil && RecentPhoto.sourceRevision(asset) == source.sourceRevision
  }
  private func captureLocalAnnotation(_ record: SearchRecord, labelsChanged: Bool, source knownSource: BackupSource? = nil, refreshSummary: Bool = true, derivedOnly: Bool = false) throws {
    guard vault.isUnlocked, let account = session.accountId,
      let source = try knownSource ?? store.backupSources().first(where: { $0.id == record.id }),
      source.id == record.id,
      AnnotationSourceBinding.accepts(sourceRevision: source.sourceRevision, recordRevision: record.revision),
      let photo = try store.backupPhoto(source.photoId) else { return }
    if derivedOnly, !automaticPhotoSyncAdmitted || !automaticDerivedSourceCurrent(source) { return }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    var value = try annotations.ledger.current(photo: photo, bundle: bundle, card: card) ?? PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    var hasCompletedDerivedResult = false
    if value.location == nil, RecentPhotosPolicy.canRead(automaticPhotosPermission),
      source.originalSha256 == photo.metadata.originalSha256,
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
      !asset.isHidden, RecentPhoto.sourceRevision(asset) == source.sourceRevision,
      let location = PhotoLocationV1.photos(asset.location) {
      try value.setLocation(location)
      hasCompletedDerivedResult = true
    }
    if !derivedOnly {
      if labelsChanged || value.labels == nil { value.labels = record.labels }
      if let caption = record.captions.first { value.caption = caption }
      if !record.keywords.isEmpty { value.keywords = record.keywords }
      // A hydrated index includes location search terms alongside supplied facts.
      // Keep the encrypted facts exact instead of recapturing that search overlay.
      if record.syncedAccountId == nil, !record.facts.isEmpty {
        let location = value.location
        value.facts = PhotoLocationFacts.userFacts(record.facts)
        if let location { try value.setLocation(location) }
      }
      value.favorite = record.favorite
    }
    let ocrStatus = record.syncedAccountId == nil ? record.ocrStatus : record.beforeSync?.ocrStatus
    if ocrStatus == .complete, record.processor == "vision-text-v1",
      RecentPhotosPolicy.canRead(automaticPhotosPermission), source.originalSha256 == photo.metadata.originalSha256 {
      hasCompletedDerivedResult = true
      value.ocr = PhotoAnnotationsV1.OCR(text: record.syncedAccountId == nil ? record.ocrText : record.beforeSync?.ocrText ?? "",
        confidence: record.syncedAccountId == nil ? record.ocrConfidence : record.beforeSync?.ocrConfidence ?? 0, processor: record.processor)
    }
    // Cloud overlays are searchable but never become fresh on-device inference.
    let visualStatus = record.syncedAccountId == nil ? record.visualStatus : record.beforeSync?.visualStatus
    let visualProcessor = record.syncedAccountId == nil ? record.visualProcessor : record.beforeSync?.visualProcessor
    let visualLabels = record.syncedAccountId == nil ? record.visualLabels : record.beforeSync?.visualLabels ?? []
    if SearchVisualPolicy.publicationEnabled, visualStatus == .complete, visualProcessor == SearchVisualPolicy.processor,
      RecentPhotosPolicy.canRead(automaticPhotosPermission), source.originalSha256 == photo.metadata.originalSha256 {
      hasCompletedDerivedResult = true
      value.visual = PhotoAnnotationsV1.Visual(processor: SearchVisualPolicy.processor,
        labels: SearchVisualPolicy.validated(visualLabels, processor: SearchVisualPolicy.processor).map {
          PhotoAnnotationsV1.Visual.Label(label: $0.label, identifier: $0.identifier, confidence: $0.confidence)
        })
    }
    guard !derivedOnly || hasCompletedDerivedResult else { return }
    try annotations.ledger.edit(value, photo: photo, bundle: bundle, card: card)
    photoAnnotations[photo.id] = value
    if refreshSummary { refreshConsumerSyncSummary() }
  }
  private func captureLocalAnnotations(derivedOnly: Bool = false) throws {
    guard let localSearch, vault.isUnlocked else { return }
    let sources = try store.backupSources()
    defer { refreshConsumerSyncSummary() }
    for source in sources {
      if let record = try localSearch.record(source.id) {
        try captureLocalAnnotation(record, labelsChanged: false, source: source, refreshSummary: false, derivedOnly: derivedOnly)
      }
    }
  }
  private func hydrateLocalAnnotations() throws {
    guard let localSearch, vault.isUnlocked, let account = session.accountId else { return }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    for source in try store.backupSources() {
      guard let photo = try store.backupPhoto(source.photoId),
        let value = try annotations.ledger.current(photo: photo, bundle: bundle, card: card) else { continue }
      try localSearch.applyAnnotations(value, source: source, accountId: account)
    }
  }
  func syncAnnotations(derivedOnly: Bool = false) async {
    guard session.isSignedIn || session.fixture,
      (try? store.uploadsPaused()) == false, vault.isUnlocked,
      let account = session.accountId, let bundle = try? vault.requireBundle(),
      let card = try? session.requireCard(account), !derivedOnly || automaticPhotoSyncAdmitted else { return }
    let generation = vault.generation
    let catalog = store
    let worker = annotations
    let origin = BackgroundUploadPolicy.origin(api.baseURL)
    await worker.resume(bundle: bundle, card: card, derivedOnly: derivedOnly, eligible: { [weak self] photo in
      guard derivedOnly else { return true }
      guard let self, self.automaticPhotoSyncAdmitted,
        let source = try? catalog.backupSources().first(where: { $0.photoId == photo.id }),
        source.originalSha256 == photo.metadata.originalSha256 else { return false }
      if let location = try? worker.ledger.current(photo: photo, bundle: bundle, card: card)?.location,
        ["photos", "exif"].contains(location.source), self.automaticLocationSourceCurrent(source) { return true }
      guard let record = try? self.localSearch?.record(source.id),
        AnnotationSourceBinding.accepts(sourceRevision: source.sourceRevision, recordRevision: record.revision) else { return false }
      return self.automaticDerivedSourceCurrent(source)
    }, valid: { [weak self] in
      guard let self else { return false }
      return (self.session.isSignedIn || self.session.fixture) && self.vault.isUnlocked && self.vault.generation == generation && self.session.accountId == account && self.store === catalog && (try? catalog.uploadsPaused()) == false
        && BackgroundUploadPolicy.origin(self.api.baseURL) == origin && self.session.pinnedCards[account] == card
        && (!derivedOnly || self.automaticPhotoSyncAdmitted)
    }, send: { signed in
      _ = try await self.api.request("/v1/photos/\(try Wire.decode(PhotoAnnotationsUpdateV1.self, Data(b64: signed.body)).photoId)/annotations", method: "PUT", body: Wire.encode(signed))
    })
    guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { return }
    do { try reloadAnnotations() } catch { self.error = error.localizedDescription }
  }
  func resolveAnnotationConflict(_ photo: LocalPhoto, keepLocal: Bool) async throws {
    let generation = vault.generation
    let account = session.accountId
    let catalog = store
    let bundle = try vault.requireBundle()
    let reply: PhotoAnnotationsReplyV1 = try await api.get("/v1/photos/\(photo.id)/annotations")
    guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { throw CancellationError() }
    guard reply.version == 1, let signed = reply.annotations else { throw FotoroError("Refresh labels before choosing a version") }
    try annotations.ledger.receive(signed, photo: photo, bundle: bundle, card: session.requireCard(signed.accountId))
    if try annotations.ledger.state(photo.id)?.conflict == true {
      try annotations.ledger.resolve(photo.id, keepLocal: keepLocal)
    }
    try reloadAnnotations()
    try hydrateLocalAnnotations()
    await syncAnnotations()
  }
  func importFiles(_ urls: [URL], publicSample: Bool = false) async throws {
    var permittedSample = false
    #if DEBUG
      permittedSample =
        publicSample && urls.count == 1
        && urls.first == Bundle.main.url(forResource: "singapore", withExtension: "jpg")
    #endif
    guard
      permittedSample
        || NativeBackupPolicy.allowsPrivatePhotos(
          accountId: session.accountId, fixture: session.fixture)
    else {
      throw FotoroError(
        "Public test accounts accept only the bundled public sample. Use a real account for your photos."
      )
    }
    try await importSelected(
      urls.map {
        SelectedResource(id: Wire.id(), origin: .file, resourceIdentifier: $0.path, fileURL: $0)
      }, publicSample: permittedSample)
  }
  func importPhotos(_ selected: [SelectedResource]) async throws {
    guard
      NativeBackupPolicy.allowsPrivatePhotos(accountId: session.accountId, fixture: session.fixture)
    else {
      throw FotoroError(
        "Public test accounts cannot import your Photos library. Use a real account.")
    }
    let generation = vault.generation
    let account = session.accountId
    let permission = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    guard vault.generation == generation, session.accountId == account else {
      throw CancellationError()
    }
    guard RecentPhotosPolicy.canRead(permission) else {
      throw FotoroError("Allow Photos access or choose original files.")
    }
    try await importSelected(selected)
  }
  private func importSelected(_ selected: [SelectedResource], publicSample: Bool = false)
    async throws
  {
    guard let account = session.accountId else { throw FotoroError("Sign in first") }
    let generation = vault.generation
    let catalog = store
    let worker = importer
    let transfers = journal
    let bundle = try vault.requireBundle()
    let result = try await worker.importResources(
      selected, accountId: account, bundle: bundle,
      valid: { @MainActor [weak self] in
        guard let self else { return false }
        return self.vault.isUnlocked && self.vault.generation == generation
          && self.session.accountId == account && self.store === catalog
      })
    guard vault.isUnlocked, vault.generation == generation, session.accountId == account,
      store === catalog
    else { throw CancellationError() }
    for photo in result { try transfers.enqueue(photo, publicSample: publicSample) }
    let messages = await worker.notices
    let failures = await worker.failures
    guard vault.generation == generation, store === catalog else { throw CancellationError() }
    notices = messages + failures.map { $0.message }
    try reload()
  }
  func resumeTransfers() async throws {
    guard session.isSignedIn || session.fixture else { throw FotoroError("Sign in to continue saving.") }
    guard try !store.uploadsPaused() else {
      throw FotoroError("Sync is paused. Continue sync to upload photos.")
    }
    if NativeBackupPolicy.allowsPrivatePhotos(
      accountId: session.accountId, fixture: session.fixture)
    {
      await journal.resumePending()
      return
    }
    #if DEBUG
      guard let sample = Bundle.main.url(forResource: "singapore", withExtension: "jpg") else {
        throw FotoroError("Public sample unavailable")
      }
      let digest = try Data(contentsOf: sample).digest
      let entries = try journal.entries()
      let allowed = Set(
        entries.filter {
          $0.publicSample == true && $0.photo.metadata.originalSha256 == digest
            && $0.photo.metadata.mediaType == "image/jpeg"
            && $0.photo.metadata.filename == "singapore.jpg"
        }.map { $0.photo.photoId })
      await journal.resumePending(only: allowed)
      if entries.contains(where: { !allowed.contains($0.photo.photoId) }) {
        throw FotoroError(
          "Private imports remain paused in this public test account. They have not been uploaded. Use a real account for your photos."
        )
      }
    #else
      if try !journal.entries().isEmpty {
        throw FotoroError(
          "Public test accounts cannot upload pending photos. Your queue is preserved.")
      }
    #endif
  }
  private func sharingAccess() throws -> SharingOperationAccess {
    guard let access = photoAccountAccess else { throw FotoroError("Open Fotoro before sharing photos.") }
    try Task.checkCancellation()
    return SharingOperationAccess(photo: access, cards: session.pinnedCards)
  }
  private func requireSharingAccess(_ access: SharingOperationAccess) throws {
    try Task.checkCancellation()
    guard photoAccountAccess == access.photo, session.pinnedCards == access.cards else { throw CancellationError() }
  }
  private func requireGrant(_ actual: GrantV1, matches expected: GrantV1, account: String) throws {
    guard actual.grantId == expected.grantId, actual.momentId == expected.momentId,
      actual.ownerAccountId == expected.ownerAccountId,
      actual.recipientAccountId == expected.recipientAccountId,
      actual.role == expected.role,
      [actual.ownerAccountId, actual.recipientAccountId].contains(account),
      expected.version > 0, actual.version >= expected.version, actual.revokedAt == nil,
      actual.expiresAt.map({ (Wire.parseDate($0) ?? .distantPast) > Date() }) ?? true else {
      throw FotoroError("This shared moment is no longer available. Ask the sender for a new invitation.")
    }
  }
  private func verifiedSharingCard(_ account: String, in detail: GrantDetailV1) throws -> AccountCardV1 {
    guard detail.version == 1 else { throw FotoroError("This photo invitation needs a newer Fotoro version.") }
    let trusted = try session.requireCard(account)
    guard detail.cards.first(where: { $0.accountId == account }) == trusted else {
      throw FotoroError("This person's Fotoro has changed. Open their new contact link before sharing.")
    }
    return trusted
  }
  func refreshSharedMoments() async throws {
    let access = try sharingAccess()
    let reading: (id: UUID, access: SharingOperationAccess, task: Task<GrantInboxV1, Error>)
    if let current = sharedInboxRead, current.access.photo == access.photo,
      current.access.cards == access.cards, !current.task.isCancelled { reading = current }
    else {
      cancelSharedMomentRefresh()
      let client = api
      reading = (UUID(), access, Task { try await client.get("/v1/grants") })
      sharedInboxRead = reading
    }
    defer { if sharedInboxRead?.id == reading.id { sharedInboxRead = nil } }
    let inbox = try await reading.task.value
    guard !reading.task.isCancelled else { throw CancellationError() }
    try requireSharingAccess(access)
    try applySharedInbox(inbox, account: access.account)
  }
  func cancelSharedMomentRefresh() {
    sharedInboxRead?.task.cancel()
    sharedInboxRead = nil
  }
  func withdrawExpiredReceivedMoment(now: Date = Date()) {
    guard let grant = selectedGrant, grant.revokedAt != nil ||
      grant.expiresAt.map({ (Wire.parseDate($0) ?? .distantPast) <= now }) == true else { return }
    received = []; selectedGrant = nil
  }
  func isReceivedGrantCurrent(_ expected: GrantV1) -> Bool {
    guard let current = selectedGrant, let access = photoAccountAccess else { return false }
    return (try? requireGrant(current, matches: expected, account: access.account)) != nil
  }
  private func applySharedInbox(_ inbox: GrantInboxV1, account: String) throws {
    guard inbox.version == 1 else { throw FotoroError("Shared photos need a newer Fotoro version.") }
    grants = inbox.grants.filter { $0.ownerAccountId == account || $0.recipientAccountId == account }
    guard let opened = selectedGrant else { return }
    guard let current = grants.first(where: { $0.grantId == opened.grantId }),
      (try? requireGrant(current, matches: opened, account: account)) != nil else {
      received = []; selectedGrant = nil
      return
    }
    selectedGrant = current
  }
  func openMoment(_ invitation: FotoroMomentInvitation) async throws {
    let access = try sharingAccess()
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(invitation.grantId)")
    try requireSharingAccess(access)
    guard detail.version == 1, detail.grant.grantId == invitation.grantId,
      detail.grant.ownerAccountId == invitation.senderCard.accountId,
      detail.grant.recipientAccountId == access.account,
      try session.requireCard(invitation.senderCard.accountId) == invitation.senderCard else {
      throw FotoroError("This invitation is for another Fotoro. Open the password for the invited Fotoro.")
    }
    try await receive(detail.grant)
  }
  func acceptContact(_ card: AccountCardV1, name: String) throws {
    let access = try sharingAccess()
    guard card.accountId != access.account else { throw FotoroError("This is your own Fotoro contact link.") }
    let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.count <= 80 else { throw FotoroError("Use a shorter contact name.") }
    _ = try FotoroShareLinks.validatePublicAccountCard(card)
    let secret = try Data(b64: vault.requireBundle().vaultKey)
    let wrapped = try crypto.wrap(try Wire.encode(["accountId": card.accountId, "name": value]), key: secret)
    let encoded = try Wire.encode(wrapped).b64
    try store.database.write { db in
      try db.execute(sql: "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        arguments: ["contact-name:" + card.accountId, encoded])
    }
    try session.pin(card)
  }
  func contactName(_ account: String) -> String {
    guard let raw = try? store.database.read({ db in
      try String.fetchOne(db, sql: "SELECT value FROM state WHERE key=?", arguments: ["contact-name:" + account])
    }), let secret = try? Data(b64: vault.requireBundle().vaultKey),
      let wrapped = try? Wire.decode(WrappedKeyV1.self, Data(b64: raw)),
      let plain = try? crypto.unwrap(wrapped, key: secret),
      let value = try? Wire.decode([String: String].self, plain), value["accountId"] == account,
      let name = value["name"], !name.isEmpty else { return "Contact " + account.suffix(8) }
    return name
  }
  func endSharedAccess(_ grant: GrantV1) async throws {
    let access = try sharingAccess()
    guard grant.ownerAccountId == access.account else { throw FotoroError("Only the sender can end access.") }
    _ = try await api.request("/v1/grants/\(grant.grantId)?media=1", method: "DELETE")
    try requireSharingAccess(access)
    try await refreshSharedMoments()
  }
  func share(_ selected: [LocalPhoto], recipient: AccountCardV1, temporary: Bool) async throws
    -> GrantV1
  {
    guard !selected.isEmpty, selected.count <= 100 else {
      throw FotoroError("Choose between 1 and 100 photos")
    }
    let access = try sharingAccess()
    try reload()
    let bundle = try vault.requireBundle()
    guard recipient.accountId != access.account,
      try session.requireCard(recipient.accountId) == recipient else {
      throw FotoroError("Choose a contact you've accepted in Fotoro.")
    }
    let current = try selected.map { p in
      guard let photo = try consumerSavedPhoto(p.id), photo.metadata == p.metadata,
        photo.manifest == p.manifest,
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Save these photos before sharing them in Fotoro.") }
      return photo
    }
    let moment = Wire.id()
    let grant: GrantV1 = try await api.post(
      "/v1/moments/\(moment)/grants/options",
      GrantOptions(
        recipientAccountId: recipient.accountId, role: "contributor",
        access: temporary ? "temporary" : "ongoing"))
    try requireSharingAccess(access)
    guard grant.ownerAccountId == access.account, grant.recipientAccountId == recipient.accountId,
      grant.momentId == moment else { throw FotoroError("Invitation does not match the chosen contact.") }
    let envelopes = try current.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: access.account,
        recipient: recipient, signingKey: Data(b64: bundle.signingSecretKey))
    }
    let signed = try crypto.sign(
      GrantBody(grant: grant, envelopes: envelopes), kind: "grant", accountId: access.account,
      secret: Data(b64: bundle.signingSecretKey))
    try requireSharingAccess(access)
    let created: GrantV1 = try await api.post(
      "/v1/moments/\(moment)/grants",
      CreateGrantV1(grant: grant, envelopes: envelopes, signedPayload: signed))
    try requireSharingAccess(access)
    try requireGrant(created, matches: grant, account: access.account)
    return created
  }
  func receive(_ grant: GrantV1) async throws {
    let access = try sharingAccess()
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)?media=1")
    try requireSharingAccess(access)
    guard detail.version == 1 else { throw FotoroError("This photo invitation needs a newer Fotoro version.") }
    try requireGrant(detail.grant, matches: grant, account: access.account)
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(access.account)
    var loaded: [LocalPhoto] = []
    for signed in detail.manifests {
      guard [detail.grant.ownerAccountId, detail.grant.recipientAccountId].contains(signed.accountId) else {
        throw FotoroError("This photo does not belong to this shared moment.")
      }
      let sender = try verifiedSharingCard(signed.accountId, in: detail)
      let manifest = try Wire.decode(
        PhotoManifestV1.self, crypto.verify(signed, card: sender, kind: CameraMedia.acceptedManifestKind(signed)))
      guard manifest.ownerAccountId == sender.accountId,
        let e = detail.envelopes.first(where: {
          $0.photoId == manifest.photoId && $0.recipientAccountId == recipient.accountId
        })
      else { continue }
      let key = try crypto.openShare(
        e, grantId: grant.grantId, photoId: manifest.photoId, sender: sender, recipient: recipient,
        boxSecret: Data(b64: bundle.boxSecretKey))
      loaded.append(try await load(manifest, key: key))
      try requireSharingAccess(access)
    }
    if grant.recipientAccountId == access.account {
      _ = try await api.request("/v1/grants/\(grant.grantId)/viewed", method: "POST")
      try requireSharingAccess(access)
    }
    received = loaded
    selectedGrant = detail.grant
  }
  func save(_ photo: LocalPhoto) async throws {
    let access = try sharingAccess()
    guard let grant = selectedGrant else { throw FotoroError("Select a shared moment") }
    guard received.contains(where: { $0.id == photo.id && $0.manifest == photo.manifest && $0.metadata == photo.metadata })
    else { throw FotoroError("Open this shared photo again before saving.") }
    let operationKey = "save-" + grant.grantId + "-" + photo.photoId
    if let pending = try store.existingOperation(operationKey, as: PendingSave.self) {
      try await finishSave(pending)
      return
    }
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)?media=1")
    try requireSharingAccess(access)
    guard detail.version == 1 else { throw FotoroError("This photo invitation needs a newer Fotoro version.") }
    try requireGrant(detail.grant, matches: grant, account: access.account)
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(access.account)
    guard
      let e = detail.envelopes.first(where: {
        $0.photoId == photo.photoId && $0.recipientAccountId == recipient.accountId
      })
    else { throw FotoroError("Missing save envelope") }
    let key = try crypto.openShare(
      e, grantId: grant.grantId, photoId: photo.photoId,
      sender: verifiedSharingCard(e.senderAccountId, in: detail), recipient: recipient,
      boxSecret: Data(b64: bundle.boxSecretKey))
    guard [grant.ownerAccountId, grant.recipientAccountId].contains(e.senderAccountId),
      let source = detail.manifests.first(where: { signed in
        guard signed.accountId == e.senderAccountId,
          let decoded = try? Wire.decode(PhotoManifestV1.self,
            crypto.verify(signed, card: verifiedSharingCard(e.senderAccountId, in: detail), kind: CameraMedia.acceptedManifestKind(signed))) else { return false }
        return decoded == photo.manifest
      }), source.accountId == photo.manifest.ownerAccountId else {
      throw FotoroError("This shared photo has changed. Open the invitation again.")
    }
    let verifiedOriginal = try await load(photo.manifest, key: key, original: true)
    try requireSharingAccess(access)
    guard let original = verifiedOriginal.originalURL,
      try Data(contentsOf: original).digest == photo.metadata.originalSha256
    else { throw FotoroError("Verify original before saving") }
    let input: PendingSave = try store.operation(operationKey) {
      var manifest = photo.manifest
      manifest.photoId = Wire.id()
      manifest.ownerAccountId = recipient.accountId
      manifest.ownerWrappedMetadataKey = try crypto.wrap(key, key: Data(b64: bundle.vaultKey))
      let signed = try crypto.sign(
        manifest, kind: CameraMedia.manifestKind(for: photo.metadata.mediaType), accountId: recipient.accountId,
        secret: Data(b64: bundle.signingSecretKey))
      let save = SavedPhotoV1(
        operationId: Wire.id(), photoId: manifest.photoId, sourceGrantId: grant.grantId,
        sourcePhotoId: photo.photoId, manifest: manifest, signedPayload: signed)
      return PendingSave(
        request: SaveRequestV1(expectedGrantVersion: detail.grant.version, save: save),
        local: verifiedOriginal)
    }
    try await finishSave(input)
  }
  func resumeSaves() async throws {
    for pending in try store.operations(prefix: "save-", as: PendingSave.self) {
      try await finishSave(pending)
    }
  }
  private func finishSave(_ pending: PendingSave) async throws {
    let access = try sharingAccess()
    let catalog = store
    guard pending.request.save.manifest.ownerAccountId == access.account else { throw CancellationError() }
    _ = try vault.requireBundle()
    let saved: SavedPhotoV1 = try await api.post("/v1/saves", pending.request)
    try requireSharingAccess(access)
    let manifest = try Wire.decode(PhotoManifestV1.self,
      crypto.verify(saved.signedPayload, card: session.requireCard(access.account), kind: CameraMedia.acceptedManifestKind(saved.signedPayload)))
    guard saved.version == 1, saved.operationId == pending.request.save.operationId,
      saved.photoId == pending.request.save.photoId,
      saved.sourceGrantId == pending.request.save.sourceGrantId,
      saved.sourcePhotoId == pending.request.save.sourcePhotoId,
      saved.manifest == pending.request.save.manifest, manifest == saved.manifest else {
      throw FotoroError("The saved-photo receipt could not be verified. Try again.")
    }
    var local = pending.local
    local.photoId = saved.photoId
    local.manifest = saved.manifest
    local.transferState = "saved"
    try catalog.put(local)
    try reload()
  }
  func contribute(_ photos: [LocalPhoto]) async throws {
    guard let grant = selectedGrant, grant.role == "contributor", !photos.isEmpty, photos.count <= 100 else {
      throw FotoroError("An active contributor grant is required")
    }
    let access = try sharingAccess()
    try reload()
    let bundle = try vault.requireBundle()
    let recipientID = grant.ownerAccountId == access.account ? grant.recipientAccountId : grant.ownerAccountId
    let recipient = try session.requireCard(recipientID)
    let committed = try photos.map { selected in
      guard let photo = try consumerSavedPhoto(selected.id), photo.metadata == selected.metadata,
        photo.manifest == selected.manifest,
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Upload must commit before contribution") }
      return photo
    }
    let manifests = try committed.map { photo in
      try crypto.sign(
        photo.manifest, kind: CameraMedia.manifestKind(for: photo.metadata.mediaType), accountId: access.account,
        secret: Data(b64: bundle.signingSecretKey))
    }
    let envelopes = try committed.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: access.account,
        recipient: recipient, signingKey: Data(b64: bundle.signingSecretKey))
    }
    let input: ContributionV1 = try store.operation(
      "contribute-" + grant.grantId + "-" + committed.map { $0.id }.sorted().joined(separator: "-")
    ) {
      ContributionV1(
        operationId: Wire.id(), expectedGrantVersion: grant.version, manifests: manifests,
        envelopes: envelopes)
    }
    let _: ContributionResult = try await api.post(
      "/v1/moments/\(grant.momentId)/contributions", input)
    try requireSharingAccess(access)
  }
  @discardableResult
  func run(phase: NativeDiagnosticPhase? = nil, _ action: @escaping @MainActor () async throws -> Void) -> Task<Void, Never>? {
    guard !busy else { return nil }
    busy = true
    error = nil
    let started = ProcessInfo.processInfo.systemUptime
    if let phase { diagnostics.record(NativeDiagnosticEvent(phase: phase, outcome: .started)) }
    return Task {
      var outcome = NativeDiagnosticOutcome.completed
      var passkeyError: NativePasskeyError?
      defer {
        busy = false
        refreshConsumerSyncSummary()
        if let phase {
          diagnostics.record(NativeDiagnosticEvent(phase: phase, outcome: outcome,
            elapsed: ProcessInfo.processInfo.systemUptime - started,
            authorizationCode: phase == .auth ? passkeyError?.code : nil))
        }
      }
      do {
        try Task.checkCancellation()
        try await action()
        if Task.isCancelled { outcome = .cancelled }
      } catch {
        outcome = .failure(for: error, taskCancelled: Task.isCancelled)
        passkeyError = error as? NativePasskeyError
        if outcome == .cancelled { return }
        recordConsumerSyncFailure(error)
        self.error = error.localizedDescription
      }
    }
  }
}
