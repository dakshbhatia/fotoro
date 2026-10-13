import XCTest

@testable import Fotoro

final class AutomaticPhotoSyncRetryTests: XCTestCase {
  func testOnlyTemporaryTransportAndServerFailuresReceiveBoundedRetries() {
    for code in [URLError.Code.timedOut, .networkConnectionLost, .notConnectedToInternet,
      .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed] {
      XCTAssertTrue(AutomaticPhotoSyncRetryPolicy.permits(URLError(code)))
    }
    for error in [CancellationError(), URLError(.cancelled), URLError(.secureConnectionFailed),
      URLError(.userAuthenticationRequired), FotoroError("STORAGE_QUOTA_EXCEEDED"),
      FotoroError("AUTH_REQUIRED", retryable: true, statusCode: 401),
      FotoroError("Invalid original digest")] as [Error] {
      XCTAssertFalse(AutomaticPhotoSyncRetryPolicy.permits(error))
    }
    XCTAssertTrue(AutomaticPhotoSyncRetryPolicy.permits(FotoroError("SERVICE_UNAVAILABLE", retryable: true, statusCode: 503)))
    XCTAssertTrue(AutomaticPhotoSyncRetryPolicy.permits(FotoroError("RATE_LIMITED", retryable: true, statusCode: 429)))
    XCTAssertEqual((0...7).map(AutomaticPhotoSyncRetryPolicy.delay),
      [5, 15, 30, 60, 120, 300, 300, 300].map { Duration.seconds($0) })
  }

  @MainActor func testRepeatedAdmissionKeepsOneWakeupAndOneAttempt() async {
    let retry = AutomaticPhotoSyncRetry<Int>()
    let gate = RetrySleepGate(entered: expectation(description: "Retry sleeping"))
    defer { retry.cancel(); gate.open() }
    var actions = 0
    for _ in 0..<3 {
      retry.schedule(binding: 1, current: { 1 }, sleep: gate.sleep, retry: { actions += 1 })
    }
    await fulfillment(of: [gate.entered], timeout: 3)
    XCTAssertEqual(gate.delays, [.seconds(5)])
    XCTAssertTrue(retry.pending)
    gate.open(); await retry.waitUntilSettled()
    XCTAssertEqual(actions, 1)
    XCTAssertFalse(retry.pending)
  }

  @MainActor func testWithdrawnOrReplacedBindingCannotWake() async {
    for replacement in [nil, 2] as [Int?] {
      let retry = AutomaticPhotoSyncRetry<Int>()
      let gate = RetrySleepGate(entered: expectation(description: "Held binding"))
      defer { retry.cancel(); gate.open() }
      var current: Int? = 1, actions = 0
      retry.schedule(binding: 1, current: { current }, sleep: gate.sleep, retry: { actions += 1 })
      await fulfillment(of: [gate.entered], timeout: 3)
      current = replacement
      gate.open(); await retry.waitUntilSettled()
      XCTAssertEqual(actions, 0)
      XCTAssertFalse(retry.pending)
    }
  }

  @MainActor func testCancelledSleeperCannotClearOrFireItsSuccessor() async {
    let retry = AutomaticPhotoSyncRetry<Int>()
    let first = RetrySleepGate(entered: expectation(description: "Earlier retry"))
    let next = RetrySleepGate(entered: expectation(description: "Successor retry"))
    defer { retry.cancel(); first.open(); next.open() }
    var actions = 0
    retry.schedule(binding: 1, current: { 1 }, sleep: first.sleep, retry: { XCTFail("Cancelled retry fired") })
    await fulfillment(of: [first.entered], timeout: 3)
    let settling = Task { await retry.waitUntilSettled() }
    await Task.yield()
    retry.cancel(resetAttempts: false)
    retry.schedule(binding: 2, current: { 2 }, sleep: next.sleep, retry: { actions += 1 })
    await fulfillment(of: [next.entered], timeout: 3)
    first.open(); await settling.value
    XCTAssertTrue(retry.pending, "Earlier cleanup cannot remove the current wakeup")
    XCTAssertEqual(next.delays, [.seconds(15)])
    XCTAssertEqual(actions, 0)
    next.open(); await retry.waitUntilSettled()
    XCTAssertEqual(actions, 1)
    XCTAssertFalse(retry.pending)
  }

  @MainActor func testBackoffCapsAndSuccessfulResetStartsAtFirstDelay() async {
    let retry = AutomaticPhotoSyncRetry<Int>()
    defer { retry.cancel() }
    var delays: [Duration] = [], actions = 0
    for _ in 0..<8 {
      retry.schedule(binding: 1, current: { 1 }, sleep: { delays.append($0) }, retry: { actions += 1 })
      await retry.waitUntilSettled()
    }
    XCTAssertEqual(delays, [5, 15, 30, 60, 120, 300, 300, 300].map { .seconds($0) })
    XCTAssertEqual(actions, 8)
    retry.cancel()
    retry.schedule(binding: 1, current: { 1 }, sleep: { delays.append($0) }, retry: { actions += 1 })
    await retry.waitUntilSettled()
    XCTAssertEqual(delays.last, .seconds(5))
    XCTAssertEqual(actions, 9)
  }

  @MainActor func testThrowingSleeperReleasesAdmissionWithoutFiring() async {
    let retry = AutomaticPhotoSyncRetry<Int>()
    defer { retry.cancel() }
    var actions = 0
    retry.schedule(binding: 1, current: { 1 }, sleep: { _ in throw CancellationError() }, retry: { actions += 1 })
    await retry.waitUntilSettled()
    XCTAssertEqual(actions, 0)
    XCTAssertFalse(retry.pending)
    retry.schedule(binding: 1, current: { 1 }, sleep: { _ in }, retry: { actions += 1 })
    await retry.waitUntilSettled()
    XCTAssertEqual(actions, 1)
  }

  @MainActor func testWakeupCanScheduleAnotherRetryWithoutLosingIt() async {
    let retry = AutomaticPhotoSyncRetry<Int>()
    let next = RetrySleepGate(entered: expectation(description: "Reentrant retry"))
    defer { retry.cancel(); next.open() }
    var actions = 0
    retry.schedule(binding: 1, current: { 1 }, sleep: { _ in }, retry: {
      actions += 1
      retry.schedule(binding: 1, current: { 1 }, sleep: next.sleep, retry: { actions += 1 })
    })
    await retry.waitUntilSettled()
    await fulfillment(of: [next.entered], timeout: 3)
    XCTAssertEqual(actions, 1)
    XCTAssertTrue(retry.pending)
    next.open(); await retry.waitUntilSettled()
    XCTAssertEqual(actions, 2)
    XCTAssertFalse(retry.pending)
  }
}

@MainActor private final class RetrySleepGate {
  let entered: XCTestExpectation
  private(set) var delays: [Duration] = []
  private var continuation: CheckedContinuation<Void, Never>?
  init(entered: XCTestExpectation) { self.entered = entered }
  func sleep(_ delay: Duration) async throws {
    delays.append(delay)
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      entered.fulfill()
    }
    try Task.checkCancellation()
  }
  func open() { continuation?.resume(); continuation = nil }
}
