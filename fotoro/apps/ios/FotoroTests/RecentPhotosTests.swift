import Photos
import XCTest

@testable import Fotoro

final class RecentPhotosTests: XCTestCase {
  @MainActor func testUnavailableSavedPreviewCanRetryWithoutUploadingOrReplacingTheOriginal() async throws {
    let services = try await previewServices()
    defer { services.vault.lock(); Keychain.remove(services.session.accountId!); try? FileManager.default.removeItem(at: services.storageRoot) }
    let (photo, cipher, plain) = try previewPhoto(owner: services.session.accountId!)
    try services.store.put(photo)
    let objectID = photo.manifest.representations[0].objectId
    defer { PreviewDownloadProtocol.registry.remove(objectID) }
    let unavailable = PreviewDownloadGate(bytes: cipher, started: expectation(description: "Unavailable preview"), error: URLError(.notConnectedToInternet))
    unavailable.release.signal()
    PreviewDownloadProtocol.registry.set(unavailable, id: objectID)
    do { try await services.ensurePreview(photo); XCTFail("The first preview should report unavailable") }
    catch { XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet) }
    XCTAssertNil(try services.consumerSavedPhoto(photo.id)?.previewURL)

    let available = PreviewDownloadGate(bytes: cipher, started: expectation(description: "Retried preview"))
    available.release.signal()
    PreviewDownloadProtocol.registry.set(available, id: objectID)
    try await services.ensurePreview(photo)
    let current = try XCTUnwrap(services.consumerSavedPhoto(photo.id))
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(current.previewURL)), plain)
    XCTAssertEqual(current.metadata, photo.metadata)
    XCTAssertEqual(current.manifest, photo.manifest)
    XCTAssertEqual(current.originalURL, photo.originalURL)
    XCTAssertTrue(try services.journal.entries().isEmpty)
    await fulfillment(of: [unavailable.started, available.started], timeout: 1)
  }
  @MainActor func testPendingPreviewDoesNotRestoreDeletedOrChangedPhotoAndPreservesFreshCache() async throws {
    for mutation in PreviewCatalogMutation.allCases {
      let services = try await previewServices()
      defer { services.vault.lock(); Keychain.remove(services.session.accountId!); try? FileManager.default.removeItem(at: services.storageRoot) }
      let (photo, cipher, plain) = try previewPhoto(owner: services.session.accountId!)
      try services.store.put(photo)
      let gate = PreviewDownloadGate(bytes: cipher, started: expectation(description: "Preview request started"))
      let objectID = photo.manifest.representations[0].objectId
      PreviewDownloadProtocol.registry.set(gate, id: objectID)
      defer { gate.release.signal(); PreviewDownloadProtocol.registry.remove(objectID) }
      let loading = Task { try await services.ensurePreview(photo) }
      await fulfillment(of: [gate.started], timeout: 3)
      var changed = photo
      switch mutation {
      case .deleted:
        try services.store.apply(ChangePageV1(version: 1, changes: [ChangeV1(cursor: "deleted", entity: "photo", entityId: photo.id, deleted: true, payload: nil)], nextCursor: nil, hasMore: false))
      case .metadata:
        changed.metadata.originalSha256 = Data("changed-original".utf8).digest
        try services.store.put(changed)
      case .manifest:
        changed.manifest.representations[0].objectId = Wire.id()
        try services.store.put(changed)
      case .cacheOnly:
        changed.originalURL = services.storageRoot.appendingPathComponent("fresh-original.jpg")
        try services.store.put(changed)
      }
      gate.release.signal()
      if mutation == .cacheOnly {
        try await loading.value
        let current = try XCTUnwrap(services.store.backupPhoto(photo.id))
        XCTAssertEqual(current.originalURL, changed.originalURL)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(current.previewURL)), plain)
      } else {
        do { try await loading.value; XCTFail("A withdrawn preview source must not write back") }
        catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        let current = try services.store.backupPhoto(photo.id)
        if mutation == .deleted { XCTAssertNil(current) }
        else {
          XCTAssertEqual(current?.metadata, changed.metadata)
          XCTAssertEqual(current?.manifest, changed.manifest)
          XCTAssertNil(current?.previewURL)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: services.store.root.appendingPathComponent("Media/cache-\(photo.id)-preview.jpg").path))
      }
    }
  }
  @MainActor func testPendingReceivedPreviewRequiresCurrentReceivedSourceAndKeepsFreshCache() async throws {
    for withdraw in [false, true] {
      let services = try await previewServices()
      defer { services.vault.lock(); Keychain.remove(services.session.accountId!); try? FileManager.default.removeItem(at: services.storageRoot) }
      let (initial, cipher, plain) = try previewPhoto(owner: Wire.id())
      var photo = initial
      photo.transferState = "received"
      services.received = [photo]
      let gate = PreviewDownloadGate(bytes: cipher, started: expectation(description: "Received preview request started"))
      let objectID = photo.manifest.representations[0].objectId
      PreviewDownloadProtocol.registry.set(gate, id: objectID)
      defer { gate.release.signal(); PreviewDownloadProtocol.registry.remove(objectID) }
      let loading = Task { try await services.ensurePreview(photo) }
      await fulfillment(of: [gate.started], timeout: 3)
      if withdraw { services.received = [] }
      else { services.received[0].originalURL = services.storageRoot.appendingPathComponent("received-original.jpg") }
      gate.release.signal()
      if withdraw {
        do { try await loading.value; XCTFail("A removed received source must not return to the catalog") }
        catch { XCTAssertTrue(error is CancellationError, "\(error)") }
        XCTAssertTrue(services.received.isEmpty)
        XCTAssertNil(try services.store.backupPhoto(photo.id))
      } else {
        try await loading.value
        let current = try XCTUnwrap(services.received.first)
        XCTAssertEqual(current.originalURL, services.storageRoot.appendingPathComponent("received-original.jpg"))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(current.previewURL)), plain)
        XCTAssertEqual(try services.store.backupPhoto(photo.id)?.transferState, "received")
      }
    }
  }
  @MainActor private func previewServices() async throws -> AppServices {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PreviewDownloadProtocol.self]
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()), networkConfiguration: configuration)
    services.api.baseURL = URL(string: "http://127.0.0.1:8799")!
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    var card = accounts.accounts[0]
    card.accountId = Wire.id()
    services.session.accountId = card.accountId
    services.session.fixture = true
    services.session.pinnedCards[card.accountId] = card
    let secret = accounts.testSecrets[0]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
    return services
  }
  private func previewPhoto(owner: String) throws -> (LocalPhoto, Data, Data) {
    let crypto = CryptoAdapter()
    let id = Wire.id()
    let key = crypto.randomKey()
    let plain = Data("controlled-preview".utf8)
    let binding = MediaBinding(photoId: id, representationId: Wire.id(), kind: "preview")
    let cipher = try crypto.encrypt(plain, key: key, binding: binding)
    let preview = RepresentationV1(binding: binding, objectId: Wire.id(), header: cipher.prefix(24).b64, ciphertextBytes: cipher.count, ciphertextSha256: cipher.digest)
    let metadata = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("metadata".utf8).digest)
    let photo = LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: owner, representations: [preview], metadataRepresentation: metadata, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "photo.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [binding.representationId: key.b64]), transferState: "committed")
    return (photo, cipher, plain)
  }
  @MainActor func testUnchangedForegroundRefreshPreservesViewerSelectionAndOriginalShare() {
    let first = RecentPhotoSource(id: "first", revision: "original-1")
    let older = RecentPhotoSource(id: "older-search-result", revision: "original-2")
    var reads = 0
    var requests = 0
    var lookedUp: Set<String> = []
    let store = RecentPhotosStore(authorization: { .authorized }, requestAccess: {
      requests += 1
      return .authorized
    }, readPhotos: { _ in reads += 1; return [] }, sourceRevisions: { ids in
      lookedUp = Set(ids)
      return [first.id: first.revision, older.id: older.revision]
    })
    defer { store.pauseAnalysis() }
    for _ in 0..<2 {
      store.restoreAccess()
      let current = store.validatePresentation(viewer: [first, older], selection: [first], share: [older])
      XCTAssertTrue(current.viewerIsCurrent)
      XCTAssertEqual(current.selectedIDs, [first.id])
      XCTAssertTrue(current.shareIsCurrent)
    }
    XCTAssertEqual(reads, 2)
    XCTAssertEqual(requests, 0)
    XCTAssertEqual(lookedUp, [first.id, older.id])
    XCTAssertTrue(store.photos.isEmpty, "An allowed older source remains valid outside the recent gallery and search results")
  }
  @MainActor func testChangedAndRemovedSourcesWithdrawOnlyAffectedPresentation() {
    let first = RecentPhotoSource(id: "first", revision: "original-1")
    let second = RecentPhotoSource(id: "second", revision: "original-2")
    var revisions = [first.id: first.revision, second.id: "edited"]
    let store = RecentPhotosStore(authorization: { .limited }, readPhotos: { _ in [] },
      sourceRevisions: { _ in revisions })
    for _ in 0..<2 {
      let current = store.validatePresentation(viewer: [first, second], selection: [first, second], share: [second])
      XCTAssertFalse(current.viewerIsCurrent)
      XCTAssertEqual(current.selectedIDs, [first.id])
      XCTAssertFalse(current.shareIsCurrent)
      XCTAssertTrue(store.validatePresentation(viewer: [first], selection: [], share: [first]).shareIsCurrent)
      revisions.removeValue(forKey: second.id)
    }
  }
  @MainActor func testFreshPermissionWithdrawalInvalidatesPresentationsBeforeCachedStatusChanges() {
    var permission = PHAuthorizationStatus.authorized
    var lookups = 0
    let source = RecentPhotoSource(id: "photo", revision: "original")
    let store = RecentPhotosStore(authorization: { permission }, readPhotos: { _ in [] }, sourceRevisions: { _ in
      lookups += 1
      return [source.id: source.revision]
    })
    store.restoreAccess()
    defer { store.pauseAnalysis() }
    permission = .denied
    XCTAssertEqual(store.status, .authorized)
    let current = store.validatePresentation(viewer: [source], selection: [source], share: [source])
    XCTAssertFalse(current.viewerIsCurrent)
    XCTAssertTrue(current.selectedIDs.isEmpty)
    XCTAssertFalse(current.shareIsCurrent)
    XCTAssertEqual(lookups, 0, "Withdrawn permission must prevent even a source metadata lookup")
  }
  @MainActor func testPermissionWithdrawalDuringSourceLookupRejectsMatchingRevisions() {
    var permission = PHAuthorizationStatus.authorized
    let source = RecentPhotoSource(id: "photo", revision: "original")
    let store = RecentPhotosStore(authorization: { permission }, sourceRevisions: { _ in
      permission = .denied
      return [source.id: source.revision]
    })
    let current = store.validatePresentation(viewer: [source], selection: [source], share: [source])
    XCTAssertFalse(current.viewerIsCurrent)
    XCTAssertTrue(current.selectedIDs.isEmpty)
    XCTAssertFalse(current.shareIsCurrent)
  }
  @MainActor func testPhotosValidationWithdrawsOnlySharesWithDeviceSources() {
    var permission = PHAuthorizationStatus.denied
    let source = RecentPhotoSource(id: "photo", revision: "original")
    var revision = source.revision
    var lookups = 0
    let store = RecentPhotosStore(authorization: { permission }, sourceRevisions: { _ in
      lookups += 1
      return [source.id: revision]
    })
    let savedOnly = store.validatePresentation(viewer: [], selection: [], share: [])
    XCTAssertFalse(savedOnly.withdrawsDeviceShare([]), "Photos permission does not own a Saved-only share")
    let deviceShare = store.validatePresentation(viewer: [], selection: [], share: [source])
    XCTAssertTrue(deviceShare.withdrawsDeviceShare([source]), "A device or mixed share still requires Photos access")
    XCTAssertEqual(lookups, 0)
    permission = .limited
    XCTAssertFalse(store.validatePresentation(viewer: [], selection: [], share: [source]).withdrawsDeviceShare([source]))
    revision = "edited"
    XCTAssertTrue(store.validatePresentation(viewer: [], selection: [], share: [source]).withdrawsDeviceShare([source]))
  }
  func testSavedViewerPreservesCacheRefreshButWithdrawsChangedMissingAndUnavailableSources() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let catalog = try LibraryStore(root: root)
    let id = Wire.id()
    let rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("cipher".utf8).digest)
    let photo = LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: Wire.id(), representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "receipt.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:]), transferState: "committed")
    try catalog.put(photo)
    XCTAssertTrue(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: catalog.backupPhoto))
    var changed = photo
    changed.thumbnailURL = root.appendingPathComponent("new-preview.jpg")
    try catalog.put(changed)
    XCTAssertTrue(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: catalog.backupPhoto))
    changed.metadata.originalSha256 = Data("edited".utf8).digest
    try catalog.put(changed)
    XCTAssertFalse(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: catalog.backupPhoto))
    changed = photo
    changed.manifest.ownerAccountId = Wire.id()
    try catalog.put(changed)
    XCTAssertFalse(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: catalog.backupPhoto))
    try catalog.removeAll()
    XCTAssertFalse(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: catalog.backupPhoto))
    XCTAssertFalse(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: { _ in nil }))
    XCTAssertFalse(SavedPhotosPresentationPolicy.isCurrent([photo], lookup: { _ in throw CancellationError() }))
  }
  func testDiagnosticFailureDistinguishesFenceCancellationAndRealErrors() {
    XCTAssertEqual(NativeDiagnosticOutcome.failure(for: CancellationError(), taskCancelled: false), .cancelled)
    XCTAssertEqual(NativeDiagnosticOutcome.failure(for: URLError(.cancelled), taskCancelled: false), .cancelled)
    XCTAssertEqual(NativeDiagnosticOutcome.failure(for: URLError(.notConnectedToInternet), taskCancelled: false), .failed)
    XCTAssertEqual(NativeDiagnosticOutcome.failure(for: URLError(.notConnectedToInternet), taskCancelled: true), .cancelled)
  }
  func testSyncAccessActionDoesNotBlockAlreadyQueuedEncryptedUploads() {
    for permission in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      XCTAssertTrue(SyncPhotosAccessPolicy.needsAccess(permission, action: .start, enabled: false, hasQueuedUploads: false))
      for action in [ConsumerSyncAction.continue, .retry] {
        XCTAssertFalse(SyncPhotosAccessPolicy.needsAccess(permission, action: action, enabled: false, hasQueuedUploads: false))
        XCTAssertFalse(SyncPhotosAccessPolicy.needsAccess(permission, action: action, enabled: true, hasQueuedUploads: true))
        XCTAssertTrue(SyncPhotosAccessPolicy.needsAccess(permission, action: action, enabled: true, hasQueuedUploads: false))
      }
      XCTAssertFalse(SyncPhotosAccessPolicy.needsAccess(permission, action: .review, enabled: true, hasQueuedUploads: false))
    }
    for permission in [PHAuthorizationStatus.limited, .authorized] {
      XCTAssertFalse(SyncPhotosAccessPolicy.needsAccess(permission, action: .start, enabled: false, hasQueuedUploads: false))
    }
  }
  func testManualSaveRequiresActivatedAccountAndConsumesOnlyOnce() {
    let source = RecentPhotoSource(id: "chosen", revision: "original")
    let catalog = NSObject(), replacement = NSObject()
    let access = PhotoAccountAccess(account: "opened", vault: UUID(), catalog: ObjectIdentifier(catalog))
    var intent = ManualPhotoSaveIntent([source])
    XCTAssertNil(intent.consume(active: true, access: access), "Unlock alone cannot authorize Save before activation")
    intent.authorize(access)
    XCTAssertNil(intent.consume(active: false, access: access))
    XCTAssertNil(intent.consume(active: true, access: nil))
    XCTAssertNil(intent.consume(active: true, access: PhotoAccountAccess(account: "another", vault: access.vault, catalog: access.catalog)))
    XCTAssertNil(intent.consume(active: true, access: PhotoAccountAccess(account: access.account, vault: UUID(), catalog: access.catalog)))
    XCTAssertNil(intent.consume(active: true, access: PhotoAccountAccess(account: access.account, vault: access.vault, catalog: ObjectIdentifier(replacement))))
    let otherAccess = PhotoAccountAccess(account: "another", vault: UUID(), catalog: ObjectIdentifier(replacement))
    intent.authorize(otherAccess)
    XCTAssertNil(intent.consume(active: true, access: otherAccess), "Access restoration cannot move an authorized Save to another account")
    XCTAssertEqual(intent.consume(active: true, access: access), [source])
    XCTAssertTrue(intent.wasConsumed)
    XCTAssertNil(intent.consume(active: true, access: access))
    var cancelled = ManualPhotoSaveIntent([source])
    cancelled.cancel()
    cancelled.authorize(access)
    XCTAssertFalse(cancelled.wasConsumed)
    XCTAssertNil(cancelled.consume(active: true, access: access), "Late authentication cannot revive a dismissed Save")
    var empty = ManualPhotoSaveIntent([])
    empty.authorize(access)
    XCTAssertNil(empty.consume(active: true, access: access))
  }
  func testAutomaticSyncConsentRequiresTheSameActivatedAccountOriginAndForeground() {
    let catalog = NSObject(), replacement = NSObject()
    let access = PhotoAccountAccess(account: "opened", vault: UUID(), catalog: ObjectIdentifier(catalog))
    var consent = AutomaticPhotoSyncConsent()
    XCTAssertFalse(consent.consume(active: true, access: access, origin: "https://fotoro.cloud"))
    consent.authorize(access, origin: "https://fotoro.cloud")
    XCTAssertFalse(consent.consume(active: false, access: access, origin: "https://fotoro.cloud"))
    XCTAssertFalse(consent.consume(active: true, access: access, origin: "https://other.example"))
    XCTAssertFalse(consent.consume(active: true, access: nil, origin: "https://fotoro.cloud"))
    let changed = [PhotoAccountAccess(account: "another", vault: access.vault, catalog: access.catalog),
      PhotoAccountAccess(account: access.account, vault: UUID(), catalog: access.catalog),
      PhotoAccountAccess(account: access.account, vault: access.vault, catalog: ObjectIdentifier(replacement))]
    for other in changed {
      consent.authorize(other, origin: "https://fotoro.cloud")
      XCTAssertFalse(consent.consume(active: true, access: other, origin: "https://fotoro.cloud"))
    }
    XCTAssertTrue(consent.consume(active: true, access: access, origin: "https://fotoro.cloud"))
    XCTAssertFalse(consent.consume(active: true, access: access, origin: "https://fotoro.cloud"))
    var cancelled = AutomaticPhotoSyncConsent()
    cancelled.authorize(access, origin: "https://fotoro.cloud")
    cancelled.cancel()
    XCTAssertFalse(cancelled.consume(active: true, access: access, origin: "https://fotoro.cloud"))
  }
  func testPendingManualSaveCanAuthorizeWhenAccountRestorationFinishes() {
    let source = RecentPhotoSource(id: "chosen", revision: "original")
    let catalog = NSObject()
    let access = PhotoAccountAccess(account: "remembered", vault: UUID(), catalog: ObjectIdentifier(catalog))
    var intent = ManualPhotoSaveIntent([source])
    intent.authorize(nil)
    XCTAssertNil(intent.consume(active: true, access: nil))
    intent.authorize(access)
    XCTAssertEqual(intent.consume(active: true, access: access), [source])
    intent.authorize(access)
    XCTAssertNil(intent.consume(active: true, access: access))
  }
  @MainActor func testSyncPermissionActionRequestsOnceAndDoesNotEnableUploads() async throws {
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    var permission = PHAuthorizationStatus.notDetermined
    var requests = 0
    var reads = 0
    let recent = RecentPhotosStore(authorization: { permission }, requestAccess: {
      requests += 1
      permission = .limited
      return permission
    }, readPhotos: { _ in reads += 1; return [] })
    services.bindRecentPhotos(recent)
    try await services.requestPhotosAccessForSync()
    XCTAssertEqual(recent.status, .limited)
    XCTAssertEqual(requests, 1)
    XCTAssertEqual(reads, 1)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertFalse(services.backup.isRunning)
    XCTAssertTrue(try services.journal.entries().isEmpty)
    try await services.requestPhotosAccessForSync()
    XCTAssertEqual(requests, 1)
    XCTAssertFalse(try services.store.syncEnabled())
    recent.pauseAnalysis()
  }
  @MainActor func testDeniedSyncPermissionDoesNotRequestAgainOrReadAssets() async throws {
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    var requests = 0
    var reads = 0
    let recent = RecentPhotosStore(authorization: { .denied }, requestAccess: {
      requests += 1
      return .denied
    }, readPhotos: { _ in reads += 1; return [] })
    services.bindRecentPhotos(recent)
    try await services.requestPhotosAccessForSync()
    XCTAssertEqual(recent.status, .denied)
    XCTAssertEqual(requests, 0)
    XCTAssertEqual(reads, 0)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertFalse(services.backup.isRunning)
    XCTAssertTrue(try services.journal.entries().isEmpty)
  }
  func testViewerZoomContinuesFromPinchAndDoubleTap() {
    var zoom = PhotoViewerZoom()
    zoom.settle(2)
    zoom.change(1.25)
    XCTAssertEqual(zoom.scale, 2.5)
    zoom.settle(1.5)
    XCTAssertEqual(zoom.scale, 3)
    zoom.change(10)
    XCTAssertEqual(zoom.scale, 5)
    zoom.reset()
    zoom.toggle()
    zoom.settle(1.5)
    XCTAssertEqual(zoom.scale, 3)
    zoom.toggle()
    XCTAssertEqual(zoom.scale, 1)
    zoom.settle(0.5)
    XCTAssertEqual(zoom.scale, 1)
  }
  func testMergedSearchRefreshTracksChildrenMeaningAndCatalog() {
    var original = ConsumerSearchPresentationID(query: "receipt", library: 1,
      results: [SearchHit(id: "parent", evidenceClass: 1, reason: "Supplied label")],
      indexed: 1, response: 1, acceptedMeaning: nil, catalog: 1, account: "account", vault: UUID())
    var next = original
    next.results[0].children = ["new-child"]
    XCTAssertNotEqual(next, original)
    next = original
    next.acceptedMeaning = "another-meaning"
    XCTAssertNotEqual(next, original)
    next = original
    next.catalog = 2
    XCTAssertNotEqual(next, original)
    next = original
    next.response = 2
    XCTAssertNotEqual(next, original)
    original.response = 2
    XCTAssertEqual(next, original)
  }
  func testCurrentSearchCanKeepEnrichmentButCannotReuseAnotherQueryOrSource() {
    let original = ConsumerSearchPresentationID(query: "receipt", library: 1,
      results: [], indexed: 1, response: 1, acceptedMeaning: nil,
      catalog: 1, account: "account", vault: UUID())
    var enrichment = original
    enrichment.response = 2
    enrichment.indexed = 2
    enrichment.results = [SearchHit(id: "new", evidenceClass: 1, reason: "Text")]
    XCTAssertTrue(original.permitsResults(for: enrichment))
    for field in ["query", "library", "meaning", "catalog", "account", "vault"] {
      var changed = enrichment
      switch field {
      case "query": changed.query = "beach"
      case "library": changed.library = 2
      case "meaning": changed.acceptedMeaning = "another"
      case "catalog": changed.catalog = 2
      case "account": changed.account = "other"
      default: changed.vault = UUID()
      }
      XCTAssertFalse(original.permitsResults(for: changed), field)
    }
  }
  func testOwnedShareCleanupRemovesOnlyTemporaryExports() throws {
    let temporary = FileManager.default.temporaryDirectory
    let export = temporary.appendingPathComponent("fotoro-share-" + Wire.id())
    let account = temporary.appendingPathComponent(Wire.id())
    let cache = account.appendingPathComponent("Media")
    let nested = account.appendingPathComponent("fotoro-share-" + Wire.id())
    defer {
      try? FileManager.default.removeItem(at: export)
      try? FileManager.default.removeItem(at: account)
    }
    let bytes = Data([1, 2, 3])
    for directory in [export, cache, nested] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try bytes.write(to: directory.appendingPathComponent("original.jpg"))
    }
    ConsumerShareExports.remove([export, cache, nested].map { $0.appendingPathComponent("original.jpg") })
    XCTAssertFalse(FileManager.default.fileExists(atPath: export.path))
    XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("original.jpg")), bytes)
    XCTAssertEqual(try Data(contentsOf: nested.appendingPathComponent("original.jpg")), bytes)
    ConsumerShareExports.remove([export.appendingPathComponent("original.jpg")])
  }
  func testSavedSearchRemainsVisibleWithoutPhotosPermission() {
    for permission in [PHAuthorizationStatus.notDetermined, .denied, .restricted, .limited, .authorized] {
      for opened in [false, true] {
        XCTAssertEqual(RecentPhotosContentMode.select(query: "cloud-only receipt", opened: opened, status: permission), .search)
      }
    }
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: false, status: .notDetermined), .openPhotos)
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: true, status: .denied), .accessOff)
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: true, status: .limited), .gallery)
  }
  @MainActor func testAccountCompletionReturnsLocallyWithoutNetworkOrAutomaticBackup() async throws {
    let savedCards = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    var card = try fixture(FixtureAccounts.self, "accounts").accounts[0]
    card.accountId = Wire.id()
    defer {
      Keychain.remove(card.accountId)
      if let savedCards { UserDefaults.standard.set(savedCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
    }
    AccountCompletionProtocol.record.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountCompletionProtocol.self]
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()), networkConfiguration: configuration)
    services.api.baseURL = URL(string: "http://127.0.0.1:8788")!
    services.session.accountId = card.accountId
    services.session.fixture = false
    services.session.bearerToken = "controlled-ui-session"
    try services.session.pin(card)
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    var completed = false
    services.auth.fallbackMessage = "Authenticated. Recover the vault with your saved code or a trusted device."
    let accountView = AccountView(services: services, onSignedIn: {
      completed = services.store.root.lastPathComponent == card.accountId
    })
    try await accountView.finishSignIn()
    XCTAssertTrue(completed)
    XCTAssertNil(services.auth.fallbackMessage)
    XCTAssertEqual(services.store.root.lastPathComponent, card.accountId)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertFalse(services.backup.isRunning)
    XCTAssertTrue(try services.journal.entries().isEmpty)
    XCTAssertTrue(AccountCompletionProtocol.record.paths.isEmpty, "Sign-in must finish without depending on a network catalog refresh")
    services.lockAccount()
    XCTAssertFalse(services.vault.isUnlocked)
    XCTAssertNil(services.auth.fallbackMessage, "Successful recovery must not hide ordinary Unlock account after a later lock")
    try await services.vault.unlock(.localKeychain)
    completed = false
    try await accountView.finishSignIn()
    XCTAssertTrue(completed)
    XCTAssertTrue(AccountCompletionProtocol.record.paths.isEmpty)
    XCTAssertTrue(services.vault.isUnlocked)
    XCTAssertNil(services.auth.fallbackMessage)
    services.vault.lock()
  }
  func testLast10DaysDateBoundariesAndMissingDates() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = Date(timeIntervalSince1970: 1_780_315_200)
    let cutoff = RecentPhotosPolicy.cutoff(now: now, calendar: calendar)
    XCTAssertEqual(cutoff, now.addingTimeInterval(-10 * 24 * 60 * 60))
    XCTAssertTrue(RecentPhotosPolicy.includes(cutoff, now: now, calendar: calendar))
    XCTAssertTrue(RecentPhotosPolicy.includes(now, now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(cutoff.addingTimeInterval(-1), now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(now.addingTimeInterval(1), now: now, calendar: calendar))
    XCTAssertFalse(RecentPhotosPolicy.includes(nil, now: now, calendar: calendar))
  }
  @MainActor func testRelaunchRestoresGrantedPhotosWithoutRequestingAccess() async {
    for permission in [PHAuthorizationStatus.authorized, .limited] {
      var requests = 0
      var reads = 0
      let store = RecentPhotosStore(authorization: { permission }, requestAccess: {
        requests += 1
        return permission
      }, readPhotos: { _ in reads += 1; return [] })
      store.restoreAccess()
      XCTAssertTrue(store.opened)
      XCTAssertEqual(store.status, permission)
      XCTAssertEqual(reads, 1)
      XCTAssertEqual(requests, 0)
    }
  }
  @MainActor func testFirstUseWaitsForOpenPhotosAndDeniedRestoreNeverReadsAssets() async {
    for permission in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      var requests = 0
      var reads = 0
      let store = RecentPhotosStore(authorization: { permission }, requestAccess: {
        requests += 1
        return permission
      }, readPhotos: { _ in reads += 1; return [] })
      store.restoreAccess()
      XCTAssertEqual(store.opened, permission != .notDetermined)
      XCTAssertEqual(reads, 0)
      XCTAssertEqual(requests, 0)
      if permission == .notDetermined {
        await store.open()
        XCTAssertEqual(requests, 1)
      }
    }
  }
  @MainActor func testOpeningAgainDoesNotRequestPhotosPermissionAgain() async {
    var permission = PHAuthorizationStatus.notDetermined
    var requests = 0
    let store = RecentPhotosStore(authorization: { permission }, requestAccess: {
      requests += 1
      permission = .limited
      return permission
    }, readPhotos: { _ in [] })
    await store.open()
    await store.open()
    XCTAssertEqual(requests, 1)
    XCTAssertEqual(store.status, .limited)
  }
  func testViewerLoadsOnlyCurrentAndNeighboringPages() {
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(4, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(5, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(6, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(3, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(7, current: 5))
  }
  func testPermissionPolicyAllowsLimitedAndFullOnly() {
    XCTAssertTrue(RecentPhotosPolicy.canRead(.limited))
    XCTAssertTrue(RecentPhotosPolicy.canRead(.authorized))
    for status in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      XCTAssertFalse(RecentPhotosPolicy.canRead(status))
    }
  }
  func testMetadataSearchUsesPhotoKitFactsWithoutInferredPeopleOrPlaces() {
    let facts = RecentPhotoFacts(
      capturedAt: Date(timeIntervalSince1970: 1_780_315_200), favorite: true, screenshot: true,
      livePhoto: false, location: "40.7128, -74.0060")
    XCTAssertTrue(facts.searchText.contains("favorite"))
    XCTAssertTrue(facts.searchText.contains("screenshot"))
    XCTAssertTrue(facts.searchText.contains("40.7128"))
    XCTAssertFalse(facts.searchText.contains("live photo"))
    XCTAssertFalse(facts.searchText.contains("New York"))
    XCTAssertEqual(
      RecentPhotoFacts(
        capturedAt: nil, favorite: false, screenshot: false, livePhoto: false, location: nil
      ).searchText, "")
  }
}

private enum PreviewCatalogMutation: CaseIterable { case deleted, metadata, manifest, cacheOnly }

private final class PreviewDownloadGate: @unchecked Sendable {
  let bytes: Data
  let started: XCTestExpectation
  let error: URLError?
  let release = DispatchSemaphore(value: 0)
  init(bytes: Data, started: XCTestExpectation, error: URLError? = nil) {
    self.bytes = bytes; self.started = started; self.error = error
  }
}

private final class PreviewDownloadRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var gates: [String: PreviewDownloadGate] = [:]
  func set(_ gate: PreviewDownloadGate, id: String) { lock.lock(); defer { lock.unlock() }; gates[id] = gate }
  func gate(_ id: String) -> PreviewDownloadGate? { lock.lock(); defer { lock.unlock() }; return gates[id] }
  func remove(_ id: String) { lock.lock(); defer { lock.unlock() }; gates.removeValue(forKey: id) }
}

private final class PreviewDownloadProtocol: URLProtocol, @unchecked Sendable {
  static let registry = PreviewDownloadRegistry()
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == 8799 }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let gate = Self.registry.gate(request.url!.lastPathComponent) else {
      client?.urlProtocol(self, didFailWithError: FotoroError("Unexpected preview request"))
      return
    }
    gate.started.fulfill()
    guard gate.release.wait(timeout: .now() + 10) == .success else {
      client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
      return
    }
    if let error = gate.error {
      client?.urlProtocol(self, didFailWithError: error)
      return
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/octet-stream"])!, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: gate.bytes)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

private final class AccountCompletionRequests: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String] = []
  var paths: [String] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
  func append(_ path: String) {
    lock.lock()
    defer { lock.unlock() }
    values.append(path)
  }
  func reset() {
    lock.lock()
    defer { lock.unlock() }
    values = []
  }
}

private final class AccountCompletionProtocol: URLProtocol, @unchecked Sendable {
  static let record = AccountCompletionRequests()
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "127.0.0.1" && request.url?.port == 8788
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    Self.record.append(path)
    let body: String
    switch (request.httpMethod, path) {
    case ("GET", "/v1/changes"):
      body = "{\"version\":1,\"mediaVersion\":1,\"changes\":[],\"nextCursor\":\"Y2F0YWxvZy1yZWFkeQ\",\"hasMore\":false}"
    case ("GET", "/v1/grants"):
      body = "{\"version\":1,\"grants\":[]}"
    default:
      client?.urlProtocol(self, didFailWithError: FotoroError("Sign-in attempted an unexpected write"))
      return
    }
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
