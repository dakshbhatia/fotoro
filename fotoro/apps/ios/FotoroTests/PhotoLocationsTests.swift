import CoreLocation
import ImageIO
import XCTest

@testable import Fotoro

final class PhotoLocationsTests: XCTestCase {
  func testSuggestedNamesUseDistinctUsefulTagsAndRemainApplicable() {
    let date = ISO8601DateFormatter().date(from: "2018-02-03T23:50:00Z")
    XCTAssertEqual(PhotoOrganizationFacts.suggestedName(original: "IMG.JPG", digest: String(repeating: "00", count: 32),
      capturedAt: date, labels: ["seoul", "", "BTS", "BTS", "Family"], place: "Seoul", screenshot: false),
      "2018-02-03_Seoul_BTS_Family_0000000000.jpg")
    let reserved = PhotoOrganizationFacts.suggestedName(original: "IMG.JPG", digest: nil,
      capturedAt: nil, labels: ["CON"], place: nil, screenshot: false)
    XCTAssertEqual(reserved, "Photo_CON.jpg")
    XCTAssertTrue(PhotoOrganizationFacts.validName(reserved))
    XCTAssertEqual(PhotoOrganizationFacts.suggestedName(original: "IMG.JPG", digest: nil,
      capturedAt: Date(timeIntervalSince1970: .infinity), labels: [], place: nil, screenshot: false), "Photo.jpg")
  }
  func testOrganizationNamesMatchWebAndTrashRestoresWithoutDestroyingWords() throws {
    let digest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    let date = try XCTUnwrap(ISO8601DateFormatter().date(from: "2018-02-03T23:50:00Z"))
    XCTAssertEqual(PhotoOrganizationFacts.suggestedName(original: "IMG_0001.JPG", digest: digest,
      capturedAt: date, labels: ["BTS", "Family  trip"], place: "Seoul", screenshot: false), "2018-02-03_Seoul_BTS_Family-trip_0000000000.jpg")
    var facts = try PhotoOrganizationFacts.replacing(["My EXACT words", "fotoro.future.v2:keep"], change: .name("BTS at Grandma’s.jpg"))
    facts = try PhotoOrganizationFacts.replacing(facts, change: .trash(true))
    facts = try PhotoOrganizationFacts.replacing(facts, change: .screenshot(true))
    XCTAssertTrue(PhotoOrganizationFacts.trashed(facts))
    XCTAssertEqual(try PhotoOrganizationFacts.replacing(facts, change: .trash(true)), facts)
    facts = try PhotoOrganizationFacts.replacing(facts, change: .trash(false))
    XCTAssertFalse(PhotoOrganizationFacts.trashed(facts))
    XCTAssertEqual(PhotoOrganizationFacts.name(facts, original: "IMG.JPG"), "BTS at Grandma’s.jpg")
    XCTAssertTrue(PhotoOrganizationFacts.screenshot(facts))
    XCTAssertEqual(Array(facts.prefix(2)), ["My EXACT words", "fotoro.future.v2:keep"])
    for name in ["../a.jpg", "a/b.jpg", "a\\b.jpg", "CON.jpg", "a?.jpg", " a.jpg", "a.jpg."] {
      XCTAssertFalse(PhotoOrganizationFacts.validName(name), name)
      XCTAssertThrowsError(try PhotoOrganizationFacts.replacing(nil, change: .name(name)))
    }
    XCTAssertThrowsError(try PhotoOrganizationFacts.replacing((0..<64).map { "fact \($0)" }, change: .trash(true)))
  }

  func testPlacePresentationKeepsCoordinatesForAnExplicitMapAction() throws {
    let location = PhotoLocationV1(latitude: 37.5665, longitude: 126.978, source: "photos")
    XCTAssertEqual(location.displayName, "Location on map")
    let url = try XCTUnwrap(location.mapURL)
    let parts = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    XCTAssertEqual(parts.host, "maps.apple.com")
    XCTAssertEqual(parts.queryItems?.map(\.name), ["ll", "q"])
    XCTAssertEqual(parts.queryItems?.first?.value, "37.5665,126.978")
    XCTAssertNil(PhotoLocationV1(latitude: 91, longitude: 0, source: "photos").mapURL)
    XCTAssertEqual(PhotoLocationV1(latitude: 37, longitude: 126, source: "photos", name: "Grandma’s house").displayName, "Grandma’s house")
  }

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
