import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import Fotoro

final class ImportTests: XCTestCase {
  private func originalWithGPS() throws -> Data {
    let bytes = try Data(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "singapore", withExtension: "jpg")))
    let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyGPSDictionary: [
      kCGImagePropertyGPSLatitude: 33.9, kCGImagePropertyGPSLatitudeRef: "S",
      kCGImagePropertyGPSLongitude: 151.2, kCGImagePropertyGPSLongitudeRef: "E",
    ]] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }
  private func originalWithCapture(offset: String? = "+08:00") throws -> Data {
    let bytes = try originalWithGPS()
    let source = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let data = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
    var exif: [CFString: Any] = [kCGImagePropertyExifDateTimeOriginal: "2000:01:02 12:34:56", kCGImagePropertyExifFNumber: 1.8,
      kCGImagePropertyExifExposureTime: 0.004, kCGImagePropertyExifISOSpeedRatings: [100]]
    if let offset { exif[kCGImagePropertyExifOffsetTimeOriginal] = offset }
    CGImageDestinationAddImage(destination, image, [kCGImagePropertyExifDictionary: exif,
      kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Apple", kCGImagePropertyTIFFModel: "Fixture camera"]] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination)); return data as Data
  }
  func testPhotosDateRemainsAuthoritativeAndCaptureFactsSeedWithoutChangingOriginalOrStrictWire() async throws {
    let bytes = try originalWithCapture()
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts"), secret = accounts.testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let current = "2026-10-07T12:00:00.000Z"
    let photos = PhotoCaptureMetadata(items: [.init(k: "createdAt", p: .photos, v: current), .init(k: "width", p: .photos, v: "1000")])
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) }, sourceRevision: { _ in "current" },
      sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in photos })
    let imported = try await importer.importResources([SelectedResource(id: "selected", origin: .photos, resourceIdentifier: "selected")], accountId: secret.accountId, bundle: bundle)
    let photo = try XCTUnwrap(imported.first)
    XCTAssertEqual(Wire.parseDate(photo.metadata.sourceDate), Wire.parseDate(current)); XCTAssertEqual(photo.metadata.dateSource, "photos")
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(photo.originalURL)), bytes)
    let ledger = AnnotationLedger(store: store, accountId: secret.accountId)
    var value = try XCTUnwrap(ledger.current(photo: photo, bundle: bundle, card: accounts.accounts[0]))
    let capture = try XCTUnwrap(PhotoCaptureFacts.read(value.facts, originalSha256: photo.metadata.originalSha256))
    XCTAssertEqual(capture.items.first { $0.k == "cameraModel" }?.v, "Fixture camera")
    XCTAssertEqual(capture.items.first { $0.k == "width" && $0.p == .photos }?.v, "1000")
    XCTAssertNil(value.location)
    let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(photo.metadata)) as? [String: Any])
    XCTAssertNil(fields["captureMetadata"]); XCTAssertNil(fields["cameraModel"])
    value.labels = ["Owner words"]
    try ledger.edit(value, photo: photo, bundle: bundle, card: accounts.accounts[0])
    let before = try ledger.state(photo.id)
    try await store.database.write { db in try ledger.seedMetadata(location: nil, capture: PhotoCaptureMetadata(), photo: photo, bundle: bundle, db: db) }
    XCTAssertEqual(try ledger.state(photo.id)?.draft, before?.draft)
    XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: accounts.accounts[0])?.labels, ["Owner words"])
  }
  func testFileExifRequiresActualOffsetAndMissingPhotosDateCannotResurrectOriginalDate() async throws {
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let importer = PhotoImport(store: store)
    let offsetBytes = try originalWithCapture()
    let explicit = try await importer.build(bytes: offsetBytes, filename: "original.jpg", accountId: secret.accountId, bundle: bundle)
    XCTAssertEqual(explicit.metadata.dateSource, "exif")
    XCTAssertEqual(Wire.parseDate(explicit.metadata.sourceDate), Wire.parseDate("2000-01-02T04:34:56.000Z"))
    let missing = try await importer.build(bytes: try originalWithCapture(offset: nil), filename: "original.jpg", accountId: secret.accountId, bundle: bundle)
    XCTAssertEqual(missing.metadata.dateSource, "import")
    let removed = try await importer.build(bytes: offsetBytes, filename: "original.jpg", accountId: secret.accountId, bundle: bundle, permitOriginalCaptureDate: false)
    XCTAssertEqual(removed.metadata.dateSource, "import")
  }
  func testFileIntakeKeepsOriginalGPSInPrivateFactsAndOriginalBytesUnchanged() async throws {
    let bytes = try originalWithGPS()
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let secret = accounts.testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) }, sourceLocation: { _ in nil })
    let imported = try await importer.importResources([SelectedResource(id: "file", origin: .file, resourceIdentifier: "file")],
      accountId: secret.accountId, bundle: bundle)
    let photo = try XCTUnwrap(imported.first)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(photo.originalURL)), bytes)
    XCTAssertEqual(photo.metadata.originalSha256, bytes.digest)
    let ledger = AnnotationLedger(store: store, accountId: secret.accountId)
    XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: accounts.accounts[0])?.location,
      PhotoLocationV1(latitude: -33.9, longitude: 151.2, source: "exif"))
    let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(photo.metadata)) as? [String: Any])
    XCTAssertNil(fields["location"])
  }
  func testPhotosLocationAbsenceDoesNotRestoreOriginalExifGPSDuringImportOrSync() async throws {
    let bytes = try originalWithGPS()
    XCTAssertNotNil(PhotoLocationV1.exif(bytes), "The unmodified original still contains GPS")
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let secret = accounts.testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) },
      sourceRevision: { _ in "current" }, sourceLocation: { _ in nil })
    let imported = try await importer.importResources([SelectedResource(id: "selected", origin: .photos, resourceIdentifier: "selected")],
      accountId: secret.accountId, bundle: bundle)
    let selected = try XCTUnwrap(imported.first)
    let ledger = AnnotationLedger(store: store, accountId: secret.accountId)
    XCTAssertNil(try ledger.current(photo: selected, bundle: bundle, card: accounts.accounts[0])?.location)
    let synced = try await importer.stageBackup(BackupSource(id: "synced", photoId: Wire.id(), sourceRevision: "current"),
      accountId: secret.accountId, bundle: bundle)
    XCTAssertNil(try ledger.current(photo: synced, bundle: bundle, card: accounts.accounts[0])?.location)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(selected.originalURL)), bytes)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(synced.originalURL)), bytes)
  }
  func testOptInSyncPrefersPhotosLocationAndDoesNotOverwriteExistingPrivateEditsWhenDeduping() async throws {
    let bytes = try originalWithGPS()
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let secret = accounts.testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let location = PhotoLocationV1(latitude: 40.7128, longitude: -74.006, source: "photos", accuracyMeters: 8)
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) },
      sourceRevision: { _ in "current" }, sourceLocation: { _ in location })
    let source = BackupSource(id: "first", photoId: Wire.id(), sourceRevision: "current")
    let photo = try await importer.stageBackup(source, accountId: secret.accountId, bundle: bundle)
    let ledger = AnnotationLedger(store: store, accountId: secret.accountId)
    XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: accounts.accounts[0])?.location, location)
    XCTAssertNotNil(try ledger.prepare(photo: photo, bundle: bundle, card: accounts.accounts[0], derivedOnly: true))
    var edited = try XCTUnwrap(ledger.current(photo: photo, bundle: bundle, card: accounts.accounts[0]))
    edited.labels = ["User words"]
    var named = location
    named.name = "User place"
    try edited.setLocation(named)
    try ledger.edit(edited, photo: photo, bundle: bundle, card: accounts.accounts[0])
    let duplicate = try await importer.stageBackup(BackupSource(id: "duplicate", photoId: Wire.id(), sourceRevision: "current"),
      accountId: secret.accountId, bundle: bundle)
    XCTAssertEqual(duplicate.id, photo.id)
    XCTAssertEqual(try ledger.current(photo: duplicate, bundle: bundle, card: accounts.accounts[0])?.location, named)
    XCTAssertEqual(try ledger.current(photo: duplicate, bundle: bundle, card: accounts.accounts[0])?.labels, ["User words"])
  }
  func testHEICOriginalPreservedAndJPEGDerivatives() async throws {
    let jpeg = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let source = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil))
    let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    let encoded = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(encoded, UTType.heic.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let original = encoded as Data
    try original.write(
      to: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("fotoro-sync-sample.heic"))
    XCTAssertEqual(try PhotoImport.validate(original, filename: "original.heic"), "image/heic")
    XCTAssertThrowsError(try PhotoImport.validate(original, filename: "pretend.jpg"))
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let photo = try await PhotoImport(store: store).build(
      bytes: original, filename: "original.heic", accountId: account.accountId,
      bundle: AccountBundle(
        vaultKey: account.vaultKey, boxSecretKey: account.boxSecretKey,
        signingSecretKey: account.signingSecretKey))
    XCTAssertEqual(photo.metadata.mediaType, "image/heic")
    XCTAssertEqual(photo.originalURL?.pathExtension, "heic")
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(photo.originalURL)), original)
    for url in [photo.thumbnailURL, photo.previewURL] {
      let bytes = try Data(contentsOf: XCTUnwrap(url))
      XCTAssertTrue(bytes.starts(with: [0xff, 0xd8, 0xff]))
    }
  }
  func testUnsupportedTranscodedAndUnavailableOriginals() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let importer = PhotoImport(store: store)
    let a = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(
      vaultKey: a.vaultKey, boxSecretKey: a.boxSecretKey, signingSecretKey: a.signingSecretKey)
    XCTAssertThrowsError(try PhotoImport.validate(Data([0, 1, 2]), filename: "photo.heic"))
    XCTAssertThrowsError(
      try PhotoImport.validate(Data([0xff, 0xd8, 0xff]), filename: "transcoded.heic"))
    let photos = try await importer.importResources(
      [
        SelectedResource(
          id: "missing", origin: .photos, resourceIdentifier: "missing-icloud-original",
          fileURL: nil)
      ], accountId: a.accountId, bundle: bundle)
    XCTAssertTrue(photos.isEmpty)
    let failures = await importer.failures
    XCTAssertEqual(failures.count, 1)
    XCTAssertTrue(try store.photos().isEmpty)
  }
  func testOriginalUnchangedAndDurableCiphertext() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let importer = PhotoImport(store: store)
    let a = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    let bytes = try Data(contentsOf: url)
    let photo = try await importer.build(
      bytes: bytes, filename: "singapore.jpg", accountId: a.accountId,
      bundle: AccountBundle(
        vaultKey: a.vaultKey, boxSecretKey: a.boxSecretKey, signingSecretKey: a.signingSecretKey))
    XCTAssertEqual(try Data(contentsOf: photo.originalURL!).digest, bytes.digest)
    XCTAssertEqual(photo.staged.count, 4)
    for path in photo.staged.values {
      XCTAssertTrue(path.path.contains("Pending"))
      XCTAssertTrue(FileManager.default.fileExists(atPath: path.path))
    }
  }
  func testEditedOriginalAndICloudDownloadFailure() async throws {
    let store = try LibraryStore(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let bytes = try Data(
      contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    let importer = PhotoImport(
      store: store,
      sourceReader: { selected in
        if selected.id == "icloud-failure" {
          throw FotoroError(
            "Original download failed: iCloud unavailable. Retry when iCloud is available.")
        }
        return (bytes, "edited-original.jpg", true)
      })
    let a = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(
      vaultKey: a.vaultKey, boxSecretKey: a.boxSecretKey, signingSecretKey: a.signingSecretKey)
    let result = try await importer.importResources(
      [
        SelectedResource(id: "edited", origin: .photos, resourceIdentifier: "edited", fileURL: nil),
        SelectedResource(
          id: "icloud-failure", origin: .photos, resourceIdentifier: "cloud", fileURL: nil),
      ], accountId: a.accountId, bundle: bundle)
    XCTAssertEqual(result.count, 1)
    XCTAssertEqual(result[0].metadata.originalSha256, bytes.digest)
    let notices = await importer.notices
    XCTAssertEqual(notices, ["Imported the unmodified original; Photos edits are not included."])
    let failures = await importer.failures
    XCTAssertEqual(failures.count, 1)
    XCTAssertEqual(failures[0].id, "icloud-failure")
    XCTAssertEqual(try store.photos().count, 1)
    _ = try store.write(Data(repeating: 1, count: 100), name: "cache-old.jpg")
    try store.trimReadCache(limit: 0)
    XCTAssertTrue(
      result[0].staged.values.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
  }

  func testPreparedBackupOriginalReadsOncePreservesBytesAndReusesDigestDuplicate() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root)
    let bytes = try originalWithCapture()
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let reads = PreparedOriginalReadCount()
    let importer = PhotoImport(store: store, sourceReader: { _ in
      await reads.increment(); return (bytes, "original.jpg", false)
    }, sourceRevision: { _ in "current" }, sourceLocation: { _ in nil }, sourceCaptureMetadata: { _ in nil })
    var source = try store.backupSource("prepared")
    source.sourceRevision = "current"
    let original = try await importer.prepareBackupOriginal(source)
    XCTAssertEqual(original.digest, bytes.digest)
    let captured = Date(timeIntervalSince1970: 1_700_000_000)
    let photo = try await importer.stageBackup(source, accountId: secret.accountId, bundle: bundle,
      capturedAt: captured, preparedOriginal: original)
    let readCount = await reads.count
    XCTAssertEqual(readCount, 1)
    XCTAssertEqual(photo.metadata.originalSha256, original.digest)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(photo.originalURL)), bytes)
    XCTAssertEqual(photo.metadata.dateSource, "photos")
    XCTAssertEqual(photo.metadata.sourceDate, Wire.date(captured))
    let representation = try XCTUnwrap(photo.manifest.representations.first { $0.binding.kind == "original" })
    let decrypted = try CryptoAdapter().decrypt(try Data(contentsOf: XCTUnwrap(photo.staged[representation.binding.representationId])),
      key: Data(b64: XCTUnwrap(photo.metadata.representationKeys[representation.binding.representationId])), representation: representation)
    XCTAssertEqual(decrypted, bytes)
    var duplicate = try store.backupSource("duplicate")
    duplicate.sourceRevision = "current"
    let duplicateOriginal = try await importer.prepareBackupOriginal(duplicate)
    let reused = try await importer.stageBackup(duplicate, accountId: secret.accountId, bundle: bundle, preparedOriginal: duplicateOriginal)
    XCTAssertEqual(reused.photoId, photo.photoId)
    XCTAssertEqual(try store.photos().count, 1)
  }
  func testPreparedBackupOriginalRejectsWrongSourceChangedRevisionAndWithdrawnConsent() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root), bytes = try originalWithCapture()
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) }, sourceRevision: { _ in "current" })
    var source = try store.backupSource("prepared")
    source.sourceRevision = "current"
    let original = try await importer.prepareBackupOriginal(source)
    var other = source; other.id = "other"
    do {
      _ = try await importer.stageBackup(other, accountId: secret.accountId, bundle: bundle, preparedOriginal: original)
      XCTFail("Prepared bytes must belong to the requested source")
    } catch { XCTAssertFalse(error is CancellationError) }
    let changed = PhotoImport(store: store, sourceReader: { _ in XCTFail("Prepared original must not be read again"); return (bytes, "original.jpg", false) },
      sourceRevision: { _ in "changed" })
    do {
      _ = try await changed.stageBackup(source, accountId: secret.accountId, bundle: bundle, preparedOriginal: original)
      XCTFail("Current revision must still match")
    } catch { XCTAssertFalse(error is CancellationError) }
    do {
      _ = try await importer.stageBackup(source, accountId: secret.accountId, bundle: bundle, valid: { false }, preparedOriginal: original)
      XCTFail("Consent withdrawal must reject prepared bytes")
    } catch { XCTAssertTrue(error is CancellationError) }
    var newRevision = source; newRevision.sourceRevision = "changed"
    let updated = PhotoImport(store: store, sourceRevision: { _ in "changed" })
    do {
      _ = try await updated.stageBackup(newRevision, accountId: secret.accountId, bundle: bundle, preparedOriginal: original)
      XCTFail("Prepared revision must match the requested revision")
    } catch { XCTAssertFalse(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
  }
  func testBackupPreparationRejectsCancellationDuringOriginalRead() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root), bytes = try originalWithCapture()
    let importer = PhotoImport(store: store, sourceReader: { _ in
      withUnsafeCurrentTask { $0?.cancel() }
      return (bytes, "original.jpg", false)
    }, sourceRevision: { _ in "current" })
    var source = try store.backupSource("prepared"); source.sourceRevision = "current"
    let task = Task { try await importer.prepareBackupOriginal(source) }
    do {
      _ = try await task.value
      XCTFail("Cancelled original read must not publish prepared bytes")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
  }
  func testBackupPreparationRechecksConsentAfterReadBeforeReturningBytes() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try LibraryStore(root: root), bytes = try originalWithCapture()
    let checks = PreparedOriginalReadCount()
    let importer = PhotoImport(store: store, sourceReader: { _ in (bytes, "original.jpg", false) }, sourceRevision: { _ in "current" })
    var source = try store.backupSource("prepared"); source.sourceRevision = "current"
    do {
      _ = try await importer.prepareBackupOriginal(source, valid: { await checks.increment(); return await checks.count == 1 })
      XCTFail("Consent withdrawn during the read must reject its result")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(try store.photos().isEmpty)
  }

}

private actor PreparedOriginalReadCount {
  private(set) var count = 0
  func increment() { count += 1 }
}
