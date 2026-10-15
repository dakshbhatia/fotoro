import CoreFoundation
import Darwin
import XCTest

@testable import Fotoro

final class SearchPerformanceTests: XCTestCase {
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
    var times: [Double] = []
    for _ in 0..<10 {
      let started = CFAbsoluteTimeGetCurrent()
      let hits = try await store.consumerResults(query, includeVisual: false)
      times.append((CFAbsoluteTimeGetCurrent() - started) * 1000)
      XCTAssertFalse(hits.isEmpty, "The authorized query must retrieve existing indexed evidence")
    }
    let coverage = try index.search("")
    times.sort()
    print("Device index copy: \(coverage.total) records, \(coverage.indexed) OCR complete; simulator text retrieval median \(times[5]) ms, p90 \(times[8]) ms. Excludes PhotoKit and rendering.")
    for length in Set([1, 2, 3, query.count]).sorted() where length <= query.count {
      let started = CFAbsoluteTimeGetCurrent()
      let result = try await index.searchAsync(String(query.prefix(length)))
      XCTAssertFalse(result.results.isEmpty)
      print("Device index prefix length \(length): \((CFAbsoluteTimeGetCurrent() - started) * 1000) ms; \(result.results.count) result groups. No photo loading or rendering.")
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
