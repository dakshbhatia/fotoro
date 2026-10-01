import Photos
import XCTest

@testable import Fotoro

final class RecentPhotosTests: XCTestCase {
  func testLast30DaysDateBoundariesAndMissingDates() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = Date(timeIntervalSince1970: 1_780_315_200)
    let cutoff = RecentPhotosPolicy.cutoff(now: now, calendar: calendar)
    XCTAssertTrue(RecentPhotosPolicy.includes(cutoff, now: now, calendar: calendar))
    XCTAssertTrue(RecentPhotosPolicy.includes(now, now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(cutoff.addingTimeInterval(-1), now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(now.addingTimeInterval(1), now: now, calendar: calendar))
    XCTAssertFalse(RecentPhotosPolicy.includes(nil, now: now, calendar: calendar))
  }
  func testViewerLoadsOnlyCurrentAndNeighboringPages() {
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(4, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(5, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(6, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(3, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(7, current: 5))
  }
  func testPermissionPolicyAllowsLimitedAndFullOnly() {
    XCTAssertTrue(RecentPhotosPolicy.canRead(.limited))
    XCTAssertTrue(RecentPhotosPolicy.canRead(.authorized))
    for status in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      XCTAssertFalse(RecentPhotosPolicy.canRead(status))
    }
  }
  func testMetadataSearchUsesPhotoKitFactsWithoutInferredPeopleOrPlaces() {
    let facts = RecentPhotoFacts(
      capturedAt: Date(timeIntervalSince1970: 1_780_315_200), favorite: true, screenshot: true,
      livePhoto: false, location: "40.7128, -74.0060")
    XCTAssertTrue(facts.searchText.contains("favorite"))
    XCTAssertTrue(facts.searchText.contains("screenshot"))
    XCTAssertTrue(facts.searchText.contains("40.7128"))
    XCTAssertFalse(facts.searchText.contains("live photo"))
    XCTAssertFalse(facts.searchText.contains("New York"))
    XCTAssertEqual(
      RecentPhotoFacts(
        capturedAt: nil, favorite: false, screenshot: false, livePhoto: false, location: nil
      ).searchText, "")
  }
}
