import Foundation

enum ConsumerPhotoReference: Hashable, Identifiable, Sendable {
  case device(String), saved(String)
  var id: String {
    switch self { case .device(let id): return "device:" + id; case .saved(let id): return "saved:" + id }
  }
}
struct ConsumerSearchHit: Identifiable, Equatable, Sendable {
  var photo: ConsumerPhotoReference
  var evidence: String?
  var id: String { photo.id }
}
enum ConsumerSearchBinding {
  static func verifiedCopies(sources: [BackupSource], records: [String: SearchRecord]) -> [String: Set<String>] {
    var copies: [String: Set<String>] = [:]
    for source in sources {
      guard let record = records[source.id], record.id == source.id, source.phase == .committed,
        let revision = source.sourceRevision, revision == record.revision,
        let digest = source.originalSha256, (try? Data(b64: digest).count) == 32 else { continue }
      copies[source.photoId, default: []].insert(digest)
    }
    return copies
  }
  static func duplicate(saved: LocalPhoto, copies: [String: Set<String>]) -> Bool {
    saved.manifest.photoId == saved.id && ["committed", "saved"].contains(saved.transferState)
      && copies[saved.id]?.contains(saved.metadata.originalSha256) == true
  }
  static func duplicate(source: BackupSource, record: SearchRecord, saved: LocalPhoto) -> Bool {
    source.id == record.id && source.photoId == saved.id && saved.manifest.photoId == saved.id
      && source.phase == .committed && source.sourceRevision != nil
      && source.sourceRevision == record.revision && source.originalSha256 == saved.metadata.originalSha256
      && ["committed", "saved"].contains(saved.transferState)
      && (try? Data(b64: saved.metadata.originalSha256).count) == 32
  }
}
