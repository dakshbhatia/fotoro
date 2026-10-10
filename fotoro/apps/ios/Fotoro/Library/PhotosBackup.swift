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

struct AutomaticPhotoSyncPreference: Codable, Equatable {
  var enabled = false
  var paused = false
  var origin: String?
}

// Account isolation comes from LibraryStore; the origin is part of the persisted key.
// Initial exclusions do not grow with new arrivals; explicit expansion admits older dated sources.
struct AutomaticPhotoSyncIntake: Codable, Equatable {
  var cutoff: Date
  var includesAll = false
  var initialExcludedIDs: Set<String>?
  var initialWindowDays = 30
  private var expandedRecentWindow = false
  enum CodingKeys: String, CodingKey { case cutoff, includesAll, initialExcludedIDs, initialWindowDays, expandedRecentWindow }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    cutoff = try values.decode(Date.self, forKey: .cutoff)
    includesAll = try values.decodeIfPresent(Bool.self, forKey: .includesAll) ?? false
    initialExcludedIDs = try values.decodeIfPresent(Set<String>.self, forKey: .initialExcludedIDs)
    initialWindowDays = try values.decodeIfPresent(Int.self, forKey: .initialWindowDays) ?? 10
    expandedRecentWindow = try values.decodeIfPresent(Bool.self, forKey: .expandedRecentWindow) ?? false
  }
  mutating func expandToThirtyDays(calendar: Calendar = .current) {
    guard initialWindowDays < 30 else { return }
    cutoff = calendar.date(byAdding: .day, value: initialWindowDays - 30, to: cutoff) ?? cutoff
    initialWindowDays = 30
    expandedRecentWindow = true
  }

  init(now: Date = Date()) { cutoff = RecentPhotosPolicy.cutoff(now: now) }

  mutating func select(_ candidates: [BackupCandidate], existingSourceIDs: Set<String>,
    now: Date = Date()) -> [BackupCandidate] {
    if initialExcludedIDs == nil {
      initialExcludedIDs = Set(candidates.filter {
        !existingSourceIDs.contains($0.id) && ($0.capturedAt.map { $0 < cutoff } ?? true)
      }.map(\.id))
    }
    if expandedRecentWindow {
      initialExcludedIDs?.subtract(candidates.filter { $0.capturedAt.map { $0 >= cutoff && $0 <= now } ?? false }.map(\.id))
    }
    return candidates.filter {
      if existingSourceIDs.contains($0.id) { return true }
      if includesAll { return true }
      if let capturedAt = $0.capturedAt, capturedAt > now { return false }
      return initialExcludedIDs?.contains($0.id) != true
    }
  }
}

struct AutomaticPhotoSyncStatus {
  enum Phase { case off, paused, locked, permissionRequired, background, ready, syncing, partial, needsAttention }
  var enabled: Bool
  var paused: Bool
  var phase: Phase
  var detail: String
}

@MainActor final class AutomaticPhotoSyncObserver: NSObject, PHPhotoLibraryChangeObserver {
  private let changed: @MainActor () -> Void
  init(changed: @escaping @MainActor () -> Void) {
    self.changed = changed
    super.init()
    PHPhotoLibrary.shared().register(self)
  }
  deinit { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
  nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
    Task { @MainActor [weak self] in self?.changed() }
  }
}

struct BackupSource: Codable, Identifiable, Equatable {
  enum Phase: String, Codable { case pending, queued, committed, skipped, failed }
  var id: String
  var photoId: String
  var phase: Phase = .pending
  var message: String?
  var sourceRevision: String?
  var originalSha256: String?
  var skipProcessor: String?
  var isRetainedOriginal: Bool { id.hasPrefix("fotoro-retained-original:") }
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
  func retainQueuedBackup(_ source: BackupSource, currentRevision: String?) throws -> BackupSource {
    var retained = source
    retained.id = "fotoro-retained-original:" + source.photoId
    retained.message = "An earlier original is kept on this device. Continue manually to save it."
    let current = BackupSource(id: source.id, photoId: Wire.id(), sourceRevision: currentRevision)
    try database.write { db in
      guard let bytes = try Data.fetchOne(db, sql: "SELECT value FROM backupSources WHERE id=?", arguments: [source.id]) else {
        throw FotoroError("Photo changed during sync. Try again.")
      }
      let previous = try Wire.decode(BackupSource.self, bytes)
      guard previous.phase == .queued, previous.photoId == source.photoId,
        previous.sourceRevision == source.sourceRevision else { throw FotoroError("Photo changed during sync. Try again.") }
      try putBackupSource(retained, db: db)
      try putBackupSource(current, db: db)
    }
    return current
  }
  private func putBackupSource(_ source: BackupSource, db: Database) throws {
    try db.execute(
      sql:
        "INSERT INTO backupSources(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      arguments: [source.id, try Wire.encode(source)])
  }
  func stageBackup(_ photo: LocalPhoto, source: BackupSource, location: PhotoLocationV1? = nil, bundle: AccountBundle? = nil, capture: PhotoCaptureMetadata? = nil) throws {
    guard photo.photoId == source.photoId else { throw FotoroError("Source identity changed") }
    try database.write { db in
      var queued = source
      queued.phase = .queued
      queued.message = nil
      queued.originalSha256 = photo.metadata.originalSha256
      try put(photo, db: db)
      if let bundle {
        try AnnotationLedger(store: self, accountId: photo.manifest.ownerAccountId).seedMetadata(location: location, capture: capture, photo: photo, bundle: bundle, db: db)
      }
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
struct PhotoSyncItemStatus: Equatable {
  enum Phase: Equatable { case waiting, preparing, uploading, finishing, saved, skipped, needsAttention }
  var sourceRevision: String?
  var photoID: String
  var phase: Phase
}

struct PhotoSyncProgress: Equatable {
  var completed = 0
  var total: Int?
  var skipped = 0
  var failed = 0
  var itemsBySourceID: [String: PhotoSyncItemStatus] = [:]
  var itemsByPhotoID: [String: PhotoSyncItemStatus] = [:]

  func status(for source: RecentPhotoSource) -> PhotoSyncItemStatus? {
    guard let status = itemsBySourceID[source.id], status.sourceRevision == source.revision else { return nil }
    return status
  }

  static func derive(sources: [BackupSource], batchSources: [BackupSource], totalKnown: Bool,
    preparingSourceID: String?, activeTransfer: PhotoSyncItemStatus?,
    pendingPhotoIDs: Set<String>, failedPhotoIDs: Set<String>) -> Self {
    var value = Self(completed: batchSources.filter { $0.phase == .committed }.count,
      total: totalKnown ? batchSources.count : nil,
      skipped: batchSources.filter { $0.phase == .skipped }.count,
      failed: batchSources.filter {
        $0.phase == .failed || (($0.phase == .queued || $0.phase == .committed) && $0.message != nil) || failedPhotoIDs.contains($0.photoId)
      }.count)
    for id in pendingPhotoIDs {
      value.itemsByPhotoID[id] = PhotoSyncItemStatus(photoID: id,
        phase: failedPhotoIDs.contains(id) ? .needsAttention : .waiting)
    }
    for source in sources where !source.isRetainedOriginal {
      var phase: PhotoSyncItemStatus.Phase
      switch source.phase {
      case .committed: phase = .saved
      case .skipped: phase = .skipped
      case .failed: phase = .needsAttention
      case .pending: phase = .waiting
      case .queued: phase = source.message != nil || failedPhotoIDs.contains(source.photoId) ? .needsAttention : .waiting
      }
      if phase != .saved && phase != .skipped {
        if preparingSourceID == source.id { phase = .preparing }
        if activeTransfer?.photoID == source.photoId, let activeTransfer { phase = activeTransfer.phase }
      }
      let item = PhotoSyncItemStatus(sourceRevision: source.sourceRevision, photoID: source.photoId, phase: phase)
      value.itemsBySourceID[source.id] = item
      // Several Photos identifiers can resolve to the same verified original.
      // A saved copy stays saved when another source alias still needs preparation.
      if value.itemsByPhotoID[source.photoId]?.phase != .saved {
        value.itemsByPhotoID[source.photoId] = item
      }
    }
    if let activeTransfer, value.itemsByPhotoID[activeTransfer.photoID]?.phase != .saved {
      value.itemsByPhotoID[activeTransfer.photoID] = activeTransfer
    }
    return value
  }
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
  private(set) var activeSource: BackupSource?
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
      sources.filter { $0.phase == .failed || (($0.phase == .queued || $0.phase == .committed) && $0.message != nil) }.count
    status.skipped = sources.filter { $0.phase == .skipped }.count
    try persist()
  }
  private func countedSources() throws -> [BackupSource] {
    countedSources(from: try store.backupSources())
  }
  func countedSources(from sources: [BackupSource]) -> [BackupSource] {
    sources.filter {
      !$0.isRetainedOriginal && (selectionIDs == nil || selectionIDs?.contains($0.id) == true
        || $0.phase == .queued || $0.phase == .committed)
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
    checkCatalog: @escaping () async throws -> Void,
    checkCatalogOnlyAfterWork: Bool = false,
    restrictQueuedToSnapshot: Bool = false,
    reconcile: ((BackupSource, BackupCandidate) async throws -> Bool)? = nil
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
        let existing = Dictionary(try store.backupSources().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (index, candidate) in candidates.enumerated() {
          if index.isMultiple(of: 128) { await Task.yield(); try fence() }
          var source = try existing[candidate.id] ?? store.backupSource(candidate.id)
          dates[candidate.id] = candidate.capturedAt
          if source.phase == .skipped, candidate.skipReason == nil,
            source.skipProcessor != "camera-original-v1" || source.sourceRevision != candidate.sourceRevision {
            source.phase = .pending
            source.message = nil
            source.skipProcessor = nil
            try store.putBackupSource(source)
          }
          if (source.phase == .pending || source.phase == .failed), source.sourceRevision != candidate.sourceRevision {
            source.sourceRevision = candidate.sourceRevision
            try store.putBackupSource(source)
          }
          if let reason = candidate.skipReason {
            if source.phase == .committed, source.sourceRevision != candidate.sourceRevision {
              // The saved original remains in the catalog; this checkpoint tracks
              // the current Photos revision, including its incomplete resources.
              source = BackupSource(id: source.id, photoId: Wire.id(), sourceRevision: candidate.sourceRevision)
            }
            if source.phase == .pending || source.phase == .failed || source.phase == .skipped {
              source.phase = .skipped
              source.sourceRevision = candidate.sourceRevision
              source.message = reason
              // Snapshot admission can recover without an asset revision change.
              // Only size failures cache the unchanged original's download result.
              source.skipProcessor = "camera-source-v1"
              try store.putBackupSource(source)
            }
          }
        }
        // Sources already queued survive aging out of the current Photos selection.
        let selectedIDs = Set(candidates.map { $0.id })
        let permitted = Dictionary(candidates.filter { $0.skipReason == nil }.map { ($0.id, $0) },
          uniquingKeysWith: { first, _ in first })
        // Verification belongs to the same per-source lifetime as preparation.
        // Snapshot scanning never needs to download every changed original first.
        let verificationIDs = Set(existing.values.filter { source in
          guard reconcile != nil, let candidate = permitted[source.id],
            source.phase == .committed || (restrictQueuedToSnapshot && source.phase == .queued) else { return false }
          return source.sourceRevision != candidate.sourceRevision || source.originalSha256 == nil
        }.map(\.id))
        let work = try store.backupSources().filter {
          verificationIDs.contains($0.id)
            || ($0.phase == .queued && (!restrictQueuedToSnapshot
            || (permitted[$0.id] != nil && permitted[$0.id]?.sourceRevision == $0.sourceRevision)))
            || (($0.phase == .pending || $0.phase == .failed) && selectedIDs.contains($0.id))
        }.sorted { ($0.phase == .queued ? 0 : 1) < ($1.phase == .queued ? 0 : 1) }
        status.sourceTotal = try countedSources().count
        status.phase = .running
        try refreshCounts()
        var performedTransferWork = false
        for var source in work {
          try fence()
          activeSource = source
          defer { activeSource = nil }
          do {
            if verificationIDs.contains(source.id), let candidate = permitted[source.id], let reconcile {
              let available = try await reconcile(source, candidate)
              try fence()
              source = try store.backupSource(source.id)
              activeSource = source
              if !available || source.phase == .committed || source.phase == .skipped {
                try refreshCounts()
                continue
              }
            }
            if source.phase != .queued {
              performedTransferWork = true
              try await stage(source, dates[source.id])
              try fence()
              source = try store.backupSource(source.id)
              activeSource = source
            }
            if source.phase != .committed {
              performedTransferWork = true
              try await upload(source)
            }
            try fence()
            source.phase = .committed
            source.message = nil
            source.originalSha256 = try store.backupPhoto(source.photoId)?.metadata.originalSha256
            try store.putBackupSource(source)
          } catch {
            try fence()
            if (verificationIDs.contains(source.id)
              && NativeDiagnosticOutcome.failure(for: error, taskCancelled: Task.isCancelled) == .cancelled)
              || (error is CancellationError && source.phase == .queued) {
              throw CancellationError()
            }
            // Reconciliation may have replaced the checkpoint before staging failed.
            source = try store.backupSource(source.id)
            if source.phase == .committed {
              // A failed verification/rebind cannot relabel earlier bytes as current.
              source.message = error.localizedDescription
              try store.putBackupSource(source)
              try refreshCounts()
              continue
            }
            // Stop at the first unresolved staged upload so Pending holds at most one new source.
            if source.phase == .queued {
              source.message = error.localizedDescription
              try store.putBackupSource(source)
              throw error
            }
            source.phase = error is CameraMediaAdmissionError ? .skipped : .failed
            source.skipProcessor = error is CameraMediaAdmissionError ? "camera-original-v1" : nil
            source.message = error.localizedDescription
            try store.putBackupSource(source)
          }
          try refreshCounts()
        }
        if !checkCatalogOnlyAfterWork || performedTransferWork { try await checkCatalog() }
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
