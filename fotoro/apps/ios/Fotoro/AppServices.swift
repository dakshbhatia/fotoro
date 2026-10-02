import Foundation
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
  let storageRoot: URL
  var photos: [LocalPhoto] = []
  var received: [LocalPhoto] = []
  var grants: [GrantV1] = []
  var error: String?
  var notices: [String] = []
  var busy = false
  var fixtureAccounts: FixtureAccounts?
  var selectedGrant: GrantV1?
  #if DEBUG
    @ObservationIgnored var consumerShareDidWrite: ((URL) -> Void)?
    @ObservationIgnored var catalogSearchWillRead: (@Sendable () -> Void)?
    @ObservationIgnored var photosBackupSnapshot: ((Date) throws -> [BackupCandidate])?
  #endif
  private(set) var consumerSyncSummary = ConsumerSyncSummary()
  private(set) var consumerCatalogGeneration: UInt64 = 0
  @ObservationIgnored private var diagnosticAccountState: NativeDiagnosticAccountState?
  @ObservationIgnored private var consumerObservation = UUID()
  @ObservationIgnored private var syncIntent = UUID()
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
    if let account {
      guard vault.isUnlocked, vault.generation == generation, store === catalog, session.accountId == account else { throw CancellationError() }
      saved = try await searchCatalog(query).filter { ["committed", "saved"].contains($0.transferState) }
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
        result.append(ConsumerSearchHit(photo: .saved(photo.id), evidence: "Saved photo"))
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
      let sources = try store.backupSources()
      let entries = try journal.entries().filter { $0.photo.manifest.ownerAccountId == account }
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
      facts.failed = backup.status.failed + journal.errors.count + annotations.errors.count + (consumerFailure == nil ? 0 : 1)
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
    importer = PhotoImport(store: initialStore)
    journal = TransferJournal(store: initialStore, api: api, vault: vault)
    annotations = AnnotationSync(ledger: AnnotationLedger(store: initialStore, accountId: session.accountId ?? "locked"))
    if session.accountId != nil {
      try BackgroundUploadTransport.shared.configure(accountId: session.accountId, fixture: session.fixture, baseURL: api.baseURL)
    }
    ImageCache.shared.costLimit = 48 * 1024 * 1024
    vault.onLock = { [weak self] in
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
  func activateAccount() throws {
    backup.pause()
    guard let id = session.accountId else { throw FotoroError("Authenticate first") }
    if store.root.lastPathComponent != id { localSearch?.clearSyncedAnnotations() }
    journal.pause(cancelBackground: store.root.lastPathComponent != id)
    store = try LibraryStore(root: storageRoot.appendingPathComponent(id))
    try store.setSyncEnabled(false)
    backup = try PhotosBackup(store: store)
    importer = PhotoImport(store: store)
    journal = TransferJournal(store: store, api: api, vault: vault)
    annotations = AnnotationSync(ledger: AnnotationLedger(store: store, accountId: id))
    try BackgroundUploadTransport.shared.configure(accountId: id, fixture: session.fixture, baseURL: api.baseURL)
    UserDefaults.standard.removeObject(forKey: "fotoro.manualLock." + id)
    photoAnnotations = [:]
    try reload()
    try hydrateLocalAnnotations()
    resetConsumerSyncObservation()
  }
  func startPhotosBackup(selection: [RecentPhotoSource]? = nil) throws {
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
    consumerOffline = false
    consumerFailure = nil
    refreshConsumerSyncSummary()
    let generation = vault.generation
    let catalog = store
    let importWorker = importer
    let uploadJournal = journal
    var acceptedPicks: PhotoPicksSnapshot?
    backup.start(
      snapshot: {
        await uploadJournal.resumePending()
        try Task.checkCancellation()
        guard self.session.isSignedIn, self.vault.generation == generation, self.session.accountId == account,
          self.store === catalog else {
          throw CancellationError()
        }
        if try !uploadJournal.entries().isEmpty {
          throw FotoroError(
            "An existing upload remains pending. Retry it before syncing more photos.")
        }
        #if DEBUG
          if let snapshot = self.photosBackupSnapshot {
            let candidates = try snapshot(RecentPhotosPolicy.cutoff(now: Date()))
            if let selection { return try ReviewedPhotosBackupPolicy.select(candidates, selection: selection) }
            return candidates
          }
        #endif
        let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard RecentPhotosPolicy.canRead(permission) else {
          throw FotoroError("Allow Photos access to sync.")
        }
        let assets: PHFetchResult<PHAsset>
        if let selection {
          assets = PHAsset.fetchAssets(withLocalIdentifiers: selection.map(\.id), options: nil)
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
        assets.enumerateObjects { asset, _, _ in
          if selection != nil && (asset.isHidden || asset.mediaType != .image) { return }
          let skip =
            asset.mediaType != .image
            ? "Video is not backed up."
            : asset.mediaSubtypes.contains(.photoLive) ? "Live Photo pairs are not backed up." : nil
          candidates.append(
            BackupCandidate(
              id: asset.localIdentifier, capturedAt: asset.creationDate, skipReason: skip,
              sourceRevision: RecentPhoto.sourceRevision(asset)))
        }
        if let selection { candidates = try ReviewedPhotosBackupPolicy.select(candidates, selection: selection) }
        else { candidates = PhotoPicksBackupPolicy.select(candidates, snapshot: acceptedPicks) }
        for candidate in candidates where candidate.skipReason == nil {
          var source = try catalog.backupSource(candidate.id)
          if source.phase == .committed, source.sourceRevision != candidate.sourceRevision || source.originalSha256 == nil,
            let photo = try catalog.backupPhoto(source.photoId) {
            let digest = try await importWorker.sourceDigest(candidate.id)
            try Task.checkCancellation()
            guard self.vault.generation == generation, self.session.accountId == account else { throw CancellationError() }
            guard let current = PHAsset.fetchAssets(withLocalIdentifiers: [candidate.id], options: nil).firstObject,
              RecentPhoto.sourceRevision(current) == candidate.sourceRevision else { throw FotoroError("Photo changed during sync. Try again.") }
            if digest == photo.metadata.originalSha256 {
              source.sourceRevision = candidate.sourceRevision
              source.originalSha256 = digest
            } else {
              source.sourceRevision = nil
              source.message = "This Photos original changed. Its earlier backup is kept separately."
            }
            try catalog.putBackupSource(source)
          }
        }
        return candidates
      },
      valid: { [weak self] in
        guard let self else { return false }
        return self.session.isSignedIn && self.vault.isUnlocked && self.vault.generation == generation
          && self.session.accountId == account && self.store === catalog
      },
      stage: { [weak self] source, date in
        _ = try await importWorker.stageBackup(
          source, accountId: account, bundle: bundle, capturedAt: date,
          valid: { @MainActor [weak self] in
            guard let self, self.session.isSignedIn, self.vault.isUnlocked, self.vault.generation == generation,
              self.session.accountId == account, self.store === catalog,
              (try? catalog.uploadsPaused()) == false else { return false }
            #if DEBUG
              if let snapshot = self.photosBackupSnapshot {
                guard let selection else { return true }
                guard let selected = selection.first(where: { $0.id == source.id }),
                  selected.revision == source.sourceRevision else { return false }
                return (try? ReviewedPhotosBackupPolicy.select(snapshot(RecentPhotosPolicy.cutoff(now: Date())), selection: [selected])) != nil
              }
            #endif
            if let selection {
              guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
                let selected = selection.first(where: { $0.id == source.id }),
                selected.revision == source.sourceRevision,
                let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
                !asset.isHidden, asset.mediaType == .image else { return false }
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
        await uploadJournal.resumePending()
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
        try self.captureLocalAnnotations()
        await self.syncAnnotations()
        try await self.sync()
      })
  }
  func resumeSavedAccount(initialRestoration: Bool = false) async {
    guard session.isSignedIn, !session.fixture else { return }
    do {
      if !vault.isUnlocked {
        guard initialRestoration, let account = session.accountId, !UserDefaults.standard.bool(forKey: "fotoro.manualLock." + account) else { return }
        try await vault.unlock(.localKeychain)
        try activateAccount()
      }
      try store.setSyncEnabled(false)
      try reload()
    } catch {
      self.error = "Sign in to open your saved photos."
    }
  }
  func lockAccount() {
    if let account = session.accountId { UserDefaults.standard.set(true, forKey: "fotoro.manualLock." + account) }
    vault.lock()
    resetConsumerSyncObservation()
  }
  func pauseSync() {
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
      store = try LibraryStore(root: storageRoot.appendingPathComponent(session.accountId!))
      backup = try PhotosBackup(store: store)
      importer = PhotoImport(store: store)
      journal = TransferJournal(store: store, api: api, vault: vault)
      annotations = AnnotationSync(ledger: AnnotationLedger(store: store, accountId: session.accountId!))
      try await vault.recover(secret: Data(b64: accounts.testSecrets[index].recoverySecret))
      try reload()
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
    let metadata = try Wire.decode(
      PhotoMetadataV1.self,
      crypto.decrypt(meta, key: key, representation: manifest.metadataRepresentation))
    guard metadata.version == 1,
      ["image/jpeg", "image/png", "image/heic"].contains(metadata.mediaType),
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
      let representationKey = try Data(b64: encoded)
      let plain = try await Task.detached {
        try CryptoAdapter().decrypt(bytes, key: representationKey, representation: rep)
      }.value
      guard vault.isUnlocked, vault.generation == generation, store === catalog,
        session.accountId == authorizedAccount
      else { throw FotoroError("Vault locked during download") }
      if rep.binding.kind == "original" {
        guard plain.digest == metadata.originalSha256, plain.count == metadata.originalBytes else {
          throw FotoroError("Original digest mismatch")
        }
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
    func fence() throws {
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation,
        session.accountId == authorizedAccount, store === catalog
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
        "/v1/changes?limit=100" + (cursor.map { "&cursor=\($0)" } ?? ""))
      guard vault.isUnlocked, vault.generation == generation, session.accountId == authorizedAccount
      else {
        throw FotoroError("Vault changed during sync")
      }
      var verified: [String: LocalPhoto] = [:]
      var ownedChanges: [ChangeV1] = []
      for c in page.changes where c.entity == "photo" && !c.deleted {
        guard let signed = c.payload else { throw FotoroError("Missing signed change") }
        let card = try session.requireCard(signed.accountId)
        let manifest = try Wire.decode(
          PhotoManifestV1.self, crypto.verify(signed, card: card, kind: "photo-manifest"))
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
    let inbox: GrantInboxV1 = try await api.get("/v1/grants")
    try fence()
    grants = inbox.grants
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
      try self?.captureLocalAnnotation(record, labelsChanged: labelsChanged)
    }
    search.onSnapshotReady = { [weak self] in
      try self?.hydrateLocalAnnotations()
      try self?.captureLocalAnnotations()
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
  func searchCatalog(_ query: String) async throws -> [LocalPhoto] {
    let generation = vault.generation
    let catalog = store
    guard let account = session.accountId else { throw FotoroError("Sign in first") }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    let ledger = annotations.ledger
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
          let value = try ledger.current(photo: photo, bundle: bundle, card: card)
          let terms = [photo.metadata.filename] + (value?.labels ?? []) + (value?.keywords ?? []) + (value?.facts ?? []) + [value?.caption ?? "", value?.ocr?.text ?? ""]
          if terms.contains(where: { $0.localizedCaseInsensitiveContains(query) }) { matches.append(photo) }
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
    return ([photo.metadata.filename] + (value?.labels ?? []) + (value?.keywords ?? []) + (value?.facts ?? []) + [value?.caption ?? "", value?.ocr?.text ?? ""])
      .contains { $0.localizedCaseInsensitiveContains(query) }
  }
  private func captureLocalAnnotation(_ record: SearchRecord, labelsChanged: Bool, source knownSource: BackupSource? = nil, refreshSummary: Bool = true) throws {
    guard vault.isUnlocked, let account = session.accountId,
      let source = try knownSource ?? store.backupSources().first(where: { $0.id == record.id }),
      source.id == record.id,
      AnnotationSourceBinding.accepts(sourceRevision: source.sourceRevision, recordRevision: record.revision),
      let photo = try store.backupPhoto(source.photoId) else { return }
    let bundle = try vault.requireBundle()
    let card = try session.requireCard(account)
    var value = try annotations.ledger.current(photo: photo, bundle: bundle, card: card) ?? PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    if labelsChanged || value.labels == nil { value.labels = record.labels }
    if let caption = record.captions.first { value.caption = caption }
    if !record.keywords.isEmpty { value.keywords = record.keywords }
    if !record.facts.isEmpty { value.facts = record.facts }
    value.favorite = record.favorite
    if record.ocrStatus == .complete {
      value.ocr = PhotoAnnotationsV1.OCR(text: record.ocrText, confidence: record.ocrConfidence, processor: record.processor)
    }
    try annotations.ledger.edit(value, photo: photo, bundle: bundle, card: card)
    photoAnnotations[photo.id] = value
    if refreshSummary { refreshConsumerSyncSummary() }
  }
  private func captureLocalAnnotations() throws {
    guard let localSearch, vault.isUnlocked else { return }
    let sources = try store.backupSources()
    defer { refreshConsumerSyncSummary() }
    for source in sources {
      if let record = try localSearch.record(source.id) {
        try captureLocalAnnotation(record, labelsChanged: false, source: source, refreshSummary: false)
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
  func syncAnnotations() async {
    guard session.isSignedIn || session.fixture,
      (try? store.uploadsPaused()) == false, vault.isUnlocked,
      let account = session.accountId, let bundle = try? vault.requireBundle(),
      let card = try? session.requireCard(account) else { return }
    let generation = vault.generation
    let catalog = store
    let worker = annotations
    await worker.resume(bundle: bundle, card: card, valid: { [weak self] in
      guard let self else { return false }
      return (self.session.isSignedIn || self.session.fixture) && self.vault.isUnlocked && self.vault.generation == generation && self.session.accountId == account && self.store === catalog && (try? catalog.uploadsPaused()) == false
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
  func share(_ selected: [LocalPhoto], recipient: AccountCardV1, temporary: Bool) async throws
    -> GrantV1
  {
    guard !selected.isEmpty, selected.count <= 100 else {
      throw FotoroError("Choose between 1 and 100 photos")
    }
    try await resumeTransfers()
    try reload()
    let bundle = try vault.requireBundle()
    let moment = Wire.id()
    let grant: GrantV1 = try await api.post(
      "/v1/moments/\(moment)/grants/options",
      GrantOptions(
        recipientAccountId: recipient.accountId, role: "contributor",
        access: temporary ? "temporary" : "ongoing"))
    let current = try selected.map { p in
      guard let photo = photos.first(where: { $0.id == p.id }),
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Upload must commit before sharing") }
      return photo
    }
    let envelopes = try current.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: session.accountId!,
        recipient: recipient, signingKey: Data(b64: bundle.signingSecretKey))
    }
    let signed = try crypto.sign(
      GrantBody(grant: grant, envelopes: envelopes), kind: "grant", accountId: session.accountId!,
      secret: Data(b64: bundle.signingSecretKey))
    return try await api.post(
      "/v1/moments/\(moment)/grants",
      CreateGrantV1(grant: grant, envelopes: envelopes, signedPayload: signed))
  }
  func receive(_ grant: GrantV1) async throws {
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)")
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(session.accountId!)
    var loaded: [LocalPhoto] = []
    for signed in detail.manifests {
      let sender = try session.requireCard(signed.accountId)
      let manifest = try Wire.decode(
        PhotoManifestV1.self, crypto.verify(signed, card: sender, kind: "photo-manifest"))
      guard manifest.ownerAccountId == sender.accountId,
        let e = detail.envelopes.first(where: {
          $0.photoId == manifest.photoId && $0.recipientAccountId == recipient.accountId
        })
      else { continue }
      let key = try crypto.openShare(
        e, grantId: grant.grantId, photoId: manifest.photoId, sender: sender, recipient: recipient,
        boxSecret: Data(b64: bundle.boxSecretKey))
      loaded.append(try await load(manifest, key: key))
    }
    received = loaded
    selectedGrant = detail.grant
    if grant.recipientAccountId == session.accountId {
      _ = try await api.request("/v1/grants/\(grant.grantId)/viewed", method: "POST")
    }
  }
  func save(_ photo: LocalPhoto) async throws {
    guard let grant = selectedGrant else { throw FotoroError("Select a shared moment") }
    let operationKey = "save-" + grant.grantId + "-" + photo.photoId
    if let pending = try store.existingOperation(operationKey, as: PendingSave.self) {
      try await finishSave(pending)
      return
    }
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)")
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(session.accountId!)
    guard
      let e = detail.envelopes.first(where: {
        $0.photoId == photo.photoId && $0.recipientAccountId == recipient.accountId
      })
    else { throw FotoroError("Missing save envelope") }
    let key = try crypto.openShare(
      e, grantId: grant.grantId, photoId: photo.photoId,
      sender: session.requireCard(e.senderAccountId), recipient: recipient,
      boxSecret: Data(b64: bundle.boxSecretKey))
    let verifiedOriginal = try await load(photo.manifest, key: key, original: true)
    guard let original = verifiedOriginal.originalURL,
      try Data(contentsOf: original).digest == photo.metadata.originalSha256
    else { throw FotoroError("Verify original before saving") }
    let input: PendingSave = try store.operation(operationKey) {
      var manifest = photo.manifest
      manifest.photoId = Wire.id()
      manifest.ownerAccountId = recipient.accountId
      manifest.ownerWrappedMetadataKey = try crypto.wrap(key, key: Data(b64: bundle.vaultKey))
      let signed = try crypto.sign(
        manifest, kind: "photo-manifest", accountId: recipient.accountId,
        secret: Data(b64: bundle.signingSecretKey))
      let save = SavedPhotoV1(
        operationId: Wire.id(), photoId: manifest.photoId, sourceGrantId: grant.grantId,
        sourcePhotoId: photo.photoId, manifest: manifest, signedPayload: signed)
      return PendingSave(
        request: SaveRequestV1(expectedGrantVersion: grant.version, save: save),
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
    _ = try vault.requireBundle()
    let saved: SavedPhotoV1 = try await api.post("/v1/saves", pending.request)
    var local = pending.local
    local.photoId = saved.photoId
    local.manifest = saved.manifest
    local.transferState = "saved"
    try store.put(local)
    try reload()
  }
  func contribute(_ photos: [LocalPhoto]) async throws {
    guard let grant = selectedGrant, grant.role == "contributor", photos.count <= 100 else {
      throw FotoroError("An active contributor grant is required")
    }
    try await resumeTransfers()
    try reload()
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(grant.ownerAccountId)
    let committed = try photos.map { selected in
      guard let photo = self.photos.first(where: { $0.id == selected.id }),
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Upload must commit before contribution") }
      return photo
    }
    let manifests = try committed.map { photo in
      try crypto.sign(
        photo.manifest, kind: "photo-manifest", accountId: session.accountId!,
        secret: Data(b64: bundle.signingSecretKey))
    }
    let envelopes = try committed.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: session.accountId!,
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
        recordConsumerSyncFailure(error)
        self.error = error.localizedDescription
      }
    }
  }
}
