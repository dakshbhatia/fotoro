import CoreLocation
import ImageIO
import XCTest

@testable import Fotoro

final class PhotoLocationsTests: XCTestCase {
  func testNameDraftFollowsUntouchedNamesButKeepsTypingAcrossIncomingCorrections() {
    var draft = PhotoNameDraft(savedName: "IMG_4826.jpg")
    draft.receive("Receipt.jpg")
    XCTAssertEqual(draft.value, "Receipt.jpg")
    draft.edit("  My receipt draft.jpg ")
    draft.receive("Reviewed receipt.jpg")
    draft.receive("Final receipt.jpg")
    XCTAssertEqual(draft.value, "  My receipt draft.jpg ", "Typing is preserved verbatim, including unfinished formatting")
    XCTAssertEqual(draft.savedName, "Final receipt.jpg")
    XCTAssertTrue(draft.savedNameChanged)
    draft.edit("Final receipt.jpg")
    XCTAssertFalse(draft.savedNameChanged)
    draft.receive("Another receipt.jpg")
    XCTAssertEqual(draft.value, "Another receipt.jpg")
  }

  func testSuccessfulNameResetResolvesDraftWhileUnrelatedAnnotationKeepsIt() {
    var draft = PhotoNameDraft(savedName: "Receipt.jpg")
    draft.edit("Uncommitted name.jpg")
    draft.receive("Receipt.jpg") // Screenshot/Trash edits do not change the name.
    XCTAssertEqual(draft.value, "Uncommitted name.jpg")
    draft.acknowledge("IMG_4826.jpg") // Successful explicit Use original name.
    XCTAssertEqual(draft.value, "IMG_4826.jpg")
    XCTAssertEqual(draft.savedName, "IMG_4826.jpg")
    XCTAssertFalse(draft.savedNameChanged)
    draft.edit("Another unfinished name.jpg")
    draft.receive("Remote.jpg")
    draft.acknowledge(draft.savedName) // Explicit Use saved name.
    XCTAssertEqual(draft.value, "Remote.jpg")
    XCTAssertFalse(draft.savedNameChanged)
  }

  func testNoNamingEvidenceKeepsOriginalFilenameEvenWithDigest() {
    XCTAssertEqual(PhotoOrganizationFacts.suggestedName(original: "Singapore Holiday.JPG", digest: String(repeating: "ab", count: 32),
      capturedAt: nil, labels: ["", "!!!"], place: "", screenshot: false), "Singapore Holiday.JPG")
  }
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
      capturedAt: Date(timeIntervalSince1970: .infinity), labels: [], place: nil, screenshot: false), "IMG.JPG")
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

  func testNamePreviewsUseCurrentAnalysisWithoutReplacingSuppliedTags() {
    var record = SearchRecord(id: "public-photo", revision: "source-r1", filename: "IMG.JPG")
    record.ocrStatus = .complete; record.ocrText = "9:41\nALFRED COFFEE\nOrder 123456\nTotal $12.50"
    record.ocrConfidence = 0.94; record.visualStatus = .complete
    record.visualLabels = [SearchVisualLabel(label: "dog", identifier: "dog", confidence: 0.92, processor: SearchVisualPolicy.processor)]
    let analysis = PhotoNameAnalysis(record: record, photoID: "public-photo", revision: "source-r1")
    func name(_ screenshot: Bool = false, labels: [String] = [], evidence: PhotoNameAnalysis? = analysis) -> String {
      PhotoOrganizationFacts.suggestedName(original: "IMG.JPG", digest: String(repeating: "00", count: 32),
        capturedAt: nil, labels: labels, place: nil, screenshot: screenshot, analysis: evidence)
    }
    XCTAssertEqual(name(), "dog_0000000000.jpg")
    XCTAssertEqual(name(true), "Screenshot_ALFRED-COFFEE_0000000000.jpg")
    XCTAssertEqual(name(labels: ["My exact title"]), "My-exact-title_0000000000.jpg")
    XCTAssertEqual(name(evidence: PhotoNameAnalysis(record: record, photoID: "other", revision: "source-r1")), "IMG.JPG")
    XCTAssertEqual(name(evidence: PhotoNameAnalysis(record: record, photoID: "public-photo", revision: "changed")), "IMG.JPG")
    record.ocrStatus = .failed; record.visualStatus = .pending
    XCTAssertEqual(name(evidence: PhotoNameAnalysis(record: record, photoID: record.id, revision: record.revision)), "IMG.JPG")
  }

  func testNamePreviewsRejectUncertainTextIdentifiersAndUnsupportedScenes() {
    var record = SearchRecord(id: "public-photo", revision: "source-r1", filename: "IMG.JPG")
    record.ocrStatus = .complete; record.ocrConfidence = 0.9
    func name() -> String {
      PhotoOrganizationFacts.suggestedName(original: record.filename, digest: nil, capturedAt: nil, labels: [], place: nil,
        screenshot: false, analysis: PhotoNameAnalysis(record: record, photoID: record.id, revision: record.revision))
    }
    record.ocrText = "9:41\nuser@example.com\nhttps://example.com\nOrder 123456\nTotal $12.50"
    XCTAssertEqual(name(), "IMG.JPG")
    record.ocrText = "Wrong title"; record.ocrConfidence = 0.4
    XCTAssertEqual(name(), "IMG.JPG")
    record.ocrConfidence = .nan
    XCTAssertEqual(name(), "IMG.JPG")
    record.ocrConfidence = 1; record.processor = "unknown-model"
    XCTAssertEqual(name(), "IMG.JPG")
    record.visualStatus = .complete
    record.visualLabels = [SearchVisualLabel(label: "Person name", identifier: "dog", confidence: 0.99, processor: SearchVisualPolicy.processor)]
    XCTAssertEqual(name(), "IMG.JPG")
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
  func testReviewedAreaNamePreservesGPSAndDoesNotReplaceExistingNames() {
    let original = PhotoLocationV1(latitude: 40.7, longitude: -74, source: "photos", accuracyMeters: 15)
    let kept = PhotoPlacesPolicy.keepingAreaName("  New York  ", location: original)
    XCTAssertEqual(kept?.name, "Near New York")
    XCTAssertEqual(kept?.latitude, original.latitude)
    XCTAssertEqual(kept?.longitude, original.longitude)
    XCTAssertEqual(kept?.source, original.source)
    XCTAssertEqual(kept?.accuracyMeters, original.accuracyMeters)
    XCTAssertNil(PhotoPlacesPolicy.keepingAreaName("Other", location: kept!))
    for invalid in ["", "   ", "New\nYork", String(repeating: "x", count: 196)] {
      XCTAssertNil(PhotoPlacesPolicy.keepingAreaName(invalid, location: original))
    }
  }

}
