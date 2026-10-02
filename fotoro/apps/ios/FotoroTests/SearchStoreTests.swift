import XCTest

@testable import Fotoro

final class SearchStoreTests: XCTestCase {
  @MainActor private func waitFor(_ store: LocalSearchStore, query: String) async throws {
    for _ in 0..<200 where store.response.query != query {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(store.response.query, query)
  }
  @MainActor func testNavigatedResultSurvivesPrefixExtensionAndSameQueryEnrichment() async throws {
    let i = try SearchIndex()
    var a = SearchRecord(id: "a")
    a.labels = ["Ronald"]
    var b = SearchRecord(id: "b")
    b.labels = ["Ronald"]
    try i.replacePermitted([a, b])
    let store = LocalSearchStore(index: i)
    store.updateQuery("r")
    try await waitFor(store, query: "r")
    store.move(1)
    XCTAssertEqual(store.displayedHit?.id, "b")
    store.updateQuery("ro")
    try await waitFor(store, query: "ro")
    XCTAssertEqual(store.displayedHit?.id, "b")
    a.favorite = true
    try i.put(a)
    let generation = store.response.generation
    store.updateQuery("ro")
    for _ in 0..<200 where store.response.generation == generation {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(store.displayedHit?.id, "b")
  }
  @MainActor func testColdDeniedStorePurgesExistingProtectedRecordsAndHistory() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let i = try SearchIndex(root: root)
    var record = SearchRecord(id: "a")
    record.labels = ["Ronald"]
    try i.replacePermitted([record])
    let meaning = try XCTUnwrap(i.search("ron").meaning)
    try i.acceptMeaning(meaning.id, sessionID: "one", now: Date())
    try i.confirmUse(meaning.id, photoID: "a", sessionID: "one", now: Date())
    let cold = LocalSearchStore(root: root)
    cold.auditAuthorization(status: .denied)
    for _ in 0..<200 where cold.indexing { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertNil(try i.record("a"))
    XCTAssertEqual(try i.historyCount(kind: "accept", meaningID: meaning.id, now: Date()), 0)
    XCTAssertEqual(
      try i.historyCount(kind: "use", meaningID: meaning.id, photoID: "a", now: Date()), 0)
    try i.replacePermitted([SearchRecord(id: "a")])
    XCTAssertNil(try i.search("ron").leading)
    cold.pause()
  }
  @MainActor func testPermittedSnapshotRefreshPreservesOnlyStillEligibleNavigatedResult()
    async throws
  {
    let i = try SearchIndex()
    var a = SearchRecord(id: "a")
    a.labels = ["Ronald"]
    var b = SearchRecord(id: "b")
    b.labels = ["Ronald"]
    try i.replacePermitted([a, b])
    let store = LocalSearchStore(index: i)
    store.updateQuery("ro")
    try await waitFor(store, query: "ro")
    store.move(1)
    XCTAssertEqual(store.displayedHit?.id, "b")
    store.beginPermittedSnapshotRefresh()
    XCTAssertNil(store.displayedHit)
    XCTAssertTrue(store.assets.isEmpty)
    a.favorite = true
    try i.replacePermitted([a, b])
    store.completePermittedSnapshotRefresh(photos: [])
    try await waitFor(store, query: "ro")
    XCTAssertEqual(store.displayedHit?.id, "b")
    store.beginPermittedSnapshotRefresh()
    try i.replacePermitted([a])
    store.completePermittedSnapshotRefresh(photos: [])
    try await waitFor(store, query: "ro")
    XCTAssertEqual(store.displayedHit?.id, "a")
  }
  @MainActor func testLabelEditorCannotClaimReadinessBeforePermittedRecordExists() throws {
    let i = try SearchIndex()
    let store = LocalSearchStore(index: i)
    XCTAssertFalse(store.canEditLabels("missing"))
    try i.replacePermitted([SearchRecord(id: "permitted")])
    XCTAssertTrue(store.canEditLabels("permitted"))
  }
}
