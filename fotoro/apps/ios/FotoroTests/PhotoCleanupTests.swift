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
}
