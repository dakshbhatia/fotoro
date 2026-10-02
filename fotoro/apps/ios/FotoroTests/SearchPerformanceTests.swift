import CoreFoundation
import Darwin
import XCTest

@testable import Fotoro

final class SearchPerformanceTests: XCTestCase {
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
