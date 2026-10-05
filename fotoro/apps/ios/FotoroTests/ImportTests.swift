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

}
