import Foundation

@main struct PresentationValidationHostTests {
  @MainActor static func main() async throws {
    let sources = Array(0..<10000)
    var reads: [Int] = []
    let valid = try await PhotoPresentationValidation.validate(sources,
      authorization: { 3 }, isCurrent: { true }, read: { batch in
        reads.append(batch.count); return Set(batch)
      })
    guard reads.count == 50, reads.allSatisfy({ $0 <= 200 }), valid.count == 10000 else {
      print("FAIL: 10,000 presentation sources must use fifty reads of at most 200; got \(reads)")
      exit(1)
    }
    print("PASS: 10,000 sources use fifty bounded reads")

    var revisionReads = 0
    let revisions = try await PhotoPresentationValidation.validate(sources,
      authorization: { 3 }, isCurrent: { true }, read: { batch in
        revisionReads += 1
        // One edited source and one removed source do not match the captured
        // presentation, even when every other source is still available.
        return Set(batch.filter { $0 != 17 && $0 != 9999 })
      })
    guard revisionReads == 50, revisions.count == 9998,
      !revisions.contains(17), !revisions.contains(9999) else { fatalError("Edited/deleted sources were accepted") }
    print("PASS: edited and removed sources fail closed across a 10,000-source snapshot")

    var permission: Int? = 3
    var permissionReads = 0
    let withdrawn = try await PhotoPresentationValidation.validate(sources,
      authorization: { permission }, isCurrent: { true }, read: { batch in
        permissionReads += 1; permission = 2; return Set(batch)
      })
    guard withdrawn.isEmpty, permissionReads == 1 else { fatalError("Permission transition retained earlier successes") }
    permission = nil
    permissionReads = 0
    let denied = try await PhotoPresentationValidation.validate(sources,
      authorization: { permission }, isCurrent: { true }, read: { batch in
        permissionReads += 1; return Set(batch)
      })
    guard denied.isEmpty, permissionReads == 0 else { fatalError("Denied permission performed source reads") }
    print("PASS: permission transition discards all success; denied access performs zero reads")

    var current = true
    var obsoleteReads = 0
    do {
      _ = try await PhotoPresentationValidation.validate(sources,
        authorization: { 3 }, isCurrent: { current }, read: { batch in
          obsoleteReads += 1; current = false; return Set(batch)
        })
      fatalError("Superseded context returned a publishable result")
    } catch is CancellationError { }
    guard obsoleteReads == 1 else { fatalError("Superseded work continued reading") }
    print("PASS: generation/context replacement stops after one read without a result")

    var cancelledReads = 0
    let cancelled = Task { @MainActor in
      try await PhotoPresentationValidation.validate(sources,
        authorization: { 3 }, isCurrent: { true }, read: { batch in
          cancelledReads += 1
          withUnsafeCurrentTask { $0?.cancel() }
          return Set(batch)
        })
    }
    do { _ = try await cancelled.value; fatalError("Cancelled work returned a result") }
    catch is CancellationError { }
    guard cancelledReads == 1 else { fatalError("Cancelled work continued reading") }
    print("PASS: cancellation discards accumulated results and stops later reads")

    var duplicateReads = 0
    let deduplicated = try await PhotoPresentationValidation.validate([4, 4, 4, 5],
      authorization: { 3 }, isCurrent: { true }, read: { batch in
        duplicateReads += batch.count; return Set(batch)
      })
    guard duplicateReads == 2, deduplicated == [4, 5] else { fatalError("Duplicate source work was retained") }
    print("PASS: overlapping viewer/selection/share sources are read once")

    let captured = ["stale-A": 1]
    let withNewSelection = ["stale-A": 1, "new-B": 2]
    let withdrawnSelection = PhotoPresentationValidation.withdrawnSelection(captured: captured,
      current: withNewSelection, valid: Set<String>())
    guard withdrawnSelection == ["stale-A"], withNewSelection.filter({ !withdrawnSelection.contains($0.key) }) == ["new-B": 2] else {
      print("FAIL: selecting unrelated B must still withdraw unchanged stale A and preserve B")
      exit(1)
    }
    let replaced = PhotoPresentationValidation.withdrawnSelection(captured: captured,
      current: ["stale-A": 3, "new-B": 2], valid: Set<String>())
    guard replaced.isEmpty else { fatalError("Old validation withdrew newly reselected A") }
    print("PASS: unrelated selection changes preserve new entries without shielding unchanged stale entries")
  }
}
