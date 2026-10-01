import Foundation
import GRDB

struct TransferEntry: Codable {
  var photo: LocalPhoto
  var publicSample: Bool?
  var reservations: [String: UploadReservationV1] = [:]
  var commits: [String: UploadCommitV1] = [:]
}
@MainActor final class TransferJournal {
  let store: LibraryStore
  let api: APIClient
  let vault: VaultStore
  private(set) var running = false
  var errors: [String: String] = [:]
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
  func resumePending(only allowedPhotoIDs: Set<String>? = nil) async {
    guard vault.isUnlocked, !running else { return }
    running = true
    defer { running = false }
    let generation = vault.generation
    let account = api.session.accountId
    func fence() throws {
      try Task.checkCancellation()
      guard vault.isUnlocked, vault.generation == generation, api.session.accountId == account
      else { throw CancellationError() }
    }
    do {
      for var e in try entries() {
        if let allowedPhotoIDs, !allowedPhotoIDs.contains(e.photo.photoId) { continue }
        do {
          try fence()
          guard e.photo.manifest.ownerAccountId == account else { throw CancellationError() }
          let bundle = try vault.requireBundle()
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
              guard let path = e.photo.staged[id] else {
                throw FotoroError("Pending ciphertext missing; reselect original")
              }
              let bytes = try await Task.detached { try Data(contentsOf: path) }.value
              try fence()
              guard bytes.digest == rep.ciphertextSha256 else {
                throw FotoroError("Staged ciphertext changed")
              }
              do { try await api.upload(bytes, to: reservation.stagingUrl) } catch {
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
                try await api.upload(bytes, to: renewed.stagingUrl)
              }
              try fence()
              commit = try await api.commit(reservation.uploadId)
            }
            try fence()
            guard commit.ciphertextSha256 == rep.ciphertextSha256,
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
            e.photo.manifest, kind: "photo-manifest", accountId: e.photo.manifest.ownerAccountId,
            secret: Data(b64: bundle.signingSecretKey))
          try fence()
          let _: PhotoManifestV1 = try await api.post("/v1/photos", signed)
          try fence()
          e.photo.transferState = "committed"
          try store.put(e.photo)
          try remove(e.photo.photoId)
          for url in e.photo.staged.values { try? FileManager.default.removeItem(at: url) }
          errors[e.photo.photoId] = nil
        } catch is CancellationError { return } catch {
          errors[e.photo.photoId] = error.localizedDescription
        }
      }
    } catch { errors["journal"] = error.localizedDescription }
  }
}
