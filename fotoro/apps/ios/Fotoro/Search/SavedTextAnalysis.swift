import Foundation
import Observation

enum SavedTextMedia {
  static func permitsPreviewOCR(_ mediaType: String) -> Bool {
    // Live Photos use a container media type but retain a readable still preview.
    switch mediaType {
    case "image/jpeg", "image/png", "image/heic", "application/vnd.fotoro.live-photo": return true
    default: return false
    }
  }
}

struct SavedTextRecognition: Sendable {
  let text: String
  let confidence: Double
}
struct SavedTextPage<Source> {
  let sources: [Source]
  let nextCursor: String?
  let hasMore: Bool
}
enum SavedTextState { case missing, checked, unavailable }
enum SavedTextPhase { case idle, checking, finished, stopped }

@MainActor @Observable final class SavedTextAnalysis<Source> {
  typealias Load = @MainActor (String?, Int) async throws -> SavedTextPage<Source>
  typealias Recognize = @MainActor (Source) async throws -> SavedTextRecognition
  private(set) var checked = 0
  private(set) var existing = 0
  private(set) var unavailable = 0
  private(set) var failed = 0
  private(set) var pageFailed = false
  private(set) var processed = 0
  private(set) var total = 0
  private(set) var hasMore = false
  private(set) var phase = SavedTextPhase.idle
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var batchStart: String?
  @ObservationIgnored private var nextCursor: String?
  private(set) var running = false
  func start(nextBatch: Bool = false, current: @escaping @MainActor () -> Bool,
    load: @escaping Load, state: @escaping @MainActor (Source) throws -> SavedTextState,
    recognize: @escaping Recognize, commit: @escaping @MainActor (Source, SavedTextRecognition) throws -> Bool) {
    guard task == nil, current(), !nextBatch || hasMore else { return }
    if nextBatch { batchStart = nextCursor }
    let cursor = batchStart, token = UUID()
    generation = token
    checked = 0; existing = 0; unavailable = 0; failed = 0; pageFailed = false; processed = 0; total = 0
    phase = .checking; running = true
    task = Task { [weak self] in
      guard let self else { return }
      @MainActor func valid() -> Bool { !Task.isCancelled && generation == token && current() }
      defer {
        if generation == token {
          if phase == .checking { phase = valid() ? .finished : .stopped }
        }
        task = nil; running = false
      }
      do {
        let page = try await load(cursor, 25)
        guard valid() else { return }
        let sources = Array(page.sources.prefix(25))
        total = sources.count; hasMore = page.hasMore; nextCursor = page.nextCursor
        for source in sources {
          guard valid() else { return }
          do {
            switch try state(source) {
            case .checked: existing += 1
            case .unavailable: unavailable += 1
            case .missing:
              let result = try await recognize(source)
              guard valid() else { return }
              // Another text worker or a synced overlay may have completed this
              // original during recognition. The durable slot wins, including empty OCR.
              switch try state(source) {
              case .checked: existing += 1
              case .unavailable: unavailable += 1
              case .missing:
                if try commit(source, result) { checked += 1 }
                else { existing += 1 }
              }
            }
          } catch is CancellationError { phase = .stopped; return }
          catch {
            guard valid() else { return }
            failed += 1
          }
          processed += 1
          await Task.yield()
        }
      } catch is CancellationError { phase = .stopped }
      catch { if valid() { pageFailed = true } }
    }
  }
  func stop() {
    task?.cancel()
    if task != nil { phase = .stopped }
  }
  func reset() {
    stop(); generation = UUID()
    batchStart = nil; nextCursor = nil; hasMore = false
    checked = 0; existing = 0; unavailable = 0; failed = 0; pageFailed = false; processed = 0; total = 0
    phase = .idle
  }
  func waitUntilSettled() async { await task?.value }
}
