import Foundation
import GRDB

struct TransferEntry: Codable {
  var photo: LocalPhoto
  var reservations: [String: UploadReservationV1] = [:]
  var commits: [String: UploadCommitV1] = [:]
}
@MainActor final class TransferJournal {
  let store: LibraryStore
  let api: APIClient
  let vault: VaultStore
  var errors: [String: String] = [:]
  init(store: LibraryStore, api: APIClient, vault: VaultStore) {
    self.store = store
    self.api = api
    self.vault = vault
  }
  func enqueue(_ photo: LocalPhoto) throws {
    try store.database.write { db in
      try db.execute(
        sql: "INSERT OR IGNORE INTO transfers(id,value) VALUES(?,?)",
        arguments: [photo.photoId, try Wire.encode(TransferEntry(photo: photo))])
    }
  }
  func entries() throws -> [TransferEntry] {
    try store.database.read { db in
      try Row.fetchAll(db, sql: "SELECT value FROM transfers ORDER BY id").map {
        try Wire.decode(TransferEntry.self, $0["value"] as Data)
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
  func resumePending() async {
    guard vault.isUnlocked else { return }
    do {
      for var e in try entries() {
        do {
          let bundle = try vault.requireBundle()
          for rep in e.photo.manifest.representations + [e.photo.manifest.metadataRepresentation] {
            let id = rep.binding.representationId
            if e.commits[id] != nil { continue }
            if e.reservations[id] == nil {
              let reservation: UploadReservationV1 = try await api.post(
                "/v1/uploads/reserve",
                ReserveUploadV1(
                  binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
                  ciphertextSha256: rep.ciphertextSha256, operationId: id))
              e.reservations[id] = reservation
              try persist(e)
            }
            let reservation = e.reservations[id]!
            // Retry commit first: an earlier response may have been lost after promotion.
            let commit: UploadCommitV1
            do { commit = try await api.commit(reservation.uploadId) } catch {
              guard let path = e.photo.staged[id] else {
                throw FotoroError("Pending ciphertext missing; reselect original")
              }
              let bytes = try await Task.detached { try Data(contentsOf: path) }.value
              guard bytes.digest == rep.ciphertextSha256 else {
                throw FotoroError("Staged ciphertext changed")
              }
              do { try await api.upload(bytes, to: reservation.stagingUrl) } catch {
                let renewed: UploadReservationV1 = try await api.post(
                  "/v1/uploads/reserve",
                  ReserveUploadV1(
                    binding: rep.binding, ciphertextBytes: rep.ciphertextBytes,
                    ciphertextSha256: rep.ciphertextSha256, operationId: id))
                guard renewed.uploadId == reservation.uploadId else {
                  throw FotoroError("Renewed reservation identity changed")
                }
                e.reservations[id] = renewed
                try persist(e)
                try await api.upload(bytes, to: renewed.stagingUrl)
              }
              commit = try await api.commit(reservation.uploadId)
            }
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
          let _: PhotoManifestV1 = try await api.post("/v1/photos", signed)
          e.photo.transferState = "committed"
          try store.put(e.photo)
          try remove(e.photo.photoId)
          for url in e.photo.staged.values { try? FileManager.default.removeItem(at: url) }
          errors[e.photo.photoId] = nil
        } catch { errors[e.photo.photoId] = error.localizedDescription }
      }
    } catch { errors["journal"] = error.localizedDescription }
  }
}
