import Foundation
import Observation
import Photos

@MainActor @Observable final class PhotoPeopleStore {
  private weak var search: LocalSearchStore?
  private var task: Task<Void, Never>?
  private var operation = UUID()
  private(set) var enabled = false
  private(set) var busy = false
  private(set) var groups: [PhotoPeopleGroup] = []
  private(set) var processed = 0
  private(set) var total = 0
  private(set) var includesOlder = false
  private(set) var remaining = 0
  private var unavailableIDs: Set<String> = []
  var unavailable: Int { unavailableIDs.count }
  private var scanScope: PhotoPeopleScanScope?
  private var cursor: PhotoAnalysisCursor?
  var error: String?
  init(search: LocalSearchStore) { self.search = search }
  private var index: SearchIndex? { search?.peopleIndex }
  func refresh() {
    do {
      enabled = try index?.peopleEnabled() ?? false
      groups = search?.peopleSnapshotReady == true && RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        ? (try index?.peopleGroups() ?? []) : []
    } catch { self.error = error.localizedDescription }
  }
  func setEnabled(_ active: Bool) {
    stop()
    do {
      guard let index else { throw FotoroError("Open Photos to prepare the local index.") }
      try index.setPeopleEnabled(active); enabled = active
      if active { scan() }
    } catch { self.error = error.localizedDescription }
  }
  func setIncludesOlder(_ active: Bool) { stop(); includesOlder = active; scanScope = nil; cursor = nil; remaining = 0; unavailableIDs = [] }
  func invalidateScope() { stop(); scanScope = nil; cursor = nil; remaining = 0; unavailableIDs = [] }
  func stop() {
    if busy { remaining += max(0, total - processed) }
    operation = UUID(); task?.cancel(); task = nil; busy = false
  }
  func scan(nextBatch: Bool = false) {
    guard task == nil, enabled, let search, let index else { return }
    guard search.peopleSnapshotReady else { return }
    let scope = nextBatch && scanScope?.query == search.query && scanScope?.scope.people == search.peopleSelection
      ? scanScope! : PhotoPeopleScanScope(query: search.query, people: search.peopleSelection, includesOlder: includesOlder)
    let after = nextBatch && scanScope == scope ? cursor : nil
    scanScope = scope
    if after == nil { cursor = nil; unavailableIDs = [] }

    busy = true; error = nil; processed = 0; total = 0
    let token = UUID(); operation = token
    task = Task { [weak self] in
      guard let self else { return }
      await NativeDiagnosticTrace.$current.withValue(NativeDiagnosticTrace(.people)) {
      let started = ProcessInfo.processInfo.systemUptime
      var outcome: NativeDiagnosticOutcome = .failed
      var reason: NativeDiagnosticReason?
      var successes = 0
      var attempts = 0
      var pending = 0
      NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .people, outcome: .started, step: .analysis))
      defer {
        NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .people, outcome: outcome,
          elapsed: ProcessInfo.processInfo.systemUptime - started, completed: successes,
          pending: pending, attempted: attempts,
          step: .analysis, reason: reason))
      }
      defer { if self.operation == token { self.task = nil; self.busy = false; self.refresh() } }
      do {
        let batch = try await Task.detached(priority: .utility) {
          (try index.pendingPeopleCount(scope: scope, after: after), try index.pendingPeopleRecords(scope: scope, after: after, limit: 500))
        }.value
        let records = batch.1
        pending = batch.0
        try Task.checkCancellation()
        guard self.operation == token else { throw CancellationError() }
        self.total = records.count; self.remaining = max(0, batch.0 - records.count)
        for record in records {
          try Task.checkCancellation()
          guard self.enabled, search.query == scope.query, search.peopleSelection == scope.scope.people, RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else { throw CancellationError() }
          let completed: Bool
          do { completed = try await search.analyzePeople(record, scanScope: scope) }
          catch is CancellationError { throw CancellationError() }
          catch { completed = false; self.error = error.localizedDescription }
          try Task.checkCancellation()
          guard self.operation == token else { throw CancellationError() }
          if completed { self.unavailableIDs.remove(record.id); successes += 1; pending = max(0, pending - 1) }
          else { self.unavailableIDs.insert(record.id) }
          self.processed += 1
          attempts += 1
          self.cursor = PhotoAnalysisCursor(record)
          self.groups = try index.peopleGroups()
          await Task.yield()
        }
        outcome = .completed
        reason = self.unavailableIDs.isEmpty ? nil : .sourceUnavailable
        NativeDiagnosticTrace.current?.completed(.analysis)
      } catch is CancellationError { outcome = .cancelled; reason = .contextChanged }
      catch { reason = .failure(error); self.error = error.localizedDescription }
      }
    }
  }
  private func save(groups groupIDs: Set<String> = [], faceID: String? = nil, _ action: (SearchIndex) throws -> [SearchRecord]) {
    do {
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), let index, let search else {
        throw FotoroError("Allow Photos access to edit People.")
      }
      guard search.peopleSnapshotReady else { throw FotoroError("Photos permissions are being refreshed. Try again after the refresh.") }
      let current = try index.peopleGroups()
      let affected = current.flatMap(\.faces).filter { groupIDs.contains($0.groupID) || $0.id == faceID }
      guard !affected.isEmpty, affected.allSatisfy({ search.canEditPeoplePhoto($0.photoID, revision: $0.revision) }) else {
        throw FotoroError("These photos changed or are no longer permitted.")
      }
      let changed = try action(index)
      for record in changed { try search.publishPeopleEdit(record) }
      refresh()
    } catch { self.error = error.localizedDescription }
  }
  func name(_ id: String, _ name: String) { save(groups: [id]) { try $0.namePeopleGroup(id, name: name) } }
  func merge(_ source: String, into target: String) { save(groups: [source,target]) { try $0.mergePeopleGroups(source, into: target) } }
  func split(_ face: String) { save(faceID: face) { try $0.splitPeopleFace(face) } }
  func reject(_ face: String) { save(faceID: face) { try $0.splitPeopleFace(face, reject: true) } }
  func erase() {
    stop()
    do { _ = try index?.erasePeople(); search?.updateQuery(search?.query ?? ""); refresh() }
    catch { self.error = error.localizedDescription }
  }
}
