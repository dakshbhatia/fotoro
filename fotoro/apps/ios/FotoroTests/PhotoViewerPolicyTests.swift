import XCTest
import Nuke
import UIKit

@testable import Fotoro

final class PhotoViewerPolicyTests: XCTestCase {
  func testRetainedTagRemovalUsesLatestLabelsAfterIncomingShrinkAndReorder() {
    let cases: [(incoming: [String], expected: [String], writes: Int)] = [
      (["B"], [], 1),
      (["new", "A", "B"], ["new", "A"], 1),
      (["B", "A"], ["A"], 1),
      (["new", "A"], ["new", "A"], 0),
      ([], [], 0),
    ]
    for scenario in cases {
      var labels = ["A", "B"]
      var writes = 0
      let removeRenderedB = {
        PhotoTagEdits.remove("B", current: { labels }) { labels = $0; writes += 1 }
      }
      labels = scenario.incoming
      removeRenderedB()
      XCTAssertEqual(labels, scenario.expected, "A retained row action must remove its named tag from current labels")
      XCTAssertEqual(writes, scenario.writes, "An already-removed tag must not create another annotation edit")
    }
  }

  func testRapidRetainedTagRemovalsPreserveAnUnrelatedIncomingTag() {
    var labels = ["A", "B"]
    var writes: [[String]] = []
    func removal(_ renderedTag: String) -> () -> Void {
      { PhotoTagEdits.remove(renderedTag, current: { labels }) { labels = $0; writes.append($0) } }
    }
    let removeA = removal("A"), removeB = removal("B")
    labels = ["new", "A", "B"]
    removeA()
    removeB()
    removeB()
    XCTAssertEqual(labels, ["new"])
    XCTAssertEqual(writes, [["new", "B"], ["new"]],
      "Rapid actions must merge into current labels without dropping incoming tags or repeating an absent edit")
  }

  @MainActor func testOversizedCachedRenditionsDecodeWithinViewerPixelBudget() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var configuration = ImagePipeline.Configuration()
    configuration.imageCache = nil
    let pipeline = ImagePipeline(configuration: configuration)
    for (index, size) in [CGSize(width: 3000, height: 2000), CGSize(width: 2000, height: 3000)].enumerated() {
      let data = autoreleasepool {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.8) { context in
          UIColor.systemBlue.setFill(); context.fill(CGRect(origin: .zero, size: size))
        }
      }
      let url = root.appendingPathComponent("public-large-rendition-\(index).jpg")
      try data.write(to: url)
      var photo = fixturePhoto(); photo.previewURL = url
      let request = try XCTUnwrap(SavedPhotoViewerPagePolicy.previewRequest(photo, fallback: photo))
      let image = try await pipeline.image(for: request)
      let decoded = try XCTUnwrap(image.cgImage)
      XCTAssertEqual(max(decoded.width, decoded.height), 1600,
        "A large cached rendition must be downsampled during decode, before SwiftUI displays it")
      XCTAssertEqual(try Data(contentsOf: url), data, "Viewing must not rewrite the cached source")
    }
  }

  func testViewerWaitsForBoundedRenditionsAndNeverFallsBackToOriginal() {
    let original = URL(fileURLWithPath: "/public-fixture/original-48mp.heic")
    let thumbnail = URL(fileURLWithPath: "/public-fixture/thumbnail-320.jpg")
    let preview = URL(fileURLWithPath: "/public-fixture/preview-1600.jpg")
    var photo = fixturePhoto()
    photo.originalURL = original
    XCTAssertNil(SavedPhotoViewerPagePolicy.previewURL(photo, fallback: photo))
    photo.thumbnailURL = thumbnail
    XCTAssertEqual(SavedPhotoViewerPagePolicy.previewURL(photo, fallback: photo), thumbnail)
    var hydrated = photo; hydrated.previewURL = preview
    XCTAssertEqual(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: photo), preview)
    hydrated.previewURL = original
    XCTAssertEqual(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: photo), thumbnail,
      "A mislabeled preview must not send the full original to the image decoder")
    hydrated.thumbnailURL = original
    XCTAssertEqual(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: photo), thumbnail)
    var unrelated = photo; unrelated.photoId = "other-photo"
    hydrated.previewURL = nil
    XCTAssertNil(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: unrelated),
      "Another photo's thumbnail cannot become this page's preview")
    var replaced = photo; replaced.metadata.originalSha256 = "replacement-original"
    XCTAssertNil(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: replaced),
      "A reused photo ID cannot admit another original's thumbnail")
    var changedManifest = photo; changedManifest.manifest.metadataRepresentation.ciphertextSha256 = "replacement-metadata"
    XCTAssertNil(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: changedManifest),
      "A changed manifest cannot supply the prior page's fallback")
    hydrated.previewURL = preview
    XCTAssertEqual(SavedPhotoViewerPagePolicy.previewURL(hydrated, fallback: replaced), preview,
      "Rejecting a mismatched fallback does not hide the current page's own rendition")
  }

  private func fixturePhoto() -> LocalPhoto {
    let id = "public-fixture-photo"
    let rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: "metadata", kind: "metadata"),
      objectId: "object", header: "", ciphertextBytes: 1, ciphertextSha256: "cipher")
    return LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: "public-fixture",
      representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")),
      metadata: PhotoMetadataV1(filename: "Public fixture.heic", mediaType: "image/heic", sourceDate: "2026-10-15T00:00:00Z",
        dateSource: "photos", originalBytes: 40_000_000, originalSha256: "original", representationKeys: [:]), transferState: "committed")
  }

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
