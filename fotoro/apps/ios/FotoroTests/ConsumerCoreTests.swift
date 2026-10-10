import XCTest
import GRDB
import Observation
import Photos
@testable import Fotoro

final class ConsumerCoreTests: XCTestCase {
  @MainActor func testPhotosExportPreservesOriginalResourcesUntilCreationCompletes() async throws {
    let archive = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live")))
    let pair = try CameraMedia.decodeLivePhoto(archive)
    for (type, bytes, expected) in [
      ("image/jpeg", Data("original-jpeg".utf8), [Data("original-jpeg".utf8)]),
      ("video/quicktime", pair.motion.bytes, [pair.motion.bytes]),
      (CameraMedia.liveType, archive, [pair.still.bytes, pair.motion.bytes]),
    ] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("download")
      try bytes.write(to: url)
      defer { try? FileManager.default.removeItem(at: directory) }
      var metadata = try samplePhoto().metadata
      metadata.mediaType = type; metadata.originalBytes = bytes.count; metadata.originalSha256 = bytes.digest
      var writes = 0
      try await CameraMedia.restoreOriginalToPhotos(url, metadata: metadata, check: {},
        requestAccess: { .authorized }, restore: { urls, restored in
          writes += 1
          XCTAssertEqual(restored, metadata)
          XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, expected)
          await Task.yield()
          XCTAssertTrue(urls.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
        })
      XCTAssertEqual(writes, 1)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
  }
  @MainActor func testPhotosExportRejectsWithdrawnAccessAfterPermissionPromptAndCleansFiles() async throws {
    for denied in [false, true] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("download")
      try Data("jpg".utf8).write(to: url)
      defer { try? FileManager.default.removeItem(at: directory) }
      let metadata = try samplePhoto().metadata
      var current = true, writes = 0
      do {
        try await CameraMedia.restoreOriginalToPhotos(url, metadata: metadata, check: {
          if !current { throw CancellationError() }
        }, requestAccess: {
          if !denied { current = false }
          return denied ? .denied : .authorized
        }, restore: { _, _ in writes += 1 })
        XCTFail("Withdrawn source or denied permission must prevent PhotoKit admission")
      } catch {
        if !denied { XCTAssertTrue(error is CancellationError) }
      }
      XCTAssertEqual(writes, 0)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
  }
  func testPhotosExportCaptureDateRequiresActualCaptureProvenance() throws {
    var metadata = try samplePhoto().metadata
    metadata.sourceDate = "2024-05-06T12:00:00.000Z"
    for source in ["photos", "exif"] {
      metadata.dateSource = source
      XCTAssertEqual(CameraMedia.captureDate(metadata), Wire.parseDate(metadata.sourceDate))
    }
    for source in ["import", "unknown"] {
      metadata.dateSource = source
      XCTAssertNil(CameraMedia.captureDate(metadata))
    }
    metadata.dateSource = "photos"; metadata.sourceDate = "invalid"
    XCTAssertNil(CameraMedia.captureDate(metadata))
  }
  @MainActor func testPhotosExportChecksEveryBoundaryAndCleansCreationFailures() async throws {
    for withdrawal in ["initial", "permission", "completion", "creation failure"] {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("download")
      try Data("jpg".utf8).write(to: url)
      defer { try? FileManager.default.removeItem(at: directory) }
      let metadata = try samplePhoto().metadata
      var current = withdrawal != "initial", writes = 0
      do {
        try await CameraMedia.restoreOriginalToPhotos(url, metadata: metadata, check: {
          if !current { throw CancellationError() }
        }, requestAccess: {
          if withdrawal == "permission" { current = false }
          return .authorized
        }, restore: { _, _ in
          writes += 1
          if withdrawal == "creation failure" { throw FotoroError("Creation failed") }
          current = false
        })
        XCTFail("Stale admission or creation failure must propagate")
      } catch {
        if withdrawal != "creation failure" { XCTAssertTrue(error is CancellationError) }
      }
      XCTAssertEqual(writes, ["completion", "creation failure"].contains(withdrawal) ? 1 : 0)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
  }
  @MainActor func testSavedSemanticPublicationRefreshesEvidenceWithoutInvalidatingBrowseCatalog() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      let preview = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png")))
      photo.previewURL = try services.store.write(preview, name: "semantic-preview.png")
      try services.store.put(photo)
      try services.reload()
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      services.savedVisualEmbedding = { _ in vector }
      services.setSavedSemanticAnalysisActive(true)
      defer { services.setSavedSemanticAnalysisActive(false) }
      let catalog = services.consumerCatalogGeneration
      let evidence = services.consumerSavedEvidenceGeneration
      let browseChanges = SavedSemanticObservationCounter(), evidenceChanges = SavedSemanticObservationCounter()
      withObservationTracking { _ = services.consumerCatalogGeneration } onChange: { browseChanges.increment() }
      withObservationTracking { _ = services.consumerSavedEvidenceGeneration } onChange: { evidenceChanges.increment() }
      let local = LocalSearchStore(index: try SearchIndex())
      _ = try await services.consumerSearch("semantic scene", local: local)
      await services.waitForSavedVisualEvidence()
      let index = try SearchIndex(root: services.store.root.appendingPathComponent("VisualSearch"))
      XCTAssertFalse(try index.needsSemantic(photoID: photo.id, revision: photo.metadata.originalSha256),
        "The production saved worker must commit the injected vector before publishing evidence")
      let result = try index.addingSemantic(vector, to: index.search("semantic scene", scope: SearchScope(source: "saved")))
      XCTAssertEqual(result.results.map(\.id), [photo.id])
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence + 1)
      XCTAssertEqual(evidenceChanges.value, 1)
      XCTAssertEqual(services.consumerCatalogGeneration, catalog)
      XCTAssertEqual(browseChanges.value, 0, "Vector publication must not rearm browse projection or pagination")
      _ = try await services.consumerSearch("semantic scene", local: local)
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence + 1, "No pending vectors means no new evidence publication")
      try services.reload()
      XCTAssertEqual(services.consumerCatalogGeneration, catalog + 1)
      XCTAssertEqual(browseChanges.value, 1, "A real catalog reload must retain its browse invalidation")
    }
  }

  @MainActor func testSavedSemanticAdmissionCancelsHeldWriteAndResumesCachedPendingRecordsAfterIdle() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      let preview = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png")))
      photo.previewURL = try services.store.write(preview, name: "semantic-admission-preview.png")
      try services.store.put(photo); try services.reload()
      let started = self.expectation(description: "First embedding held")
      let gate = SavedSemanticEmbeddingGate()
      var calls = 0
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      services.savedVisualEmbedding = { _ in
        calls += 1
        if calls == 1 { started.fulfill(); await gate.wait() }
        return vector
      }
      services.setPhotoSyncForeground(true)
      defer { services.setSavedSemanticAnalysisActive(false); services.setPhotoSyncForeground(false); gate.open() }
      let catalog = services.consumerCatalogGeneration, evidence = services.consumerSavedEvidenceGeneration
      _ = try await services.consumerSearch("semantic scene", local: LocalSearchStore(index: try SearchIndex()))
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(calls, 0, "Foreground uploads alone must not admit automatic semantic analysis")
      services.setSavedSemanticAnalysisActive(true)
      await self.fulfillment(of: [started], timeout: 3)
      services.setSavedSemanticBrowseInteractionActive(true)
      gate.open()
      await services.waitForSavedVisualEvidence()
      let index = try SearchIndex(root: services.store.root.appendingPathComponent("VisualSearch"))
      XCTAssertTrue(try index.needsSemantic(photoID: photo.id, revision: photo.metadata.originalSha256))
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence)
      services.setSavedSemanticBrowseInteractionActive(false)
      XCTAssertEqual(calls, 1, "Ending interaction must wait for idle rather than start immediately")
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(calls, 2, "Idle admission must resume the cached pending record without another search")
      XCTAssertFalse(try index.needsSemantic(photoID: photo.id, revision: photo.metadata.originalSha256))
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence + 1)
      XCTAssertEqual(services.consumerCatalogGeneration, catalog)
      services.setSavedSemanticAnalysisActive(false)
      services.setSavedSemanticAnalysisActive(true)
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(calls, 2, "Persisted vectors must survive admission withdrawal")
    }
  }

  @MainActor func testSavedSemanticSupersededHeldWorkerProcessesLatestHydratedSnapshotWithoutAnotherTrigger() async throws {
    try await withSavedLibrary { services, _ in
      var first = try self.samplePhoto()
      first.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      let preview = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png")))
      first.previewURL = try services.store.write(preview, name: "semantic-successor-preview.png")
      try services.store.put(first); try services.reload()
      let held = self.expectation(description: "Old snapshot embedding held")
      let gate = SavedSemanticEmbeddingGate()
      var calls = 0
      var vector = [Float](repeating: 0, count: 512); vector[0] = 1
      services.savedVisualEmbedding = { _ in
        calls += 1
        if calls == 1 { held.fulfill(); await gate.wait() }
        return vector
      }
      services.setSavedSemanticAnalysisActive(true)
      defer { services.setSavedSemanticAnalysisActive(false); gate.open() }
      let local = LocalSearchStore(index: try SearchIndex())
      let evidence = services.consumerSavedEvidenceGeneration
      _ = try await services.consumerSearch("semantic scene", local: local)
      await self.fulfillment(of: [held], timeout: 3)
      var second = try self.samplePhoto()
      second.manifest.ownerAccountId = first.manifest.ownerAccountId
      second.previewURL = first.previewURL
      try services.store.put(second); try services.reload()
      let catalog = services.consumerCatalogGeneration
      _ = try await services.consumerSearch("semantic scene", local: local)
      XCTAssertEqual(calls, 1, "The latest snapshot must wait for the retained worker to drain")
      let index = try SearchIndex(root: services.store.root.appendingPathComponent("VisualSearch"))
      XCTAssertTrue(try index.needsSemantic(photoID: first.id, revision: first.metadata.originalSha256))
      gate.open()
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(calls, 3, "Discard the held vector, then process both latest-snapshot records without another search")
      XCTAssertFalse(try index.needsSemantic(photoID: first.id, revision: first.metadata.originalSha256))
      XCTAssertFalse(try index.needsSemantic(photoID: second.id, revision: second.metadata.originalSha256))
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence + 1)
      XCTAssertEqual(services.consumerCatalogGeneration, catalog)
    }
  }

  @MainActor func testAutomaticSavedSemanticExcludedDatesNeverFetchMissingPreviewsOrEmbed() async throws {
    try await withSavedLibrary { services, server in
      let now = Date()
      var photos: [LocalPhoto] = []
      for offset in [-40, 1, 0] {
        var photo = try self.samplePhoto()
        photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
        photo.metadata.sourceDate = Wire.date(now.addingTimeInterval(Double(offset) * 86400))
        if offset == 0 { photo.metadata.dateSource = "upload" }
        let rep = RepresentationV1(binding: MediaBinding(photoId: photo.id, representationId: Wire.id(), kind: "preview"),
          objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("preview".utf8).digest)
        photo.manifest.representations = [rep]
        photo.metadata.representationKeys[rep.binding.representationId] = Data(repeating: 0, count: 32).b64
        try services.store.put(photo); photos.append(photo)
      }
      try services.reload()
      var embeddings = 0
      services.savedVisualEmbedding = { _ in embeddings += 1; return [Float](repeating: 0, count: 512) }
      services.setSavedSemanticAnalysisActive(true)
      defer { services.setSavedSemanticAnalysisActive(false) }
      let requests = server.requests.count
      let evidence = services.consumerSavedEvidenceGeneration
      _ = try await services.consumerSearch("semantic scene", local: LocalSearchStore(index: try SearchIndex()))
      await services.waitForSavedVisualEvidence()
      XCTAssertEqual(server.requests.count, requests, "Excluded originals with missing previews must never reach ensurePreview's object read")
      XCTAssertEqual(embeddings, 0)
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence)
      let index = try SearchIndex(root: services.store.root.appendingPathComponent("VisualSearch"))
      XCTAssertEqual(try index.pendingSemanticRecords().count, 3, "All-age metadata remains indexed for search")
      for photo in photos {
        XCTAssertNil(try services.consumerSavedPhoto(photo.id)?.previewURL)
        XCTAssertTrue(try index.needsSemantic(photoID: photo.id, revision: photo.metadata.originalSha256))
      }
    }
  }

  @MainActor func testSavedSemanticWorkerRejectsOriginWithdrawalBeforeVectorCommit() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      let preview = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png")))
      photo.previewURL = try services.store.write(preview, name: "semantic-held-preview.png")
      try services.store.put(photo)
      try services.reload()
      let started = self.expectation(description: "Saved vector generation is held")
      let gate = SavedSemanticEmbeddingGate()
      services.savedVisualEmbedding = { _ in
        started.fulfill()
        await gate.wait()
        var vector = [Float](repeating: 0, count: 512); vector[0] = 1
        return vector
      }
      services.setSavedSemanticAnalysisActive(true)
      defer { services.setSavedSemanticAnalysisActive(false); gate.open() }
      let catalog = services.consumerCatalogGeneration, evidence = services.consumerSavedEvidenceGeneration
      _ = try await services.consumerSearch("semantic scene", local: LocalSearchStore(index: try SearchIndex()))
      await self.fulfillment(of: [started], timeout: 3)
      services.api.baseURL = URL(string: "https://withdrawn-origin.test")!
      gate.open()
      await services.waitForSavedVisualEvidence()
      let index = try SearchIndex(root: services.store.root.appendingPathComponent("VisualSearch"))
      XCTAssertTrue(try index.needsSemantic(photoID: photo.id, revision: photo.metadata.originalSha256))
      XCTAssertEqual(services.consumerSavedEvidenceGeneration, evidence)
      XCTAssertEqual(services.consumerCatalogGeneration, catalog)
    }
  }

  @MainActor func testEmptySavedContinuationDoesNotInvalidateCatalogAndNonemptyPageStillPublishes() async throws {
    try await withSavedLibrary { services, _ in
      var newest = try self.samplePhoto()
      newest.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      newest.metadata.sourceDate = "2026-10-08T12:00:00.000Z"
      try services.store.put(newest)
      try services.reload()
      let initialGeneration = services.consumerCatalogGeneration
      try services.loadMore()
      XCTAssertEqual(services.photos.map(\.id), [newest.id])
      XCTAssertEqual(services.consumerCatalogGeneration, initialGeneration,
        "An empty continuation cannot announce a new catalog and rearm the gallery footer")

      var older = try self.samplePhoto()
      older.manifest.ownerAccountId = newest.manifest.ownerAccountId
      older.metadata.sourceDate = "2026-10-07T12:00:00.000Z"
      try services.store.put(older)
      try services.loadMore()
      XCTAssertEqual(services.photos.map(\.id), [newest.id, older.id])
      XCTAssertEqual(services.consumerCatalogGeneration, initialGeneration + 1,
        "An admitted older photo still invalidates catalog projections once")
      let completeGeneration = services.consumerCatalogGeneration
      for _ in 0..<3 { try services.loadMore() }
      XCTAssertEqual(services.photos.map(\.id), [newest.id, older.id])
      XCTAssertEqual(services.consumerCatalogGeneration, completeGeneration,
        "Repeated end-of-list callbacks must settle without a generation feedback loop")
    }
  }
  @MainActor func testMixedOriginalShareKeepsEverySelectedSourceAndSeparateResourceNames() async throws {
    let deviceDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()).appendingPathComponent(Wire.id())
    let savedDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
    defer {
      RecentShareExports.remove([deviceDirectory.appendingPathComponent("IMG_1.HEIC")])
      ConsumerShareExports.remove([savedDirectory.appendingPathComponent("IMG_2.JPG")])
    }
    try FileManager.default.createDirectory(at: deviceDirectory, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: savedDirectory, withIntermediateDirectories: true)
    let deviceURLs = ["IMG_1.HEIC", "IMG_1.MOV"].map { deviceDirectory.appendingPathComponent($0) }
    let savedURLs = ["IMG_2.JPG", "IMG_2.MOV"].map { savedDirectory.appendingPathComponent($0) }
    for (index, url) in (deviceURLs + savedURLs).enumerated() { try Data([UInt8(index)]).write(to: url) }
    let saved = try samplePhoto()
    var selection = SavedPhotoSelection()
    selection.toggle(saved)
    let selected = try selection.resolve(using: { $0 == saved.id ? saved : nil })
    let device = [RecentPhotoSource(id: "selected-before-search", revision: "current")]
    let batch = try await PhotoOriginalShareBatch.prepare(device: device, saved: selected,
      valid: { XCTAssertTrue(SavedPhotoSelection.isCurrent(selected, lookup: { $0 == saved.id ? saved : nil })) },
      exportDevice: { XCTAssertEqual($0, device); return deviceURLs },
      exportSaved: { XCTAssertEqual($0.id, saved.id); return savedURLs[0] },
      expandSaved: { _, _ in savedURLs }, removeDevice: RecentShareExports.remove, removeSaved: ConsumerShareExports.remove)
    XCTAssertEqual(batch.photoCount, 2, "Two selected photos may contain four exact original resources")
    XCTAssertEqual(batch.urls.map(\.lastPathComponent), ["IMG_1.HEIC", "IMG_1.MOV", "IMG_2.JPG", "IMG_2.MOV"])
    for (index, url) in batch.urls.enumerated() { XCTAssertEqual(try Data(contentsOf: url), Data([UInt8(index)])) }
    XCTAssertEqual(batch.device, deviceURLs)
    XCTAssertEqual(batch.saved, savedURLs)
  }
  @MainActor func testMixedShareRejectsLateDownloadAfterCancellationOrAccountLockAndRemovesBothExportShapes() async throws {
    for interruption in ["cancel", "lock", "source", "permission"] {
      try await withSavedLibrary { services, _ in
        var saved = try self.samplePhoto()
        saved.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
        try services.store.put(saved)
        let immutableSaved = saved
        var permission = PHAuthorizationStatus.limited
        let deviceSources = [RecentPhotoSource(id: "device", revision: "current")]
        let photos = RecentPhotosStore(authorization: { permission }, readPhotos: { _ in [] },
          sourceRevisions: { _ in ["device": "current"] })
        let deviceDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()).appendingPathComponent(Wire.id())
        let savedDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
        try FileManager.default.createDirectory(at: deviceDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: savedDirectory, withIntermediateDirectories: true)
        let deviceURL = deviceDirectory.appendingPathComponent("device.jpg"), savedURL = savedDirectory.appendingPathComponent("saved.jpg")
        try Data("original-device".utf8).write(to: deviceURL)
        try Data("original-saved".utf8).write(to: savedURL)
        defer { RecentShareExports.remove([deviceURL]); ConsumerShareExports.remove([savedURL]) }
        let gate = SavedShareDownloadGate()
        let started = expectation(description: "Saved original download " + interruption)
        let operation = Task {
          try await PhotoOriginalShareBatch.prepare(device: deviceSources, saved: [immutableSaved],
            valid: {
              guard services.photoAccountAccess != nil,
                SavedPhotoSelection.isCurrent([immutableSaved], lookup: services.consumerSavedPhoto),
                photos.validatePresentation(viewer: [], selection: [], share: deviceSources).shareIsCurrent
              else { throw CancellationError() }
            }, exportDevice: { _ in [deviceURL] }, exportSaved: { _ in
              started.fulfill()
              return await gate.read()
            }, expandSaved: { url, _ in [url] }, removeDevice: RecentShareExports.remove, removeSaved: ConsumerShareExports.remove)
        }
        await fulfillment(of: [started], timeout: 3)
        switch interruption {
        case "cancel": operation.cancel()
        case "lock": services.vault.lock()
        case "permission": permission = .denied
        default:
          saved.metadata.originalSha256 = Data("changed-original".utf8).digest
          try services.store.put(saved)
        }
        await gate.finish(savedURL)
        do { _ = try await operation.value; XCTFail("A withdrawn batch must not present any originals") }
        catch is CancellationError {} catch { XCTFail("Unexpected share withdrawal error: \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: deviceDirectory.deletingLastPathComponent().path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: savedDirectory.path))
      }
    }
  }
  @MainActor func testMixedShareExpansionFailureCleansPartialLivePairWithoutDeletingOtherTemporaryFiles() async throws {
    let saved = try samplePhoto()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-share-" + Wire.id())
    let other = FileManager.default.temporaryDirectory.appendingPathComponent("unrelated-" + Wire.id())
    let original = directory.appendingPathComponent("live.fotoro-live")
    defer { ConsumerShareExports.remove([original]); try? FileManager.default.removeItem(at: other) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("complete-archive".utf8).write(to: original)
    try Data("keep".utf8).write(to: other)
    do {
      _ = try await PhotoOriginalShareBatch.prepare(device: [], saved: [saved], valid: {},
        exportDevice: { _ in XCTFail("Saved-only batches need no Photos permission"); return [] },
        exportSaved: { _ in original }, expandSaved: { _, _ in
          try Data("partial-still".utf8).write(to: directory.appendingPathComponent("still.jpg"))
          throw FotoroError("CONTROLLED_MISSING_MOTION")
        }, removeDevice: RecentShareExports.remove, removeSaved: ConsumerShareExports.remove)
      XCTFail("A partial Live Photo must not be shared")
    } catch {}
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    RecentShareExports.remove([other, FileManager.default.temporaryDirectory.appendingPathComponent("unowned.jpg")])
    XCTAssertEqual(try Data(contentsOf: other), Data("keep".utf8), "Device cleanup cannot traverse a saved export or the temporary root")
    for name in ["", ".", "..", "../IMG.JPG", "folder/IMG.JPG", "folder\\IMG.JPG", "IMG\n.JPG"] {
      XCTAssertFalse(RecentOriginalFilename.isSafe(name))
    }
    XCTAssertTrue(RecentOriginalFilename.isSafe("IMG_1234.HEIC"))
  }
  func testUnifiedTimelineOrdersBothLibrariesAndNeverDeduplicatesBySimilarMetadata() throws {
    var saved = try samplePhoto()
    let date = Date(timeIntervalSince1970: 1_800_000_000)
    let facts = RecentPhotoFacts(capturedAt: date, favorite: false, screenshot: false, livePhoto: false, location: nil)
    let device = PhotoBrowseItem(source: RecentPhotoSource(id: saved.id, revision: "current"), facts: facts)
    let earlier = PhotoBrowseItem(source: RecentPhotoSource(id: "earlier", revision: "1"),
      facts: RecentPhotoFacts(capturedAt: date.addingTimeInterval(-86400), favorite: false, screenshot: false, livePhoto: false, location: nil))
    saved.metadata.sourceDate = Wire.date(date)
    let result = PhotoTimelinePolicy.groups(device: [earlier, device], saved: [.init(photo: saved, facts: facts)],
      sources: [], account: saved.manifest.ownerAccountId)
    XCTAssertEqual(result.flatMap(\.sources).map(\.id), ["device:" + saved.id, "saved:" + saved.id, "device:earlier"])
    XCTAssertEqual(result.flatMap(\.sources).count, 3, "Same ID, capture date, name or digest cannot prove a cross-library copy")
    let reversed = PhotoTimelinePolicy.groups(device: [device, earlier], saved: [.init(photo: saved, facts: facts)],
      sources: [], account: saved.manifest.ownerAccountId)
    XCTAssertEqual(result.flatMap(\.sources), reversed.flatMap(\.sources))
  }
  func testUnifiedTimelineDedupeWithdrawsWithRevisionOrPhotosPermission() throws {
    let saved = try samplePhoto(), account = saved.manifest.ownerAccountId
    let facts = RecentPhotoFacts(capturedAt: Date(), favorite: false, screenshot: false, livePhoto: false, location: nil)
    let source = BackupSource(id: "permitted-device", photoId: saved.id, phase: .committed,
      sourceRevision: "original", originalSha256: saved.metadata.originalSha256)
    let device = PhotoBrowseItem(source: RecentPhotoSource(id: source.id, revision: "original"), facts: facts)
    func ids(_ device: [PhotoBrowseItem], _ source: BackupSource, _ account: String?) -> [String] {
      PhotoTimelinePolicy.groups(device: device, saved: [.init(photo: saved, facts: facts)],
        sources: [source], account: account).flatMap(\.sources).map(\.id)
    }
    XCTAssertEqual(ids([device], source, account), ["device:permitted-device"])
    let edited = PhotoBrowseItem(source: RecentPhotoSource(id: source.id, revision: "edited"), facts: facts)
    XCTAssertEqual(Set(ids([edited], source, account)), ["device:permitted-device", "saved:" + saved.id])
    XCTAssertEqual(ids([], source, account), ["saved:" + saved.id], "Revoking device Photos access still leaves the unlocked owned copy")
    XCTAssertEqual(ids([], source, nil), [], "Locking Fotoro withdraws saved copies")
    XCTAssertEqual(ids([], source, Wire.id()), [], "Other account originals never join this timeline")
    var unverified = source; unverified.originalSha256 = Data("different".utf8).digest
    XCTAssertEqual(ids([device], unverified, account).count, 2)
    unverified = source; unverified.phase = .pending
    XCTAssertEqual(ids([device], unverified, account).count, 2)
  }
  func testUnifiedTimelineKeepsSavedFavoriteWhenItsDeviceCopyIsFilteredOut() throws {
    let saved = try samplePhoto()
    var favorite = RecentPhotoFacts(capturedAt: Date(), favorite: true, screenshot: false, livePhoto: false, location: nil)
    let source = BackupSource(id: "device", photoId: saved.id, phase: .committed,
      sourceRevision: "current", originalSha256: saved.metadata.originalSha256)
    favorite.favorite = false
    let device = PhotoBrowseItem(source: RecentPhotoSource(id: "device", revision: "current"), facts: favorite)
    favorite.favorite = true
    let filtered = PhotoTimelinePolicy.groups(device: [device], saved: [.init(photo: saved, facts: favorite)],
      sources: [source], account: saved.manifest.ownerAccountId, filter: .favorites)
    XCTAssertEqual(filtered.flatMap(\.sources).map(\.id), ["saved:" + saved.id])
  }
  func testLegacyCatalogBuildsDigestIndexAndRescansMediaOnlyOnce() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let original = try samplePhoto()
    let legacy = try DatabaseQueue(path: root.appendingPathComponent("catalog.sqlite").path)
    try legacy.write { db in
      try db.execute(sql: "CREATE TABLE photos(id TEXT PRIMARY KEY, sourceDate TEXT NOT NULL, value BLOB NOT NULL); CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT)")
      try db.execute(sql: "INSERT INTO photos(id,sourceDate,value) VALUES(?,?,?)",
        arguments: [original.id, original.metadata.sourceDate, try Wire.encode(original)])
      try db.execute(sql: "INSERT INTO state(key,value) VALUES('cursor','legacy-passed-hidden-media')")
    }
    let store = try LibraryStore(root: root)
    XCTAssertNil(try store.cursor(), "An older reader may have advanced past hidden media")
    XCTAssertEqual(try store.ownedOriginal(digest: original.metadata.originalSha256,
      accountId: original.manifest.ownerAccountId)?.id, original.id)
    let plan = try store.database.read { db in
      try Row.fetchAll(db, sql: "EXPLAIN QUERY PLAN " + LibraryStore.ownedOriginalQuery,
        arguments: [original.manifest.ownerAccountId, original.metadata.originalSha256])
        .map { $0["detail"] as String }
    }
    XCTAssertTrue(plan.contains { $0.contains("photos_owned_original") }, "Digest reuse must avoid decoding the whole library")
    try store.apply(ChangePageV1(version: 1, changes: [], nextCursor: "media-aware", hasMore: false))
    let reopened = try LibraryStore(root: root)
    XCTAssertEqual(try reopened.cursor(), "media-aware", "Reader capability migration must not repeatedly rescan")
    XCTAssertEqual(try reopened.ownedOriginal(digest: original.metadata.originalSha256,
      accountId: original.manifest.ownerAccountId)?.id, original.id)
  }
  func testIndexedDigestReuseTracksMutationsAndPrefersSavedOriginals() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root)
    var pending = try samplePhoto(), saved = try samplePhoto(), received = try samplePhoto()
    pending.transferState = "pending"
    received.transferState = "received"
    let account = saved.manifest.ownerAccountId, digest = saved.metadata.originalSha256
    try store.put(pending); try store.put(received); try store.put(saved)
    XCTAssertEqual(try store.ownedOriginal(digest: digest, accountId: account)?.id, saved.id)
    XCTAssertNil(try store.ownedOriginal(digest: digest, accountId: Wire.id()))
    saved.metadata.originalSha256 = Data("changed-original".utf8).digest
    try store.put(saved)
    XCTAssertEqual(try store.ownedOriginal(digest: digest, accountId: account)?.id, pending.id)
    pending.manifest.ownerAccountId = Wire.id()
    try store.put(pending)
    XCTAssertNil(try store.ownedOriginal(digest: digest, accountId: account), "Received and other-account rows cannot satisfy owned reuse")
    XCTAssertEqual(try store.ownedOriginal(digest: saved.metadata.originalSha256, accountId: account)?.id, saved.id)
    try store.apply(ChangePageV1(version: 1,
      changes: [ChangeV1(cursor: "1", entity: "photo", entityId: saved.id, deleted: true, payload: nil)],
      nextCursor: "1", hasMore: false))
    XCTAssertNil(try store.ownedOriginal(digest: saved.metadata.originalSha256, accountId: account))
    try store.removeAll()
    XCTAssertNil(try store.ownedOriginal(digest: digest, accountId: pending.manifest.ownerAccountId))
  }
  func testVerifiedCatalogRescanPreservesOnlyUnchangedCachedOriginals() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root)
    var original = try samplePhoto()
    original.originalURL = try store.write(Data("jpg".utf8), name: "original.jpg")
    original.previewURL = try store.write(Data("preview".utf8), name: "preview.jpg")
    try store.put(original)
    var downloaded = original
    downloaded.originalURL = nil; downloaded.previewURL = nil
    let change = ChangeV1(cursor: "1", entity: "photo", entityId: original.id, deleted: false, payload: nil)
    let page = ChangePageV1(version: 1, changes: [change], nextCursor: "1", hasMore: false)
    try store.apply(page, verified: [original.id: downloaded])
    let retained = try XCTUnwrap(store.backupPhoto(original.id))
    XCTAssertEqual(retained.originalURL, original.originalURL)
    XCTAssertEqual(retained.previewURL, original.previewURL)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(retained.originalURL)), Data("jpg".utf8))
    downloaded.metadata.originalSha256 = Data("new-original".utf8).digest
    try store.apply(page, verified: [original.id: downloaded])
    XCTAssertNil(try store.backupPhoto(original.id)?.originalURL, "A different original cannot inherit earlier cache files")
    XCTAssertNil(try store.backupPhoto(original.id)?.previewURL)
  }
  func testEmptySavedGuidanceUsesTheActualSyncPhase() {
    let expected: [(AutomaticPhotoSyncStatus.Phase, String)] = [
      (.paused, "Sync is paused. Resume to add your photos."),
      (.locked, "Open Fotoro to resume sync."),
      (.permissionRequired, "Allow Photos access in Settings to sync your photos."),
      (.needsAttention, "Open Sync to review what needs attention."),
      (.partial, "Some originals couldn't sync. Open Sync for details."),
      (.background, "Open Fotoro to continue syncing your photos."),
      (.syncing, "Photos appear here as they sync. Keep Fotoro open."),
      (.ready, "No photos saved yet. Sync is on for the photos you allow.")
    ]
    for (phase, message) in expected {
      let status = AutomaticPhotoSyncStatus(enabled: true, paused: phase == .paused, phase: phase, detail: "")
      XCTAssertEqual(savedLibraryEmptyMessage(sync: status), message)
      XCTAssertEqual(savedLibraryEmptyMessage(sync: status, favoritesOnly: true), "No saved favorites yet.")
    }
    XCTAssertEqual(savedLibraryEmptyMessage(sync: AutomaticPhotoSyncStatus(enabled: false, paused: false, phase: .off, detail: "")),
      "Save photos in Fotoro, or pull down to check photos saved on another device.")
  }
  func testServiceLimitsExplainTheNextActionWithoutChangingRetrySemantics() {
    let full = FotoroError("STORAGE_QUOTA_EXCEEDED")
    XCTAssertEqual(full.errorDescription, "Fotoro storage is full. Pause sync or contact support.")
    XCTAssertFalse(full.retryable)
    let limited = FotoroError("AUTH_RATE_LIMITED", retryable: true)
    XCTAssertEqual(limited.errorDescription, "Too many attempts. Wait a minute and try again.")
    XCTAssertTrue(limited.retryable)
  }
  func testSyncOpeningRequiresAPrivateCurrentAccountEvenWhenLocalCatalogIsReadable() {
    let privateAccount = "11111111-1111-4111-8111-111111111111"
    XCTAssertFalse(PhotoSyncAccountPolicy.requiresAuthentication(hasAccountAccess: true, isSignedIn: true,
      accountId: privateAccount, fixture: false, rejectedSession: false))
    for (account, fixture, signedIn, rejected) in [
      (privateAccount, true, true, false),
      ("00000000-0000-4000-8000-000000000001", false, true, false),
      (privateAccount, false, false, false),
      (privateAccount, false, true, true),
    ] {
      XCTAssertTrue(PhotoSyncAccountPolicy.requiresAuthentication(hasAccountAccess: true, isSignedIn: signedIn,
        accountId: account, fixture: fixture, rejectedSession: rejected))
    }
    XCTAssertTrue(PhotoSyncAccountPolicy.requiresAuthentication(hasAccountAccess: false, isSignedIn: true,
      accountId: privateAccount, fixture: false, rejectedSession: false))
  }
  func testAccountEntryKeepsPrivateRememberedRecoveryOneTapAndExcludesPublicAccounts() {
    let privateAccount = "11111111-1111-4111-8111-111111111111"
    XCTAssertEqual(AccountEntryPolicy.initialPage(accountId: privateAccount, fixture: false,
      hasRememberedPassword: true, isSignedIn: true, canUnlockLocally: true,
      enterPassword: false, reauthenticate: true), .remembered)
    for (account, fixture) in [(privateAccount, true), ("00000000-0000-4000-8000-000000000001", false)] {
      XCTAssertEqual(AccountEntryPolicy.initialPage(accountId: account, fixture: fixture,
        hasRememberedPassword: true, isSignedIn: true, canUnlockLocally: true,
        enterPassword: false, reauthenticate: true), .welcome)
    }
    XCTAssertEqual(AccountEntryPolicy.initialPage(accountId: nil, fixture: false,
      hasRememberedPassword: false, isSignedIn: false, canUnlockLocally: false,
      enterPassword: false, reauthenticate: false), .welcome)
    XCTAssertEqual(AccountEntryPolicy.initialPage(accountId: privateAccount, fixture: false,
      hasRememberedPassword: false, isSignedIn: true, canUnlockLocally: true,
      enterPassword: false, reauthenticate: true), .welcome)
    XCTAssertEqual(AccountEntryPolicy.initialPage(accountId: privateAccount, fixture: false,
      hasRememberedPassword: true, isSignedIn: true, canUnlockLocally: true,
      enterPassword: true, reauthenticate: false), .password)
  }
  @MainActor func testChoosingPrivateAuthenticationFromFixtureKeepsAccountCatalogAndQueuedPhotos() async throws {
    try await withSavedLibrary { services, server in
      let previousFixture = UserDefaults.standard.object(forKey: "fotoro.fixtureAccount")
      defer {
        if let previousFixture { UserDefaults.standard.set(previousFixture, forKey: "fotoro.fixtureAccount") }
        else { UserDefaults.standard.removeObject(forKey: "fotoro.fixtureAccount") }
      }
      let account = try XCTUnwrap(services.session.accountId), catalog = services.store
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = account
      photo.transferState = "pending"
      try catalog.put(photo)
      try services.journal.enqueue(photo, publicSample: true)
      UserDefaults.standard.set(account, forKey: "fotoro.fixtureAccount")
      try AccountEntryPolicy.preparePrivateAuthentication(services)
      XCTAssertFalse(services.session.fixture)
      XCTAssertEqual(services.api.baseURL, APIURLPolicy.canonical)
      XCTAssertEqual(services.session.accountId, account)
      XCTAssertTrue(services.store === catalog)
      XCTAssertNotNil(try catalog.backupPhoto(photo.id))
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [photo.id])
      XCTAssertNil(UserDefaults.standard.object(forKey: "fotoro.fixtureAccount"))
      XCTAssertFalse(services.automaticPhotoSync.enabled)
      XCTAssertTrue(server.requests.isEmpty)
    }
  }
  func testUnknownTotalsAreOmittedAndQueuedPhotosDoNotCountAsCompleted() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.pending = 2
    let summary = ConsumerSyncSummary.derive(facts)
    XCTAssertEqual(summary.completedPhotos, 0)
    XCTAssertNil(summary.totalPhotos)
    XCTAssertEqual(summary.state, .needsAttention)
  }
  func testPausePrecedesOfflineAndLockedSnapshotDropsPrivateCounts() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.paused = true
    facts.offline = true
    facts.completed = 12
    facts.pending = 1
    facts.total = 13
    facts.skipped = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .paused)
    facts.unlocked = false
    let locked = ConsumerSyncSummary.derive(facts)
    XCTAssertNil(locked.completedPhotos)
    XCTAssertNil(locked.totalPhotos)
    XCTAssertEqual(locked.skippedPhotos, 0)
    XCTAssertEqual(locked.action, .signIn)
  }
  func testSkippedPhotosNeedAttentionWhileLocalDraftsKeepSavedPhotosReady() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.completed = 1
    facts.lastChecked = Date()
    facts.skipped = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .needsAttention)
    facts.skipped = 0
    facts.annotationsPending = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).detail, "Photo changes are saved on this device.")
    facts.annotationsPending = 0
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start, "A finished batch must still allow another explicit Save")
  }
  func testManualSaveIsAvailableWhenIdleAndContinueRequiresActualQueue() {
    var facts = ConsumerSyncFacts()
    facts.unlocked = true
    facts.paused = true
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start)
    facts.completed = 5
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).state, .upToDate)
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .start)
    facts.pending = 1
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .continue)
    facts.paused = false
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .retry)
    facts.preparing = true
    XCTAssertEqual(ConsumerSyncSummary.derive(facts).action, .none)
  }
  func testVerifiedMappingDeduplicatesOnlyCurrentRevisionAndOriginalDigest() throws {
    let photo = try samplePhoto()
    var source = BackupSource(id: "local", photoId: photo.id, phase: .committed, sourceRevision: "current", originalSha256: photo.metadata.originalSha256)
    let record = SearchRecord(id: "local", revision: "current")
    func duplicate(_ saved: LocalPhoto) -> Bool {
      ConsumerSearchBinding.duplicate(saved: saved, copies: ConsumerSearchBinding.verifiedCopies(sources: [source], records: [record.id: record]))
    }
    XCTAssertTrue(duplicate(photo))
    XCTAssertTrue(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    var altered = photo
    altered.metadata.originalSha256 = Data("different".utf8).digest
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: altered))
    XCTAssertFalse(duplicate(altered))
    source.sourceRevision = "old"
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
    source.sourceRevision = nil
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
    source.sourceRevision = "current"
    source.photoId = UUID().uuidString
    XCTAssertFalse(ConsumerSearchBinding.duplicate(source: source, record: record, saved: photo))
    XCTAssertFalse(duplicate(photo))
  }
  @MainActor func testCloudOnlyReceiptAndLocalRankingSurviveLocalPermissionWithdrawal() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let defaults = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let services = try AppServices(root: root)
    defer {
      services.vault.lock()
      Keychain.remove(accounts.accounts[0].accountId)
      if let defaults { UserDefaults.standard.set(defaults, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: root)
    }
    services.session.accountId = accounts.accounts[0].accountId
    services.session.fixture = true
    try services.session.pin(accounts.accounts[0])
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: accounts.testSecrets[0].recoverySecret), wrapper: accounts.testSecrets[0].encryptedBundle))
    try services.activateAccount()
    let cloud = try samplePhoto()
    try services.store.put(cloud)
    let index = try SearchIndex()
    var localRecord = SearchRecord(id: "permitted-local")
    localRecord.labels = ["receipt"]
    localRecord.burstID = "known-burst"
    var child = SearchRecord(id: "permitted-child")
    child.labels = ["receipt"]
    child.burstID = "known-burst"
    child.capturedAt = Date(timeIntervalSince1970: 1)
    localRecord.capturedAt = Date(timeIntervalSince1970: 2)
    try index.replacePermitted([localRecord, child])
    let local = LocalSearchStore(index: index)
    let result = try await services.consumerSearch("receipt", local: local)
    XCTAssertEqual(result.map(\.photo), [.device("permitted-local"), .device("permitted-child"), .saved(cloud.id)])
    XCTAssertEqual(try services.consumerSavedPhoto(cloud.id)?.id, cloud.id)
    let gate = CatalogScanGate()
    var unrelated = try samplePhoto()
    unrelated.metadata.filename = "other.jpg"
    try services.store.put(unrelated)
    services.catalogSearchWillRead = { gate.visit() }
    let scan = Task { try await services.searchCatalog("receipt") }
    while gate.count == 0 { await Task.yield() }
    scan.cancel()
    gate.release.signal()
    do { _ = try await scan.value; XCTFail("Cancelled scan must not publish") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(gate.count, 1, "Parent cancellation must stop the actual catalog worker before it reads another photo")
    services.catalogSearchWillRead = nil
    local.auditAuthorization(status: .denied)
    let afterWithdrawal = try await services.consumerSearch("receipt", local: local)
    XCTAssertEqual(afterWithdrawal.map(\.photo), [.saved(cloud.id)])
    services.vault.lock()
    let afterLock = try await services.consumerSearch("receipt", local: local)
    XCTAssertTrue(afterLock.isEmpty)
    XCTAssertNil(services.consumerSyncSummary.completedPhotos)
    XCTAssertNil(try services.consumerSavedPhoto(cloud.id))
  }
  @MainActor func testSavedResolutionRejectsPendingAndOtherAccountRecords() async throws {
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let priorCards = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    defer {
      services.vault.lock(); Keychain.remove(accounts.accounts[0].accountId)
      if let priorCards { UserDefaults.standard.set(priorCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: services.storageRoot)
    }
    services.session.accountId = accounts.accounts[0].accountId
    services.session.fixture = true
    try services.session.pin(accounts.accounts[0])
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: accounts.testSecrets[0].recoverySecret), wrapper: accounts.testSecrets[0].encryptedBundle))
    try services.activateAccount()
    var photo = try samplePhoto()
    try services.store.put(photo)
    XCTAssertNotNil(try services.consumerSavedPhoto(photo.id))
    photo.metadata.filename = "../../receipt.jpg"
    photo.originalURL = try services.store.write(Data("jpg".utf8), name: "cache-original.jpg")
    try services.store.put(photo)
    let exported = try await services.consumerShareOriginal(photo)
    defer { try? FileManager.default.removeItem(at: exported.deletingLastPathComponent()) }
    XCTAssertEqual(exported.lastPathComponent, "receipt.jpg")
    XCTAssertNotEqual(exported, photo.originalURL)
    try FileManager.default.removeItem(at: XCTUnwrap(photo.originalURL))
    XCTAssertEqual(try? Data(contentsOf: exported), Data("jpg".utf8), "Owned share copy must survive cache eviction")

    photo.transferState = "pending"
    try services.store.put(photo)
    XCTAssertNil(try services.consumerSavedPhoto(photo.id))
    photo.transferState = "committed"
    photo.manifest.ownerAccountId = accounts.accounts[1].accountId
    try services.store.put(photo)
    XCTAssertNil(try services.consumerSavedPhoto(photo.id))
    photo.manifest.ownerAccountId = accounts.accounts[0].accountId
    photo.originalURL = try services.store.write(Data("jpg".utf8), name: "cache-original.jpg")
    try services.store.put(photo)
    var written: URL?
    services.consumerShareDidWrite = { written = $0 }
    let cancelled = Task { try await services.consumerShareOriginal(photo) }
    cancelled.cancel()
    do { _ = try await cancelled.value; XCTFail("Cancelled share cannot publish a copy") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertNil(written)
    services.consumerShareDidWrite = { written = $0; services.vault.lock() }
    do { _ = try await services.consumerShareOriginal(photo); XCTFail("Lock after export must reject the copy") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(written).deletingLastPathComponent().path))
    services.consumerShareDidWrite = nil
  }
  @MainActor func testSavedNaturalDatesComposeTextAndOnlyTrustCaptureProvenance() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let previousCards = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let services = try AppServices(root: root)
    defer {
      services.vault.lock(); Keychain.remove(accounts.accounts[0].accountId)
      if let previousCards { UserDefaults.standard.set(previousCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: root)
    }
    services.session.accountId = accounts.accounts[0].accountId
    services.session.fixture = true
    try services.session.pin(accounts.accounts[0])
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: accounts.testSecrets[0].recoverySecret), wrapper: accounts.testSecrets[0].encryptedBundle))
    try services.activateAccount()
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/New_York")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 4, day: 15, hour: 12))!
    let march = calendar.date(from: DateComponents(year: 2026, month: 3, day: 8, hour: 12))!
    let end = calendar.date(from: DateComponents(year: 2026, month: 4, day: 1))!
    var photos = try samplePhoto()
    photos.metadata.filename = "beach.png"
    photos.metadata.sourceDate = Wire.date(march)
    photos.metadata.dateSource = "photos"
    var exif = try samplePhoto()
    exif.metadata.filename = "other.png"
    exif.metadata.sourceDate = Wire.date(march)
    exif.metadata.dateSource = "exif"
    var imported = try samplePhoto()
    imported.metadata.filename = "beach-import.png"
    imported.metadata.sourceDate = Wire.date(march)
    imported.metadata.dateSource = "import"
    var boundary = try samplePhoto()
    boundary.metadata.filename = "beach-end.png"
    boundary.metadata.sourceDate = Wire.date(end)
    boundary.metadata.dateSource = "photos"
    var malformed = try samplePhoto()
    malformed.metadata.filename = "beach-invalid.png"
    malformed.metadata.sourceDate = "invalid"
    malformed.metadata.dateSource = "photos"
    var unrelated = try samplePhoto()
    unrelated.metadata.filename = "beach-other-account.png"
    unrelated.metadata.sourceDate = Wire.date(march)
    unrelated.manifest.ownerAccountId = accounts.accounts[1].accountId
    for photo in [photos, exif, imported, boundary, malformed, unrelated] { try services.store.put(photo) }
    try services.setLabels(["beach"], photo: exif)
    let combined = try await services.searchCatalog("beach last month", now: now, calendar: calendar)
    XCTAssertEqual(Set(combined.map(\.id)), [photos.id, exif.id])
    let dateOnly = try await services.searchCatalog("last month", now: now, calendar: calendar)
    XCTAssertEqual(Set(dateOnly.map(\.id)), [photos.id, exif.id])
    let plain = try await services.searchCatalog("beach", now: now, calendar: calendar)
    XCTAssertTrue(plain.contains(where: { $0.id == imported.id }), "An import date is ineligible only for capture-date queries")
    let invalid = try await services.searchCatalog("beach 2026-02-30", now: now, calendar: calendar)
    XCTAssertTrue(invalid.isEmpty, "An invalid date stays evidence text, without partial date matching")
    let unsupported = try await services.searchCatalog("Aunt Mira last month", now: now, calendar: calendar)
    XCTAssertTrue(unsupported.isEmpty, "Date matches cannot invent a named-person match")
    XCTAssertEqual(try services.annotations.ledger.pendingIDs(), [exif.id])
  }

  @MainActor func testSavedReviewedPeopleChoicesFindAnyAndEveryoneWithoutPhotosPermission() async throws {
    try await withSavedLibrary { services, _ in
      let account = try XCTUnwrap(services.session.accountId)
      let card = try services.session.requireCard(account), bundle = try services.vault.requireBundle()
      let first = Wire.id(), second = Wire.id()
      @MainActor func saved(_ assignments: [(String, String)], digest: String? = nil, state: String = "committed") throws -> LocalPhoto {
        var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = account; photo.transferState = state
        try services.store.put(photo)
        var annotation = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
        annotation.facts = try PhotoPeopleFacts.replacing([], with: assignments.enumerated().map {
          PhotoPersonAssignment(p: $0.element.0, n: $0.element.1, b: [$0.offset*100,0,100,100])
        }, originalSha256: digest ?? photo.metadata.originalSha256)
        try services.annotations.ledger.edit(annotation, photo: photo, bundle: bundle, card: card)
        return photo
      }
      let a = try saved([(first, "Family")]), b = try saved([(second, "Family")])
      let together = try saved([(first, "Family"), (second, "Family")])
      _ = try saved([(Wire.id(), "Wrong source")], digest: Data("other-original".utf8).digest)
      _ = try saved([(Wire.id(), "Not saved")], state: "pending")
      var foreign = try self.samplePhoto(); foreign.manifest.ownerAccountId = Wire.id(); try services.store.put(foreign)
      let local = LocalSearchStore(index: try SearchIndex())
      local.auditAuthorization(status: .denied)
      XCTAssertFalse(local.peopleSnapshotReady)
      let loaded = try await SavedPeopleSearchSnapshot.load(services)
      let snapshot = try XCTUnwrap(loaded)
      XCTAssertEqual(Set(snapshot.choices.map(\.id)), [first, second])
      XCTAssertEqual(snapshot.choices.map(\.name), ["Family", "Family"], "Names alone must not merge different people UUIDs")
      let any = PeopleSearchSelection(personIDs: [first, second])
      XCTAssertTrue(PhotoPeopleSearchChoice.canFind(any, choices: snapshot.choices))
      local.setPeopleSelection(any, names: Dictionary(uniqueKeysWithValues: snapshot.choices.map { ($0.id, $0.name) }))
      let anyHits = try await services.consumerSearch("", local: local)
      XCTAssertEqual(Set(anyHits.map(\.photo)), [.saved(a.id), .saved(b.id), .saved(together.id)])
      local.setPeopleSelection(PeopleSearchSelection(personIDs: [first, second], match: .everyone))
      let everyoneHits = try await services.consumerSearch("", local: local)
      XCTAssertEqual(everyoneHits.map(\.photo), [.saved(together.id)])
    }
  }
  @MainActor func testSavedPeopleChoicesInvalidateWithSourceAccountVaultOriginAndCatalog() async throws {
    for interruption in ["source", "account", "lock", "origin", "catalog"] {
      try await withSavedLibrary { services, _ in
        var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
        try services.store.put(photo)
        var annotation = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
        annotation.facts = try PhotoPeopleFacts.replacing([], with: [PhotoPersonAssignment(p: Wire.id(), n: "Family", b: [0,0,100,100])], originalSha256: photo.metadata.originalSha256)
        try services.annotations.ledger.edit(annotation, photo: photo, bundle: services.vault.requireBundle(),
          card: services.session.requireCard(photo.manifest.ownerAccountId))
        let loaded = try await SavedPeopleSearchSnapshot.load(services)
        let snapshot = try XCTUnwrap(loaded)
        XCTAssertTrue(snapshot.isCurrent(services))
        switch interruption {
        case "source": photo.metadata.originalSha256 = Data("replacement".utf8).digest; try services.store.put(photo)
        case "account": services.session.accountId = Wire.id()
        case "lock": services.vault.lock()
        case "origin": services.api.baseURL = URL(string: "http://localhost:8796")!
        default: try services.reload()
        }
        XCTAssertFalse(snapshot.isCurrent(services), interruption)
      }
    }
  }
  @MainActor func testRejectingLastReviewedLocalFaceInvalidatesSavedPeopleChoiceWithoutChangingOriginal() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      try services.store.put(photo)
      let record = SearchRecord(id: "local-family-source", revision: "current")
      try services.store.putBackupSource(BackupSource(id: record.id, photoId: photo.id, phase: .committed,
        sourceRevision: record.revision, originalSha256: photo.metadata.originalSha256))
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: record.id, capturedAt: Date(), sourceRevision: record.revision)] }
      let index = try SearchIndex(); try index.setWorkGeneration(1)
      try index.replacePermitted([record]); try index.setPeopleEnabled(true)
      var vector = [Float](repeating: 0, count: 128); vector[0] = 1
      XCTAssertTrue(try index.applyPeople([PhotoFaceEmbedding(box: [0,0,100,100], vector: vector)],
        photoID: record.id, revision: record.revision, generation: 1))
      let group = try XCTUnwrap(index.peopleGroups().first)
      let local = LocalSearchStore(index: index)
      services.bindLocalSearch(local)
      for changed in try index.namePeopleGroup(group.id, name: "Family") {
        try local.onRecordChanged?(changed, true)
      }
      let loaded = try await SavedPeopleSearchSnapshot.load(services)
      let snapshot = try XCTUnwrap(loaded)
      XCTAssertEqual(snapshot.choices.map(\.id), [group.id])
      let face = try XCTUnwrap(index.peopleGroups().first?.faces.first)
      let corrected = try index.splitPeopleFace(face.id, reject: true)
      XCTAssertFalse(corrected.isEmpty)
      for changed in corrected { try local.onRecordChanged?(changed, true) }
      XCTAssertFalse(snapshot.isCurrent(services), "An annotation correction must invalidate choices even with the same original")
      let current = try XCTUnwrap(services.consumerSavedPhoto(photo.id))
      XCTAssertEqual(current.metadata, photo.metadata); XCTAssertEqual(current.manifest, photo.manifest)
      XCTAssertTrue(PhotoPeopleFacts.read(services.annotation(current).facts ?? [], originalSha256: current.metadata.originalSha256).isEmpty)
      let reloaded = try await SavedPeopleSearchSnapshot.load(services)
      XCTAssertTrue(try XCTUnwrap(reloaded).choices.isEmpty)
      let generation = services.consumerCatalogGeneration
      for changed in corrected { try local.onRecordChanged?(changed, true) }
      XCTAssertEqual(services.consumerCatalogGeneration, generation, "An unchanged People overlay must not repeatedly invalidate the catalog")
    }
  }
  @MainActor func testSavedPeopleChoiceScanRejectsLateResultsAfterLockAndCancellation() async throws {
    for interruption in ["lock", "cancel", "account", "origin", "catalog"] {
      try await withSavedLibrary { services, _ in
        var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
        try services.store.put(photo)
        let gate = CatalogScanGate()
        let scan = Task {
          try await SavedPeopleSearchSnapshot.load(services, readPage: { catalog, after, limit in
            try await Task.detached { gate.visit(); return try catalog.photos(after: after, limit: limit) }.value
          })
        }
        while gate.count == 0 { await Task.yield() }
        switch interruption {
        case "lock": services.vault.lock()
        case "account": services.session.accountId = Wire.id()
        case "origin": services.api.baseURL = URL(string: "http://localhost:8796")!
        case "catalog": try services.reload()
        default: scan.cancel()
        }
        gate.release.signal()
        do { _ = try await scan.value; XCTFail("Withdrawn Saved choices must not publish") }
        catch { XCTAssertTrue(error is CancellationError) }
      }
    }
  }

  @MainActor func testSavedPeopleNamesLoadOnlyOneExplicitPageAndRetainEarlierChoices() async throws {
    try await withSavedLibrary { services, _ in
      let account = try XCTUnwrap(services.session.accountId)
      let bundle = try services.vault.requireBundle(), card = try services.session.requireCard(account)
      let first = Wire.id(), older = Wire.id()
      let start = try XCTUnwrap(Wire.parseDate("2026-10-01T00:00:00.000Z"))
      for index in 0...202 {
        var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = account
        photo.metadata.sourceDate = Wire.date(start.addingTimeInterval(Double(index)))
        if index == 201 { photo.transferState = "pending" }
        if index == 202 { photo.manifest.ownerAccountId = Wire.id() }
        try services.store.put(photo)
        if index == 200 || index == 0 {
          var annotation = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
          let assignments = index == 200 ? [PhotoPersonAssignment(p: first, n: "Newest name", b: [0,0,100,100])]
            : [PhotoPersonAssignment(p: first, n: "Earlier name", b: [0,0,100,100]),
               PhotoPersonAssignment(p: older, n: "Older reviewed person", b: [100,0,100,100])]
          annotation.facts = try PhotoPeopleFacts.replacing([], with: assignments, originalSha256: photo.metadata.originalSha256)
          try services.annotations.ledger.edit(annotation, photo: photo, bundle: bundle, card: card)
        }
      }
      let probe = SavedPeoplePageProbe()
      let read: @Sendable (LibraryStore, String?, Int) async throws -> [LocalPhoto] = { catalog, after, limit in
        await probe.record(after: after, limit: limit)
        return try await Task.detached { try catalog.photos(after: after, limit: limit) }.value
      }
      let initial = try await SavedPeopleSearchSnapshot.load(services, readPage: read)
      let firstPage = try XCTUnwrap(initial)
      XCTAssertEqual(firstPage.checkedPhotos, 198)
      XCTAssertTrue(firstPage.hasMore)
      XCTAssertEqual(firstPage.choices.map(\.id), [first])
      let selection = PeopleSearchSelection(personIDs: [first])
      let loaded = try await SavedPeopleSearchSnapshot.load(services, continuing: firstPage, readPage: read)
      let nextPage = try XCTUnwrap(loaded)
      XCTAssertEqual(nextPage.checkedPhotos, 201)
      XCTAssertFalse(nextPage.hasMore)
      XCTAssertEqual(Set(nextPage.choices.map(\.id)), [first, older])
      XCTAssertEqual(nextPage.choices.first(where: { $0.id == first })?.name, "Newest name")
      XCTAssertTrue(PhotoPeopleSearchChoice.canFind(selection, choices: nextPage.choices))
      _ = try await SavedPeopleSearchSnapshot.load(services, continuing: nextPage, readPage: read)
      let requests = await probe.requests
      XCTAssertEqual(requests.count, 2, "Opening and each explicit continuation read one page; completion does not read again")
      XCTAssertEqual(requests.map(\.limit), [200, 200])
      XCTAssertNil(requests[0].after); XCTAssertNotNil(requests[1].after)
    }
  }

  @MainActor func testSavedPeoplePagesDeduplicateAndRejectRepeatingCursorOrStaleContinuation() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto(); photo.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      try services.store.put(photo)
      let repeated = Array(repeating: photo, count: SavedPeopleSearchSnapshot.pageSize)
      let loaded = try await SavedPeopleSearchSnapshot.load(services, readPage: { _, _, _ in repeated })
      let snapshot = try XCTUnwrap(loaded)
      XCTAssertEqual(snapshot.checkedPhotos, 1)
      XCTAssertTrue(snapshot.hasMore)
      do {
        _ = try await SavedPeopleSearchSnapshot.load(services, continuing: snapshot, readPage: { _, _, _ in repeated })
        XCTFail("A repeating cursor must stop rather than silently loop or claim complete coverage")
      } catch { XCTAssertFalse(error is CancellationError) }
      try services.reload()
      do {
        _ = try await SavedPeopleSearchSnapshot.load(services, continuing: snapshot)
        XCTFail("A stale generation must not continue an earlier page")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
  }

  private func samplePhoto() throws -> LocalPhoto {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let owner = accounts.testSecrets[0]
    let id = Wire.id()
    let rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: "", ciphertextBytes: 1, ciphertextSha256: Data("cipher".utf8).digest)
    return LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: owner.accountId, representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "receipt.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:]), transferState: "committed")
  }
}

private actor SavedPeoplePageProbe {
  struct Request: Sendable { let after: String?; let limit: Int }
  private(set) var requests: [Request] = []
  func record(after: String?, limit: Int) { requests.append(Request(after: after, limit: limit)) }
}

private final class CatalogScanGate: @unchecked Sendable {
  private let lock = NSLock()
  private var visits = 0
  let release = DispatchSemaphore(value: 0)
  var count: Int { lock.lock(); defer { lock.unlock() }; return visits }
  func visit() {
    lock.lock(); visits += 1; let first = visits == 1; lock.unlock()
    if first { _ = release.wait(timeout: .now() + 10) }
  }
}

extension ConsumerCoreTests {
  func testReleaseAPIRestorationIgnoresEverySavedOverride() {
    for saved in [nil, "http://127.0.0.1:8787", "http://localhost:8790", "https://old-api.invalid",
      "https://user:secret@fotoro.cloud", "https://fotoro.cloud?token=secret", "http://[invalid"] {
      XCTAssertEqual(APIURLPolicy.restored(saved, development: false), APIURLPolicy.canonical)
    }
    XCTAssertNil(APIURLPolicy.configured("http://127.0.0.1:8787", development: false))
    XCTAssertNil(APIURLPolicy.configured("https://old-api.invalid", development: false))
    XCTAssertEqual(APIURLPolicy.configured("https://fotoro.cloud:443/", development: false), APIURLPolicy.canonical)
  }
  func testDevelopmentAPIOverridesMustBeCredentialFreeOrigins() {
    for valid in ["http://127.0.0.1:8787", "http://localhost:8790", "https://dev-api.invalid"] {
      XCTAssertEqual(APIURLPolicy.restored(valid, development: true).absoluteString, valid)
    }
    for invalid in ["http://remote.invalid", "https://user:secret@fotoro.cloud", "https://fotoro.cloud?token=secret",
      "https://fotoro.cloud#secret", "https://fotoro.cloud/v1", "https://fotoro.cloud:65536", "http://[invalid"] {
      XCTAssertNil(APIURLPolicy.configured(invalid, development: true))
      XCTAssertEqual(APIURLPolicy.restored(invalid, development: true), APIURLPolicy.canonical)
    }
  }
  @MainActor func testAPIRejectedOriginsAndFixtureSecretsRecordAttemptsWithoutPrivateData() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let session = AccountSession()
    session.fixture = false
    let api = APIClient(session: session, baseURL: APIURLPolicy.canonical, diagnostics: diagnostics)
    do {
      _ = try await api.request("https://foreign.invalid/v1/auth/private-token?token=private-secret", method: "POST")
      XCTFail("Foreign origins must be rejected before networking")
    } catch { XCTAssertEqual((error as? FotoroError)?.message, "Untrusted API URL") }
    session.fixture = true
    do {
      _ = try await api.request("/v1/auth/private-token", method: "POST", body: Data("private-secret".utf8))
      XCTFail("Fixture credentials must be rejected before networking")
    } catch { XCTAssertEqual((error as? FotoroError)?.message, "Fixture secrets cannot leave loopback") }
    let events = try diagnosticEvents(diagnostics, file: file)
    XCTAssertEqual(events.map(\.outcome), [.started, .failed, .started, .failed])
    XCTAssertTrue(events.allSatisfy { $0.phase == .api && $0.endpoint == .auth && $0.method == .POST })
    let serialized = try String(contentsOf: file, encoding: .utf8)
    for secret in ["private-token", "private-secret", "foreign.invalid", "https://"] { XCTAssertFalse(serialized.contains(secret)) }
  }
  @MainActor func testAuthenticationRequestsUseTwentySecondTimeoutAndStartedOutcome() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let session = AccountSession(); session.fixture = false; session.bearerToken = nil
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AuthTimeoutProtocol.self]
    let api = APIClient(session: session, baseURL: URL(string: "https://auth-timeout.invalid")!,
      networkConfiguration: configuration, diagnostics: diagnostics)
    let data = try await api.request("/v1/auth/login/options", method: "POST")
    XCTAssertEqual(String(data: data, encoding: .utf8), "20.0")
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).map(\.outcome), [.started, .completed])
  }
  @MainActor func testRunClaimsBusyImmediatelyRejectsDuplicateAndRecordsCompletion() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: directory.appendingPathComponent("library"), diagnostics: diagnostics)
    services.error = "previous failure"
    let suspended = expectation(description: "First action suspended")
    var continuation: CheckedContinuation<Void, Never>?
    var actions = 0
    let first = try XCTUnwrap(services.run(phase: .auth) {
      actions += 1
      await withCheckedContinuation { continuation = $0; suspended.fulfill() }
    })
    defer { first.cancel(); continuation?.resume(); continuation = nil }
    XCTAssertTrue(services.busy)
    XCTAssertNil(services.error)
    XCTAssertNil(services.run(phase: .auth) { actions += 1 })
    await fulfillment(of: [suspended], timeout: 3)
    XCTAssertEqual(actions, 1)
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }.map(\.outcome), [.started])
    continuation?.resume(); continuation = nil
    await first.value
    XCTAssertFalse(services.busy)
    XCTAssertNil(services.error)
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }.map(\.outcome), [.started, .completed])
  }
  @MainActor func testRunRecordsFailureAllowsRetryAndClassifiesPasskeyCancellation() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: directory.appendingPathComponent("library"), diagnostics: diagnostics)
    let failed = try XCTUnwrap(services.run(phase: .auth) { throw NativePasskeyError(code: .failed) })
    await failed.value
    XCTAssertFalse(services.busy)
    XCTAssertNotNil(services.error)
    let retry = try XCTUnwrap(services.run(phase: .auth) {})
    XCTAssertTrue(services.busy)
    XCTAssertNil(services.error)
    await retry.value
    let cancelled = try XCTUnwrap(services.run(phase: .auth) { throw NativePasskeyError(code: .canceled) })
    await cancelled.value
    let fence = try XCTUnwrap(services.run(phase: .auth) { throw CancellationError() })
    await fence.value
    let events = try diagnosticEvents(diagnostics, file: file).filter { $0.phase == .auth }
    XCTAssertEqual(events.map(\.outcome), [.started, .failed, .started, .completed, .started, .cancelled, .started, .cancelled])
    XCTAssertEqual(events[1].authorizationCode, NativePasskeyError(code: .failed).code.rawValue)
    XCTAssertEqual(events[5].authorizationCode, NativePasskeyError(code: .canceled).code.rawValue)
    XCTAssertNil(events[7].authorizationCode)
    let serialized = try String(contentsOf: file, encoding: .utf8)
    XCTAssertFalse(serialized.contains(NativePasskeyError(code: .failed).localizedDescription))
    XCTAssertFalse(serialized.contains(NativePasskeyError(code: .canceled).localizedDescription))
  }
  private func diagnosticEvents(_ diagnostics: NativeDiagnostics, file: URL) throws -> [NativeDiagnosticEvent] {
    diagnostics.flush()
    return try Data(contentsOf: file).split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
  }
  @MainActor func testDiagnosticActionCorrelatesAPIHeadersAndDoesNotCompleteMalformedDecode() async throws {
    let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
    let session = AccountSession(); session.fixture = false
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DiagnosticTraceProtocol.self]
    let api = APIClient(session: session, baseURL: URL(string: "https://diagnostics.invalid")!, networkConfiguration: config, diagnostics: diagnostics)
    let reply: DiagnosticTraceReply = try await NativeDiagnosticTrace.action(.auth, diagnostics: diagnostics) {
      let first: DiagnosticTraceReply = try await api.get("/v1/auth/options/private-name?query=private-query")
      let second: DiagnosticTraceReply = try await api.get("/v1/auth/verify/private-name")
      XCTAssertEqual(first.trace, second.trace)
      return second
    }
    let trace = try XCTUnwrap(UUID(uuidString: reply.trace))
    var events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    XCTAssertEqual(Set(events.compactMap(\.traceId)), [trace])
    XCTAssertTrue(events.allSatisfy { $0.operation == .auth })
    XCTAssertEqual(events.filter { $0.phase == .auth }.map(\.outcome), [.started, .completed])
    XCTAssertEqual(events.filter { $0.phase == .api && $0.outcome == .completed }.map(\.step), [.decode, .decode])
    XCTAssertEqual(events.last?.lastCompletedStep, .decode)
    XCTAssertTrue(events.filter { $0.phase == .api && $0.outcome == .completed }.allSatisfy { $0.requestId != nil })
    do {
      let _: DiagnosticTraceReply = try await NativeDiagnosticTrace.action(.sync, diagnostics: diagnostics) {
        try await api.get("/v1/albums/malformed/private-album")
      }
      XCTFail("Malformed successful responses must fail decoding.")
    } catch { XCTAssertTrue(error is DecodingError) }
    events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    let failed = events.filter { $0.operation == .sync }
    XCTAssertEqual(failed.filter { $0.phase == .api }.map(\.outcome), [.started, .failed])
    XCTAssertEqual(failed.last?.outcome, .failed)
    XCTAssertEqual(failed.last?.reason, .decode)
    XCTAssertEqual(failed.last?.lastCompletedStep, .response)
    XCTAssertEqual(failed.first { $0.phase == .api }?.endpoint, .albums)
    let safe = String(decoding: diagnostics.exportJSON(), as: UTF8.self)
    for secret in ["private-name", "private-query", "private-album", "private-response", "https://", "diagnostics.invalid"] { XCTAssertFalse(safe.contains(secret), secret) }
    XCTAssertNil(NativeDiagnosticTrace.current, "A completed action must not leak its context to later work.")
  }
  @MainActor func testConcurrentDiagnosticActionsKeepSeparateEphemeralTracesAndCancellationTerminal() async throws {
    let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
    let session = AccountSession(); session.fixture = false
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [DiagnosticTraceProtocol.self]
    let api = APIClient(session: session, baseURL: URL(string: "https://diagnostics.invalid")!, networkConfiguration: config, diagnostics: diagnostics)
    let first = Task { @MainActor in
      try await NativeDiagnosticTrace.action(.sync, diagnostics: diagnostics) { () -> DiagnosticTraceReply in
        await Task.yield(); return try await api.get("/v1/photos/first-private")
      }
    }
    let second = Task { @MainActor in
      try await NativeDiagnosticTrace.action(.share, diagnostics: diagnostics) { () -> DiagnosticTraceReply in
        await Task.yield(); return try await api.get("/v1/grants/second-private")
      }
    }
    let a = try await first.value, b = try await second.value
    XCTAssertNotEqual(a.trace, b.trace)
    let cancelled = Task { @MainActor in
      try await NativeDiagnosticTrace.action(.auth, diagnostics: diagnostics) {
        NativeDiagnosticTrace.current?.completed(.credential)
        throw CancellationError()
      }
    }
    do { try await cancelled.value; XCTFail("Cancellation must propagate.") } catch { XCTAssertTrue(error is CancellationError) }
    let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    XCTAssertEqual(Set(events.filter { $0.operation == .sync }.compactMap(\.traceId)), [UUID(uuidString: a.trace)!])
    XCTAssertEqual(Set(events.filter { $0.operation == .share }.compactMap(\.traceId)), [UUID(uuidString: b.trace)!])
    XCTAssertEqual(events.last?.outcome, .cancelled)
    XCTAssertEqual(events.last?.lastCompletedStep, .credential)
    XCTAssertNil(NativeDiagnosticTrace.current)
  }
  func testDiagnosticExportBoundsAndSanitizesLegacyRecordsWithoutTraceFields() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let file = root.appendingPathComponent("runtime.jsonl")
    let legacy = #"{"timestamp":1,"phase":"api","outcome":"failed","build":"private-person-name","unknown":"private-query"}"#
    try Data((legacy + "\n").utf8).write(to: file)
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    var exported = diagnostics.exportJSON()
    var events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: exported)
    XCTAssertEqual(events.count, 1); XCTAssertNil(events[0].traceId); XCTAssertEqual(events[0].build, "")
    XCTAssertFalse(String(decoding: exported, as: UTF8.self).contains("private"))
    for _ in 0..<200 {
      let trace = NativeDiagnosticTrace(.people)
      diagnostics.record(NativeDiagnosticEvent(phase: .people, outcome: .completed, elapsed: 1,
        completed: 20, pending: 30, attempted: 25, trace: trace, step: .analysis, reason: .sourceUnavailable))
    }
    exported = diagnostics.exportJSON(); events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: exported)
    XCTAssertLessThanOrEqual(exported.count, NativeDiagnostics.maximumBytes)
    XCTAssertLessThanOrEqual(events.count, 160); XCTAssertFalse(events.isEmpty)
    XCTAssertTrue(events.allSatisfy { $0.attempted == 25 && $0.completed == 20 && $0.pending == 30 })
  }
  @MainActor func testAccountDiagnosticsEmitOnlyStateChangesWithoutIdentityOrCredentials() throws {
    let savedSession = try? Keychain.read("session")
    Keychain.remove("session")
    defer {
      if let savedSession { try? Keychain.write(savedSession, id: "session") }
      else { Keychain.remove("session") }
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    let services = try AppServices(root: root.appendingPathComponent("app"), diagnostics: diagnostics)
    services.session.accountId = nil
    services.session.bearerToken = nil
    services.session.fixture = false
    services.refreshConsumerSyncSummary()
    let initial = try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }
    XCTAssertFalse(initial.isEmpty)
    XCTAssertEqual(initial.last?.accountState, .signedOut)
    services.refreshConsumerSyncSummary()
    services.refreshConsumerSyncSummary()
    XCTAssertEqual(try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }.count, initial.count)
    let account = Wire.id()
    let token = "private-account-status-token"
    services.session.accountId = account
    services.session.bearerToken = token
    services.refreshConsumerSyncSummary()
    services.session.fixture = true
    services.refreshConsumerSyncSummary()
    let events = try diagnosticEvents(diagnostics, file: file).filter { $0.accountState != nil }
    XCTAssertEqual(events.suffix(2).compactMap(\.accountState), [.recoveryRequired, .demo])
    XCTAssertTrue(events.allSatisfy { $0.phase == .app && $0.outcome == .changed && $0.requestId == nil && $0.completed == nil && $0.pending == nil })
    let bytes = try String(contentsOf: file, encoding: .utf8)
    XCTAssertFalse(bytes.contains(account))
    XCTAssertFalse(bytes.contains(token))
    for state in [NativeDiagnosticAccountState.signedOut, .locked, .recoveryRequired, .unlocked, .demo] {
      let event = NativeDiagnosticEvent(phase: .app, outcome: .changed, accountState: state)
      let decoded = try JSONDecoder().decode(NativeDiagnosticEvent.self, from: JSONEncoder().encode(event))
      XCTAssertEqual(decoded.accountState, state)
      XCTAssertNil(decoded.requestId)
    }
  }
  func testRuntimeDiagnosticsCannotIncludeRequestPathsOrUntrustedIdentifiers() throws {
    XCTAssertEqual(NativeDiagnosticEndpoint(path: "/v1/background/uploads/private-id/staging"), .upload)
    let secret = "private-photo-recovery-query-token"
    let url = try XCTUnwrap(URL(string: "https://fotoro.cloud/v1/grants/\(secret)?token=\(secret)"))
    let event = NativeDiagnosticEvent(phase: .api, outcome: .failed,
      endpoint: NativeDiagnosticEndpoint(path: url.path), method: secret,
      elapsed: .infinity, status: 999, networkError: URLError(.notConnectedToInternet), requestId: secret)
    let serialized = try XCTUnwrap(String(data: JSONEncoder().encode(event), encoding: .utf8))
    XCTAssertFalse(serialized.contains(secret))
    XCTAssertFalse(serialized.contains("https://"))
    XCTAssertEqual(event.endpoint, .exchange)
    XCTAssertEqual(event.method, .OTHER)
    XCTAssertEqual(event.elapsedMS, 0)
    XCTAssertEqual(event.networkCode, URLError.notConnectedToInternet.rawValue)
    XCTAssertNil(event.requestId)
    XCTAssertNil(event.status)
  }
  func testRuntimeDiagnosticsPreserveCorrelationAndBoundTimingAndCounts() throws {
    let request = UUID()
    let event = NativeDiagnosticEvent(phase: .api, outcome: .failed, endpoint: .upload,
      method: "PUT", elapsed: 1.25, status: 408, requestId: request.uuidString,
      state: .offline, completed: -1, pending: Int.max)
    let decoded = try JSONDecoder().decode(NativeDiagnosticEvent.self, from: JSONEncoder().encode(event))
    XCTAssertEqual(decoded.requestId, request)
    XCTAssertEqual(decoded.elapsedMS, 1250)
    XCTAssertEqual(decoded.status, 408)
    XCTAssertEqual(decoded.completed, 0)
    XCTAssertEqual(decoded.pending, 1_000_000)
    XCTAssertEqual(decoded.state, .offline)
  }
  func testRuntimeDiagnosticsRotatePersistAndExcludeDeviceBackup() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("runtime.jsonl")
    let diagnostics = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    for index in 0..<200 {
      diagnostics.record(NativeDiagnosticEvent(phase: .sync, outcome: .changed, completed: index))
    }
    diagnostics.flush()
    let data = try Data(contentsOf: file)
    XCTAssertLessThanOrEqual(data.count, NativeDiagnostics.maximumBytes)
    var events = try data.split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
    XCTAssertEqual(events.count, 160)
    XCTAssertEqual(events.first?.completed, 40)
    XCTAssertEqual(events.last?.completed, 199)
    XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    let restored = NativeDiagnostics(fileURL: file, emitSystemLog: false)
    restored.record(NativeDiagnosticEvent(phase: .app, outcome: .started))
    restored.flush()
    events = try Data(contentsOf: file).split(separator: 10).map { try JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0)) }
    XCTAssertEqual(events.count, 160)
    XCTAssertEqual(events.first?.completed, 41)
    XCTAssertEqual(events.last?.phase, .app)
  }
}

private struct DiagnosticTraceReply: Decodable { let trace: String }
private final class DiagnosticTraceProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "diagnostics.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url, let trace = request.value(forHTTPHeaderField: "X-Fotoro-Trace-Id"),
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
        headerFields: ["X-Request-Id": UUID().uuidString]) else { return }
    let data = url.path.contains("malformed") ? Data("private-response".utf8)
      : (try! JSONSerialization.data(withJSONObject: ["trace": trace]))
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
private final class AuthTimeoutProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "auth-timeout.invalid" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let url = request.url,
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(String(request.timeoutInterval).utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

extension ConsumerCoreTests {
  @MainActor func testSavedCatalogSearchHidesPreviousQueryBeforeStartingAndRejectsLateCompletion() async throws {
    try await withSavedLibrary { services, _ in
      var first = try self.samplePhoto(), second = try self.samplePhoto(), third = try self.samplePhoto()
      first.manifest.ownerAccountId = services.session.accountId!
      second.manifest.ownerAccountId = services.session.accountId!
      third.manifest.ownerAccountId = services.session.accountId!
      first.metadata.filename = "first.jpg"; second.metadata.filename = "second.jpg"; third.metadata.filename = "third.jpg"
      try services.store.put(first); try services.store.put(second); try services.store.put(third); try services.reload()
      let search = SavedCatalogSearch(), gate = SavedCatalogSearchGate()
      var current = self.savedSearchID("first", services: services)
      await search.search(current, current: { current }) { try await services.searchCatalog("first") }
      XCTAssertEqual(search.results(for: current)?.map(\.id), [first.id])
      current = self.savedSearchID("second", services: services)
      XCTAssertNil(search.results(for: current), "Changing the field must hide the prior query before its task starts")
      XCTAssertTrue(search.isPending(current))
      let secondID = current
      let older = Task { await search.search(secondID, current: { current }) { try await gate.read("second") } }
      try await self.waitForSavedSearch(gate, request: "second")
      current = self.savedSearchID("third", services: services)
      let thirdID = current
      let latest = Task { await search.search(thirdID, current: { current }) { try await gate.read("third") } }
      try await self.waitForSavedSearch(gate, request: "third")
      await gate.finish("second", photos: [second])
      await older.value
      XCTAssertNil(search.results(for: current))
      XCTAssertTrue(search.isPending(current), "The cancelled query cannot finish the newer query's progress")
      await gate.finish("third", photos: [third])
      await latest.value
      XCTAssertEqual(search.results(for: current)?.map(\.id), [third.id])
      XCTAssertFalse(search.isPending(current))
      XCTAssertNil(search.failure(for: current))
    }
  }
  @MainActor func testSavedCatalogSearchFailureCanRetryWhileKeepingOnlyCurrentCompletedMatches() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = services.session.accountId!
      try services.store.put(photo); try services.reload()
      let search = SavedCatalogSearch(), gate = SavedCatalogSearchGate()
      var current = self.savedSearchID("receipt", services: services)
      await search.search(current, current: { current }) { try await services.searchCatalog("receipt") }
      await search.search(current, current: { current }) { throw FotoroError("CONTROLLED_SEARCH_UNAVAILABLE") }
      XCTAssertEqual(search.results(for: current)?.map(\.id), [photo.id])
      XCTAssertFalse(search.isPending(current))
      XCTAssertEqual(search.failure(for: current), "CONTROLLED_SEARCH_UNAVAILABLE")
      let retryID = current
      let retry = Task { await search.search(retryID, current: { current }) { try await gate.read("retry") } }
      try await self.waitForSavedSearch(gate, request: "retry")
      XCTAssertTrue(search.isPending(current))
      XCTAssertNil(search.failure(for: current))
      XCTAssertEqual(search.results(for: current)?.map(\.id), [photo.id], "A same-binding retry keeps the useful completed answer")
      await gate.finish("retry", photos: [])
      await retry.value
      XCTAssertTrue(search.hasCompleted(current))
      XCTAssertEqual(search.results(for: current)?.count, 0, "A finished empty answer differs from pending or failed work")
      XCTAssertFalse(search.isPending(current))
      current = self.savedSearchID("other", services: services)
      await search.search(current, current: { current }) { throw FotoroError("CONTROLLED_SEARCH_UNAVAILABLE") }
      XCTAssertNil(search.results(for: current))
      XCTAssertFalse(search.hasCompleted(current))
      XCTAssertFalse(search.isPending(current))
      XCTAssertEqual(search.failure(for: current), "CONTROLLED_SEARCH_UNAVAILABLE")
    }
  }
  @MainActor func testSavedCatalogSearchCatalogAndAccountBindingsFenceResultsAndLateErrors() async throws {
    try await withSavedLibrary { services, _ in
      var photo = try self.samplePhoto()
      photo.manifest.ownerAccountId = services.session.accountId!
      try services.store.put(photo); try services.reload()
      let search = SavedCatalogSearch(), gate = SavedCatalogSearchGate()
      var current = self.savedSearchID("receipt", services: services)
      await search.search(current, current: { current }) { try await services.searchCatalog("receipt") }
      let previous = current
      let outdated = Task { await search.search(previous, current: { current }) { try await gate.read("outdated") } }
      try await self.waitForSavedSearch(gate, request: "outdated")
      photo.metadata.filename = "other.jpg"
      try services.store.put(photo); try services.reload()
      current = self.savedSearchID("receipt", services: services)
      XCTAssertNotEqual(current.catalog, previous.catalog)
      XCTAssertNil(search.results(for: current), "Same query does not make older catalog matches current")
      await gate.fail("outdated")
      await outdated.value
      XCTAssertNil(search.failure(for: current), "A previous catalog's failure cannot replace the new query state")
      await search.search(current, current: { current }) { try await services.searchCatalog("receipt") }
      XCTAssertEqual(search.results(for: current)?.count, 0)

      let completed = current
      try services.activateAccount()
      current = self.savedSearchID("receipt", services: services)
      XCTAssertEqual(current.binding.account, completed.binding.account)
      XCTAssertEqual(current.binding.vault, completed.binding.vault)
      XCTAssertNotEqual(current.binding.catalog, completed.binding.catalog)
      XCTAssertNil(search.results(for: current), "Replacing a store in the same account starts a new presentation binding")
      var changedAccount = completed
      changedAccount.binding.account = Wire.id()
      XCTAssertNil(search.results(for: changedAccount))
      services.vault.lock()
      current = self.savedSearchID("receipt", services: services)
      XCTAssertNotEqual(current.binding.vault, completed.binding.vault)
      XCTAssertNil(search.results(for: current))
    }
  }
  @MainActor func testSavedCatalogSearchCancellationCannotPublishOrSurfaceFailure() async throws {
    try await withSavedLibrary { services, _ in
      let search = SavedCatalogSearch(), gate = SavedCatalogSearchGate()
      let current = self.savedSearchID("receipt", services: services)
      let reading = Task { await search.search(current, current: { current }) { try await gate.read("cancelled") } }
      try await self.waitForSavedSearch(gate, request: "cancelled")
      reading.cancel()
      search.cancel(clearResults: true)
      await gate.fail("cancelled")
      await reading.value
      XCTAssertNil(search.results(for: current))
      XCTAssertFalse(search.hasCompleted(current))
      XCTAssertNil(search.failure(for: current))
    }
  }
  @MainActor private func savedSearchID(_ query: String, services: AppServices) -> SavedCatalogSearchPresentationID {
    SavedCatalogSearchPresentationID(query: query, catalog: services.consumerCatalogGeneration,
      binding: SavedLibraryOpenBinding(services))
  }
  @MainActor private func waitForSavedSearch(_ gate: SavedCatalogSearchGate, request: String) async throws {
    for _ in 0..<200 {
      if await gate.started(request) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Saved search did not reach its controlled read: \(request)")
    throw CancellationError()
  }
  @MainActor func testFreshOwnerSavedSyncSkipsPeerContributionWithoutTrustOrObjectReads() async throws {
    try await withSavedLibrary(peerContribution: true) { services, server in
      let owner = try XCTUnwrap(services.session.accountId)
      XCTAssertEqual(Set(services.session.pinnedCards.keys), [owner])
      XCTAssertTrue(try services.store.photos().isEmpty)
      try await services.sync()
      XCTAssertEqual(try services.store.cursor(), "2", "Ignored peer changes still advance the consumed feed")
      XCTAssertEqual(try services.store.photos().map(\.id), [server.photoID])
      XCTAssertEqual(try services.consumerSavedPhoto(server.photoID)?.metadata.filename, "remote-receipt.jpg")
      XCTAssertNil(try services.store.backupPhoto(server.peerPhotoID))
      XCTAssertNil(services.session.pinnedCards[server.peerAccountID])
      XCTAssertEqual(Set(services.session.pinnedCards.keys), [owner], "Reading Saved cannot trust a peer implicitly")
      XCTAssertEqual(server.requests.map(\.path), ["/v1/changes", "/v1/objects/" + server.objectID, "/v1/grants"])
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testExplicitSavedLibraryOpenFetchesCatalogWithoutSendingQueuedOriginalsOrLocalDrafts() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Explicit catalog read started"))
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate) { services, server in
      var queued = try self.samplePhoto()
      queued.manifest.ownerAccountId = services.session.accountId!
      queued.transferState = "pending"
      try services.store.put(queued)
      try services.journal.enqueue(queued, publicSample: true)
      try services.reload()
      try services.setLabels(["local-only-draft"], photo: queued)
      let drafts = try services.annotations.ledger.pendingIDs()
      let refresh = SavedLibraryRefresh()
      XCTAssertTrue(server.requests.isEmpty)
      let opening = Task { await refresh.open(services) }
      await fulfillment(of: [gate.started], timeout: 3)
      XCTAssertTrue(refresh.isRefreshing)
      await refresh.open(services)
      await refresh.open(services, recheck: true)
      await refresh.refresh(services)
      XCTAssertEqual(server.requests.count, 1, "Repeated taps cannot start a second catalog request")
      gate.release.signal()
      await opening.value
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertNil(refresh.error)
      XCTAssertEqual(try services.consumerSavedPhoto(server.photoID)?.metadata.filename, "remote-receipt.jpg")
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.id])
      XCTAssertEqual(try services.annotations.ledger.pendingIDs(), drafts)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      XCTAssertEqual(Set(server.requests.map(\.path)), ["/v1/changes", "/v1/objects/" + server.objectID, "/v1/grants"])
      let completed = server.requests.count
      await refresh.open(services)
      await services.resumeSavedAccount()
      XCTAssertEqual(server.requests.count, completed, "Reappearing and foreground restoration must not fetch again")
      services.vault.lock()
      refresh.cancel()
      try await services.vault.unlock(.localKeychain)
      try services.activateAccount()
      await refresh.open(services)
      XCTAssertGreaterThan(server.requests.count, completed, "Explicit unlock opens a fresh vault binding")
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSavedForegroundRecheckCoalescesAnExplicitRefreshAlreadyInFlight() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Explicit Saved refresh started"))
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate) { services, server in
      let refresh = SavedLibraryRefresh()
      let reading = Task { await refresh.refresh(services) }
      await fulfillment(of: [gate.started], timeout: 3)
      await refresh.open(services, recheck: true)
      await refresh.refresh(services)
      XCTAssertEqual(server.requests.count, 1, "Foreground and pull-to-refresh share one read")
      gate.release.signal()
      await reading.value
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertNil(refresh.error)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testCatalogSyncSharesEquivalentReadsWithoutCancellingAnotherWaiter() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Shared catalog read"))
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate) { services, server in
      let first = Task { try await services.sync() }
      await fulfillment(of: [gate.started], timeout: 3)
      let joined = expectation(description: "Second caller joined")
      let second = Task { joined.fulfill(); try await services.sync() }
      await fulfillment(of: [joined], timeout: 1)
      first.cancel()
      await Task.yield()
      XCTAssertEqual(server.requests.count, 1)
      XCTAssertEqual(services.consumerSyncSummary.state, .checking)
      gate.release.signal()
      do { try await first.value; XCTFail("Cancelled caller reported success") } catch is CancellationError {}
      try await second.value
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 1)
      try await services.sync()
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2, "A later recheck must not reuse a completed read")
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSharedCatalogSyncRejectsCancelledOrWithdrawnContextBeforePublication() async throws {
    for interruption in ["cancel", "lock", "account", "origin", "token", "session", "store", "cursor"] {
      let gate = SavedLibraryRequestGate(started: expectation(description: "Held catalog " + interruption))
      defer { gate.release.signal() }
      try await withSavedLibrary(gate: gate) { services, server in
        let catalog = services.store
        if interruption == "session" { services.session.bearerToken = "retained-session" }
        let first = Task { try await services.sync() }
        await fulfillment(of: [gate.started], timeout: 3)
        let joined = expectation(description: "Joined catalog " + interruption)
        let second = Task { joined.fulfill(); try await services.sync() }
        await fulfillment(of: [joined], timeout: 1)
        switch interruption {
        case "cancel": first.cancel(); second.cancel(); await Task.yield()
        case "lock": services.vault.lock()
        case "account": services.session.accountId = Wire.id()
        case "origin": services.api.baseURL = URL(string: "https://different-service.test")!
        case "session": services.session.fixture = false
        case "store": try services.activateAccount()
        case "cursor": try catalog.apply(ChangePageV1(version: 1, mediaVersion: 1, changes: [], nextCursor: "external", hasMore: false), verified: [:])
        default: services.session.bearerToken = "replacement-session"
        }
        gate.release.signal()
        for caller in [first, second] {
          do { try await caller.value; XCTFail("Withdrawn read reported success: " + interruption) } catch is CancellationError {}
        }
        XCTAssertEqual(try catalog.cursor(), interruption == "cursor" ? "external" : nil, interruption)
        XCTAssertTrue(try catalog.photos().isEmpty, interruption)
        XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 1)
        XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      }
    }
  }
  @MainActor func testCatalogSyncJoinsCurrentPageAfterOwnedCursorAdvances() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Second catalog page held"), cursor: "1")
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate, multipage: true) { services, server in
      let first = Task { try await services.sync() }
      await fulfillment(of: [gate.started], timeout: 3)
      XCTAssertEqual(try services.store.cursor(), "1")
      let joined = expectation(description: "Caller joins current catalog page")
      let second = Task { joined.fulfill(); try await services.sync() }
      await fulfillment(of: [joined], timeout: 1)
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2)
      gate.release.signal()
      try await first.value; try await second.value
      XCTAssertEqual(try services.store.cursor(), "2")
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.map(\.cursor), [nil, "1"])
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
    }
  }
  @MainActor func testPhotosRefreshJoinsAutomaticPreflightWithoutCancellingIt() async throws {
    let gate = SavedLibraryRequestGate(started: expectation(description: "Automatic and Photos catalog read"))
    defer { gate.release.signal() }
    try await withSavedLibrary(gate: gate) { services, server in
      services.session.fixture = false
      services.session.bearerToken = "controlled-private-session"
      services.automaticPhotosAuthorization = { .authorized }
      services.photosBackupSnapshot = { _ in [] }
      try services.enableAutomaticPhotoSync()
      await fulfillment(of: [gate.started], timeout: 3)
      let refresh = SavedLibraryRefresh(), joined = expectation(description: "Visible Photos refresh joined")
      let reading = Task { joined.fulfill(); await refresh.open(services, recheck: true) }
      await fulfillment(of: [joined], timeout: 1)
      refresh.cancel()
      await Task.yield()
      XCTAssertEqual(server.requests.count, 1)
      gate.release.signal()
      await reading.value
      await services.waitForAutomaticPhotoSync()
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 1)
      XCTAssertTrue(try services.journal.entries().isEmpty)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testReturningToSavedRechecksCatalogWithoutSendingPausedOriginalsOrLocalDrafts() async throws {
    try await withSavedLibrary { services, server in
      var queued = try self.samplePhoto()
      queued.manifest.ownerAccountId = services.session.accountId!
      queued.transferState = "pending"
      try services.store.put(queued)
      try services.journal.enqueue(queued, publicSample: true)
      try services.store.setSyncIntent(enabled: false, uploadsPaused: true)
      try services.reload()
      try services.setLabels(["local-only-draft"], photo: queued)
      let drafts = try services.annotations.ledger.pendingIDs()
      let refresh = SavedLibraryRefresh()
      await refresh.open(services, recheck: true)
      let firstRead = server.requests.count
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      await refresh.open(services)
      XCTAssertEqual(server.requests.count, firstRead, "An unchanged binding does not poll")
      await refresh.open(services, recheck: true)
      XCTAssertGreaterThan(server.requests.count, firstRead, "Returning to visible Saved checks for cross-device changes")
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      XCTAssertTrue(try services.store.uploadsPaused(), "Reading Saved does not resume uploads")
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.id])
      XCTAssertEqual(try services.annotations.ledger.pendingIDs(), drafts)
      let completed = server.requests.count
      services.vault.lock()
      await refresh.open(services, recheck: true)
      XCTAssertEqual(server.requests.count, completed, "A locked account cannot start a foreground read")
      XCTAssertFalse(refresh.isRefreshing)
    }
  }
  @MainActor func testUnlockedUnactivatedAccountCannotReadWrongCatalogAndRemainsOpenable() async throws {
    try await withSavedLibrary { services, server in
      let refresh = SavedLibraryRefresh()
      services.store = try LibraryStore(root: services.storageRoot.appendingPathComponent(Wire.id()))
      XCTAssertTrue(services.vault.isUnlocked)
      XCTAssertNil(services.photoAccountAccess)
      await refresh.open(services)
      await refresh.refresh(services)
      do { try await services.sync(); XCTFail("An unactivated store was read") }
      catch let error as FotoroError { XCTAssertEqual(error.message, "Open Fotoro before loading saved photos.") }
      XCTAssertTrue(server.requests.isEmpty)
      try services.activateAccount()
      XCTAssertNotNil(services.photoAccountAccess)
      await refresh.open(services)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testCancelledInitialSavedReadReopensSameBindingWithoutWrites() async throws {
    for interruption in ["scope", "query"] {
      let gate = SavedLibraryRequestGate(started: expectation(description: "Blocked initial Saved read " + interruption))
      defer { gate.release.signal() }
      try await withSavedLibrary(gate: gate) { services, server in
        let refresh = SavedLibraryRefresh()
        let access = services.photoAccountAccess
        let opening = Task { await refresh.open(services) }
        await fulfillment(of: [gate.started], timeout: 3)
        XCTAssertTrue(refresh.isRefreshing)
        XCTAssertNil(try services.consumerSavedPhoto(server.photoID))
        if interruption == "scope" { refresh.cancel() }
        else { opening.cancel() }
        let reopening = Task { await refresh.open(services) }
        gate.release.signal()
        await opening.value
        await reopening.value
        XCTAssertEqual(services.photoAccountAccess, access, "Navigation must preserve the account and vault binding")
        XCTAssertFalse(refresh.isRefreshing)
        XCTAssertNil(refresh.error, "Cancellation is not a catalog failure")
        XCTAssertEqual(try services.consumerSavedPhoto(server.photoID)?.metadata.filename, "remote-receipt.jpg")
        XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2,
          "Returning Saved must retry its interrupted initial read")
        XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
        let completed = server.requests.count
        refresh.cancel()
        await refresh.open(services)
        XCTAssertEqual(server.requests.count, completed, "A completed binding survives later dismissal")
      }
    }
  }
  @MainActor func testSavedLibraryOpenTracksStoreReplacementWithinSameAccountAndVault() async throws {
    try await withSavedLibrary { services, server in
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      let completed = server.requests.count
      let generation = services.vault.generation
      let old = services.store
      try services.activateAccount()
      XCTAssertFalse(services.store === old)
      XCTAssertEqual(services.vault.generation, generation)
      await refresh.open(services)
      XCTAssertGreaterThan(server.requests.count, completed)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testFailedAccountActivationKeepsServicesTogetherAndAllowsExplicitRetry() async throws {
    try await withSavedLibrary { services, server in
      let originalStore = services.store, originalBackup = services.backup
      let originalJournal = services.journal
      try await originalStore.database.write { db in
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('backupSelection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [Data("invalid-json".utf8).b64])
      }
      XCTAssertThrowsError(try services.activateAccount())
      XCTAssertTrue(services.store === originalStore)
      XCTAssertTrue(services.backup === originalBackup)
      XCTAssertTrue(services.journal === originalJournal)
      XCTAssertNil(services.photoAccountAccess)
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      XCTAssertTrue(server.requests.isEmpty)
      try await originalStore.database.write { db in
        try db.execute(sql: "DELETE FROM state WHERE key='backupSelection'")
      }
      try services.activateAccount()
      XCTAssertNotNil(services.photoAccountAccess)
      await refresh.open(services)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSavedLibraryRefreshShowsFailureAndRetriesOnlyReadOnlyCatalogWork() async throws {
    try await withSavedLibrary(failFirst: true) { services, server in
      var queued = try self.samplePhoto()
      queued.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      queued.transferState = "pending"
      try services.store.put(queued)
      try services.journal.enqueue(queued, publicSample: true)
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertEqual(refresh.error, "CONTROLLED_CATALOG_UNAVAILABLE")
      XCTAssertEqual(refresh.failureDetails(services), "CONTROLLED_CATALOG_UNAVAILABLE")
      XCTAssertEqual(services.consumerSyncSummary.state, .needsAttention)
      XCTAssertFalse(refresh.requiresAuthentication(services))
      XCTAssertNil(try services.consumerSavedPhoto(server.photoID))
      await refresh.refresh(services)
      XCTAssertFalse(refresh.isRefreshing)
      XCTAssertNil(refresh.error)
      XCTAssertNil(refresh.failureDetails(services), "Successful read-only retry clears stale Sync details")
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [queued.id])
      XCTAssertFalse(services.automaticPhotoSync.enabled, "Catalog retry does not opt into automatic uploads")
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
      XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2)
    }
  }
  @MainActor func testCancelledCatalogReadDoesNotRequireAttentionButNetworkFailureDoes() async throws {
    for code in [URLError.Code.cancelled, .networkConnectionLost] {
      try await withSavedLibrary(networkFailure: code) { services, server in
        XCTAssertEqual(services.consumerSyncSummary.state, .notStarted)
        let initialDetail = services.consumerSyncSummary.detail
        do {
          try await services.sync()
          XCTFail("The controlled network failure must propagate")
        } catch is CancellationError {
          XCTAssertEqual(code, .cancelled)
        } catch let error as URLError {
          XCTAssertEqual(error.code, code)
          XCTAssertNotEqual(code, .cancelled, "API transport cancellation uses CancellationError")
        }
        XCTAssertNil(try services.store.cursor())
        XCTAssertTrue(try services.store.photos().isEmpty)
        XCTAssertTrue(try services.journal.entries().isEmpty)
        if code == .cancelled {
          XCTAssertEqual(services.consumerSyncSummary.state, .notStarted,
            "A cancelled URLSession read must not become a failed Sync status")
          XCTAssertEqual(services.consumerSyncSummary.detail, initialDetail)
        } else {
          XCTAssertEqual(services.consumerSyncSummary.state, .needsAttention,
            "A genuine network failure must still require Retry")
          XCTAssertNotNil(services.consumerSyncSummary.detail)
        }
        XCTAssertEqual(server.requests.map(\.path), ["/v1/changes"])
        try await services.sync()
        XCTAssertEqual(services.consumerSyncSummary.state, .upToDate)
        XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
        XCTAssertTrue(try services.journal.entries().isEmpty)
        XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
        XCTAssertEqual(server.requests.filter { $0.path == "/v1/changes" }.count, 2)
      }
    }
  }
  @MainActor func testRejectedSavedSessionNeedsExplicitAccountOpeningWithoutDiscardingLocalPhotos() async throws {
    try await withSavedLibrary(failFirst: true, failureCode: "UNAUTHENTICATED") { services, server in
      var cached = try self.samplePhoto()
      cached.manifest.ownerAccountId = try XCTUnwrap(services.session.accountId)
      try services.store.put(cached)
      try services.reload()
      let account = services.session.accountId, vault = services.vault.generation
      let catalog = services.store
      let refresh = SavedLibraryRefresh()
      await refresh.open(services)
      XCTAssertTrue(refresh.requiresAuthentication(services))
      XCTAssertEqual(refresh.error, "UNAUTHENTICATED")
      await refresh.refresh(services)
      XCTAssertEqual(server.requests.count, 1, "A rejected session needs account opening, not another identical request")
      XCTAssertEqual(services.session.accountId, account)
      XCTAssertEqual(services.vault.generation, vault)
      XCTAssertTrue(services.store === catalog)
      XCTAssertNotNil(try services.consumerSavedPhoto(cached.id))
      XCTAssertFalse(services.automaticPhotoSync.enabled)
      refresh.cancel()
      XCTAssertTrue(refresh.requiresAuthentication(services), "Navigation cannot erase the recovery route")
      XCTAssertEqual(refresh.authenticationFailure(services), "UNAUTHENTICATED", "Sync details retain the rejected-session failure")
      try services.activateAccount()
      XCTAssertFalse(refresh.requiresAuthentication(services), "Account opening creates a fresh catalog binding")
      await refresh.open(services)
      XCTAssertNil(refresh.error)
      XCTAssertNotNil(try services.consumerSavedPhoto(cached.id))
      XCTAssertNotNil(try services.consumerSavedPhoto(server.photoID))
      XCTAssertFalse(services.automaticPhotoSync.enabled, "Account recovery does not consent to automatic uploads")
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" })
    }
  }
  @MainActor func testSavedLibrarySelectionSharesBothSearchChoicesAndRejectsChangedOrWithdrawnSources() async throws {
    try await withSavedLibrary { services, _ in
      var first = try self.samplePhoto(), second = try self.samplePhoto()
      first.manifest.ownerAccountId = services.session.accountId!
      second.manifest.ownerAccountId = services.session.accountId!
      first.metadata.filename = "first.jpg"; second.metadata.filename = "second.jpg"
      first.originalURL = try services.store.write(Data("one".utf8), name: "first-original.jpg")
      second.originalURL = try services.store.write(Data("two".utf8), name: "second-original.jpg")
      first.metadata.originalSha256 = Data("one".utf8).digest
      second.metadata.originalSha256 = Data("two".utf8).digest
      try services.store.put(first); try services.store.put(second); try services.reload()
      var selection = SavedPhotoSelection()
      selection.toggle(first)
      let secondQuery = try await services.searchCatalog("second.jpg")
      XCTAssertEqual(secondQuery.map(\.id), [second.id])
      selection.toggle(try XCTUnwrap(secondQuery.first))
      XCTAssertEqual(selection.count, 2)
      let choices = try selection.resolve(using: services.consumerSavedPhoto)
      XCTAssertEqual(Set(choices.map(\.id)), [first.id, second.id])
      var exports: [URL] = []
      defer { ConsumerShareExports.remove(exports) }
      for photo in choices { exports.append(try await services.consumerShareOriginal(photo)) }
      XCTAssertEqual(exports.count, selection.count)
      XCTAssertEqual(try Set(exports.map { try Data(contentsOf: $0) }), [Data("one".utf8), Data("two".utf8)])
      first.previewURL = try services.store.write(Data("preview".utf8), name: "fresh-preview.jpg")
      try services.store.put(first)
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 2, "Fresh cache fields do not change the chosen original")
      XCTAssertEqual(try selection.resolve(using: services.consumerSavedPhoto).first { $0.id == first.id }?.previewURL, first.previewURL)
      first.metadata.originalSha256 = Data("changed-original".utf8).digest
      try services.store.put(first)
      XCTAssertThrowsError(try selection.resolve(using: services.consumerSavedPhoto))
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 1)
      XCTAssertFalse(selection.contains(first.id))
      XCTAssertEqual(try selection.resolve(using: services.consumerSavedPhoto).map(\.id), [second.id])
      services.vault.lock()
      selection.removeWithdrawn(using: services.consumerSavedPhoto)
      XCTAssertEqual(selection.count, 0)
    }
  }
  @MainActor func testAutomaticSyncReconcilesRemoteOriginalBeforeStagingANewDeviceAsset() async throws {
    let bytes = try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    try await withSavedLibrary(original: bytes) { services, server in
      services.session.fixture = false
      services.session.bearerToken = "controlled-private-session"
      services.automaticPhotosAuthorization = { .limited }
      let reads = ReconciliationSourceReads()
      services.photosBackupSnapshot = { cutoff in
        XCTAssertEqual(cutoff, .distantPast)
        return [BackupCandidate(id: "this-devices-asset", capturedAt: Date(), sourceRevision: "original")]
      }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in
        await reads.record()
        return (bytes, "public-sample.jpg", false)
      }, sourceRevision: { _ in "original" })
      XCTAssertTrue(try services.store.photos().isEmpty)
      try services.enableAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      let readCount = await reads.count
      XCTAssertEqual(readCount, 1, "A new device compares its unchanged original with the verified remote digest")
      let checkpoint = try services.store.backupSource("this-devices-asset")
      XCTAssertEqual(checkpoint.photoId, server.photoID)
      XCTAssertEqual(checkpoint.phase, .committed)
      XCTAssertEqual(try services.store.photos().map(\.id), [server.photoID])
      XCTAssertTrue(try services.journal.entries().isEmpty)
      XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" }, "An existing owned original needs no reserve, upload, commit or publish")
      XCTAssertEqual(server.requests.first?.path, "/v1/changes")
      XCTAssertTrue(server.requests.filter { $0.path == "/v1/changes" }.allSatisfy { $0.mediaAware })
      XCTAssertEqual(services.automaticPhotoSync.phase, .ready)
    }
  }
  @MainActor func testAutomaticReconciliationRejectsLegacyServerBeforeReadingAnyOriginal() async throws {
    try await withSavedLibrary(mediaVersion: nil) { services, server in
      services.session.fixture = false
      services.session.bearerToken = "controlled-private-session"
      services.automaticPhotosAuthorization = { .authorized }
      var scans = 0
      services.photosBackupSnapshot = { _ in scans += 1; return [] }
      try services.enableAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(scans, 0, "An old server ignoring media=1 must not admit any staging")
      XCTAssertTrue(try services.store.photos().isEmpty)
      XCTAssertNil(try services.store.cursor())
      XCTAssertTrue(try services.store.backupSources().isEmpty)
      XCTAssertTrue(try services.journal.entries().isEmpty)
      XCTAssertEqual(server.requests.map(\.path), ["/v1/changes"])
      XCTAssertEqual(services.automaticPhotoSync.phase, .needsAttention)
    }
  }
  @MainActor func testAutomaticReconciliationCannotStageAfterItsAccessOrIntentIsWithdrawn() async throws {
    for interruption in ["lock", "pause", "account", "origin", "permission", "background", "disable"] {
      let gate = SavedLibraryRequestGate(started: expectation(description: "Automatic catalog preflight " + interruption))
      defer { gate.release.signal() }
      try await withSavedLibrary(gate: gate) { services, server in
        services.session.fixture = false
        services.session.bearerToken = "controlled-private-session"
        services.automaticPhotosAuthorization = { .authorized }
        var scans = 0
        services.photosBackupSnapshot = { _ in
          scans += 1
          return [BackupCandidate(id: "not-staged", capturedAt: Date(), sourceRevision: "original")]
        }
        let reads = ReconciliationSourceReads()
        services.importer = PhotoImport(store: services.store, sourceReader: { _ in
          await reads.record()
          return (Data("jpg".utf8), "public-sample.jpg", false)
        }, sourceRevision: { _ in "original" })
        try services.enableAutomaticPhotoSync()
        await fulfillment(of: [gate.started], timeout: 3)
        switch interruption {
        case "lock": services.vault.lock()
        case "pause": services.pauseAutomaticPhotoSync()
        case "account": services.session.accountId = Wire.id()
        case "origin": services.api.baseURL = URL(string: "https://different-service.test")!
        case "permission":
          services.automaticPhotosAuthorization = { .denied }
          services.kickAutomaticPhotoSync()
        case "background": services.setPhotoSyncForeground(false)
        default: try services.disableAutomaticPhotoSync()
        }
        gate.release.signal()
        await services.waitForAutomaticPhotoSync()
        let readCount = await reads.count
        XCTAssertEqual(scans, 0, interruption)
        XCTAssertEqual(readCount, 0, interruption)
        XCTAssertTrue(try services.store.photos().isEmpty, interruption)
        XCTAssertTrue(try services.store.backupSources().isEmpty, interruption)
        XCTAssertTrue(try services.journal.entries().isEmpty, interruption)
        XCTAssertTrue(server.requests.allSatisfy { $0.method == "GET" }, interruption)
      }
    }
  }
  @MainActor private func withSavedLibrary(gate: SavedLibraryRequestGate? = nil, failFirst: Bool = false,
    failureCode: String = "CONTROLLED_CATALOG_UNAVAILABLE",
    networkFailure: URLError.Code? = nil,
    original: Data? = nil, mediaVersion: Int? = 1, peerContribution: Bool = false, multipage: Bool = false,
    check: @MainActor (AppServices, SavedLibraryServer) async throws -> Void) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let previousCards = UserDefaults.standard.object(forKey: "fotoro.pinnedCards")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    var card = accounts.accounts[0]; card.accountId = Wire.id()
    let secret = accounts.testSecrets[0]
    let server = try SavedLibraryServer(card: card, secret: secret, gate: gate, failFirst: failFirst,
      failureCode: failureCode, networkFailure: networkFailure,
      original: original ?? Data("jpg".utf8), mediaVersion: mediaVersion, peerContribution: peerContribution, multipage: multipage)
    SavedLibraryProtocol.server = server
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SavedLibraryProtocol.self]
    let services = try AppServices(root: directory, networkConfiguration: configuration,
      diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    defer {
      SavedLibraryProtocol.server = nil
      services.vault.lock(); Keychain.remove(card.accountId)
      UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards.v2." + card.accountId.lowercased())
      if let previousCards { UserDefaults.standard.set(previousCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: directory)
    }
    services.api.baseURL = URL(string: "http://127.0.0.1:8796")!
    services.session.accountId = card.accountId; services.session.fixture = true
    try services.session.pin(card)
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
    try await check(services, server)
  }
}

private actor SavedCatalogSearchGate {
  private var requests: Set<String> = []
  private var waiting: [String: CheckedContinuation<[LocalPhoto], Error>] = [:]
  func read(_ request: String) async throws -> [LocalPhoto] {
    try await withCheckedThrowingContinuation { continuation in
      waiting[request] = continuation
      requests.insert(request)
    }
  }
  func started(_ request: String) -> Bool { requests.contains(request) }
  func finish(_ request: String, photos: [LocalPhoto]) { waiting.removeValue(forKey: request)?.resume(returning: photos) }
  func fail(_ request: String) { waiting.removeValue(forKey: request)?.resume(throwing: FotoroError("CONTROLLED_SEARCH_UNAVAILABLE")) }
}

private actor ReconciliationSourceReads {
  private(set) var count = 0
  func record() { count += 1 }
}

private actor SavedShareDownloadGate {
  private var pending: CheckedContinuation<URL, Never>?
  private var completed: URL?
  func read() async -> URL {
    if let completed { self.completed = nil; return completed }
    return await withCheckedContinuation { pending = $0 }
  }
  func finish(_ url: URL) {
    if let pending { pending.resume(returning: url); self.pending = nil }
    else { completed = url }
  }
}

private final class SavedLibraryRequestGate: @unchecked Sendable {
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  let cursor: String?
  init(started: XCTestExpectation, cursor: String? = nil) { self.started = started; self.cursor = cursor }
}
private final class SavedLibraryServer: @unchecked Sendable {
  struct Request { var method: String; var path: String; var mediaAware: Bool; var cursor: String? }
  let photoID = Wire.id(), objectID = Wire.id()
  let peerPhotoID = Wire.id(), peerAccountID = Wire.id()
  private let lock = NSLock()
  private var recorded: [Request] = []
  private let gate: SavedLibraryRequestGate?
  private var gateUsed = false
  private let multipage: Bool
  private var failFirst: Bool
  private var networkFailure: URLError.Code?
  private let failureCode: String
  private let page: Data
  private let metadata: Data
  init(card: AccountCardV1, secret: FixtureSecrets, gate: SavedLibraryRequestGate?, failFirst: Bool,
    failureCode: String, networkFailure: URLError.Code?, original: Data, mediaVersion: Int?, peerContribution: Bool, multipage: Bool = false) throws {
    self.gate = gate; self.failFirst = failFirst
    self.multipage = multipage
    self.failureCode = failureCode
    self.networkFailure = networkFailure
    let crypto = CryptoAdapter(), key = crypto.randomKey()
    let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata")
    let value = PhotoMetadataV1(filename: "remote-receipt.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(),
      dateSource: "photos", originalBytes: original.count, originalSha256: original.digest, representationKeys: [:])
    metadata = try crypto.encrypt(Wire.encode(value), key: key, binding: binding)
    let rep = RepresentationV1(binding: binding, objectId: objectID, header: metadata.prefix(24).b64,
      ciphertextBytes: metadata.count, ciphertextSha256: metadata.digest)
    let manifest = PhotoManifestV1(photoId: photoID, ownerAccountId: card.accountId, representations: [],
      metadataRepresentation: rep, ownerWrappedMetadataKey: try crypto.wrap(key, key: Data(b64: secret.vaultKey)))
    let signed = try crypto.sign(manifest, kind: "photo-manifest", accountId: card.accountId,
      secret: Data(b64: secret.signingSecretKey))
    var changes: [ChangeV1] = []
    if peerContribution {
      // Accepted grant contributions also appear in the owner's feed signed by the peer.
      // A fresh device has only its own card and must use explicit invitations for peer access.
      let peerSecret = try fixture(FixtureAccounts.self, "accounts").testSecrets[1]
      let peerKey = crypto.randomKey()
      let peerBinding = MediaBinding(photoId: peerPhotoID, representationId: Wire.id(), kind: "metadata")
      let peerBytes = try crypto.encrypt(Wire.encode(value), key: peerKey, binding: peerBinding)
      let peerRepresentation = RepresentationV1(binding: peerBinding, objectId: Wire.id(), header: peerBytes.prefix(24).b64,
        ciphertextBytes: peerBytes.count, ciphertextSha256: peerBytes.digest)
      let peerManifest = PhotoManifestV1(photoId: peerPhotoID, ownerAccountId: peerAccountID, representations: [],
        metadataRepresentation: peerRepresentation, ownerWrappedMetadataKey: try crypto.wrap(peerKey, key: Data(b64: peerSecret.vaultKey)))
      let peerSigned = try crypto.sign(peerManifest, kind: "photo-manifest", accountId: peerAccountID,
        secret: Data(b64: peerSecret.signingSecretKey))
      changes.append(ChangeV1(cursor: "1", entity: "photo", entityId: peerPhotoID, deleted: false, payload: peerSigned))
    }
    let cursor = peerContribution ? "2" : "1"
    changes.append(ChangeV1(cursor: cursor, entity: "photo", entityId: photoID, deleted: false, payload: signed))
    page = try Wire.encode(ChangePageV1(version: 1, mediaVersion: mediaVersion,
      changes: changes, nextCursor: cursor, hasMore: false))
  }
  var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
  func response(_ request: URLRequest) throws -> (Int, Data) {
    guard request.httpMethod == "GET", let path = request.url?.path else { throw FotoroError("Catalog reading sent a write") }
    let mediaAware = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
      .contains { $0.name == "media" && $0.value == "1" } == true
    let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
    lock.lock(); recorded.append(Request(method: "GET", path: path, mediaAware: mediaAware, cursor: cursor)); let first = recorded.count == 1
    let hold = !gateUsed && (gate?.cursor.map { path == "/v1/changes" && cursor == $0 } ?? first)
    if hold { gateUsed = true }
    let fail = failFirst && path == "/v1/changes"; if fail { failFirst = false }
    let networkError = path == "/v1/changes" ? networkFailure : nil
    if networkError != nil { networkFailure = nil }
    lock.unlock()
    if hold, let gate { gate.started.fulfill(); _ = gate.release.wait(timeout: .now() + 5) }
    if let networkError { throw URLError(networkError) }
    if fail {
      return (failureCode == "UNAUTHENTICATED" ? 401 : 503,
        try JSONSerialization.data(withJSONObject: ["code": failureCode, "retryable": true]))
    }
    if path == "/v1/changes" {
      if multipage {
        var value = try Wire.decode(ChangePageV1.self, page)
        value.changes = cursor == nil ? value.changes : []
        value.nextCursor = cursor == nil ? "1" : "2"
        value.hasMore = cursor == nil
        return (200, try Wire.encode(value))
      }
      return (200, page)
    }
    if path == "/v1/objects/" + objectID { return (200, metadata) }
    if path == "/v1/grants" { return (200, try Wire.encode(GrantInboxV1(version: 1, grants: []))) }
    throw FotoroError("Unexpected catalog read")
  }
}
private final class SavedLibraryProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var server: SavedLibraryServer?
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == 8796 }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      guard let url = request.url, let server = Self.server else { throw FotoroError("Missing controlled catalog") }
      let (status, body) = try server.response(request)
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

final class ChangedOriginalReconciliationTests: XCTestCase {
  @MainActor func testUnavailableChangedOriginalDoesNotBlockReadyNeighborsAndRetriesWithoutLosingEarlierCopy() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
    let services = try await context.enroll(diagnostics: diagnostics)
    defer { services.vault.lock() }
    let original = try Data(contentsOf: context.sample)
    let newOriginal = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png")))
    let queuedOriginal = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-c", withExtension: "png")))
    services.automaticPhotosAuthorization = { .authorized }
    let capturedAt = Date()
    services.photosBackupSnapshot = { _ in [BackupCandidate(id: "changed", capturedAt: capturedAt, sourceRevision: "before")] }
    services.importer = PhotoImport(store: services.store, sourceReader: { _ in (original, "earlier.jpg", false) },
      sourceRevision: { _ in "before" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
    try services.enableAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    let earlier = try services.store.backupSource("changed")
    let earlierPhoto = try XCTUnwrap(services.store.backupPhoto(earlier.photoId))
    let reads = ReconciliationReadState()
    services.importer = PhotoImport(store: services.store, sourceReader: { source in
      if source.resourceIdentifier == "changed", await reads.shouldFail() { throw URLError(.resourceUnavailable) }
      return source.resourceIdentifier == "queued" ? (queuedOriginal, "queued.png", false) : (newOriginal, "current.png", false)
    }, sourceRevision: { _ in "current" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
    var queued = try services.store.backupSource("queued")
    queued.sourceRevision = "current"
    try services.store.putBackupSource(queued)
    _ = try await services.importer.stageBackup(queued, accountId: XCTUnwrap(services.session.accountId),
      bundle: services.vault.requireBundle(), capturedAt: capturedAt)
    services.photosBackupSnapshot = { _ in [
      BackupCandidate(id: "changed", capturedAt: capturedAt, sourceRevision: "current"),
      BackupCandidate(id: "new", capturedAt: capturedAt, sourceRevision: "current"),
      BackupCandidate(id: "queued", capturedAt: capturedAt, sourceRevision: "current")
    ] }
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    let unavailable = try services.store.backupSource("changed")
    XCTAssertEqual(unavailable.photoId, earlier.photoId)
    XCTAssertEqual(unavailable.sourceRevision, earlier.sourceRevision)
    XCTAssertEqual(unavailable.originalSha256, earlier.originalSha256)
    XCTAssertEqual(unavailable.phase, .committed)
    XCTAssertNotNil(unavailable.message)
    XCTAssertEqual(try services.store.backupSource("new").phase, .committed)
    XCTAssertEqual(try services.store.backupSource("queued").phase, .committed)
    XCTAssertTrue(try services.journal.entries().isEmpty)
    XCTAssertEqual(services.backup.status.failed, 1)
    XCTAssertEqual(services.automaticPhotoSync.phase, .needsAttention)
    services.refreshConsumerSyncSummary()
    XCTAssertNotEqual(services.consumerSyncSummary.state, .upToDate)
    XCTAssertEqual(services.photoSyncProgress.failed, 1)
    XCTAssertNil(services.photoSyncItem(sourceID: "changed", revision: "current"), "An earlier saved binding cannot claim this changed revision was saved")
    XCTAssertEqual(services.photoSyncItem(sourceID: "changed", revision: "before")?.phase, .saved)
    let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
    XCTAssertEqual(events.last(where: { $0.phase == .sync && $0.step == .verify })?.outcome, .failed)
    for step in [NativeDiagnosticStep.scan, .prepare, .transfer] {
      XCTAssertTrue(events.contains(where: { $0.phase == .sync && $0.step == step && $0.outcome == .completed }))
    }
    await reads.allowRead()
    services.kickAutomaticPhotoSync()
    await services.waitForAutomaticPhotoSync()
    let current = try services.store.backupSource("changed")
    XCTAssertEqual(current.phase, .committed)
    XCTAssertEqual(current.sourceRevision, "current")
    XCTAssertEqual(current.originalSha256, newOriginal.digest)
    XCTAssertNil(current.message)
    let changedReadCount = await reads.count()
    XCTAssertEqual(changedReadCount, 2, "One failed attempt plus one retry; preparation must reuse the verified bytes")
    XCTAssertEqual(services.backup.status.failed, 0)
    XCTAssertEqual(services.automaticPhotoSync.phase, .ready)
    services.refreshConsumerSyncSummary()
    XCTAssertEqual(services.consumerSyncSummary.state, .upToDate)
    let preserved = try XCTUnwrap(services.store.backupPhoto(earlier.photoId))
    XCTAssertEqual(preserved.metadata.sourceDate, earlierPhoto.metadata.sourceDate)
    XCTAssertEqual(preserved.metadata.originalSha256, original.digest)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preserved.originalURL)), original)
  }

  @MainActor func testWithdrawnChangedOriginalDoesNotPersistLateReadFailure() async throws {
    for withdrawal in ["revision", "permission", "lock"] {
      let context = try PausedUploadContext()
      defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
      let services = try await context.enroll()
      defer { services.vault.lock() }
      let bytes = try Data(contentsOf: context.sample)
      var permission = PHAuthorizationStatus.authorized
      services.automaticPhotosAuthorization = { permission }
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "changed", capturedAt: Date(), sourceRevision: "before")] }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in (bytes, "earlier.jpg", false) },
        sourceRevision: { _ in "before" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
      try services.enableAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      let earlier = try services.store.backupSource("changed")
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "changed", capturedAt: Date(), sourceRevision: "current")] }
      let gate = ReconciliationFailureGate()
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in
        await gate.wait()
        throw URLError(.resourceUnavailable)
      }, sourceRevision: { _ in "current" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
      services.kickAutomaticPhotoSync()
      while !gate.entered { await Task.yield() }
      switch withdrawal {
      case "revision":
        services.photosBackupSnapshot = { _ in [BackupCandidate(id: "changed", capturedAt: Date(), sourceRevision: "newer")] }
      case "permission": permission = .denied
      default: services.vault.lock()
      }
      gate.release()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(try services.store.backupSource("changed"), earlier,
        "A withdrawn context cannot turn a late availability error into a source failure")
      XCTAssertEqual(services.backup.status.phase, .paused)
      XCTAssertEqual(services.backup.status.failed, 0)
    }
  }

  @MainActor func testCancelledChangedOriginalReadAbortsWithoutPersistingAvailabilityFailure() async throws {
    for urlCancellation in [false, true] {
      let context = try PausedUploadContext()
      defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
      let diagnostics = NativeDiagnostics(fileURL: nil, emitSystemLog: false)
      let services = try await context.enroll(diagnostics: diagnostics)
      defer { services.vault.lock() }
      let bytes = try Data(contentsOf: context.sample)
      services.automaticPhotosAuthorization = { .authorized }
      services.photosBackupSnapshot = { _ in [BackupCandidate(id: "changed", capturedAt: Date(), sourceRevision: "before")] }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in (bytes, "earlier.jpg", false) },
        sourceRevision: { _ in "before" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
      try services.enableAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      let earlier = try services.store.backupSource("changed")
      services.photosBackupSnapshot = { _ in [
        BackupCandidate(id: "changed", capturedAt: Date(), sourceRevision: "current"),
        BackupCandidate(id: "neighbor", capturedAt: Date(), sourceRevision: "current")
      ] }
      services.importer = PhotoImport(store: services.store, sourceReader: { _ in
        if urlCancellation { throw URLError(.cancelled) }
        throw CancellationError()
      }, sourceRevision: { _ in "current" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
      services.kickAutomaticPhotoSync()
      await services.waitForAutomaticPhotoSync()
      XCTAssertEqual(try services.store.backupSource("changed"), earlier)
      XCTAssertEqual(try services.store.backupSource("neighbor").phase, .pending,
        "Metadata scanning may admit the neighbor, but cancelled verification cannot prepare or upload it")
      XCTAssertTrue(try services.journal.entries().isEmpty)
      XCTAssertEqual(services.backup.status.phase, .paused)
      XCTAssertEqual(services.backup.status.failed, 0)
      let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: diagnostics.exportJSON())
      XCTAssertEqual(events.last(where: { $0.phase == .sync && $0.step == .verify })?.outcome, .cancelled)
      XCTAssertEqual(events.last(where: { $0.phase == .sync && $0.step == .scan })?.outcome, .completed,
        "Scanning metadata completes before per-source verification begins")
    }
  }
}

private actor ReconciliationReadState {
  private var unavailable = true
  private var attempts = 0
  func shouldFail() -> Bool { attempts += 1; return unavailable }
  func count() -> Int { attempts }
  func allowRead() { unavailable = false }
}

@MainActor private final class ReconciliationFailureGate {
  private(set) var entered = false
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      entered = true
    }
  }
  func release() { continuation?.resume(); continuation = nil }
}

private final class SavedSemanticObservationCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  var value: Int { lock.lock(); defer { lock.unlock() }; return count }
  func increment() { lock.lock(); defer { lock.unlock() }; count += 1 }
}

@MainActor private final class SavedSemanticEmbeddingGate {
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { await withCheckedContinuation { continuation = $0 } }
  func open() { continuation?.resume(); continuation = nil }
}
