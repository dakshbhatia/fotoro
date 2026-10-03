import Foundation
import GRDB
import Observation
import Photos

enum NativeBackupPolicy {
  static func allowsPrivatePhotos(accountId: String?, fixture: Bool) -> Bool {
    guard !fixture, let accountId, UUID(uuidString: accountId) != nil else { return false }
    return !["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
      .contains(accountId.lowercased())
  }
}

struct BackupSource: Codable, Identifiable {
  enum Phase: String, Codable { case pending, queued, committed, skipped, failed }
  var id: String
  var photoId: String
  var phase: Phase = .pending
  var message: String?
  var sourceRevision: String?
  var originalSha256: String?
}

extension LibraryStore {
  func syncEnabled() throws -> Bool {
    try database.read { try String.fetchOne($0, sql: "SELECT value FROM state WHERE key='syncEnabled'") == "1" }
  }
  func setSyncEnabled(_ enabled: Bool) throws {
    try database.write { try $0.execute(sql: "INSERT INTO state(key,value) VALUES('syncEnabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [enabled ? "1" : "0"]) }
  }
  func backupSource(_ id: String) throws -> BackupSource {
    try database.write { db in
      if let bytes = try Data.fetchOne(
        db, sql: "SELECT value FROM backupSources WHERE id=?", arguments: [id])
      {
        return try Wire.decode(BackupSource.self, bytes)
      }
      let source = BackupSource(id: id, photoId: Wire.id())
      try db.execute(
        sql: "INSERT INTO backupSources(id,value) VALUES(?,?)",
        arguments: [id, try Wire.encode(source)])
      return source
    }
  }
  func backupSources() throws -> [BackupSource] {
    try database.read { db in
      try Data.fetchAll(db, sql: "SELECT value FROM backupSources ORDER BY id").map {
        try Wire.decode(BackupSource.self, $0)
      }
    }
  }
  func putBackupSource(_ source: BackupSource) throws {
    try database.write { db in try putBackupSource(source, db: db) }
  }
  private func putBackupSource(_ source: BackupSource, db: Database) throws {
    try db.execute(
      sql:
        "INSERT INTO backupSources(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      arguments: [source.id, try Wire.encode(source)])
  }
  func stageBackup(_ photo: LocalPhoto, source: BackupSource) throws {
    guard photo.photoId == source.photoId else { throw FotoroError("Source identity changed") }
    try database.write { db in
      var queued = source
      queued.phase = .queued
      queued.message = nil
      queued.originalSha256 = photo.metadata.originalSha256
      try put(photo, db: db)
      try putBackupSource(queued, db: db)
      try db.execute(
        sql: "INSERT OR IGNORE INTO transfers(id,value) VALUES(?,?)",
        arguments: [photo.photoId, try Wire.encode(TransferEntry(photo: photo))])
    }
  }
  func backupPhoto(_ id: String) throws -> LocalPhoto? {
    try database.read { db in
      guard
        let bytes = try Data.fetchOne(
          db, sql: "SELECT value FROM photos WHERE id=?", arguments: [id])
      else { return nil }
      return rebased(try Wire.decode(LocalPhoto.self, bytes))
    }
  }
}

struct BackupCandidate {
  var id: String
  var capturedAt: Date?
  var skipReason: String?
  var sourceRevision: String?
}
struct BackupStatus: Codable {
  enum Phase: String, Codable { case idle, scanning, running, paused, failed, partial, complete }
  var phase: Phase = .idle
  var completed = 0
  var pending = 0
  var failed = 0
  var skipped = 0
  var message: String?
  var lastChecked: Date?
  var sourceTotal: Int?
}
@MainActor @Observable final class PhotosBackup {
  let store: LibraryStore
  private(set) var status: BackupStatus
  private var selectionIDs: Set<String>?
  private var task: Task<Void, Never>?
  var isRunning: Bool { task != nil }
  init(store: LibraryStore) throws {
    self.store = store
    selectionIDs = try store.database.read { db in
      try String.fetchOne(db, sql: "SELECT value FROM state WHERE key='backupSelection'").map {
        let bytes: Data
        if let standard = Data(base64Encoded: $0) { bytes = standard }
        else { bytes = try Data(b64: $0) }
        return Set(try Wire.decode([String].self, bytes))
      }
    }
    status = try store.database.read { db in
      guard
        let value = try String.fetchOne(
          db, sql: "SELECT value FROM state WHERE key='backupStatus'"),
        let bytes = Data(base64Encoded: value)
      else { return BackupStatus() }
      return try Wire.decode(BackupStatus.self, bytes)
    }
    if [.running, .scanning].contains(status.phase) { status.phase = .paused }
    try refreshCounts()
  }
  private func persist() throws {
    let encoded = try Wire.encode(status).base64EncodedString()
    try store.database.write { db in
      if let selectionIDs {
        try db.execute(
          sql: "INSERT INTO state(key,value) VALUES('backupSelection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [try Wire.encode(selectionIDs.sorted()).base64EncodedString()])
      }
      try db.execute(
        sql:
          "INSERT INTO state(key,value) VALUES('backupStatus',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        arguments: [encoded])
    }
  }
  func refreshCounts() throws {
    let sources = try countedSources()
    status.completed = sources.filter { $0.phase == .committed }.count
    status.pending = sources.filter { $0.phase == .pending || $0.phase == .queued }.count
    status.failed =
      sources.filter { $0.phase == .failed || ($0.phase == .queued && $0.message != nil) }.count
    status.skipped = sources.filter { $0.phase == .skipped }.count
    try persist()
  }
  private func countedSources() throws -> [BackupSource] {
    try store.backupSources().filter {
      selectionIDs == nil || selectionIDs?.contains($0.id) == true
        || $0.phase == .queued || $0.phase == .committed
    }
  }
  func unpreparedSources() throws -> [BackupSource] {
    try countedSources().filter { $0.phase == .pending || $0.phase == .failed }
  }
  func pause() { task?.cancel() }
  func waitUntilSettled() async { await task?.value }
  func start(
    snapshot: @escaping () async throws -> [BackupCandidate],
    valid: @escaping () -> Bool,
    stage: @escaping (BackupSource, Date?) async throws -> Void,
    upload: @escaping (BackupSource) async throws -> Void,
    checkCatalog: @escaping () async throws -> Void
  ) {
    guard task == nil else { return }
    task = Task {
      defer { task = nil }
      do {
        func fence() throws {
          try Task.checkCancellation()
          guard valid() else { throw CancellationError() }
        }
        try fence()
        status.phase = .scanning
        status.message = nil
        status.sourceTotal = nil
        try persist()
        let candidates = try await snapshot()
        try fence()
        selectionIDs = Set(candidates.map(\.id))
        var dates: [String: Date] = [:]
        for candidate in candidates {
          var source = try store.backupSource(candidate.id)
          dates[candidate.id] = candidate.capturedAt
          if source.phase == .pending || source.phase == .failed {
            source.sourceRevision = candidate.sourceRevision
            try store.putBackupSource(source)
          }
          if let reason = candidate.skipReason, source.phase == .pending || source.phase == .failed
          {
            source.phase = .skipped
            source.message = reason
            try store.putBackupSource(source)
          }
        }
        // Sources already queued survive aging out of the current Photos selection.
        let selectedIDs = Set(candidates.map { $0.id })
        let work = try store.backupSources().filter {
          $0.phase == .queued
            || (($0.phase == .pending || $0.phase == .failed) && selectedIDs.contains($0.id))
        }.sorted { ($0.phase == .queued ? 0 : 1) < ($1.phase == .queued ? 0 : 1) }
        status.sourceTotal = try countedSources().count
        status.phase = .running
        try refreshCounts()
        for var source in work {
          try fence()
          do {
            if source.phase != .queued {
              try await stage(source, dates[source.id])
              try fence()
              source = try store.backupSource(source.id)
            }
            if source.phase != .committed { try await upload(source) }
            try fence()
            source.phase = .committed
            source.message = nil
            source.originalSha256 = try store.backupPhoto(source.photoId)?.metadata.originalSha256
            try store.putBackupSource(source)
          } catch {
            try fence()
            // Stop at the first unresolved staged upload so Pending holds at most one new source.
            if (try store.backupSource(source.id)).phase == .queued {
              source = try store.backupSource(source.id)
              source.message = error.localizedDescription
              try store.putBackupSource(source)
              throw error
            }
            source.phase = .failed
            source.message = error.localizedDescription
            try store.putBackupSource(source)
          }
          try refreshCounts()
        }
        try await checkCatalog()
        try fence()
        status.lastChecked = Date()
        try refreshCounts()
        status.phase =
          status.failed > 0 || status.pending > 0
          ? .failed : status.skipped > 0 ? .partial : .complete
        try persist()
      } catch is CancellationError {
        status.phase = .paused
        status.message = "Resume while the app is open and your account is unlocked."
        try? refreshCounts()
      } catch {
        status.phase = .failed
        status.message = error.localizedDescription
        try? refreshCounts()
      }
    }
  }
}
