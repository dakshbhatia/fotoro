import Foundation

// One fixed window for a burst, with one trailing window when edits arrive
// during the drain. Withdrawal cancels the old binding even if it later returns.
@MainActor final class FixedWindowWorkBatch<Binding: Equatable> {
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var binding: Binding?
  private var requested = false
  var pending: Bool { task != nil }
  func cancel() {
    generation = UUID(); task?.cancel(); task = nil; binding = nil; requested = false
  }
  func enqueue(binding: Binding, current: @escaping @MainActor () -> Binding?,
    sleep: @escaping @MainActor () async throws -> Void = { try await Task.sleep(for: .milliseconds(500)) },
    run: @escaping @MainActor () async -> Void) {
    guard current() == binding else { return }
    if self.binding == binding, task != nil { requested = true; return }
    cancel()
    self.binding = binding; requested = true
    let token = generation
    task = Task { [weak self] in
      defer {
        if let self, generation == token { task = nil; self.binding = nil; requested = false }
      }
      while let self, generation == token, requested {
        do { try await sleep() } catch { return }
        guard !Task.isCancelled, generation == token, current() == binding else { return }
        requested = false
        await run()
        guard !Task.isCancelled, generation == token, current() == binding else { return }
      }
    }
  }
  func waitUntilSettled() async { await task?.value }
}

enum AutomaticPhotoSyncRetryPolicy {
  static func permits(_ error: Error) -> Bool {
    if let error = error as? BackgroundUploadFailure { return error.retryable }
    if let error = error as? URLError {
      return [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
        .dnsLookupFailed, .notConnectedToInternet].contains(error.code)
    }
    guard let error = error as? FotoroError, error.retryable else { return false }
    guard let status = error.statusCode else { return true }
    return status == 408 || status == 429 || (500...599).contains(status)
  }
  static func delay(attempt: Int) -> Duration {
    let seconds = [5, 15, 30, 60, 120, 300]
    return .seconds(seconds[min(seconds.count - 1, max(0, attempt))])
  }
}

@MainActor final class AutomaticPhotoSyncRetry<Binding: Equatable> {
  typealias Sleep = @MainActor (Duration) async throws -> Void
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var attempt = 0
  var pending: Bool { task != nil }

  func cancel(resetAttempts: Bool = true) {
    generation = UUID()
    task?.cancel()
    task = nil
    if resetAttempts { attempt = 0 }
  }

  func schedule(binding: Binding, current: @escaping @MainActor () -> Binding?,
    sleep: Sleep? = nil, retry: @escaping @MainActor () -> Void)
  {
    guard task == nil else { return }
    let token = UUID(), delay = AutomaticPhotoSyncRetryPolicy.delay(attempt: attempt)
    generation = token
    attempt = min(attempt + 1, 5)
    let sleep = sleep ?? { try await Task.sleep(for: $0) }
    task = Task { [weak self] in
      do { try await sleep(delay) } catch {
        if let self, generation == token { task = nil }
        return
      }
      guard let self, generation == token else { return }
      task = nil
      guard !Task.isCancelled, current() == binding else { return }
      retry()
    }
  }

  func waitUntilSettled() async { await task?.value }
}
