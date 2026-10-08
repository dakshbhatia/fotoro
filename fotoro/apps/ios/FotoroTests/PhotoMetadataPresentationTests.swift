import XCTest
@testable import Fotoro

final class PhotoMetadataPresentationTests: XCTestCase {
  func testEditedPhotoDimensionsStayDistinctFromTheOriginal() {
    let metadata = PhotoCaptureMetadata(items: [
      .init(k: "width", p: .original, v: "4032"), .init(k: "height", p: .original, v: "3024"),
      .init(k: "width", p: .photos, v: "1080"), .init(k: "height", p: .photos, v: "1080")])
    let result = PhotoMetadataPresentation(metadata)
    XCTAssertEqual(result.media.first?.value, "1080 × 1080 px")
    XCTAssertEqual(result.media.first?.provenance, .photos)
    XCTAssertEqual(result.details.first?.value, "4032 × 3024 px")
    XCTAssertEqual(result.details.first?.provenance, .original)
    XCTAssertEqual(result.media.count, 1)
  }

  func testSameMeasurementsAndFormatDoNotRepeatInInfo() {
    let metadata = PhotoCaptureMetadata(items: [.init(k: "width", p: .photos, v: "4032"),
      .init(k: "height", p: .photos, v: "3024"), .init(k: "width", p: .original, v: "4032"),
      .init(k: "height", p: .original, v: "3024"), .init(k: "contentType", p: .photos, v: "public.heic"),
      .init(k: "contentType", p: .original, v: "public.heic")])
    let result = PhotoMetadataPresentation(metadata)
    XCTAssertEqual(result.media.map(\.value), ["4032 × 3024 px", "HEIC"])
    XCTAssertTrue(result.details.isEmpty)
  }

  func testTechnicalFactsBecomeReadableDetailsWithoutInventingPeople() {
    let metadata = PhotoCaptureMetadata(items: [.init(k: "subtypes", p: .photos, v: "hdr,livePhoto"),
      .init(k: "sourceTypes", p: .photos, v: "userLibrary"),
      .init(k: "exposureSeconds", p: .original, v: "0.008"),
      .init(k: "cameraModel", p: .original, v: "iPhone"),
      .init(k: "peopleCount", p: .photos, v: "4")])
    let result = PhotoMetadataPresentation(metadata)
    XCTAssertEqual(result.media.map(\.value), ["HDR · Live Photo"])
    XCTAssertEqual(result.camera.map(\.value), ["iPhone"])
    XCTAssertEqual(result.details.map(\.value), ["1/125 s", "Your library"])
    XCTAssertFalse((result.media + result.camera + result.details).contains { $0.title.contains("People") })
  }

  func testMissingAndInvalidEvidenceStaysAbsent() {
    let result = PhotoMetadataPresentation(PhotoCaptureMetadata(items: [
      .init(k: "width", p: .photos, v: "0"), .init(k: "height", p: .photos, v: "1080"),
      .init(k: "cameraModel", p: .photos, v: "Guessed camera"),
      .init(k: "iso", p: .original, v: "unknown")]))
    XCTAssertTrue(result.media.isEmpty)
    XCTAssertTrue(result.camera.isEmpty)
    XCTAssertTrue(result.details.isEmpty)
  }

  func testSubNanosecondExposureCannotOverflowFormatting() {
    let result = PhotoMetadataPresentation(PhotoCaptureMetadata(items: [
      .init(k: "exposureSeconds", p: .original, v: "0.0000000000000000000000000001")]))
    XCTAssertEqual(result.details.count, 1)
    XCTAssertTrue(result.details[0].value.hasSuffix(" s"))
  }
}
