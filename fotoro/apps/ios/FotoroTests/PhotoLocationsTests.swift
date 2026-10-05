import CoreLocation
import ImageIO
import XCTest

@testable import Fotoro

final class PhotoLocationsTests: XCTestCase {
  private let location = PhotoLocationV1(latitude: 40.7128, longitude: -74.006,
    source: "photos", name: "  My place  ", accuracyMeters: 12)

  func testFactRoundTripPreservesUserWordsAndFitsReleasedAnnotationLimits() throws {
    let facts = try XCTUnwrap(PhotoLocationFacts.replacing(in: ["  User’s exact words  ", "screenshot"], with: location))
    XCTAssertEqual(Array(facts.prefix(2)), ["  User’s exact words  ", "screenshot"])
    XCTAssertEqual(PhotoLocationFacts.read(facts), location)
    XCTAssertTrue(facts.allSatisfy { $0.unicodeScalars.count <= 240 })
    XCTAssertEqual(try PhotoLocationFacts.replacing(in: facts, with: nil), ["  User’s exact words  ", "screenshot"])
  }
  func testCapacityRefusesToDeleteOrTruncateUserFacts() throws {
    let original = (0..<63).map { "Fact \($0)" }
    XCTAssertThrowsError(try PhotoLocationFacts.replacing(in: original, with: location))
    var coordinatesOnly = location
    coordinatesOnly.name = nil
    XCTAssertEqual(try PhotoLocationFacts.replacing(in: original, with: coordinatesOnly)?.count, 64)
  }
  func testMalformedAmbiguousAndInvalidCoordinatesHaveNoPlace() throws {
    let valid = try XCTUnwrap(PhotoLocationFacts.replacing(in: nil, with: location))
    let invalidJSON = [
      #"{"latitude":91,"longitude":0,"source":"exif"}"#,
      #"{"latitude":0,"longitude":181,"source":"exif"}"#,
      #"{"latitude":true,"longitude":0,"source":"photos"}"#,
      #"{"latitude":0,"longitude":0,"source":"live-tracking"}"#,
      #"{"latitude":0,"longitude":0,"source":"exif","accuracyMeters":-1}"#,
      #"{"latitude":0,"longitude":0,"source":"exif","accuracyMeters":100001}"#,
      #"{"latitude":0,"longitude":0,"source":"exif","name":"invented"}"#,
      #"{"latitude":0,"latitude":1,"longitude":0,"source":"exif"}"#,
      #"{"latitude":0,"\u006catitude":1,"longitude":0,"source":"exif"}"#,
    ]
    for json in invalidJSON { XCTAssertNil(PhotoLocationFacts.read([PhotoLocationFacts.coordinatePrefix + json]), json) }
    XCTAssertNil(PhotoLocationFacts.read(valid + [valid[0]]))
    XCTAssertNil(PhotoLocationFacts.read(valid + [PhotoLocationFacts.placePrefix + "other"]))
    XCTAssertNil(PhotoLocationFacts.read([PhotoLocationFacts.placePrefix + "name only"]))
    var invalid = location
    invalid.latitude = .infinity
    XCTAssertThrowsError(try PhotoLocationFacts.replacing(in: nil, with: invalid))
  }
  func testExifHemispheresAndPhotosProvenanceAreFactual() throws {
    let gps: [String: Any] = [kCGImagePropertyGPSLatitude as String: 33.9,
      kCGImagePropertyGPSLatitudeRef as String: "S", kCGImagePropertyGPSLongitude as String: 151.2,
      kCGImagePropertyGPSLongitudeRef as String: "E"]
    XCTAssertEqual(PhotoLocationV1.exif(gps: gps), PhotoLocationV1(latitude: -33.9, longitude: 151.2, source: "exif"))
    var missingRef = gps
    missingRef.removeValue(forKey: kCGImagePropertyGPSLongitudeRef as String)
    XCTAssertNil(PhotoLocationV1.exif(gps: missingRef))
    XCTAssertEqual(PhotoLocationV1.photos(CLLocation(latitude: 40, longitude: -74))?.source, "photos")
    XCTAssertNil(PhotoLocationV1.photos(CLLocation(latitude: 100, longitude: -74)))
  }
  func testPlacesKeepCurrentRevisionSortDatesAndRejectInvalidGPS() {
    let early = PhotoPlaceItem(reference: .device("a"), revision: "1", capturedAt: Date(timeIntervalSince1970: 1), location: location)
    var current = early
    current.revision = "2"
    current.capturedAt = Date(timeIntervalSince1970: 3)
    let middle = PhotoPlaceItem(reference: .device("b"), revision: "1", capturedAt: Date(timeIntervalSince1970: 2), location: location)
    let undated = PhotoPlaceItem(reference: .device("c"), revision: "1", location: location)
    var invalid = undated
    invalid.reference = .device("invalid")
    invalid.location.longitude = .nan
    let result = PhotoPlacesPolicy.ordered([early, middle, undated, invalid, current])
    XCTAssertEqual(result.map(\.id), ["device:a", "device:b", "device:c"])
    XCTAssertEqual(result.first?.revision, "2")
  }
}
