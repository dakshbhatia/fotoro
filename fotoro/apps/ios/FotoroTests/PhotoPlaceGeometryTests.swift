import Foundation
import XCTest

@testable import Fotoro

final class PhotoPlaceGeometryTests: XCTestCase {
  private let world = PhotoPlaceViewport(center: .init(latitude: 0, longitude: 0), latitudeSpan: 180, longitudeSpan: 360)
  private func point(_ id: String, _ latitude: Double, _ longitude: Double, date: Date? = nil, name: String? = nil) -> PhotoPlacePoint {
    PhotoPlacePoint(id: id, revision: "current", coordinate: .init(latitude: latitude, longitude: longitude), capturedAt: date, name: name)
  }

  func testTwentyThousandLocationsHaveBoundedMarkersAndCompleteDeterministicCoverage() {
    let points = (0..<20_000).map { index in
      point("photo-\(index)", -89 + Double(index % 179), -179.9 + Double((index * 137) % 3599) / 10)
    }
    let result = PhotoPlaceGeometry.snapshot(points, viewport: world)
    XCTAssertLessThanOrEqual(result.clusters.count, 80)
    XCTAssertEqual(result.visibleCount, points.count)
    let represented = result.clusters.flatMap(\.photoIDs)
    XCTAssertEqual(represented.count, points.count)
    XCTAssertEqual(Set(represented), Set(points.map(\.id)))
    XCTAssertEqual(result, PhotoPlaceGeometry.snapshot(Array(points.reversed()), viewport: world))
    let sources = Dictionary(uniqueKeysWithValues: points.map { ($0.id, $0.coordinate) })
    for cluster in result.clusters {
      XCTAssertTrue(cluster.bounds.isValid)
      XCTAssertTrue(cluster.photoIDs.allSatisfy { cluster.bounds.contains(sources[$0]!) })
    }
  }

  func testViewportCountsIncludeLateLoadedPhotosWithoutPrefixTruncation() {
    let far = (0..<1_000).map { point("far-\($0)", -40, 120) }
    let nearby = (0..<750).map { point("near-\($0)", 40 + Double($0 % 10) / 1_000, -74 + Double($0 % 20) / 1_000) }
    let viewport = PhotoPlaceViewport(center: .init(latitude: 40, longitude: -74), latitudeSpan: 1, longitudeSpan: 1)
    let result = PhotoPlaceGeometry.snapshot(far + nearby, viewport: viewport)
    XCTAssertEqual(result.visibleCount, nearby.count)
    XCTAssertEqual(Set(result.clusters.flatMap(\.photoIDs)), Set(nearby.map(\.id)))
    XCTAssertFalse(result.visiblePhotoIDs.contains { $0.hasPrefix("far-") })
  }

  func testDatelineViewportAndClusterBoundsUseTheShortArc() throws {
    let points = [point("west", -17, -179.9), point("east", -16.9, 179.8), point("elsewhere", -17, 0)]
    let bounds = try XCTUnwrap(PhotoPlaceGeometry.bounds(Array(points.prefix(2)).map(\.coordinate)))
    XCTAssertLessThan(bounds.longitudeSpan, 0.31)
    XCTAssertGreaterThan(abs(bounds.center.longitude), 179)
    XCTAssertTrue(points.prefix(2).allSatisfy { bounds.contains($0.coordinate) })
    XCTAssertFalse(bounds.contains(points[2].coordinate))
    let viewport = PhotoPlaceViewport(center: .init(latitude: -17, longitude: 180), latitudeSpan: 2, longitudeSpan: 2)
    let result = PhotoPlaceGeometry.snapshot(points, viewport: viewport, maximumMarkers: 1)
    XCTAssertEqual(result.visibleCount, 2)
    let cluster = try XCTUnwrap(result.clusters.first)
    XCTAssertLessThan(cluster.bounds.longitudeSpan, 0.31)
    XCTAssertTrue(points.prefix(2).allSatisfy { cluster.bounds.contains($0.coordinate) })
  }

  func testZoomRevealsSeparatePhotosAndRetainsAllClusterMembers() throws {
    let points = [point("a", 40, -74), point("b", 40.0001, -74.0001)]
    let overview = PhotoPlaceGeometry.snapshot(points, viewport: world)
    XCTAssertEqual(overview.scale, .regions)
    XCTAssertEqual(overview.clusters.count, 1)
    let cluster = try XCTUnwrap(overview.clusters.first)
    XCTAssertEqual(Set(cluster.photoIDs), Set(points.map(\.id)))
    let detail = PhotoPlaceGeometry.snapshot(points, viewport: cluster.bounds.padded(1.4, minimum: 0.0002))
    XCTAssertEqual(detail.scale, .photos)
    XCTAssertEqual(Set(detail.clusters.flatMap(\.photoIDs)), Set(points.map(\.id)))
    XCTAssertTrue(detail.clusters.allSatisfy { $0.count == 1 })
    for (span, expected) in [(20.0, PhotoPlaceScale.regions), (1, .cities), (0.02, .spots), (0.002, .photos)] {
      XCTAssertEqual(PhotoPlaceGeometry.scale(for: .init(center: .init(latitude: 0, longitude: 0), latitudeSpan: span, longitudeSpan: span)), expected)
    }
  }

  func testCoincidentPhotosRemainCountedAndDoNotInventACommonPlaceName() throws {
    let exactName = "  User’s exact place  "
    let mixed = [point("a", 40, -74, name: exactName), point("b", 40, -74)]
    let result = PhotoPlaceGeometry.snapshot(mixed, viewport: world)
    let cluster = try XCTUnwrap(result.clusters.first)
    XCTAssertEqual(cluster.count, 2)
    XCTAssertNil(cluster.name)
    XCTAssertTrue(cluster.bounds.isValid)
    XCTAssertTrue(cluster.bounds.padded().contains(mixed[0].coordinate))
    let agreed = PhotoPlaceGeometry.snapshot([mixed[0], point("b", 40, -74, name: exactName)], viewport: world)
    XCTAssertEqual(agreed.clusters.first?.name, exactName)
    let conflicting = PhotoPlaceGeometry.snapshot([mixed[0], point("b", 40, -74, name: "Other supplied name")], viewport: world)
    XCTAssertNil(conflicting.clusters.first?.name)
  }

  func testRecentScopeUsesThirtyCalendarDaysAndExplicitAllRetainsUndatedOlderPhotos() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
    let formatter = ISO8601DateFormatter()
    // Noon local time across the autumn daylight-saving transition: 30 days are 721 hours.
    let now = try XCTUnwrap(formatter.date(from: "2026-11-05T17:00:00Z"))
    let cutoff = try XCTUnwrap(formatter.date(from: "2026-10-06T16:00:00Z"))
    XCTAssertTrue(PhotoPlaceGeometry.includes(point("boundary", 0, 0, date: cutoff), recentOnly: true, now: now, calendar: calendar))
    XCTAssertFalse(PhotoPlaceGeometry.includes(point("older", 0, 0, date: cutoff.addingTimeInterval(-1)), recentOnly: true, now: now, calendar: calendar))
    XCTAssertFalse(PhotoPlaceGeometry.includes(point("future", 0, 0, date: now.addingTimeInterval(1)), recentOnly: true, now: now, calendar: calendar))
    XCTAssertFalse(PhotoPlaceGeometry.includes(point("undated", 0, 0), recentOnly: true, now: now, calendar: calendar))
    XCTAssertTrue(PhotoPlaceGeometry.includes(point("undated", 0, 0), recentOnly: false, now: now, calendar: calendar))
    XCTAssertTrue(PhotoPlaceGeometry.includes(point("historical", 0, 0, date: .distantPast), recentOnly: false, now: now, calendar: calendar))
  }

  func testInvalidSourcesAndViewportsDoNotPublishMarkers() {
    var unrevisioned = point("unrevisioned", 0, 0)
    unrevisioned.revision = ""
    let points = [point("valid", 90, 180), point("", 0, 0), unrevisioned,
      point("bad-latitude", 91, 0), point("bad-longitude", 0, 181), point("nan", .nan, 0)]
    let result = PhotoPlaceGeometry.snapshot(points, viewport: world)
    XCTAssertEqual(result.visiblePhotoIDs, ["valid"])
    let invalid = PhotoPlaceViewport(center: .init(latitude: 0, longitude: .nan), latitudeSpan: 1, longitudeSpan: 1)
    XCTAssertEqual(PhotoPlaceGeometry.snapshot(points, viewport: invalid), .empty)
    XCTAssertNil(PhotoPlaceGeometry.bounds([.init(latitude: .infinity, longitude: 0)]))
  }

  func testDuplicateIDsDoNotInflateCountsAndMarkerIdentityIsStableWhilePanning() {
    let points = [point("a", 40, -74), point("b", 40.01, -74.01)]
    let viewport = PhotoPlaceViewport(center: .init(latitude: 40, longitude: -74), latitudeSpan: 1, longitudeSpan: 1)
    let first = PhotoPlaceGeometry.snapshot(points + points, viewport: viewport)
    let panned = PhotoPlaceGeometry.snapshot(points, viewport: .init(center: .init(latitude: 40.1, longitude: -74.1), latitudeSpan: 1, longitudeSpan: 1))
    XCTAssertEqual(first.visibleCount, 2)
    XCTAssertEqual(first.clusters, panned.clusters)
  }

  func testNearbyRowsAreOrderedByObservedCaptureDateThenStableID() {
    let result = PhotoPlaceGeometry.snapshot([point("undated", 0, 0), point("old", 0, 0, date: Date(timeIntervalSince1970: 1)),
      point("new-b", 0, 0, date: Date(timeIntervalSince1970: 2)), point("new-a", 0, 0, date: Date(timeIntervalSince1970: 2))], viewport: world)
    XCTAssertEqual(result.visiblePhotoIDs, ["new-a", "new-b", "old", "undated"])
  }

  @MainActor func testAreaLookupIsExplicitBoundedAndDoesNotReplaceSuppliedNames() async throws {
    let points = (0..<20).map { point("p\($0)", -80 + Double($0) * 8, -170 + Double($0) * 16) }
    var clusters = PhotoPlaceGeometry.snapshot(points, viewport: world).clusters
    clusters[0].name = "My supplied place"
    let names = PhotoPlaceNames()
    var requests: [PhotoPlaceCoordinate] = []
    XCTAssertTrue(names.names.isEmpty)
    await names.load(clusters) { coordinate in requests.append(coordinate); return " City, Country " }
    XCTAssertEqual(requests.count, 8)
    XCTAssertFalse(requests.contains(clusters[0].coordinate))
    XCTAssertNil(names.name(for: clusters[0]))
    XCTAssertEqual(names.name(for: clusters[1]), "City, Country")
    XCTAssertFalse(names.loading)
    var changed = clusters[1]
    changed.photoIDs.append("different-source")
    XCTAssertNil(names.name(for: changed))
    changed = clusters[1]; changed.coordinate.latitude += 0.01
    XCTAssertNil(names.name(for: changed))
  }

  @MainActor func testWithdrawingPlaceSourceDiscardsLateNameWithoutClearingNewResult() async throws {
    let cluster = try XCTUnwrap(PhotoPlaceGeometry.snapshot([point("a", 40, -74)], viewport: world).clusters.first)
    let names = PhotoPlaceNames()
    var suspended: CheckedContinuation<String?, Error>?
    let old = Task { await names.load([cluster]) { _ in try await withCheckedThrowingContinuation { suspended = $0 } } }
    while suspended == nil { await Task.yield() }
    names.clear()
    await names.load([cluster]) { _ in "Current city" }
    suspended?.resume(returning: "Old city")
    await old.value
    XCTAssertEqual(names.name(for: cluster), "Current city")
    XCTAssertFalse(names.loading)
    names.clear()
    XCTAssertNil(names.name(for: cluster))
  }

  @MainActor func testCancelledAreaLookupAndFailuresDoNotInventNames() async throws {
    let clusters = PhotoPlaceGeometry.snapshot([point("a", 40, -74), point("b", -40, 74)], viewport: world).clusters
    let names = PhotoPlaceNames()
    var suspended: CheckedContinuation<String?, Error>?
    let task = Task { await names.load(clusters) { _ in try await withCheckedThrowingContinuation { suspended = $0 } } }
    while suspended == nil { await Task.yield() }
    task.cancel(); suspended?.resume(returning: "Cancelled city"); await task.value
    XCTAssertTrue(names.names.isEmpty)
    await names.load(clusters) { _ in throw URLError(.notConnectedToInternet) }
    XCTAssertTrue(names.names.isEmpty)
    XCTAssertTrue(names.failed)
    XCTAssertFalse(names.loading)
  }

  @MainActor func testCancelledBeforeStartingAreaLookupPreservesCurrentNames() async throws {
    let clusters = PhotoPlaceGeometry.snapshot([point("a", 40, -74)], viewport: world).clusters
    let names = PhotoPlaceNames()
    await names.load(clusters) { _ in "Current city" }
    var requests = 0
    let cancelled = Task { await names.load(clusters) { _ in requests += 1; return "Old city" } }
    cancelled.cancel()
    await cancelled.value
    XCTAssertEqual(requests, 0)
    XCTAssertEqual(names.name(for: clusters[0]), "Current city")
  }
}
