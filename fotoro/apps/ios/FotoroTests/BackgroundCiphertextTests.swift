import XCTest

@testable import Fotoro

final class BackgroundCiphertextTests: XCTestCase {
  private func staged() throws -> (URL, Data) {
    let pending = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      .appendingPathComponent("Pending")
    try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: true)
    let binding = MediaBinding(photoId: Wire.id(), representationId: Wire.id(), kind: "original")
    let cipher = try CryptoAdapter().encrypt(
      Data("private original bytes".utf8), key: Data(repeating: 7, count: 32), binding: binding)
    let source = pending.appendingPathComponent("encrypted.bin")
    try cipher.write(to: source)
    return (source, cipher)
  }
  private func destination() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id() + ".bin")
  }

  func testOnlyValidatedCiphertextIsCopiedForBackgroundUpload() throws {
    let (source, cipher) = try staged()
    let result = destination()
    defer {
      try? FileManager.default.removeItem(at: source.deletingLastPathComponent().deletingLastPathComponent())
      try? FileManager.default.removeItem(at: result)
    }
    try BackgroundCiphertext.prepare(
      source: source, pendingDirectory: source.deletingLastPathComponent(), destination: result,
      bytes: cipher.count, sha256: cipher.digest, header: cipher.prefix(24).b64)
    XCTAssertEqual(try Data(contentsOf: result), cipher)
    XCTAssertEqual(try Data(contentsOf: source), cipher)
    #if !targetEnvironment(simulator)
      let attributes = try FileManager.default.attributesOfItem(atPath: result.path)
      let protection = (attributes[.protectionKey] as? FileProtectionType)?.rawValue
        ?? attributes[.protectionKey] as? String
      XCTAssertEqual(protection, FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
    #endif
  }

  func testChangedCiphertextIsRemovedBeforeItCanBeScheduled() throws {
    let (source, cipher) = try staged()
    defer { try? FileManager.default.removeItem(at: source.deletingLastPathComponent().deletingLastPathComponent()) }
    for (bytes, digest, header) in [
      (cipher.count - 1, cipher.digest, cipher.prefix(24).b64),
      (cipher.count, Data("changed".utf8).digest, cipher.prefix(24).b64),
      (cipher.count, cipher.digest, Data(repeating: 0, count: 24).b64),
    ] {
      let result = destination()
      XCTAssertThrowsError(try BackgroundCiphertext.prepare(
        source: source, pendingDirectory: source.deletingLastPathComponent(), destination: result,
        bytes: bytes, sha256: digest, header: header))
      XCTAssertFalse(FileManager.default.fileExists(atPath: result.path))
    }
  }

  func testExternalOrDecryptedMediaPathCannotBecomeBackgroundBody() throws {
    let (source, cipher) = try staged()
    let allowed = source.deletingLastPathComponent()
    let result = destination()
    let plain = allowed.appendingPathComponent("original.jpg")
    let link = allowed.appendingPathComponent("external.bin")
    let external = destination()
    defer {
      try? FileManager.default.removeItem(at: allowed.deletingLastPathComponent())
      try? FileManager.default.removeItem(at: external)
      try? FileManager.default.removeItem(at: result)
    }
    try cipher.write(to: plain)
    try cipher.write(to: external)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: external)
    for invalid in [plain, external, link] {
      XCTAssertThrowsError(try BackgroundCiphertext.prepare(
        source: invalid, pendingDirectory: allowed, destination: result,
        bytes: cipher.count, sha256: cipher.digest, header: cipher.prefix(24).b64))
      XCTAssertFalse(FileManager.default.fileExists(atPath: result.path))
    }
  }

  @MainActor func testForegroundAPIRejectsForeignOriginBeforeSendingAccountCredential() async throws {
    let session = AccountSession()
    session.fixture = false
    session.bearerToken = "test-token"
    let api = APIClient(session: session, baseURL: URL(string: "https://fotoro.cloud")!)
    do {
      _ = try await api.request("https://foreign.example/v1/photos")
      XCTFail("Foreign origins cannot receive the request")
    } catch { XCTAssertEqual(error.localizedDescription, "Untrusted API URL") }
  }
}
