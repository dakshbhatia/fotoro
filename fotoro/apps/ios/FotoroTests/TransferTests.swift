import XCTest

@testable import Fotoro

final class TransferTests: XCTestCase {
  @MainActor func testJournalRestartAndTransactionalCursor() async throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let s = try AppServices(root: path)
    try await s.fixtureUnlock(index: 0)
    let importer = s.importer
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    let photo = try await importer.build(
      bytes: Data(contentsOf: url), filename: "singapore.jpg", accountId: s.session.accountId!,
      bundle: s.vault.requireBundle())
    try s.journal.enqueue(photo)
    try s.journal.enqueue(photo)
    let restarted = TransferJournal(store: s.store, api: s.api, vault: s.vault)
    XCTAssertEqual(try restarted.entries().count, 1)
    await restarted.resumePending()
    XCTAssertTrue(restarted.errors.isEmpty, "\(restarted.errors)")
    XCTAssertTrue(try restarted.entries().isEmpty)
    let committed = try s.store.photos().first { $0.photoId == photo.photoId }
    XCTAssertEqual(committed?.transferState, "committed")
    let before = try s.store.cursor()
    let page = ChangePageV1(
      version: 1,
      changes: [
        ChangeV1(
          cursor: "invalid", entity: "photo", entityId: Wire.id(), deleted: false, payload: nil)
      ], nextCursor: "invalid", hasMore: false)
    XCTAssertThrowsError(try s.store.apply(page, verified: [:]))
    XCTAssertEqual(try s.store.cursor(), before)
  }
  @MainActor func testAmbiguousCommitReconcilesWithoutStagedSource() async throws {
    let s = try AppServices(
      root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try await s.fixtureUnlock(index: 0)
    let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")!
    let photo = try await s.importer.build(
      bytes: Data(contentsOf: url), filename: "singapore.jpg", accountId: s.session.accountId!,
      bundle: s.vault.requireBundle())
    try s.journal.enqueue(photo)
    var entry = try XCTUnwrap(s.journal.entries().first)
    let rep = photo.manifest.representations[0]
    let id = rep.binding.representationId
    let reservation: UploadReservationV1 = try await s.api.post(
      "/v1/uploads/reserve",
      ReserveUploadV1(
        binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
        ciphertextSha256: rep.ciphertextSha256, operationId: id))
    entry.reservations[id] = reservation
    try s.journal.persist(entry)
    let staged = try XCTUnwrap(photo.staged[id])
    try await s.api.upload(Data(contentsOf: staged), to: reservation.stagingUrl)
    let commit = try await s.api.commit(reservation.uploadId)
    // Emulate process death after the server commits but before the local commit receipt persists.
    try FileManager.default.removeItem(at: staged)
    let restarted = TransferJournal(store: s.store, api: s.api, vault: s.vault)
    await restarted.resumePending()
    XCTAssertTrue(restarted.errors.isEmpty, "\(restarted.errors)")
    XCTAssertTrue(try restarted.entries().isEmpty)
    let restored = try XCTUnwrap(s.store.photos().first { $0.photoId == photo.photoId })
    XCTAssertEqual(restored.manifest.representations[0].objectId, commit.objectId)
    XCTAssertEqual(restored.metadata.originalSha256, photo.metadata.originalSha256)
  }

}
