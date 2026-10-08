import Foundation
import GRDB
import Observation

struct TransferEntry: Codable {
  var photo: LocalPhoto
  var publicSample: Bool?
  var reservations: [String: UploadReservationV1] = [:]
  var commits: [String: UploadCommitV1] = [:]
}
enum TransferResumeOutcome: Equatable { case idle, finished, cancelled }
@MainActor @Observable final class TransferJournal {
  let store: LibraryStore
  let api: APIClient
  let vault: VaultStore
  private(set) var running = false
  var errors: [String: String] = [:]
  private var foregroundGeneration = UUID()
  private var settlementWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]
  private let background = BackgroundUploadTransport.shared
  private var sourceAccount: String { store.root.lastPathComponent }
  var backgroundPending: Int {
    background.records(accountId: sourceAccount).filter {
      $0.state == .transferring || $0.state == .uploaded
    }.count
  }
  var backgroundStatus: String {
    if let error = background.storageError { return error }
    let records = background.records(accountId: sourceAccount)
    if records.contains(where: { $0.state == .transferring }) {
      return "Encrypted files are scheduled with iOS. Continue saving to finish this batch. Force quitting pauses uploads."
    }
    if let failure = records.first(where: { $0.state == .failed })?.message { return failure }
    if records.contains(where: { $0.state == .uploaded }) {
      return "Encrypted uploads finished. Unlock your account and continue saving to finish this batch."
    }
    return "Save picks to prepare a batch. iOS can finish already scheduled encrypted uploads."
  }
  func pause(cancelBackground: Bool = false) {
    foregroundGeneration = UUID()
    background.interruptWaiters(accountId: sourceAccount)
    if cancelBackground {
      do { try background.cancel(accountId: sourceAccount) }
      catch { errors["journal"] = error.localizedDescription }
    }
  }
  init(store: LibraryStore, api: APIClient, vault: VaultStore) {
    self.store = store
    self.api = api
    self.vault = vault
  }
  func enqueue(_ photo: LocalPhoto, publicSample: Bool = false) throws {
    try store.database.write { db in
      try db.execute(
        sql: "INSERT OR IGNORE INTO transfers(id,value) VALUES(?,?)",
        arguments: [
          photo.photoId, try Wire.encode(TransferEntry(photo: photo, publicSample: publicSample)),
        ])
    }
  }
  func entries() throws -> [TransferEntry] {
    try store.database.read { db in
      try Row.fetchAll(db, sql: "SELECT value FROM transfers ORDER BY id").map {
        var entry = try Wire.decode(TransferEntry.self, $0["value"] as Data)
        entry.photo = store.rebased(entry.photo)
        return entry
      }
    }
  }
  func persist(_ e: TransferEntry) throws {
    try store.database.write {
      try $0.execute(
        sql: "UPDATE transfers SET value=? WHERE id=?",
        arguments: [try Wire.encode(e), e.photo.photoId])
    }
  }
  private func remove(_ id: String) throws {
    try store.database.write {
      try $0.execute(sql: "DELETE FROM transfers WHERE id=?", arguments: [id])
    }
  }
  func waitUntilSettled() async throws {
    try Task.checkCancellation()
    guard running else { return }
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
        else if !running { continuation.resume() }
        else { settlementWaiters[id] = continuation }
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.settlementWaiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
      }
    }
  }
  @discardableResult func resumePending(only allowedPhotoIDs: Set<String>? = nil) async -> TransferResumeOutcome {
    guard vault.isUnlocked, !running else { return .idle }
    running = true
    defer {
      running = false
      let waiters = Array(settlementWaiters.values)
      settlementWaiters.removeAll()
      for waiter in waiters { waiter.resume() }
    }
    let generation = vault.generation
    let foreground = foregroundGeneration
    let account = api.session.accountId
    let backgroundAllowed = BackgroundUploadPolicy.permits(
      accountId: account, fixture: api.session.fixture)
    func stillAuthorized() -> Bool {
      api.session.isSignedIn && vault.isUnlocked && vault.generation == generation && api.session.accountId == account
        && foregroundGeneration == foreground
    }
    func fence() throws {
      try Task.checkCancellation()
      guard stillAuthorized() else { throw CancellationError() }
    }
    do {
      if backgroundAllowed {
        try background.configure(
          accountId: account, fixture: api.session.fixture, baseURL: api.baseURL)
      }
      for var e in try entries() {
        if let allowedPhotoIDs, !allowedPhotoIDs.contains(e.photo.photoId) { continue }
        do {
          try fence()
          guard e.photo.manifest.ownerAccountId == account else { throw CancellationError() }
          if CameraMedia.isMotion(e.photo.metadata.mediaType) {
            let page: ChangePageV1 = try await api.get("/v1/changes?limit=1&media=1")
            try fence()
            guard page.mediaVersion == 1 else { throw FotoroError("Update the Fotoro service before syncing video or Live Photos") }
          }
          for rep in e.photo.manifest.representations + [e.photo.manifest.metadataRepresentation] {
            try fence()
            let id = rep.binding.representationId
            if e.commits[id] != nil { continue }
            if e.reservations[id] == nil {
              let reservation: UploadReservationV1 = try await api.post(
                "/v1/uploads/reserve",
                ReserveUploadV1(
                  binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
                  ciphertextSha256: rep.ciphertextSha256, operationId: id))
              try fence()
              e.reservations[id] = reservation
              try persist(e)
            }
            let reservation = e.reservations[id]!
            // Retry commit first: an earlier response may have been lost after promotion.
            let commit: UploadCommitV1
            do { commit = try await api.commit(reservation.uploadId) } catch {
              try fence()
              guard (error as? FotoroError)?.message == "UPLOAD_INCOMPLETE" else { throw error }
              guard let path = e.photo.staged[id] else {
                throw FotoroError("Pending ciphertext missing; reselect original")
              }
              func upload(_ reservation: UploadReservationV1) async throws {
                try fence()
                if backgroundAllowed, let account {
                  try await background.upload(
                    file: path, pendingDirectory: store.root.appendingPathComponent("Pending"),
                    representation: rep, reservation: reservation, accountId: account,
                    baseURL: api.baseURL, stillAuthorized: stillAuthorized)
                } else {
                  // Public fixture samples use only the foreground loopback transport.
                  let bytes = try await Task.detached { try Data(contentsOf: path) }.value
                  try fence()
                  guard bytes.digest == rep.ciphertextSha256 else {
                    throw FotoroError("Staged ciphertext changed")
                  }
                  try await api.upload(bytes, to: reservation.stagingUrl)
                }
              }
              do { try await upload(reservation) } catch is CancellationError {
                throw CancellationError()
              } catch {
                try fence()
                let renewed: UploadReservationV1 = try await api.post(
                  "/v1/uploads/reserve",
                  ReserveUploadV1(
                    binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
                    ciphertextSha256: rep.ciphertextSha256, operationId: id))
                try fence()
                guard renewed.uploadId == reservation.uploadId else {
                  throw FotoroError("Renewed reservation identity changed")
                }
                e.reservations[id] = renewed
                try persist(e)
                try await upload(renewed)
              }
              try fence()
              commit = try await api.commit(reservation.uploadId)
            }
            try fence()
            guard commit.version == 1, commit.uploadId == reservation.uploadId,
              commit.ciphertextSha256 == rep.ciphertextSha256,
              commit.ciphertextBytes == rep.ciphertextBytes
            else { throw FotoroError("Commit digest mismatch") }
            e.commits[id] = commit
            try persist(e)
          }
          for i in e.photo.manifest.representations.indices {
            let id = e.photo.manifest.representations[i].binding.representationId
            e.photo.manifest.representations[i].objectId = e.commits[id]!.objectId
          }
          e.photo.manifest.metadataRepresentation.objectId =
            e.commits[e.photo.manifest.metadataRepresentation.binding.representationId]!.objectId
          let signed = try CryptoAdapter().sign(
            e.photo.manifest, kind: CameraMedia.manifestKind(for: e.photo.metadata.mediaType), accountId: e.photo.manifest.ownerAccountId,
            secret: Data(b64: vault.requireBundle().signingSecretKey))
          try fence()
          let _: PhotoManifestV1 = try await api.post("/v1/photos", signed)
          try fence()
          e.photo.transferState = "committed"
          try store.put(e.photo)
          try remove(e.photo.photoId)
          if let account { try? background.forget(accountId: account, photoId: e.photo.photoId) }
          for url in e.photo.staged.values { try? FileManager.default.removeItem(at: url) }
          errors[e.photo.photoId] = nil
        } catch is CancellationError { return .cancelled } catch {
          errors[e.photo.photoId] = error.localizedDescription
        }
      }
    } catch is CancellationError { return .cancelled } catch { errors["journal"] = error.localizedDescription }
    return .finished
  }
}
