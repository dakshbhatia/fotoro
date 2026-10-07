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
  func stop() { operation = UUID(); task?.cancel(); task = nil; busy = false }
  func scan() {
    guard task == nil, enabled, let search, let index else { return }
    busy = true; error = nil; processed = 0
    let token = UUID(); operation = token
    task = Task { [weak self] in
      guard let self else { return }
      defer { if self.operation == token { self.task = nil; self.busy = false; self.refresh() } }
      do {
        let records = try index.pendingPeopleRecords(); self.total = records.count
        for record in records {
          try Task.checkCancellation()
          guard self.enabled, RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else { throw CancellationError() }
          if try await search.analyzePeople(record) { self.processed += 1 }
          try Task.checkCancellation()
          guard self.operation == token else { throw CancellationError() }
          self.groups = try index.peopleGroups()
          await Task.yield()
        }
      } catch is CancellationError {} catch { self.error = error.localizedDescription }
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
