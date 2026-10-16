import CoreFoundation
import Darwin
import XCTest

@testable import Fotoro

final class SearchPerformanceTests: XCTestCase {
  #if !FOTORO_LOCAL_PREVIEW
  func testTenDayAnnotationHydrationBatchBenchmark() throws {
    let index = try SearchIndex(), now = Date(timeIntervalSince1970: 1_792_065_600)
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let records = (0..<1000).map { number -> SearchRecord in
      var record = SearchRecord(id: "public-\(number)")
      record.capturedAt = calendar.date(byAdding: .day, value: -(number / 100), to: now)
      record.labels = ["Public fixture"]; return record
    }
    let buildStarted = CFAbsoluteTimeGetCurrent()
    try index.replacePermitted(records)
    let buildMS = (CFAbsoluteTimeGetCurrent() - buildStarted) * 1000
    let digest = Data("public synthetic cohort".utf8).digest
    let updates = records.map { record -> SearchIndex.AnnotationUpdate in
      var value = PhotoAnnotationsV1(photoId: record.id, originalSha256: digest)
      value.labels = record.labels
      return SearchIndex.AnnotationUpdate(value: value, photoID: record.id, revision: record.revision, accountId: "public-owner")
    }
    for start in stride(from: 0, to: updates.count, by: 200) {
      _ = try index.applyAnnotationsBatch(Array(updates[start..<min(start + 200, updates.count)]))
    }
    XCTAssertEqual(try index.analysisCoverage(now: now, scope: PhotoAnalysisWindow.tenDays.scope(now: now, calendar: calendar)).first?.total, 1000)
    var single: [Double] = [], batched: [Double] = []
    for _ in 0..<3 {
      var started = CFAbsoluteTimeGetCurrent()
      for update in updates {
        _ = try index.record(update.photoID)
        XCTAssertTrue(try index.applyAnnotations(update.value, photoID: update.photoID, revision: update.revision, accountId: update.accountId))
        _ = try index.record(update.photoID)
      }
      single.append((CFAbsoluteTimeGetCurrent() - started) * 1000)
      started = CFAbsoluteTimeGetCurrent()
      var accepted = 0
      for start in stride(from: 0, to: updates.count, by: 200) {
        let result = try index.applyAnnotationsBatch(Array(updates[start..<min(start + 200, updates.count)]))
        accepted += result.acceptedPhotoIDs.count
        XCTAssertTrue(result.changedRecords.isEmpty)
      }
      batched.append((CFAbsoluteTimeGetCurrent() - started) * 1000)
      XCTAssertEqual(accepted, 1000)
    }
    single.sort(); batched.sort()
    print("Ten-day public cohort: 1000 records, 100/day; metadata index \(buildMS) ms; unchanged per-photo hydration \(single[1]) ms, 200-record batches \(batched[1]) ms; \(single[1] / max(0.001, batched[1]))x. Conservative same-code SQL comparison; excludes crypto, inference, Photos, network and rendering.")
  }
  #endif
  func testBroadPrefixAcrossManyMeaningsDoesNotMultiplyByTheWholeLibrary() throws {
    let index = try SearchIndex()
    let records = (0..<10_000).map { number -> SearchRecord in
      var record = SearchRecord(id: "photo-\(number)")
      record.labels = ["alpha \(number % 1500)"]
      return record
    }
    try index.replacePermitted(records)
    let started = CFAbsoluteTimeGetCurrent()
    let result = try index.search("a")
    let elapsed = CFAbsoluteTimeGetCurrent() - started
    XCTAssertFalse(result.results.isEmpty)
    XCTAssertLessThanOrEqual(result.meanings.count, 6)
    XCTAssertLessThanOrEqual(result.results.count, 200)
    XCTAssertLessThan(elapsed, 5, "A broad typed prefix must not stall the database queue for seconds")
  }
  // Opt in locally with a read-only copy of an authorized device index. Never
  // bundle personal data or print queries, photo identifiers or recognized text.
  @MainActor func testOptInDeviceIndexTextRetrieval() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let path = env["FOTORO_SEARCH_AUDIT_INDEX"], let query = env["FOTORO_SEARCH_AUDIT_QUERY"] else {
      throw XCTSkip("No local device index audit requested")
    }
    let index = try SearchIndex(root: URL(fileURLWithPath: path))
    let store = LocalSearchStore(index: index)
    let expectedIDs: Set<String>?
    if let expectedPath = env["FOTORO_SEARCH_AUDIT_EXPECTED_IDS"] {
      expectedIDs = Set(try JSONDecoder().decode([String].self,
        from: Data(contentsOf: URL(fileURLWithPath: expectedPath))))
    } else { expectedIDs = nil }
    var times: [Double] = []
    var photoMatches = 0
    for _ in 0..<10 {
      let started = CFAbsoluteTimeGetCurrent()
      let hits = try await store.consumerResults(query, includeVisual: false)
      photoMatches = hits.reduce(0) { $0 + 1 + $1.children.count }
      if let expectedIDs {
        XCTAssertTrue(Set(hits.flatMap { [$0.id] + $0.children }) == expectedIDs,
          "Retrieved photo identities must match the private expected set; identifiers are withheld")
      }
      times.append((CFAbsoluteTimeGetCurrent() - started) * 1000)
      XCTAssertFalse(hits.isEmpty, "The authorized query must retrieve existing indexed evidence")
    }
    let coverage = try index.search("")
    times.sort()
    print("Device index copy: \(coverage.total) records, \(coverage.indexed) OCR complete; \(photoMatches) matching photos; simulator text retrieval median \(times[5]) ms, p90 \(times[8]) ms. Excludes PhotoKit and rendering.")
    for length in Set([1, 2, 3, query.count]).sorted() where length <= query.count {
      let started = CFAbsoluteTimeGetCurrent()
      let result = try await index.searchAsync(String(query.prefix(length)))
      XCTAssertFalse(result.results.isEmpty)
      print("Device index prefix length \(length): \((CFAbsoluteTimeGetCurrent() - started) * 1000) ms; \(result.results.count) result groups. No photo loading or rendering.")
    }
    if let casesPath = env["FOTORO_SEARCH_AUDIT_CASES"] {
      struct AuditCase: Decodable { let query: String; let expectedIDs: [String] }
      let cases = try JSONDecoder().decode([AuditCase].self,
        from: Data(contentsOf: URL(fileURLWithPath: casesPath)))
      XCTAssertFalse(cases.isEmpty)
      XCTAssertLessThanOrEqual(cases.count, 20, "Keep private audit batches bounded")
      var batchTimes: [Double] = []
      for (offset, item) in cases.prefix(20).enumerated() {
        let started = CFAbsoluteTimeGetCurrent()
        let hits = try await store.consumerResults(item.query, includeVisual: false)
        batchTimes.append((CFAbsoluteTimeGetCurrent() - started) * 1000)
        let actual = Set(hits.flatMap { [$0.id] + $0.children })
        XCTAssertTrue(actual == Set(item.expectedIDs),
          "Private audit case \(offset + 1) returned \(actual.count) photos; expected \(Set(item.expectedIDs).count). Queries and identifiers are withheld.")
      }
      batchTimes.sort()
      if !batchTimes.isEmpty {
        print("Private text audit: \(batchTimes.count) bounded cases; median \(batchTimes[batchTimes.count / 2]) ms, maximum \(batchTimes.last!) ms. Expected sets are local evidence checks, not recognition quality or physical UI latency.")
      }
    }
  }
  private func footprint() -> UInt64 {
    var info = task_vm_info_data_t()
    let capacity = MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
    var count = mach_msg_type_number_t(capacity)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return result == KERN_SUCCESS ? info.phys_footprint : 0
  }
  func testTenThousandSyntheticRecordsWarmQueriesAndBoundedCandidates() throws {
    let before = footprint()
    let records = (0..<10_000).map { n -> SearchRecord in
      var r = SearchRecord(id: String(format: "p%05d", n))
      r.labels = [n % 100 == 0 ? "Ronald" : "Term \(n)"]
      r.ocrStatus = .complete
      r.previewAvailable = true
      return r
    }
    let index = try SearchIndex()
    let start = CFAbsoluteTimeGetCurrent()
    try index.replacePermitted(records)
    let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
    _ = try index.search("ron")
    var times: [Double] = []
    for _ in 0..<60 {
      let start = CFAbsoluteTimeGetCurrent()
      let result = try index.search("ron")
      times.append((CFAbsoluteTimeGetCurrent() - start) * 1000)
      XCTAssertLessThanOrEqual(result.meanings.count, 6)
      XCTAssertLessThanOrEqual(result.results.count, 200)
      XCTAssertEqual(result.leading?.id, "p00000")
    }
    times.sort()
    print(
      "Native synthetic 10k: metadata index \(elapsed) ms; warm query p95 \(times[Int(Double(times.count-1)*0.95)]) ms; process footprint before \(before), after \(footprint()) bytes. Simulator, excludes Photos decoding and rendering."
    )
  }
}
