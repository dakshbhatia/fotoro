import XCTest

@testable import Fotoro

final class ExchangeTests: XCTestCase {
  @MainActor func testReceiveSaveContributeAndLock() async throws {
    let sender = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let recipient = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try await sender.fixtureUnlock(index: 0)
    try await recipient.fixtureUnlock(index: 1)
    let photo = try XCTUnwrap(sender.photos.first)
    let grant = try await sender.share(
      [photo], recipient: recipient.session.requireCard(recipient.session.accountId!),
      temporary: false)
    try await recipient.receive(grant)
    let received = try XCTUnwrap(recipient.received.first)
    XCTAssertEqual(received.metadata.originalSha256, photo.metadata.originalSha256)
    XCTAssertNil(received.originalURL)
    try await recipient.save(received)
    let saved = try XCTUnwrap(
      recipient.photos.first { $0.manifest.ownerAccountId == recipient.session.accountId })
    XCTAssertEqual(saved.metadata.originalSha256, photo.metadata.originalSha256)
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    try await recipient.importFiles([url])
    await recipient.journal.resumePending()
    try recipient.reload()
    let contribution = try XCTUnwrap(recipient.photos.first { $0.transferState == "committed" })
    try await recipient.contribute([saved, contribution])
    try await sender.receive(grant)
    XCTAssertTrue(sender.received.contains { $0.photoId == contribution.photoId })
    XCTAssertTrue(sender.received.contains { $0.photoId == saved.photoId })
    let reshare = try await recipient.share(
      [saved], recipient: sender.session.requireCard(sender.session.accountId!), temporary: false)
    try await sender.receive(reshare)
    XCTAssertEqual(sender.received.first?.metadata.originalSha256, saved.metadata.originalSha256)
    _ = try await sender.api.request("/v1/grants/\(grant.grantId)", method: "DELETE")
    try await recipient.sync()
    XCTAssertTrue(recipient.photos.contains { $0.photoId == saved.photoId })
    try recipient.store.apply(
      ChangePageV1(
        version: 1,
        changes: [
          ChangeV1(
            cursor: "receipt-lost", entity: "photo", entityId: saved.photoId, deleted: true,
            payload: nil)
        ], nextCursor: nil, hasMore: false))
    try recipient.reload()
    XCTAssertFalse(recipient.photos.contains { $0.photoId == saved.photoId })
    try await recipient.resumeSaves()
    XCTAssertTrue(recipient.photos.contains { $0.photoId == saved.photoId })
    recipient.vault.lock()
    XCTAssertTrue(recipient.photos.isEmpty)
    XCTAssertFalse(recipient.vault.isUnlocked)
    try await recipient.vault.unlock(.localKeychain)
    try recipient.reload()
    XCTAssertFalse(recipient.photos.isEmpty)
    do {
      try await recipient.vault.unlock(
        .prf(output: Data(), wrapper: photo.manifest.ownerWrappedMetadataKey))
      XCTFail("Absent PRF accepted")
    } catch {}
  }
}
