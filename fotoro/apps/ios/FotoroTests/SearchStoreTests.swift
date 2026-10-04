import XCTest

@testable import Fotoro

final class SearchStoreTests: XCTestCase {
  @MainActor private func waitFor(_ store: LocalSearchStore, query: String) async throws {
    for _ in 0..<200 where store.response.query != query || store.searching || !store.hasCurrentResponse {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(store.response.query, query)
    XCTAssertFalse(store.searching)
    XCTAssertTrue(store.hasCurrentResponse)
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
  @MainActor func testNewQueryClearsPriorAnswerAndLateQueryCannotFinishItsSuccessor() async throws {
    let index = try SearchIndex()
    var old = SearchRecord(id: "old")
    old.labels = ["Ronald"]
    var receipt = SearchRecord(id: "receipt")
    receipt.labels = ["Receipt"]
    var beach = SearchRecord(id: "beach")
    beach.labels = ["Beach"]
    try index.replacePermitted([old, receipt, beach])
    let gate = SearchQueryGate()
    let store = gatedStore(index: index, gate: gate)
    store.updateQuery("ron")
    try await waitForGate(gate, query: "ron")
    await gate.resume("ron")
    try await waitFor(store, query: "ron")
    XCTAssertEqual(store.displayedHit?.id, "old")

    store.updateQuery("receipt")
    XCTAssertTrue(store.searching)
    XCTAssertFalse(store.hasCurrentResponse)
    XCTAssertTrue(store.response.results.isEmpty)
    XCTAssertNil(store.displayedHit)
    try await waitForGate(gate, query: "receipt")
    store.updateQuery("beach")
    try await waitForGate(gate, query: "beach")
    await gate.resume("receipt")
    try await waitForGate(gate, query: "receipt", returned: true)
    XCTAssertTrue(store.searching, "An old completion cannot clear the current query's progress")
    XCTAssertFalse(store.hasCurrentResponse)
    await gate.resume("beach")
    try await waitFor(store, query: "beach")
    XCTAssertEqual(store.displayedHit?.id, "beach")
  }
  @MainActor func testPauseAndBlankQueryFenceLateResultsAndProgress() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "a")
    record.labels = ["Receipt", "Beach"]
    try index.replacePermitted([record])
    let gate = SearchQueryGate()
    let store = gatedStore(index: index, gate: gate)
    store.updateQuery("receipt")
    try await waitForGate(gate, query: "receipt")
    store.pause()
    XCTAssertFalse(store.searching)
    XCTAssertFalse(store.hasCurrentResponse)
    XCTAssertNil(store.analysisProgress)
    await gate.resume("receipt")
    try await waitForGate(gate, query: "receipt", returned: true)
    XCTAssertTrue(store.response.results.isEmpty)
    XCTAssertNil(store.error)

    store.updateQuery("beach")
    try await waitForGate(gate, query: "beach")
    store.updateQuery(" ")
    XCTAssertFalse(store.searching)
    XCTAssertNil(store.acceptedMeaningID)
    await gate.resume("beach")
    try await waitForGate(gate, query: "beach", returned: true)
    XCTAssertTrue(store.response.results.isEmpty)
    XCTAssertFalse(store.searching)
    XCTAssertNil(store.error)
  }
  @MainActor func testSameQueryEnrichmentKeepsCompletedMatchesWhileSearching() async throws {
    let index = try SearchIndex()
    var a = SearchRecord(id: "a")
    a.labels = ["Ronald"]
    var b = SearchRecord(id: "b")
    b.labels = ["Ronald"]
    try index.replacePermitted([a, b])
    let gate = SearchQueryGate()
    let store = gatedStore(index: index, gate: gate)
    store.updateQuery("ron")
    try await waitForGate(gate, query: "ron")
    await gate.resume("ron")
    try await waitFor(store, query: "ron")
    store.move(1)
    let completedGeneration = store.response.generation
    a.favorite = true
    try index.put(a)
    store.updateQuery("ron")
    XCTAssertTrue(store.searching)
    XCTAssertTrue(store.hasCurrentResponse)
    XCTAssertEqual(store.response.results.count, 2)
    XCTAssertEqual(store.displayedHit?.id, "b")
    try await waitForGate(gate, query: "ron", count: 2)
    await gate.resume("ron")
    try await waitFor(store, query: "ron")
    XCTAssertGreaterThan(store.response.generation, completedGeneration)
    XCTAssertEqual(store.displayedHit?.id, "b")
  }
  @MainActor func testSnapshotRefreshRejectsLateAnswerAndWaitsForCurrentPermittedIndex() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "withdrawn")
    record.labels = ["Receipt"]
    try index.replacePermitted([record])
    let gate = SearchQueryGate()
    let store = gatedStore(index: index, gate: gate)
    store.updateQuery("receipt")
    try await waitForGate(gate, query: "receipt")
    store.beginPermittedSnapshotRefresh()
    XCTAssertFalse(store.searching)
    XCTAssertFalse(store.hasCurrentResponse)
    XCTAssertTrue(store.assets.isEmpty)
    await gate.resume("receipt")
    try await waitForGate(gate, query: "receipt", returned: true)
    XCTAssertTrue(store.response.results.isEmpty)

    store.updateQuery("receipt")
    XCTAssertFalse(store.searching, "A query cannot run against the old permitted snapshot")
    XCTAssertFalse(store.hasCurrentResponse)
    try index.replacePermitted([])
    store.completePermittedSnapshotRefresh(photos: [])
    XCTAssertTrue(store.searching)
    try await waitForGate(gate, query: "receipt", count: 2)
    await gate.resume("receipt")
    try await waitFor(store, query: "receipt")
    XCTAssertTrue(store.response.results.isEmpty)
    XCTAssertEqual(store.response.total, 0)
  }
  @MainActor func testFailedCurrentQueryEndsProgressWithoutClaimingCompletedEmptyResults() async throws {
    let store = LocalSearchStore(index: try SearchIndex(), queryExecutor: { _, _, _, _, _ in
      throw CocoaError(.fileReadCorruptFile)
    })
    store.updateQuery("receipt")
    XCTAssertTrue(store.searching)
    for _ in 0..<200 where store.searching {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertFalse(store.searching)
    XCTAssertFalse(store.hasCurrentResponse)
    XCTAssertTrue(store.response.results.isEmpty)
    XCTAssertNotNil(store.error)
  }
  @MainActor private func gatedStore(index: SearchIndex, gate: SearchQueryGate) -> LocalSearchStore {
    LocalSearchStore(index: index, queryExecutor: { index, query, accepted, previous, generation in
      await gate.wait(query)
      let response = try index.search(query, acceptedMeaningID: accepted, previous: previous, generation: generation)
      await gate.didReturn(query)
      return response
    })
  }
  @MainActor private func waitForGate(_ gate: SearchQueryGate, query: String, count: Int = 1,
    returned: Bool = false) async throws
  {
    for _ in 0..<200 {
      if await gate.count(query, returned: returned) >= count {
        // Allow the query task to publish (or reject) the executor's returned response.
        if returned { try await Task.sleep(for: .milliseconds(10)) }
        return
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Query did not reach its controlled lifecycle point: \(query)")
    throw CancellationError()
  }
}

private actor SearchQueryGate {
  private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
  private var started: [String: Int] = [:]
  private var returned: [String: Int] = [:]
  func wait(_ query: String) async {
    await withCheckedContinuation { continuation in
      waiting[query] = continuation
      started[query, default: 0] += 1
    }
  }
  func resume(_ query: String) { waiting.removeValue(forKey: query)?.resume() }
  func didReturn(_ query: String) { returned[query, default: 0] += 1 }
  func count(_ query: String, returned completed: Bool) -> Int {
    (completed ? returned : started)[query, default: 0]
  }
}
