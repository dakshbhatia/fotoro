import Foundation

enum ConsumerSyncState: String, Codable, Sendable { case notStarted, preparing, uploading, checking, upToDate, paused, offline, needsAttention }
enum ConsumerSyncAction: String, Sendable { case start, `continue`, retry, signIn, openSettings, review, none }
struct ConsumerSyncSummary: Equatable, Sendable {
  var state: ConsumerSyncState = .notStarted
  var completedPhotos: Int?
  var totalPhotos: Int?
  var skippedPhotos = 0
  var lastCheckedAt: Date?
  var detail: String?
  var action: ConsumerSyncAction = .signIn
  static func derive(_ facts: ConsumerSyncFacts) -> Self {
    guard facts.unlocked else { return Self() }
    var value = Self(completedPhotos: facts.completed, totalPhotos: facts.total,
      skippedPhotos: facts.skipped, lastCheckedAt: facts.lastChecked, detail: facts.detail)
    if facts.preparing { value.state = .preparing; value.action = .none }
    else if facts.uploading { value.state = .uploading; value.action = .none }
    else if facts.checking { value.state = .checking; value.action = .none }
    else if facts.paused && facts.pending > 0 { value.state = .paused; value.action = .continue }
    else if facts.offline { value.state = .offline; value.action = facts.pending > 0 ? .retry : .start }
    else if facts.failed > 0 || facts.skipped > 0 || facts.pending > 0 || facts.unprepared > 0 {
      value.state = .needsAttention
      value.action = facts.pending > 0 ? .retry : .start
      if value.detail == nil {
        value.detail = "Some photos still need attention."
      }
    } else {
      value.state = facts.completed > 0 ? .upToDate : .notStarted
      value.action = .start
      if facts.annotationsPending > 0, value.detail == nil { value.detail = "Photo changes are saved on this device." }
    }
    return value
  }
}
struct ConsumerSyncFacts {
  var unlocked = false
  var paused = false
  var preparing = false
  var uploading = false
  var checking = false
  var offline = false
  var completed = 0
  var total: Int?
  var pending = 0
  var unprepared = 0
  var failed = 0
  var skipped = 0
  var annotationsPending = 0
  var lastChecked: Date?
  var detail: String?
}
