import Foundation

// Collection validation only withdraws stale UI. Sharing still requires an
// immediate source check at the point an original is exported.
enum PhotoPresentationValidation {
  static func withdrawnSelection<ID: Hashable, Identity: Equatable>(captured: [ID: Identity],
    current: [ID: Identity], valid: Set<ID>) -> Set<ID> {
    Set(captured.keys.filter { !valid.contains($0) && current[$0] == captured[$0] })
  }

  @MainActor static func validate<Source: Hashable>(_ sources: [Source],
    authorization: () -> Int?, isCurrent: () -> Bool,
    read: ([Source]) -> Set<Source>) async throws -> Set<Source> {
    func check() throws {
      try Task.checkCancellation()
      guard isCurrent() else { throw CancellationError() }
    }
    try check()
    guard let permission = authorization() else { return [] }
    let unique = Array(Set(sources))
    var valid: Set<Source> = []
    for offset in stride(from: 0, to: unique.count, by: 200) {
      // Yield before every slice, including the first, so work is cancellable
      // before the first Photos lookup and between subsequent actor turns.
      await Task.yield()
      try check()
      guard authorization() == permission else { return [] }
      let batch = Array(unique[offset..<min(offset + 200, unique.count)])
      valid.formUnion(read(batch))
      try check()
      guard authorization() == permission else { return [] }
    }
    try check()
    guard authorization() == permission else { return [] }
    return valid
  }
}
