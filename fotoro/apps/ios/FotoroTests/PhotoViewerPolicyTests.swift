import XCTest

@testable import Fotoro

final class PhotoViewerPolicyTests: XCTestCase {
  func testLargeViewerOnlyAdmitsSelectedPhotoAndAdjacentPages() {
    let ids = (0..<100_000).map { "photo-\($0)" }
    XCTAssertEqual(SavedPhotoViewerPagePolicy.loadedIDs(ids, selected: "photo-50000"),
      Set(["photo-49999", "photo-50000", "photo-50001"]))
    XCTAssertEqual(SavedPhotoViewerPagePolicy.loadedIDs(ids, selected: "photo-0"),
      Set(["photo-0", "photo-1"]))
    XCTAssertEqual(SavedPhotoViewerPagePolicy.loadedIDs(ids, selected: "photo-99999"),
      Set(["photo-99998", "photo-99999"]))
  }

  func testReorderedSnapshotFollowsStableSelectedIdentityAndWithdrawalAdmitsNothing() {
    let initial = ["a", "b", "c", "d", "e"]
    XCTAssertEqual(SavedPhotoViewerPagePolicy.loadedIDs(initial, selected: "c"), Set(["b", "c", "d"]))
    let reordered = ["c", "e", "a", "b", "d"]
    XCTAssertEqual(SavedPhotoViewerPagePolicy.loadedIDs(reordered, selected: "c"), Set(["c", "e"]))
    XCTAssertTrue(SavedPhotoViewerPagePolicy.loadedIDs(["a", "b", "d", "e"], selected: "c").isEmpty)
    XCTAssertTrue(SavedPhotoViewerPagePolicy.loadedIDs([], selected: "c").isEmpty)
  }

  func testCompletedOriginalIdentitySurvivesMetadataPresentationEditsButChangesWithOriginalResources() {
    let original = PhotoMetadataV1(filename: "first.jpg", mediaType: "image/jpeg", sourceDate: "2026-10-01",
      dateSource: "photos", originalBytes: 1234, originalSha256: "exact-original", representationKeys: [:])
    let identity = SavedPhotoViewerPagePolicy.originalIdentity(original)
    var renamed = original
    renamed.filename = "renamed.jpg"; renamed.sourceDate = "2026-10-02"; renamed.dateSource = "exif"
    XCTAssertEqual(SavedPhotoViewerPagePolicy.originalIdentity(renamed), identity)
    var replaced = original
    replaced.originalSha256 = "replacement"
    XCTAssertNotEqual(SavedPhotoViewerPagePolicy.originalIdentity(replaced), identity)
    replaced = original; replaced.originalBytes += 1
    XCTAssertNotEqual(SavedPhotoViewerPagePolicy.originalIdentity(replaced), identity)
    replaced = original; replaced.mediaType = "video/quicktime"
    XCTAssertNotEqual(SavedPhotoViewerPagePolicy.originalIdentity(replaced), identity)
  }

}
