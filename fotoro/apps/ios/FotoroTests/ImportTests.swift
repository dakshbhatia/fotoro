import XCTest

@testable import Fotoro

final class ImportTests: XCTestCase {
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
