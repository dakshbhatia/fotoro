import XCTest

@testable import Fotoro

final class PhotoCleanupTests: XCTestCase {
  private let flat = AutomaticPhotoPickSignals(hash: 0, luminance: 1, contrast: 0, sharpness: 0, color: [255, 255, 255])
  private func photo(_ id: String, favorite: Bool = false, screenshot: Bool = false, eligible: Bool = true) -> PhotoCleanupCandidate {
    PhotoCleanupCandidate(id: id, digest: "public-fixture", favorite: favorite, screenshot: screenshot, eligible: eligible)
  }
  func testTrashedOrWithdrawnKeeperCannotImplyAnotherRetainedCopy() {
    let signals = ["keeper": flat, "other": flat]
    let initial = PhotoCleanupPolicy.review([photo("keeper"), photo("other")], signals: signals)
    XCTAssertEqual(initial.reasons["other"], ["Identical original · keep another copy", "Possibly too dark or bright"])
    let latest = PhotoCleanupPolicy.review([photo("keeper", eligible: false), photo("other")], signals: signals)
    XCTAssertNil(latest.reasons["keeper"])
    XCTAssertEqual(latest.reasons["other"], ["Possibly too dark or bright"])
    XCTAssertEqual(latest.unassessed, 0)
  }
  func testCurrentFavoritesAndScreenshotCorrectionsApplyToExistingMeasurements() {
    let signals = ["keeper": flat, "other": flat]
    let favorite = PhotoCleanupPolicy.review([photo("keeper"), photo("other", favorite: true)], signals: signals)
    XCTAssertNil(favorite.reasons["other"])
    XCTAssertEqual(favorite.reasons["keeper"], ["Identical original · keep another copy", "Possibly too dark or bright"])
    XCTAssertTrue(PhotoCleanupPolicy.review([photo("other", screenshot: true)], signals: signals).reasons.isEmpty)
    XCTAssertEqual(PhotoCleanupPolicy.review([photo("other")], signals: signals).reasons["other"], ["Possibly too dark or bright"])
  }
  func testPublishedSourceProjectionRejectsChangedOwnershipAndExactMediaIdentity() {
    let binding = MediaBinding(photoId: "other", representationId: "fixture", kind: "metadata")
    let representation = RepresentationV1(binding: binding, objectId: "object", header: "header", ciphertextBytes: 1, ciphertextSha256: "cipher")
    let metadata = PhotoMetadataV1(filename: "fixture.jpg", mediaType: "image/jpeg", sourceDate: "2026-10-01", dateSource: "photos",
      originalBytes: 1, originalSha256: "public-fixture", representationKeys: [:])
    let manifest = PhotoManifestV1(photoId: "other", ownerAccountId: "owner", representations: [], metadataRepresentation: representation,
      ownerWrappedMetadataKey: WrappedKeyV1(nonce: "fixture", ciphertext: "fixture"))
    let expected = PhotoCleanupSourceIdentity(id: "other", metadata: metadata, manifest: manifest, transferState: "committed")
    XCTAssertTrue(expected.matches(expected, account: "owner"))
    var changedMetadata = expected
    changedMetadata.metadata.filename = "replacement.jpg"
    var changedManifest = expected
    changedManifest.manifest.metadataRepresentation.objectId = "replacement"
    var changedOwner = expected
    changedOwner.manifest.ownerAccountId = "different"
    var changedID = expected
    changedID.manifest.photoId = "different"
    var pending = expected
    pending.transferState = "pending"
    for loaded in [nil, changedMetadata, changedManifest, changedOwner, changedID, pending] {
      let eligible = expected.matches(loaded, account: "owner")
      let result = PhotoCleanupPolicy.review([photo("other", eligible: eligible)], signals: ["other": flat])
      XCTAssertTrue(result.reasons.isEmpty)
      XCTAssertEqual(result.unassessed, 0)
    }
    XCTAssertFalse(expected.matches(expected, account: "different"))
  }
  func testUnavailableAndInvalidMeasurementsRemainUnjudged() {
    for signals in [[:], ["other": AutomaticPhotoPickSignals(hash: 0, luminance: .nan, contrast: 0, sharpness: 0, color: [255,255,255])]] {
      let result = PhotoCleanupPolicy.review([photo("other"), photo("denied", eligible: false)], signals: signals)
      XCTAssertTrue(result.reasons.isEmpty)
      XCTAssertEqual(result.unassessed, 1)
    }
  }
  private func journalSource(_ id: String) -> PhotoCleanupJournalRecord.Source {
    let binding = MediaBinding(photoId: id, representationId: "fixture", kind: "metadata")
    let representation = RepresentationV1(binding: binding, objectId: "object-" + id, header: "header", ciphertextBytes: 1, ciphertextSha256: "cipher")
    let metadata = PhotoMetadataV1(filename: "private-fixture.jpg", mediaType: "image/jpeg", sourceDate: "2026-10-01", dateSource: "photos",
      originalBytes: 1, originalSha256: "digest-" + id, representationKeys: [:])
    let manifest = PhotoManifestV1(photoId: id, ownerAccountId: "owner", representations: [], metadataRepresentation: representation,
      ownerWrappedMetadataKey: WrappedKeyV1(nonce: "fixture", ciphertext: "fixture"))
    return .init(id: id, metadata: metadata, manifest: manifest, transferState: "committed")
  }
  func testCleanupCheckpointRestoresOrderedCursorAndMeasurementsWithoutInventingMissingCoverage() throws {
    let sources = [journalSource("a"), journalSource("b"), journalSource("c")]
    let record = PhotoCleanupJournalRecord(account: "owner", origin: "https://one.test", sources: sources,
      completed: 2, signals: ["a": .init(flat)])
    let decoded = try JSONDecoder().decode(PhotoCleanupJournalRecord.self, from: JSONEncoder().encode(record))
    let restored = try XCTUnwrap(decoded.restored(current: sources.reversed(), retired: [], account: "owner", origin: "https://one.test"))
    XCTAssertEqual(restored.sources.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(restored.completed, 2)
    XCTAssertEqual(Set(restored.signals.keys), ["a"])
    XCTAssertEqual(PhotoCleanupPolicy.review([photo("a"), photo("b")], signals: restored.signals).unassessed, 1)
  }
  func testCleanupCheckpointRetiresOnlyVerifiedTrashedMembersAndRejectsMissingChangedOrNewScope() throws {
    let sources = [journalSource("a"), journalSource("b"), journalSource("c")]
    let record = PhotoCleanupJournalRecord(account: "owner", origin: "https://one.test", sources: sources,
      completed: 2, signals: ["a": .init(flat), "b": .init(flat)])
    let remaining = Array(sources.dropFirst())
    let restored = try XCTUnwrap(record.restored(current: remaining, retired: [sources[0]], account: "owner", origin: "https://one.test"))
    XCTAssertEqual(restored.completed, 1)
    XCTAssertEqual(Set(restored.signals.keys), ["b"])
    XCTAssertNil(record.restored(current: remaining, retired: [], account: "owner", origin: "https://one.test"))
    var replacement = sources[0]; replacement.metadata.originalSha256 = "changed"
    XCTAssertNil(record.restored(current: remaining, retired: [replacement], account: "owner", origin: "https://one.test"))
    XCTAssertNil(record.restored(current: remaining + [journalSource("d")], retired: [sources[0]], account: "owner", origin: "https://one.test"))
    XCTAssertNil(record.restored(current: sources, retired: [], account: "other", origin: "https://one.test"))
    XCTAssertNil(record.restored(current: sources, retired: [], account: "owner", origin: "https://other.test"))
  }
  func testPausedCleanupCheckpointKeepsExactNonBatchCursorAndRejectsInvalidMeasurements() throws {
    let sources = (0..<50).map { journalSource(String($0)) }
    var record = PhotoCleanupJournalRecord(account: "owner", origin: "origin", sources: sources, completed: 40,
      signals: Dictionary(uniqueKeysWithValues: sources.prefix(40).map { ($0.id, .init(flat)) }))
    XCTAssertEqual(record.restored(current: sources, retired: [], account: "owner", origin: "origin")?.completed, 40)
    record.signals["0"]?.luminance = .nan
    XCTAssertNil(record.restored(current: sources, retired: [], account: "owner", origin: "origin"))
    record.signals = [:]; record.completed = 51
    XCTAssertNil(record.restored(current: sources, retired: [], account: "owner", origin: "origin"))
  }

}
