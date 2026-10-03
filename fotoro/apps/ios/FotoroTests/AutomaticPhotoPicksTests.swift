import XCTest

@testable import Fotoro

final class AutomaticPhotoPicksTests: XCTestCase {
  private let epoch = Date(timeIntervalSince1970: 1_780_315_200)
  private func photo(
    _ id: String, seconds: Double? = nil, favorite: Bool = false, screenshot: Bool = false,
    width: Int = 1200, height: Int = 800
  ) -> AutomaticPhotoPickCandidate {
    AutomaticPhotoPickCandidate(
      id: id, sourceRevision: "original-v1",
      capturedAt: seconds.map { epoch.addingTimeInterval($0) },
      width: width, height: height, favorite: favorite, isScreenshot: screenshot)
  }
  private func signal(_ hash: UInt64 = 0, sharpness: Double = 0.12) -> AutomaticPhotoPickSignals {
    AutomaticPhotoPickSignals(
      hash: hash, luminance: 0.5, contrast: 0.15, sharpness: sharpness, color: [120, 120, 120])
  }

  func testTenPercentQuotaUsesUniqueAssessedGroupsAndPreservesInput() {
    let photos = (0..<20).map { photo(String($0)) }
    let signals = Dictionary(
      uniqueKeysWithValues: photos.enumerated().map { index, photo in
        (photo.id, signal(UInt64(index), sharpness: index == 5 ? 0.5 : index == 12 ? 0.4 : 0.01))
      })
    let result = AutomaticPhotoPickPolicy.recommend(photos, signals: signals)
    XCTAssertEqual(result.ids, ["5", "12"])
    XCTAssertEqual(result.groupCount, 20)
    XCTAssertEqual(result.duplicateCount, 0)
    XCTAssertEqual(photos.map(\.sourceRevision), Array(repeating: "original-v1", count: 20))
    XCTAssertEqual(AutomaticPhotoPickPolicy.recommend([photos[0]], signals: signals).ids, ["0"])
    XCTAssertTrue(AutomaticPhotoPickPolicy.recommend([], signals: [:]).ids.isEmpty)
  }

  func testFavoriteHasPriorityOverASharperNonFavorite() {
    let photos = (0..<20).map { photo(String($0), favorite: $0 == 19) }
    let signals = Dictionary(
      uniqueKeysWithValues: photos.map {
        ($0.id, signal(sharpness: $0.favorite ? 0.01 : 0.3))
      })
    let result = AutomaticPhotoPickPolicy.recommend(photos, signals: signals)
    XCTAssertEqual(result.ids, ["19", "0"])
    XCTAssertTrue(result.reasons["19"]?.contains("Favorite") == true)
  }

  func testScreenshotsAreExcludedUnlessExplicitlyFavoritedWithoutRemovingTheSource() {
    let screenshot = photo("screen", screenshot: true)
    let result = AutomaticPhotoPickPolicy.recommend([screenshot], signals: ["screen": signal()])
    XCTAssertTrue(result.ids.isEmpty)
    XCTAssertEqual(result.groupCount, 0)
    XCTAssertEqual(result.unassessed, 0)
    XCTAssertEqual(screenshot.id, "screen")
    let favorite = photo("screen", favorite: true, screenshot: true)
    XCTAssertEqual(
      AutomaticPhotoPickPolicy.recommend([favorite], signals: ["screen": signal()]).ids, ["screen"])
  }

  func testBurstKeepsClearerRepresentativeWithoutChainingAcrossCaptureTimes() {
    let photos = [
      photo("soft", seconds: 0), photo("clear", seconds: 20), photo("later", seconds: 40),
    ]
    let result = AutomaticPhotoPickPolicy.recommend(
      photos,
      signals: [
        "soft": signal(3, sharpness: 0.01), "clear": signal(3, sharpness: 0.4),
        "later": signal(3, sharpness: 0.1),
      ])
    XCTAssertEqual(result.groupCount, 2)
    XCTAssertEqual(result.duplicateCount, 1)
    XCTAssertEqual(result.ids, ["clear"])
    XCTAssertTrue(result.reasons["clear"]?.contains("Representative of 2 similar photos") == true)
    XCTAssertEqual(photos.count, 3)
  }

  func testSimilarityRequiresAspectExposureColorAndCloseHash() {
    let photos = [
      photo("a", seconds: 0), photo("color", seconds: 1),
      photo("aspect", seconds: 2, width: 800, height: 1200), photo("hash", seconds: 3),
      photo("exposure", seconds: 4), photo("contrast", seconds: 5),
    ]
    let otherColor = AutomaticPhotoPickSignals(
      hash: 0, luminance: 0.5, contrast: 0.15, sharpness: 0.12, color: [240, 10, 20])
    var otherExposure = signal()
    otherExposure.luminance = 0.54
    var otherContrast = signal()
    otherContrast.contrast = 0.20
    let result = AutomaticPhotoPickPolicy.recommend(
      photos,
      signals: [
        "a": signal(), "color": otherColor, "aspect": signal(), "hash": signal(7),
        "exposure": otherExposure, "contrast": otherContrast,
      ])
    XCTAssertEqual(result.groupCount, 6)
    XCTAssertEqual(result.duplicateCount, 0)
  }

  func testMissingAndNonFiniteCaptureDatesCannotGroupPhotos() {
    let missing = [photo("a"), photo("b")]
    XCTAssertEqual(
      AutomaticPhotoPickPolicy.recommend(missing, signals: ["a": signal(), "b": signal()])
        .groupCount, 2)
    let invalid = AutomaticPhotoPickCandidate(
      id: "invalid", sourceRevision: "1", capturedAt: Date(timeIntervalSince1970: .infinity),
      width: 1200, height: 800, favorite: false, isScreenshot: false)
    XCTAssertEqual(
      AutomaticPhotoPickPolicy.recommend(
        [invalid, photo("known", seconds: 0)],
        signals: ["invalid": signal(), "known": signal()]
      ).groupCount, 2)
  }

  func testCaptureDayVarietyPreventsOneBusyDayTakingEveryPick() {
    var photos = (0..<19).map { photo("a\($0)", seconds: Double($0 * 120)) }
    photos.append(photo("another-day", seconds: -86400))
    let signals = Dictionary(
      uniqueKeysWithValues: photos.map {
        ($0.id, signal(sharpness: $0.id == "another-day" ? 0.1 : 0.2))
      })
    XCTAssertEqual(
      AutomaticPhotoPickPolicy.recommend(photos, signals: signals).ids, ["a0", "another-day"])
  }

  func testBlankMissingAndInvalidSignalsNeverFillTheQuota() {
    let photos = ["blank", "receipt", "missing", "nan", "range", "color", "colorNan", "negative"]
      .map { photo($0) }
    var nan = signal()
    nan.luminance = .nan
    var outOfRange = signal()
    outOfRange.contrast = 1.1
    var badColor = signal()
    badColor.color = [120, 120]
    var nonFiniteColor = signal()
    nonFiniteColor.color = [120, .nan, 120]
    var negativeSharpness = signal()
    negativeSharpness.sharpness = -0.1
    let blank = AutomaticPhotoPickSignals(
      hash: 0, luminance: 1, contrast: 0, sharpness: 0, color: [255, 255, 255])
    let result = AutomaticPhotoPickPolicy.recommend(
      photos,
      signals: [
        "blank": blank, "receipt": signal(5), "nan": nan, "range": outOfRange, "color": badColor,
        "colorNan": nonFiniteColor, "negative": negativeSharpness,
      ])
    XCTAssertEqual(result.ids, ["receipt"])
    XCTAssertEqual(result.groupCount, 1)
    XCTAssertEqual(result.unassessed, 6)
    XCTAssertEqual(photos.count, 8)
  }

  func testDenseBurstHasABoundedTwentyFourAnchorWindow() {
    var photos = (0..<25).map { photo(String($0), seconds: 0) }
    photos.append(photo("repeat-oldest", seconds: 1))
    var signals = Dictionary(
      uniqueKeysWithValues: (0..<25).map {
        (String($0), signal(UInt64($0) &* 0x9e37_79b9_7f4a_7c15))
      })
    signals["repeat-oldest"] = signal(0)
    let result = AutomaticPhotoPickPolicy.recommend(photos, signals: signals)
    XCTAssertEqual(result.groupCount, 26)
    XCTAssertEqual(result.duplicateCount, 0)
    XCTAssertEqual(result.ids.count, 3)
  }

  func testRepeatedIDsUseLatestMetadataAndStableInputTieOrder() {
    let photos = [photo("z"), photo("a"), photo("z", favorite: true)]
    let result = AutomaticPhotoPickPolicy.recommend(
      photos, signals: ["z": signal(), "a": signal()])
    XCTAssertEqual(result.groupCount, 2)
    XCTAssertEqual(result.ids, ["z"])
    let tied = [photo("z"), photo("a")]
    XCTAssertEqual(
      AutomaticPhotoPickPolicy.recommend(tied, signals: ["z": signal(), "a": signal()]).ids, ["z"])
  }

  func testPixelMeasurementsSeparateFlatTransparentAndDetailedPreviews() throws {
    var pixels = [UInt8](repeating: 255, count: 16 * 16 * 4)
    let white = try AutomaticPhotoPickPolicy.analyzePixels(width: 16, height: 16, rgba: pixels)
    XCTAssertEqual(white.luminance, 1, accuracy: 0.000001)
    XCTAssertEqual(white.contrast, 0, accuracy: 0.000001)
    XCTAssertEqual(white.sharpness, 0, accuracy: 0.000001)
    for y in 0..<16 {
      for x in 0..<16 {
        let value: UInt8 = (x + y) % 2 == 0 ? 60 : 190
        let at = (y * 16 + x) * 4
        pixels[at] = value
        pixels[at + 1] = value
        pixels[at + 2] = value
      }
    }
    let detailed = try AutomaticPhotoPickPolicy.analyzePixels(width: 16, height: 16, rgba: pixels)
    XCTAssertGreaterThan(detailed.contrast, 0.2)
    XCTAssertGreaterThan(detailed.sharpness, white.sharpness)
    XCTAssertNotEqual(detailed.hash, white.hash)
    let transparent = try AutomaticPhotoPickPolicy.analyzePixels(
      width: 1, height: 1, rgba: [0, 0, 0, 0])
    XCTAssertEqual(transparent.luminance, 1, accuracy: 0.000001)
    XCTAssertEqual(transparent.color, [255, 255, 255])
  }
  func testMeasuredUniformColorsDoNotFillPicksButDetailedControlRemainsEligible() throws {
    let colors: [[UInt8]] = [[0, 0, 0, 255], [255, 255, 255, 255], [128, 128, 128, 255], [80, 150, 210, 255]]
    var signals: [String: AutomaticPhotoPickSignals] = [:]
    var photos: [AutomaticPhotoPickCandidate] = []
    for (index, color) in colors.enumerated() {
      let id = "uniform-\(index)"
      let pixels = Array(repeating: color, count: 64 * 64).flatMap { $0 }
      let measured = try AutomaticPhotoPickPolicy.analyzePixels(width: 64, height: 64, rgba: pixels)
      XCTAssertEqual(measured.contrast, 0, accuracy: 0.000001)
      XCTAssertEqual(measured.sharpness, 0, accuracy: 0.000001)
      signals[id] = measured
      photos.append(photo(id))
    }
    XCTAssertTrue(AutomaticPhotoPickPolicy.recommend(photos, signals: signals).ids.isEmpty)
    var pixels: [UInt8] = []
    for y in 0..<64 {
      for x in 0..<64 {
        let value: UInt8 = (x / 4 + y / 4) % 2 == 0 ? 60 : 190
        pixels.append(contentsOf: [value, value, value, 255])
      }
    }
    signals["detailed"] = try AutomaticPhotoPickPolicy.analyzePixels(width: 64, height: 64, rgba: pixels)
    photos.append(photo("detailed"))
    let result = AutomaticPhotoPickPolicy.recommend(photos, signals: signals)
    XCTAssertEqual(result.ids, ["detailed"])
    XCTAssertEqual(result.groupCount, 1)
    XCTAssertEqual(result.unassessed, 0)
  }

  func testPixelMeasurementRejectsMalformedOrUnboundedInputWithoutOverflow() {
    XCTAssertThrowsError(try AutomaticPhotoPickPolicy.analyzePixels(width: 0, height: 1, rgba: []))
    XCTAssertThrowsError(
      try AutomaticPhotoPickPolicy.analyzePixels(width: 2, height: 2, rgba: [0, 0, 0, 255]))
    XCTAssertThrowsError(
      try AutomaticPhotoPickPolicy.analyzePixels(width: Int.max, height: Int.max, rgba: []))
    XCTAssertThrowsError(
      try AutomaticPhotoPickPolicy.analyzePixels(width: 257, height: 256, rgba: []))
  }
}
