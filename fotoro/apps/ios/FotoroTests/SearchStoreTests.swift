import GRDB
import XCTest

@testable import Fotoro

final class SearchStoreTests: XCTestCase {
  func testCoveragePartitionsWholePhotosCatalogAndIgnoresStaleRetryAttempts() throws {
    let index = try SearchIndex(), now = Date(timeIntervalSince1970: 1_790_000_000)
    var records = ["complete", "pending", "failed", "unavailable"].map { SearchRecord(id: $0) }
    records[0].ocrStatus = .complete; records[0].visualStatus = .complete
    records[0].ocrText = "private text must never enter coverage"
    try index.replacePermitted(records)
    var saved = SearchRecord(id: "separate-saved-copy"); saved.scope = "saved"
    try index.put(saved)
    XCTAssertTrue(try index.applyOCR(nil, status: .failed, photoID: "failed", revision: "1", attemptedAt: now))
    XCTAssertTrue(try index.applyOCR(nil, status: .unavailable, photoID: "unavailable", revision: "1", attemptedAt: now))
    let ocr = try XCTUnwrap(index.analysisCoverage(now: now).first { $0.stage == .ocr })
    XCTAssertEqual(ocr.total, 4); XCTAssertEqual(ocr.complete, 1); XCTAssertEqual(ocr.pending, 1)
    XCTAssertEqual(ocr.failed, 1); XCTAssertEqual(ocr.unavailable, 1); XCTAssertEqual(ocr.deferred, 2)
    XCTAssertEqual(ocr.nextRetry, now.addingTimeInterval(30))
    let due = try XCTUnwrap(index.analysisCoverage(now: now.addingTimeInterval(301)).first { $0.stage == .ocr })
    XCTAssertEqual(due.deferred, 0); XCTAssertNil(due.nextRetry)
    XCTAssertEqual(due.failed, 1, "A retry becoming due does not mean recognition succeeded")
    try index.database.write { db in
      try db.execute(sql: "UPDATE searchAnalysisAttempts SET revision='withdrawn-revision'")
    }
    let stale = try XCTUnwrap(index.analysisCoverage(now: now).first { $0.stage == .ocr })
    XCTAssertEqual(stale.deferred, 0); XCTAssertNil(stale.nextRetry)
    try index.replacePermitted([])
    XCTAssertTrue(try index.analysisCoverage(now: now).allSatisfy { $0.total == 0 && $0.complete == 0 && $0.deferred == 0 })
  }
  #if !FOTORO_LOCAL_PREVIEW
  func testSemanticCoverageDistinguishesModelWaitFailuresAndCurrentVectors() throws {
    let index = try SearchIndex(), now = Date(timeIntervalSince1970: 1_790_000_000)
    try index.replacePermitted(["complete", "model", "failed", "unavailable", "pending"].map { SearchRecord(id: $0) })
    var vector = [Float](repeating: 0, count: 512); vector[0] = 1
    XCTAssertTrue(try index.applySemantic(vector, photoID: "complete", revision: "1"))
    for (id, outcome) in [("model", SearchAnalysisOutcome.modelDeferred), ("failed", .failed), ("unavailable", .unavailable)] {
      XCTAssertTrue(try index.deferSemantic(outcome, photoID: id, revision: "1", attemptedAt: now))
    }
    var semantic = try XCTUnwrap(index.analysisCoverage(now: now).first { $0.stage == .semantic })
    XCTAssertEqual(semantic.total, 5); XCTAssertEqual(semantic.complete, 1); XCTAssertEqual(semantic.pending, 2)
    XCTAssertEqual(semantic.failed, 1); XCTAssertEqual(semantic.unavailable, 1)
    XCTAssertEqual(semantic.modelDeferred, 1); XCTAssertEqual(semantic.deferred, 3)
    try index.database.write { db in
      try db.execute(sql: "UPDATE searchVectors SET revision='old'")
      try db.execute(sql: "UPDATE searchAnalysisAttempts SET processor='old'")
    }
    semantic = try XCTUnwrap(index.analysisCoverage(now: now).first { $0.stage == .semantic })
    XCTAssertEqual(semantic.complete, 0); XCTAssertEqual(semantic.pending, 5)
    XCTAssertEqual(semantic.deferred, 0); XCTAssertEqual(semantic.modelDeferred, 0)
  }
  #endif
  func testCancellingRunningSQLiteSearchUnblocksSuccessorAndPreservesAnalysisWrites() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "source"); record.labels = ["alpha"]
    try index.replacePermitted([record])
    let began = expectation(description: "Search is executing inside SQLite")
    let gate = DispatchSemaphore(value: 0)
    try await index.database.write { db in
      try db.execute(sql: "INSERT INTO searchEvents(kind,meaning,photo,scope,session,at) VALUES('accept','label:alpha','',?,'test',0)",
        arguments: [SearchScope().key])
      db.add(function: DatabaseFunction("searchDecay", argumentCount: 2) { _ in
        began.fulfill()
        _ = gate.wait(timeout: .now() + 5)
        return 1.0
      })
    }
    let query = Task { try await index.searchAsync("alpha") }
    await fulfillment(of: [began], timeout: 3)
    query.cancel(); gate.signal()
    do { _ = try await query.value; XCTFail("Running SQLite work must respect cancellation") }
    catch { XCTAssertTrue(query.isCancelled) }
    record.labels = ["successor"]
    try index.put(record)
    let next = try await index.searchAsync("successor")
    XCTAssertEqual(next.results.map(\.id), [record.id], "Cancellation cannot poison the shared connection or later analysis")
  }
  func testBulkSearchRecordValidationHandlesMoreThanOneBindBatchAndWithdrawal() throws {
    let index = try SearchIndex()
    let records = (0..<850).map { SearchRecord(id: "photo-\($0)") }
    try index.replacePermitted(records)
    let ids = records.map(\.id)
    XCTAssertEqual(try index.records(ids + ids + ["missing"]).count, 850)
    try index.replacePermitted(Array(records.prefix(1)))
    XCTAssertEqual(Set(try index.records(ids).keys), [records[0].id], "Withdrawn sources cannot survive bulk retrieval")
  }
  func testAnalysisRetriesReopenByStageWithoutLosingCompletedWork() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    let scope = PhotoAnalysisScope(now: now)
    var records = ["complete", "unavailable", "failed", "vector-only", "untouched"].map { id in
      var record = SearchRecord(id: id); record.capturedAt = now; return record
    }
    for number in 0..<4 { records[number].ocrStatus = .complete; records[number].visualStatus = .complete }
    var index: SearchIndex? = try SearchIndex(root: root)
    try index!.replacePermitted(records)
    #if !FOTORO_LOCAL_PREVIEW
    var vector = [Float](repeating: 0, count: 512); vector[0] = 1
    for id in ["complete", "unavailable", "failed"] {
      XCTAssertTrue(try index!.applySemantic(vector, photoID: id, revision: "1"))
    }
    #endif
    XCTAssertTrue(try index!.applyOCR(nil, status: .unavailable, photoID: "unavailable", revision: "1", attemptedAt: now))
    XCTAssertTrue(try index!.applyVisual(nil, status: .failed, photoID: "failed", revision: "1", attemptedAt: now))
    index = nil
    let reopened = try SearchIndex(root: root)
    try reopened.replacePermitted(records)
    let due = try reopened.pendingMetadataAnalysisWork(scope: scope, retryFailed: true, now: now)
    #if !FOTORO_LOCAL_PREVIEW
    XCTAssertEqual(Set(due.map { $0.record.id }), ["vector-only", "untouched"])
    XCTAssertEqual(due.first { $0.record.id == "vector-only" }?.stages, [.semantic])
    XCTAssertTrue(try reopened.needsSemantic(photoID: "vector-only", revision: "1"),
      "A canceled stage that did not commit stays eligible after reopening")
    XCTAssertFalse(try reopened.needsSemantic(photoID: "complete", revision: "1"))
    #else
    XCTAssertEqual(due.map { $0.record.id }, ["untouched"])
    #endif
    XCTAssertEqual(due.first { $0.record.id == "untouched" }?.stages.intersection([.ocr, .visual]), [.ocr, .visual])
    XCTAssertEqual(try reopened.record("complete")?.ocrStatus, .complete)
    XCTAssertEqual(try reopened.nextMetadataAnalysisRetry(scope: scope, now: now), now.addingTimeInterval(30))
    let later = now.addingTimeInterval(301)
    XCTAssertEqual(try reopened.nextMetadataAnalysisRetry(scope: scope, now: later), now.addingTimeInterval(30),
      "An earlier retry that became due during a long batch must still wake the owner")
    let laterWork = try reopened.pendingMetadataAnalysisWork(scope: scope, now: later)
    XCTAssertEqual(laterWork.first { $0.record.id == "unavailable" }?.stages, [.ocr])
    XCTAssertEqual(laterWork.first { $0.record.id == "failed" }?.stages, [.visual])
    let explicit = try reopened.pendingMetadataAnalysisWork(scope: scope, retryFailed: true, now: now, bypassDeferred: true)
    XCTAssertTrue(explicit.contains { $0.record.id == "unavailable" && $0.stages == [.ocr] })
    XCTAssertTrue(explicit.contains { $0.record.id == "failed" && $0.stages == [.visual] })
  }

  func testAnalysisRetryRevisionProcessorWithdrawalAndAtomicFailure() throws {
    let now = Date(timeIntervalSince1970: 1_790_000_000), scope = PhotoAnalysisScope(now: Date(timeIntervalSince1970: 1_790_000_000))
    let index = try SearchIndex()
    var record = SearchRecord(id: "source"); record.capturedAt = now
    try index.replacePermitted([record])
    XCTAssertTrue(try index.applyOCR(nil, status: .unavailable, photoID: record.id, revision: "1", attemptedAt: now))
    XCTAssertTrue(try index.applyVisual(nil, status: .unavailable, photoID: record.id, revision: "1", attemptedAt: now))
    record.processor = "vision-text-v2"
    try index.replacePermitted([record])
    let processorWork = try XCTUnwrap(index.pendingMetadataAnalysisWork(scope: scope, now: now).first)
    XCTAssertTrue(processorWork.stages.contains(.ocr)); XCTAssertFalse(processorWork.stages.contains(.visual))
    XCTAssertFalse(try index.applyOCR(nil, status: .failed, photoID: record.id, revision: "1", attemptedAt: now, expectedProcessor: "vision-text-v1"))
    record.revision = "2"
    try index.replacePermitted([record])
    let changed = try XCTUnwrap(index.pendingMetadataAnalysisWork(scope: scope, now: now).first)
    XCTAssertTrue(changed.stages.isSuperset(of: [.ocr, .visual]))
    XCTAssertFalse(try index.applyVisual(nil, status: .failed, photoID: record.id, revision: "1", attemptedAt: now))
    try index.database.write { db in
      try db.execute(sql: "CREATE TRIGGER rejectAttempt BEFORE INSERT ON searchAnalysisAttempts BEGIN SELECT RAISE(ABORT,'test rollback'); END")
    }
    XCTAssertThrowsError(try index.applyOCR(nil, status: .failed, photoID: record.id, revision: "2", attemptedAt: now))
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .pending, "Result and retry deadline roll back together")
    try index.database.write { try $0.execute(sql: "DROP TRIGGER rejectAttempt") }
    XCTAssertTrue(try index.applyOCR(nil, status: .failed, photoID: record.id, revision: "2", attemptedAt: now))
    try index.setWorkGeneration(2)
    try index.replacePermitted([], generation: 2)
    XCTAssertFalse(try index.applyOCR(nil, status: .failed, photoID: record.id, revision: "2", generation: 1, attemptedAt: now))
    XCTAssertEqual(try index.database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchAnalysisAttempts") }, 0)
    XCTAssertTrue(try index.pendingMetadataAnalysisWork(scope: scope, now: now).isEmpty)
  }

  #if !FOTORO_LOCAL_PREVIEW
  func testSyncedCompletionDoesNotBecomeLocalRetryAuthority() throws {
    let now = Date(timeIntervalSince1970: 1_790_000_000), scope = PhotoAnalysisScope(now: Date(timeIntervalSince1970: 1_790_000_000))
    let index = try SearchIndex()
    var record = SearchRecord(id: "source"); record.capturedAt = now; record.visualStatus = .complete
    try index.replacePermitted([record])
    XCTAssertTrue(try index.applyOCR(nil, status: .unavailable, photoID: record.id, revision: "1", attemptedAt: now))
    var remote = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("original".utf8).digest)
    remote.ocr = PhotoAnnotationsV1.OCR(text: "Remote receipt", confidence: 0.9, processor: record.processor)
    XCTAssertTrue(try index.applyAnnotations(remote, photoID: record.id, revision: "1", accountId: "owner"))
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .complete)
    try index.clearSyncedAnnotations()
    XCTAssertEqual(try index.record(record.id)?.ocrStatus, .unavailable)
    XCTAssertFalse(try index.pendingMetadataAnalysisWork(scope: scope, now: now).first?.stages.contains(.ocr) ?? false,
      "Clearing account evidence retains the local source retry deadline")
    XCTAssertTrue(try index.pendingMetadataAnalysisWork(scope: scope, now: now.addingTimeInterval(301)).first?.stages.contains(.ocr) ?? false)
    XCTAssertTrue(try index.applyOCR(SearchOCRResult(text: "Local receipt", confidence: 0.9), status: .complete,
      photoID: record.id, revision: "1", attemptedAt: now.addingTimeInterval(301)))
    XCTAssertEqual(try index.database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchAnalysisAttempts WHERE stage='ocr'") }, 0)
  }

  func testModelReadinessReleasesOnlyDeferredVectorsAfterReopen() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let now = Date(timeIntervalSince1970: 1_790_000_000), scope = PhotoAnalysisScope(now: Date(timeIntervalSince1970: 1_790_000_000))
    var records = ["cold", "unavailable", "failed"].map { id in
      var record = SearchRecord(id: id); record.capturedAt = now; record.ocrStatus = .complete; record.visualStatus = .complete; return record
    }
    records[0].ocrStatus = .unavailable
    var index: SearchIndex? = try SearchIndex(root: root)
    try index!.replacePermitted(records)
    XCTAssertTrue(try index!.applyOCR(nil, status: .unavailable, photoID: "cold", revision: "1", attemptedAt: now))
    XCTAssertTrue(try index!.deferSemantic(.modelDeferred, photoID: "cold", revision: "1", attemptedAt: now))
    XCTAssertTrue(try index!.deferSemantic(.unavailable, photoID: "unavailable", revision: "1", attemptedAt: now))
    XCTAssertTrue(try index!.deferSemantic(.failed, photoID: "failed", revision: "1", attemptedAt: now))
    index = nil
    let reopened = try SearchIndex(root: root)
    XCTAssertTrue(try reopened.pendingMetadataAnalysisWork(scope: scope, retryFailed: true, now: now).isEmpty)
    try reopened.setWorkGeneration(2)
    XCTAssertFalse(try reopened.releaseModelDeferredAnalysis(generation: 1))
    XCTAssertTrue(try reopened.releaseModelDeferredAnalysis(generation: 2))
    let ready = try reopened.pendingMetadataAnalysisWork(scope: scope, now: now)
    XCTAssertEqual(ready.map { $0.record.id }, ["cold"])
    XCTAssertEqual(ready.first?.stages, [.semantic], "Readiness cannot bypass the source's OCR deadline")
    var vector = [Float](repeating: 0, count: 512); vector[0] = 1
    XCTAssertTrue(try reopened.applySemantic(vector, photoID: "cold", revision: "1", generation: 2))
    XCTAssertFalse(try reopened.releaseModelDeferredAnalysis(generation: 2))
    XCTAssertFalse(try reopened.deferSemantic(.failed, photoID: "cold", revision: "1", attemptedAt: now, generation: 2))
    XCTAssertEqual(try reopened.pendingMetadataAnalysisWork(scope: scope, now: now.addingTimeInterval(31)).map { $0.record.id }, ["failed"])
    XCTAssertEqual(try reopened.nextMetadataAnalysisRetry(scope: scope, now: now), now.addingTimeInterval(30))
  }
  #endif

  func testHeavyAnalysisMetadataFilterPrecedesExplicitBatchAndPreservesCompletedHistory() throws {
    let index = try SearchIndex(), now = Date()
    var records = (0..<601).map { number in
      var value = SearchRecord(id: "match-\(number)"); value.capturedAt = now; value.filename = "Singapore-\(number).jpg"; return value
    }
    var old = SearchRecord(id: "old-pending"); old.capturedAt = now.addingTimeInterval(-90 * 86400); old.filename = "Singapore-old.jpg"
    var historical = old; historical.id = "old-complete"; historical.ocrStatus = .complete; historical.ocrText = "historical receipt"
    historical.visualStatus = .complete
    var ocrOnly = SearchRecord(id: "ocr-only"); ocrOnly.capturedAt = now; ocrOnly.filename = "IMG.jpg"; ocrOnly.ocrStatus = .complete; ocrOnly.ocrText = "Singapore"
    var unknown = old; unknown.id = "unknown"; unknown.capturedAt = nil
    var future = old; future.id = "future"; future.capturedAt = now.addingTimeInterval(60)
    records += [old, historical, ocrOnly, unknown, future]
    try index.replacePermitted(records)
    #if !FOTORO_LOCAL_PREVIEW
    var vector = [Float](repeating: 0, count: 512); vector[0] = 1
    XCTAssertTrue(try index.applySemantic(vector, photoID: historical.id, revision: historical.revision))
    #endif
    let recent = PhotoAnalysisScope(query: "Singapore", now: now)
    XCTAssertEqual(try index.pendingMetadataAnalysisCount(scope: recent), 601)
    let first = try index.pendingMetadataAnalysisRecords(scope: recent)
    XCTAssertEqual(first.count, 500)
    let cursor = PhotoAnalysisCursor(try XCTUnwrap(first.last))
    XCTAssertEqual(try index.pendingMetadataAnalysisCount(scope: recent, after: cursor), 101)
    let second = try index.pendingMetadataAnalysisRecords(scope: recent, after: cursor)
    XCTAssertEqual(second.count, 101)
    XCTAssertTrue(Set(first.map(\.id)).isDisjoint(with: Set(second.map(\.id))))
    let unavailable = try XCTUnwrap(first.first)
    XCTAssertTrue(try index.applyOCR(nil, status: .failed, photoID: unavailable.id, revision: unavailable.revision))
    XCTAssertTrue(try index.applyVisual(nil, status: .unavailable, photoID: unavailable.id, revision: unavailable.revision))
    let end = PhotoAnalysisCursor(try XCTUnwrap(second.last))
    XCTAssertEqual(try index.pendingMetadataAnalysisCount(scope: recent, after: end, retryFailed: true), 0,
      "The exhausted cursor counts unattempted work, not successful coverage")
    XCTAssertTrue(try index.pendingMetadataAnalysisRecords(scope: recent, retryFailed: true).contains { $0.id == unavailable.id },
      "Retry starts before the cursor so an unavailable earlier source remains retryable")
    let expanded = PhotoAnalysisScope(query: "Singapore", includesOlder: true, now: now)
    XCTAssertEqual(try index.pendingMetadataAnalysisCount(scope: expanded), 603)
    XCTAssertFalse(try index.pendingMetadataAnalysisRecords(scope: expanded, after: PhotoAnalysisCursor(unknown)).contains { $0.id == unknown.id })
    XCTAssertEqual(try index.search("historical receipt").results.map(\.id), [historical.id])
    #if !FOTORO_LOCAL_PREVIEW
    XCTAssertFalse(try index.needsSemantic(photoID: historical.id, revision: historical.revision))
    XCTAssertTrue(try index.needsSemantic(photoID: historical.id, revision: "changed"))
    #endif
  }
  #if !FOTORO_LOCAL_PREVIEW
  @MainActor func testPeopleOnlySearchFencesLateSelectionAndClearWithoutLosingText() async throws {
    let index = try SearchIndex(), a = UUID().uuidString.lowercased(), b = UUID().uuidString.lowercased()
    func record(_ id: String, person: String) throws -> SearchRecord {
      var value = SearchRecord(id: id); value.labels = ["beach"]
      value.facts = try PhotoPeopleFacts.replacing([], with: [PhotoPersonAssignment(p: person, n: "Family", b: [0,0,100,100])])
      return value
    }
    try index.replacePermitted([record("a", person: a), record("b", person: b)])
    let gate = SearchQueryGate()
    let store = LocalSearchStore(index: index, queryExecutor: { index, query, scope, accepted, previous, generation in
      await gate.wait(scope.key)
      let result = try index.search(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
      await gate.didReturn(scope.key)
      return result
    })
    let first = PeopleSearchSelection(personIDs: [a]), second = PeopleSearchSelection(personIDs: [b], match: .everyone)
    let firstKey = SearchScope(people: first).key, secondKey = SearchScope(people: second).key
    store.setPeopleSelection(first, names: [a:"Family A"])
    XCTAssertTrue(store.hasSearch); XCTAssertEqual(store.query, "")
    store.setPeopleSelection(first, names: [a:"Renamed family member"])
    XCTAssertEqual(store.selectedPeopleNames[a], "Renamed family member")
    try await waitForGate(gate, query: firstKey)
    store.setPeopleSelection(second, names: [b:"Family B"])
    XCTAssertFalse(store.hasCurrentResponse)
    try await waitForGate(gate, query: secondKey)
    await gate.resume(firstKey)
    try await waitForGate(gate, query: firstKey, returned: true)
    XCTAssertTrue(store.response.results.isEmpty, "Old family selection cannot publish under the new one")
    await gate.resume(secondKey)
    try await waitFor(store, query: "")
    XCTAssertEqual(store.response.results.map(\.id), ["b"])
    store.setPeopleSelection(first)
    try await waitForGate(gate, query: firstKey, count: 2)
    store.setPeopleSelection(PeopleSearchSelection())
    XCTAssertFalse(store.hasSearch); XCTAssertTrue(store.response.results.isEmpty)
    await gate.resume(firstKey)
    try await waitForGate(gate, query: firstKey, count: 2, returned: true)
    XCTAssertTrue(store.response.results.isEmpty, "Clearing People cannot resurrect an old family result")
    store.updateQuery("beach")
    let plainKey = SearchScope().key
    try await waitForGate(gate, query: plainKey)
    await gate.resume(plainKey)
    try await waitFor(store, query: "beach")
    store.setPeopleSelection(first)
    try await waitForGate(gate, query: firstKey, count: 3)
    store.setPeopleSelection(PeopleSearchSelection())
    XCTAssertEqual(store.query, "beach", "Clear people preserves the text/date query")
    await gate.resume(firstKey)
    try await waitForGate(gate, query: plainKey, count: 2)
    await gate.resume(plainKey)
    try await waitFor(store, query: "beach")
    XCTAssertEqual(Set(store.response.results.map(\.id)), ["a","b"])
    store.pause()
  }
  #endif
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
  @MainActor func testConsumerTextNeverReusesMatchesAfterTheirLabelWasRemoved() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "source"); record.labels = ["before"]
    try index.replacePermitted([record])
    let store = LocalSearchStore(index: index)
    store.updateQuery("before")
    try await waitFor(store, query: "before")
    XCTAssertTrue(store.setLabels(["after"], photoID: record.id))
    let hits = try await store.consumerResults("before", includeVisual: false)
    XCTAssertTrue(hits.isEmpty, "A completed response from before an edit cannot become the new answer")
  }
  @MainActor func testConsumerTextReusesCompletedResponseWithoutRerunningQuery() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "screenshot")
    record.ocrText = "Alfred project notes"; record.ocrStatus = .complete; record.ocrConfidence = 0.95
    try index.replacePermitted([record])
    let gate = SearchQueryGate(), store = gatedStore(index: index, gate: gate)
    store.updateQuery("alfred")
    try await waitForGate(gate, query: "alfred")
    await gate.resume("alfred")
    try await waitFor(store, query: "alfred")
    let hits = try await store.consumerResults("alfred", includeVisual: false)
    XCTAssertEqual(hits.map(\.id), [record.id], "Completed OCR retrieval must not wait for visual inference")
    let calls = await gate.count("alfred", returned: false)
    XCTAssertEqual(calls, 1, "Consumer presentation must not enqueue duplicate lexical retrieval")
  }
  @MainActor func testAnalysisBurstPublishesOnceAndPendingEvidenceCannotReuseStaleText() async throws {
    let index = try SearchIndex(), counter = SearchQueryCounter(), delay = SearchQueryGate()
    var record = SearchRecord(id: "screenshot")
    try index.replacePermitted([record])
    let store = countedStore(index: index, counter: counter)
    store.analysisQueryRefreshDelay = { await delay.wait("refresh") }
    defer { store.pause() }
    store.updateQuery("receipt")
    try await waitFor(store, query: "receipt")
    let generation = store.response.generation
    XCTAssertTrue(store.response.results.isEmpty)
    record.ocrText = "Receipt for train tickets"; record.ocrStatus = .complete; record.ocrConfidence = 0.95
    try index.put(record)
    for _ in 0..<40 { store.metadataAnalysisDidChange() }
    try await waitForGate(delay, query: "refresh")
    XCTAssertEqual(store.response.generation, generation, "Stage checkpoints cannot churn presentation generations")
    XCTAssertFalse(store.searching, "Completed matches remain usable between bounded refreshes")
    let beforeConsumer = await counter.count
    XCTAssertEqual(beforeConsumer, 1)
    let hits = try await store.consumerResults("receipt", includeVisual: false)
    XCTAssertEqual(hits.map(\.id), [record.id], "A consumer during the window must read new evidence instead of stale cached text")
    await delay.resume("refresh")
    try await waitForResponseGeneration(store, after: generation)
    XCTAssertEqual(store.response.results.map(\.id), [record.id])
    let afterRefresh = await counter.count
    XCTAssertEqual(afterRefresh, 3, "Forty stage checkpoints need one refresh, plus the explicit fresh consumer")
    _ = try await store.consumerResults("receipt", includeVisual: false)
    let afterReuse = await counter.count
    XCTAssertEqual(afterReuse, afterRefresh, "The completed current revision is reusable again")
  }
  @MainActor func testSuspendedConsumerRejectsOwnerEditButSurvivesAdditiveAnalysisRefresh() async throws {
    for ownerEdit in [false, true] {
      let index = try SearchIndex(), counter = SearchQueryCounter(), gate = SearchQueryGate(), delay = SearchQueryGate()
      var record = SearchRecord(id: "source"); record.labels = ["before"]
      try index.replacePermitted([record])
      let store = LocalSearchStore(index: index, queryExecutor: { index, query, scope, accepted, previous, generation in
        let call = await counter.next()
        let snapshot = try await index.searchAsync(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
        if call == 2 { await gate.wait("consumer") }
        return snapshot
      })
      store.analysisQueryRefreshDelay = { await delay.wait("refresh") }
      defer { store.pause() }
      store.updateQuery("before")
      try await waitFor(store, query: "before")
      let generation = store.response.generation
      store.metadataAnalysisDidChange()
      try await waitForGate(delay, query: "refresh")
      let consumer = Task { try await store.consumerResults("before", includeVisual: false) }
      try await waitForGate(gate, query: "consumer")
      if ownerEdit { XCTAssertTrue(store.setLabels(["after"], photoID: record.id)) }
      await delay.resume("refresh")
      try await waitForResponseGeneration(store, after: generation)
      await gate.resume("consumer")
      if ownerEdit {
        do { _ = try await consumer.value; XCTFail("A removed label cannot return from an older suspended search") }
        catch { XCTAssertTrue(error is CancellationError) }
      } else {
        let hits = try await consumer.value
        XCTAssertEqual(hits.map(\.id), [record.id], "Additive analysis refresh cannot cancel otherwise current consumer results")
      }
    }
  }
  @MainActor func testConsumerRecordReadRejectsEditWhileWaitingForDatabase() async throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "source"); record.labels = ["before"]
    try index.replacePermitted([record])
    let store = LocalSearchStore(index: index)
    let blocked = expectation(description: "Database queue is held"), began = expectation(description: "Consumer entered record read")
    let release = DispatchSemaphore(value: 0)
    let blocker = Task.detached {
      try await index.database.write { _ in
        blocked.fulfill()
        _ = release.wait(timeout: .now() + 5)
      }
    }
    await fulfillment(of: [blocked], timeout: 2)
    let consumer = Task {
      began.fulfill()
      return try await store.consumerRecords([record.id])
    }
    await fulfillment(of: [began], timeout: 2)
    // An explicit same-text update represents an owner/synced annotation edit;
    // it must be fenced without requiring the replacement query to finish.
    store.updateQuery("before")
    release.signal()
    try await blocker.value
    do { _ = try await consumer.value; XCTFail("An edit during a queued validation read must reject its earlier context") }
    catch { XCTAssertTrue(error is CancellationError) }
    store.pause()
  }
  @MainActor func testAnalysisRefreshLetsSlowFirstTextQueryFinishBeforeSuccessor() async throws {
    let index = try SearchIndex(), gate = SearchQueryGate()
    var record = SearchRecord(id: "source"); record.labels = ["receipt"]
    try index.replacePermitted([record])
    let store = gatedStore(index: index, gate: gate)
    store.analysisQueryRefreshDelay = {}
    defer { store.pause() }
    store.updateQuery("receipt")
    try await waitForGate(gate, query: "receipt")
    for _ in 0..<40 { store.metadataAnalysisDidChange() }
    try await Task.sleep(for: .milliseconds(20))
    let heldCalls = await gate.count("receipt", returned: false)
    XCTAssertEqual(heldCalls, 1, "Analysis cannot cancel and restart a slow first query")
    XCTAssertTrue(store.searching)
    await gate.resume("receipt")
    try await waitForGate(gate, query: "receipt", count: 2)
    XCTAssertEqual(store.response.results.map(\.id), [record.id], "The first response is visible while enrichment catches up")
    XCTAssertTrue(store.hasCurrentResponse)
    await gate.resume("receipt")
    try await waitFor(store, query: "receipt")
  }
  @MainActor func testTypedQueryBypassesPendingAnalysisAndCancelledWindowCannotReplay() async throws {
    let index = try SearchIndex(), counter = SearchQueryCounter(), delay = SearchQueryGate()
    var receipt = SearchRecord(id: "receipt"); receipt.labels = ["receipt"]
    var beach = SearchRecord(id: "beach"); beach.labels = ["beach"]
    try index.replacePermitted([receipt, beach])
    let store = countedStore(index: index, counter: counter)
    store.analysisQueryRefreshDelay = { await delay.wait("refresh") }
    defer { store.pause() }
    store.updateQuery("receipt")
    try await waitFor(store, query: "receipt")
    store.metadataAnalysisDidChange()
    try await waitForGate(delay, query: "refresh")
    store.updateQuery("beach")
    try await waitFor(store, query: "beach")
    XCTAssertEqual(store.response.results.map(\.id), [beach.id], "Typing cannot wait for the analysis refresh window")
    await delay.resume("refresh")
    try await Task.sleep(for: .milliseconds(20))
    let calls = await counter.count
    XCTAssertEqual(calls, 2, "The canceled old window cannot replay or invalidate the typed answer")
    XCTAssertEqual(store.response.query, "beach")
  }
  @MainActor func testPauseAndPermissionRefreshCancelPendingAnalysisQuery() async throws {
    for withdrawPermission in [false, true] {
      let index = try SearchIndex(), counter = SearchQueryCounter(), delay = SearchQueryGate()
      var record = SearchRecord(id: "source"); record.labels = ["receipt"]
      try index.replacePermitted([record])
      let store = countedStore(index: index, counter: counter)
      store.analysisQueryRefreshDelay = { await delay.wait("refresh") }
      store.updateQuery("receipt")
      try await waitFor(store, query: "receipt")
      store.metadataAnalysisDidChange()
      try await waitForGate(delay, query: "refresh")
      if withdrawPermission { store.beginPermittedSnapshotRefresh() } else { store.pause() }
      await delay.resume("refresh")
      try await Task.sleep(for: .milliseconds(20))
      let calls = await counter.count
      XCTAssertEqual(calls, 1, "A delayed window cannot reopen work after pause or permission withdrawal")
      XCTAssertFalse(store.searching)
      if withdrawPermission { XCTAssertTrue(store.response.results.isEmpty) }
      store.pause()
    }
  }
  @MainActor private func countedStore(index: SearchIndex, counter: SearchQueryCounter) -> LocalSearchStore {
    LocalSearchStore(index: index, queryExecutor: { index, query, scope, accepted, previous, generation in
      await counter.record()
      return try await index.searchAsync(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
    })
  }
  @MainActor private func waitForResponseGeneration(_ store: LocalSearchStore, after generation: UInt64) async throws {
    for _ in 0..<200 where store.response.generation <= generation || store.searching {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertGreaterThan(store.response.generation, generation)
    XCTAssertFalse(store.searching)
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
    let store = LocalSearchStore(index: try SearchIndex(), queryExecutor: { _, _, _, _, _, _ in
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
    LocalSearchStore(index: index, queryExecutor: { index, query, scope, accepted, previous, generation in
      await gate.wait(query)
      let response = try index.search(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
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

private actor SearchQueryCounter {
  private(set) var count = 0
  func record() { count += 1 }
  func next() -> Int { count += 1; return count }
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
