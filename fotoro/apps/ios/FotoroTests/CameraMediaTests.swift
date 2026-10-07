import ImageIO
import Photos
import XCTest

@testable import Fotoro

final class CameraMediaTests: XCTestCase {
  private func readRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }
  func testOriginalStreamPreservesEveryByteAndRemovesTemporaryPlaintext() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task { try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
      start: { request.start($0, $1) }, cancel: { request.cancel($0) }) }
    while !request.started { await Task.yield() }
    request.receive(Data([1, 2])); request.receive(Data([3, 4, 5])); request.finish(nil)
    let bytes = try await task.value
    XCTAssertEqual(bytes, Data([1, 2, 3, 4, 5]))
    XCTAssertTrue(request.cancelledIDs.isEmpty)
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }
  func testOversizedStreamStopsBeforeProviderCompletionAndCannotRetainPartialBytes() async throws {
    let root = try readRoot()
    let cancelled = expectation(description: "Oversized request cancelled before completion")
    let request = ControlledOriginalRequest(onCancel: { cancelled.fulfill() })
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task { try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
      start: { request.start($0, $1) }, cancel: { request.cancel($0) }) }
    while !request.started { await Task.yield() }
    request.receive(Data([1, 2, 3])); request.receive(Data([4, 5, 6]))
    await fulfillment(of: [cancelled], timeout: 2)
    XCTAssertEqual(request.cancelledIDs, [7], "Stop before the remaining iCloud bytes arrive")
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    request.finish(nil)
    do { _ = try await task.value; XCTFail("Oversized resource must not be returned") }
    catch { XCTAssertTrue(error is CameraMediaAdmissionError) }
  }
  func testPausedReadCancelsPhotosRequestAndIgnoresLateChunksAndCompletion() async throws {
    let root = try readRoot()
    let cancelled = expectation(description: "Paused request cancelled before completion")
    let request = ControlledOriginalRequest(onCancel: { cancelled.fulfill() })
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task { try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
      start: { request.start($0, $1) }, cancel: { request.cancel($0) }) }
    while !request.started { await Task.yield() }
    request.receive(Data([1, 2, 3]))
    task.cancel()
    await fulfillment(of: [cancelled], timeout: 2)
    XCTAssertEqual(request.cancelledIDs, [7])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    request.receive(Data([4, 5])); request.finish(nil); request.finish(nil)
    do { _ = try await task.value; XCTFail("Paused read must not publish an original") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(request.cancelledIDs, [7], "Late callbacks cannot cancel or complete a second time")
  }
  func testPauseBeforeRequestIDReturnsCancelsExactlyOnce() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task {
      try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
        start: { receive, finish in
          withUnsafeCurrentTask { $0?.cancel() }
          receive(Data([1, 2, 3])); finish(nil)
          return 7
        }, cancel: { request.cancel($0) })
    }
    do { _ = try await task.value; XCTFail("Pause must win over late successful completion") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(request.cancelledIDs, [7])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }
  func testEmptyResourceCannotBecomeAnOriginal() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      _ = try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
        start: { _, finish in finish(nil); return 7 }, cancel: { request.cancel($0) })
      XCTFail("An empty resource is not a saved original")
    } catch { XCTAssertTrue(error is FotoroError) }
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }
  func testOversizedCallbackBeforeRequestIDReturnsStillCancelsExactlyOnce() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      _ = try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
        start: { receive, finish in
          receive(Data([1, 2, 3, 4, 5, 6])); finish(nil)
          return 7
        }, cancel: { request.cancel($0) })
      XCTFail("A synchronous oversized callback must not return an original")
    } catch { XCTAssertTrue(error is CameraMediaAdmissionError) }
    XCTAssertEqual(request.cancelledIDs, [7])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }
  func testFailedResourceRetryStartsWithNoEarlierPartialBytes() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task { try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
      start: { request.start($0, $1) }, cancel: { request.cancel($0) }) }
    while !request.started { await Task.yield() }
    request.receive(Data([9, 9])); request.finish(FotoroError("Controlled source interruption"))
    do { _ = try await task.value; XCTFail("Interrupted resource must fail") }
    catch { XCTAssertTrue(error is FotoroError) }
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    let bytes = try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
      start: { receive, finish in receive(Data([1, 2, 3])); finish(nil); return 8 }, cancel: { request.cancel($0) })
    XCTAssertEqual(bytes, Data([1, 2, 3]))
    XCTAssertTrue(request.cancelledIDs.isEmpty)
  }
  func testCleanupFailureCannotPublishOriginalAndLeavesNoSpoolContents() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      _ = try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
        removeTemporary: { _ in throw FotoroError("Controlled deletion failure") },
        start: { receive, finish in receive(Data([1, 2, 3])); finish(nil); return 7 },
        cancel: { request.cancel($0) })
      XCTFail("Cleanup failure cannot return a saved original")
    } catch { XCTAssertEqual(error.localizedDescription, "Cannot clear the temporary original. Retry sync.") }
    let directory = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("original")).count, 0)
  }
  func testCancellationCanReenterProviderCompletionWithoutDeadlocking() async throws {
    let root = try readRoot(), request = ControlledOriginalRequest()
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      _ = try await PhotosOriginalReader.read(maximumBytes: 5, temporaryRoot: root,
        start: { receive, finish in
          _ = request.start(receive, finish)
          receive(Data([1, 2, 3, 4, 5, 6]))
          return 7
        }, cancel: { id in request.cancel(id); request.finish(CancellationError()) })
      XCTFail("Oversized original must fail")
    } catch { XCTAssertTrue(error is CameraMediaAdmissionError) }
    XCTAssertEqual(request.cancelledIDs, [7])
    XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }
  private func resource(_ name: String, _ ext: String) throws -> Data {
    try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: ext)))
  }
  func testCrossLanguageArchivePreservesBothCompleteResourcesAndRejectsCorruption() throws {
    let archive = try resource("camera-live", "fotoro-live")
    let pair = try CameraMedia.decodeLivePhoto(archive)
    XCTAssertEqual(pair.still.filename, "original.png")
    XCTAssertEqual(pair.motion.filename, "paired.MOV")
    XCTAssertEqual(pair.still.bytes, try resource("neutral-a", "png"))
    XCTAssertEqual(pair.motion.bytes, try resource("camera-motion", "mov"))
    let reencoded = try CameraMedia.encodeLivePhoto(still: pair.still, motion: pair.motion)
    let restored = try CameraMedia.decodeLivePhoto(reencoded)
    XCTAssertEqual(restored.still, pair.still); XCTAssertEqual(restored.motion, pair.motion)
    var corrupt = archive; corrupt[corrupt.count - 1] ^= 1
    XCTAssertThrowsError(try CameraMedia.decodeLivePhoto(corrupt))
    XCTAssertThrowsError(try CameraMedia.decodeLivePhoto(archive.dropLast()))
    XCTAssertThrowsError(try CameraMedia.decodeLivePhoto(archive + Data([0])))
    var path = pair.still; path.filename = "../original.png"
    XCTAssertThrowsError(try CameraMedia.encodeLivePhoto(still: path, motion: pair.motion))
  }
  func testMediaKindsRemainExplicitAndLogicalOriginalLimitDoesNotBecomeAStillOnlyShortcut() throws {
    XCTAssertEqual(CameraMedia.manifestKind(for: "image/jpeg"), "photo-manifest")
    XCTAssertEqual(CameraMedia.manifestKind(for: "video/quicktime"), "photo-media-manifest-v1")
    XCTAssertEqual(CameraMedia.manifestKind(for: CameraMedia.liveType), "photo-media-manifest-v1")
    XCTAssertThrowsError(try CameraMedia.validateSize(CameraMedia.maximumOriginalBytes + 1)) { XCTAssertTrue($0 is CameraMediaAdmissionError) }
    let video = try resource("camera-motion", "mov")
    XCTAssertEqual(try CameraMedia.videoType(filename: "original.MOV", bytes: video), "video/quicktime")
    XCTAssertThrowsError(try CameraMedia.videoType(filename: "original.mp4", bytes: video))
    XCTAssertThrowsError(try CameraMedia.videoType(filename: "original.MOV", bytes: Data([1, 2, 3])))
  }
  func testRealMotionAndLivePairBuildPostersButEncryptCompleteOriginalBytes() async throws {
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let captured = try XCTUnwrap(Wire.parseDate("2026-10-01T12:34:56Z"))
    for (name, ext, type) in [("camera-motion", "mov", "video/quicktime"), ("camera-live", "fotoro-live", CameraMedia.liveType)] {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      defer { try? FileManager.default.removeItem(at: root) }
      let store = try LibraryStore(root: root), bytes = try resource(name, ext)
      let photo = try await PhotoImport(store: store).buildMedia(bytes: bytes, filename: name + "." + ext,
        accountId: secret.accountId, bundle: bundle, capturedAt: captured)
      XCTAssertEqual(photo.metadata.mediaType, type)
      XCTAssertEqual(photo.metadata.originalBytes, bytes.count)
      XCTAssertEqual(photo.metadata.originalSha256, bytes.digest)
      XCTAssertEqual(photo.metadata.dateSource, "photos")
      XCTAssertEqual(photo.metadata.sourceDate, Wire.date(captured))
      XCTAssertEqual(try Data(contentsOf: XCTUnwrap(photo.originalURL)), bytes)
      XCTAssertNotNil(CGImageSourceCreateWithData(try Data(contentsOf: XCTUnwrap(photo.previewURL)) as CFData, nil))
      let representation = try XCTUnwrap(photo.manifest.representations.first { $0.binding.kind == "original" })
      let decrypted = try CryptoAdapter().decrypt(try Data(contentsOf: XCTUnwrap(photo.staged[representation.binding.representationId])),
        key: Data(b64: XCTUnwrap(photo.metadata.representationKeys[representation.binding.representationId])), representation: representation)
      XCTAssertEqual(decrypted, bytes)
      let directory = root.appendingPathComponent("exports")
      let files = try CameraMedia.exportOriginals(decrypted, metadata: photo.metadata, directory: directory)
      XCTAssertEqual(files.count, type == CameraMedia.liveType ? 2 : 1)
      if type == CameraMedia.liveType {
        XCTAssertEqual(try Data(contentsOf: files[0]), try resource("neutral-a", "png"))
        XCTAssertEqual(try Data(contentsOf: files[1]), try resource("camera-motion", "mov"))
      } else { XCTAssertEqual(try Data(contentsOf: files[0]), bytes) }
    }
  }
  @MainActor func testCancelledMotionSourceReadCannotPublishAnyLocalPhotoOrQueue() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root), gate = MediaReadGate(), bytes = try resource("camera-motion", "mov")
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let importer = PhotoImport(store: store, sourceReader: { _ in await gate.wait(); return (bytes, "original.MOV", false) }, sourceRevision: { _ in "current" })
    var source = try store.backupSource("video"); source.sourceRevision = "current"; try store.putBackupSource(source)
    let task = Task { try await importer.stageBackup(source, accountId: secret.accountId,
      bundle: AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey), valid: { await gate.allowed }) }
    while !(await gate.entered) { await Task.yield() }
    await gate.revokeAndOpen()
    do { _ = try await task.value; XCTFail("Revoked source must not create a partial media checkpoint") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
    XCTAssertEqual(try store.backupSource(source.id).phase, .pending)
  }
  @MainActor func testLegacySkippedVideoReopensOnceAndOversizedRevisionIsNotRepeatedlyDownloaded() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root), backup = try PhotosBackup(store: store)
    var old = try store.backupSource("video"); old.phase = .skipped; old.sourceRevision = "current"; old.message = "Video is not backed up."
    try store.putBackupSource(old)
    var stages = 0
    func run(_ revision: String, oversized: Bool) {
      backup.start(snapshot: { [BackupCandidate(id: "video", sourceRevision: revision)] }, valid: { true }, stage: { _, _ in
        stages += 1
        if oversized { throw CameraMediaAdmissionError.originalTooLarge }
      }, upload: { _ in }, checkCatalog: {})
    }
    run("current", oversized: true); await backup.waitUntilSettled()
    XCTAssertEqual(stages, 1); XCTAssertEqual(backup.status.phase, .partial)
    XCTAssertEqual(try store.backupSource("video").skipProcessor, "camera-original-v1")
    run("current", oversized: true); await backup.waitUntilSettled()
    XCTAssertEqual(stages, 1, "Unchanged oversized originals must not be fetched every foreground")
    run("edited", oversized: false); await backup.waitUntilSettled()
    XCTAssertEqual(stages, 2); XCTAssertEqual(try store.backupSource("video").phase, .committed)
  }
  @MainActor func testOversizedEditedOriginalKeepsEarlierSavedBytesAndDoesNotBlockOtherEligibleSources() async throws {
    let context = try PausedUploadContext()
    defer { context.restore(); try? FileManager.default.removeItem(at: context.root) }
    let services = try await context.enroll()
    defer { services.vault.lock() }
    let oldBytes = try Data(contentsOf: context.sample), newBytes = try resource("neutral-a", "png")
    var old = try await services.importer.build(bytes: oldBytes, filename: "earlier.jpg",
      accountId: XCTUnwrap(services.session.accountId), bundle: services.vault.requireBundle())
    old.transferState = "committed"; try services.store.put(old)
    var source = try services.store.backupSource("edited")
    source.photoId = old.id; source.phase = .committed; source.sourceRevision = "before"; source.originalSha256 = old.metadata.originalSha256
    try services.store.putBackupSource(source)
    services.automaticPhotosAuthorization = { .authorized }
    services.photosBackupSnapshot = { _ in [BackupCandidate(id: "edited", capturedAt: Date(), sourceRevision: "after"), BackupCandidate(id: "other", capturedAt: Date(), sourceRevision: "current")] }
    services.importer = PhotoImport(store: services.store, sourceReader: { selected in
      if selected.id == "edited" { throw CameraMediaAdmissionError.originalTooLarge }
      return (newBytes, "other.png", false)
    }, sourceRevision: { $0 == "edited" ? "after" : "current" })
    try services.enableAutomaticPhotoSync(); await services.waitForAutomaticPhotoSync()
    XCTAssertEqual(try services.store.backupSource("edited").phase, .skipped)
    XCTAssertNotEqual(try services.store.backupSource("edited").photoId, old.id)
    XCTAssertEqual(try services.store.backupSource("other").phase, .committed)
    XCTAssertEqual(try services.consumerSavedPhoto(old.id)?.metadata.originalSha256, old.metadata.originalSha256)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(old.originalURL)), oldBytes)
    XCTAssertEqual(services.automaticPhotoSync.phase, .partial,
      "A skipped original must remain visible instead of reporting healthy completion")
    XCTAssertTrue(services.automaticPhotoSync.detail.contains("1 original"))
  }
}

private final class ControlledOriginalRequest: @unchecked Sendable {
  private let lock = NSLock()
  private var receiveHandler: (@Sendable (Data) -> Void)?
  private var finishHandler: (@Sendable (Error?) -> Void)?
  private var cancelled: [PHAssetResourceDataRequestID] = []
  private let onCancel: @Sendable () -> Void
  init(onCancel: @escaping @Sendable () -> Void = {}) { self.onCancel = onCancel }
  var started: Bool { lock.lock(); defer { lock.unlock() }; return receiveHandler != nil }
  var cancelledIDs: [PHAssetResourceDataRequestID] { lock.lock(); defer { lock.unlock() }; return cancelled }
  func start(_ receive: @escaping @Sendable (Data) -> Void,
    _ finish: @escaping @Sendable (Error?) -> Void) -> PHAssetResourceDataRequestID {
    lock.lock(); receiveHandler = receive; finishHandler = finish; lock.unlock()
    return 7
  }
  func cancel(_ id: PHAssetResourceDataRequestID) { lock.lock(); cancelled.append(id); lock.unlock(); onCancel() }
  func receive(_ bytes: Data) { lock.lock(); let callback = receiveHandler; lock.unlock(); callback?(bytes) }
  func finish(_ error: Error?) { lock.lock(); let callback = finishHandler; lock.unlock(); callback?(error) }
}

private actor MediaReadGate {
  var entered = false
  var allowed = true
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { entered = true; await withCheckedContinuation { continuation = $0 } }
  func revokeAndOpen() { allowed = false; continuation?.resume(); continuation = nil }
}
