import Foundation
import GRDB

struct LocalPhoto: Codable, Identifiable, Sendable {
  var id: String { photoId }
  var photoId: String
  var manifest: PhotoManifestV1
  var metadata: PhotoMetadataV1
  var transferState: String
  var originalURL: URL?
  var thumbnailURL: URL?
  var previewURL: URL?
  var staged: [String: URL] = [:]
}
final class LibraryStore: @unchecked Sendable {
  static let ownedOriginalQuery = """
    SELECT value FROM photos
    WHERE json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId')=?
      AND json_extract(CAST(value AS TEXT),'$.metadata.originalSha256')=?
      AND json_extract(CAST(value AS TEXT),'$.transferState') IN ('pending','committed','saved')
    ORDER BY CASE json_extract(CAST(value AS TEXT),'$.transferState') WHEN 'pending' THEN 1 ELSE 0 END,id
    LIMIT 1
    """
  let database: DatabaseQueue
  let root: URL
  private var ownedRoots: Set<String> = []
  init(root: URL) throws {
    self.root = root
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    database = try DatabaseQueue(path: root.appendingPathComponent("catalog.sqlite").path)
    try database.write { db in
      try db.execute(
        sql:
          "CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS backupSources (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, sourceDate TEXT NOT NULL, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value BLOB NOT NULL)"
      )
      // Existing catalogs are indexed on opening; SQLite maintains the index for every write path.
      try db.execute(sql: """
        CREATE INDEX IF NOT EXISTS photos_owned_original ON photos(
          json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId'),
          json_extract(CAST(value AS TEXT),'$.metadata.originalSha256'),
          json_extract(CAST(value AS TEXT),'$.transferState'))
        """)
      try db.execute(sql: """
        CREATE INDEX IF NOT EXISTS photos_owned_browse ON photos(
          json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId'), sourceDate DESC, id)
        """)
      // Legacy change feeds hid unsupported media while advancing the same cursor.
      // Re-read once with this reader's capability; the marker and cursor reset commit together.
      if try String.fetchOne(db, sql: "SELECT value FROM state WHERE key='mediaCatalogVersion'") != "1" {
        try db.execute(sql: "DELETE FROM state WHERE key='cursor'")
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('mediaCatalogVersion','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      }
    }
    let history = try database.read { db -> [String] in
      guard
        let value = try String.fetchOne(db, sql: "SELECT value FROM state WHERE key='rootHistory'")
      else { return [] }
      return try Wire.decode([String].self, Data(value.utf8))
    }
    ownedRoots = Set(history.map { ($0 as NSString).standardizingPath })
    ownedRoots.insert((root.path as NSString).standardizingPath)
    let historyValue = String(
      data: try Wire.encode(ownedRoots.sorted()), encoding: .utf8)!
    try database.write { db in
      try db.execute(
        sql:
          "INSERT INTO state(key,value) VALUES('rootHistory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        arguments: [historyValue])
    }
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete],
      ofItemAtPath: root.appendingPathComponent("catalog.sqlite").path)
  }
  // Only paths created inside this account's Media/Pending folders move with its sandbox.
  func rebased(_ photo: LocalPhoto) -> LocalPhoto {
    func owned(_ url: URL?, folder: String) -> URL? {
      guard let url, url.isFileURL else { return url }
      let previousRoot = url.deletingLastPathComponent().deletingLastPathComponent()
      // Legacy production records predate rootHistory; only the exact app-owned layout migrates.
      let legacyLayout =
        previousRoot.deletingLastPathComponent().lastPathComponent == "Fotoro"
        && previousRoot.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
          == "Application Support"
        && previousRoot.deletingLastPathComponent().deletingLastPathComponent()
          .deletingLastPathComponent().lastPathComponent == "Library"
      guard ownedRoots.contains((previousRoot.path as NSString).standardizingPath) || legacyLayout,
        url.deletingLastPathComponent().lastPathComponent == folder,
        url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
          == root.lastPathComponent,
        ![".", "..", ""].contains(url.lastPathComponent)
      else { return url }
      return root.appendingPathComponent(folder).appendingPathComponent(url.lastPathComponent)
    }
    var value = photo
    value.originalURL = owned(photo.originalURL, folder: "Media")
    value.thumbnailURL = owned(photo.thumbnailURL, folder: "Media")
    value.previewURL = owned(photo.previewURL, folder: "Media")
    value.staged = photo.staged.mapValues { owned($0, folder: "Pending")! }
    return value
  }
  func put(_ photo: LocalPhoto) throws { try database.write { db in try put(photo, db: db) } }
  func put(_ photo: LocalPhoto, db: Database) throws {
    try db.execute(
      sql:
        "INSERT INTO photos(id,sourceDate,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET sourceDate=excluded.sourceDate,value=excluded.value",
      arguments: [photo.photoId, photo.metadata.sourceDate, try Wire.encode(photo)])
  }
  func photos(after id: String? = nil, limit: Int = 100) throws -> [LocalPhoto] {
    try database.read { db in
      let rows: [Row]
      if let id,
        let date = try String.fetchOne(
          db, sql: "SELECT sourceDate FROM photos WHERE id=?", arguments: [id])
      {
        rows = try Row.fetchAll(
          db,
          sql:
            "SELECT value FROM photos WHERE sourceDate < ? OR (sourceDate = ? AND id > ?) ORDER BY sourceDate DESC,id LIMIT ?",
          arguments: [date, date, id, min(1000, max(1, limit))])
      } else {
        rows = try Row.fetchAll(
          db, sql: "SELECT value FROM photos ORDER BY sourceDate DESC,id LIMIT ?",
          arguments: [min(1000, max(1, limit))])
      }
      return try rows.map { rebased(try Wire.decode(LocalPhoto.self, $0["value"] as Data)) }
    }
  }
  // Apply ownership before the page limit; shared rows cannot hide an owned cursor.
  // Keep every transfer state, matching the existing saved catalog projection.
  func ownedPhotos(accountId: String, after id: String? = nil, limit: Int = 100) throws -> [LocalPhoto] {
    try database.read { db in
      let rows: [Row]
      let owner = "json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId')"
      if let id, let date = try String.fetchOne(db,
        sql: "SELECT sourceDate FROM photos WHERE id=? AND \(owner)=?", arguments: [id, accountId]) {
        rows = try Row.fetchAll(db, sql: """
          SELECT value FROM photos WHERE \(owner)=?
            AND (sourceDate < ? OR (sourceDate = ? AND id > ?))
          ORDER BY sourceDate DESC,id LIMIT ?
          """, arguments: [accountId, date, date, id, min(1000, max(1, limit))])
      } else {
        rows = try Row.fetchAll(db, sql: """
          SELECT value FROM photos WHERE \(owner)=? ORDER BY sourceDate DESC,id LIMIT ?
          """, arguments: [accountId, min(1000, max(1, limit))])
      }
      return try rows.map { rebased(try Wire.decode(LocalPhoto.self, $0["value"] as Data)) }
    }
  }
  // Read the current first page plus the already admitted range in one snapshot.
  // Newer arrivals cannot push its old tail out; older unvisited rows stay unloaded.
  func ownedPhotoWindow(accountId: String, retaining tail: LocalPhoto?) throws -> [LocalPhoto] {
    try database.read { db in
      let owner = "json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId')"
      var count = 1000
      if let tail, tail.manifest.ownerAccountId == accountId {
        let retained = try Int.fetchOne(db, sql: """
          SELECT COUNT(*) FROM photos WHERE \(owner)=?
            AND (sourceDate > ? OR (sourceDate = ? AND id <= ?))
          """, arguments: [accountId, tail.metadata.sourceDate, tail.metadata.sourceDate, tail.id]) ?? 0
        count = max(count, retained)
      }
      let rows = try Row.fetchAll(db, sql: """
        SELECT value FROM photos WHERE \(owner)=? ORDER BY sourceDate DESC,id LIMIT ?
        """, arguments: [accountId, count])
      return try rows.map { rebased(try Wire.decode(LocalPhoto.self, $0["value"] as Data)) }
    }
  }
  func consumerCommittedCount(accountId: String) throws -> Int {
    try database.read {
      try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM photos WHERE json_extract(CAST(value AS TEXT),'$.manifest.ownerAccountId')=? AND json_extract(CAST(value AS TEXT),'$.transferState') IN ('committed','saved')", arguments: [accountId]) ?? 0
    }
  }
  func consumerPendingAnnotations(accountId: String) throws -> Int {
    try database.read {
      try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM annotations WHERE json_extract(CAST(value AS TEXT),'$.accountId')=? AND (json_extract(CAST(value AS TEXT),'$.draft') IS NOT NULL OR json_extract(CAST(value AS TEXT),'$.conflict')=1)", arguments: [accountId]) ?? 0
    }
  }
  func consumerLastChecked() throws -> Date? {
    try database.read {
      guard let value = try String.fetchOne($0, sql: "SELECT value FROM state WHERE key='consumerLastChecked'"), let time = TimeInterval(value) else { return nil }
      return Date(timeIntervalSince1970: time)
    }
  }
  func setConsumerLastChecked(_ date: Date) throws {
    try database.write { try $0.execute(sql: "INSERT INTO state(key,value) VALUES('consumerLastChecked',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [String(date.timeIntervalSince1970)]) }
  }
  func ownedOriginal(digest: String, accountId: String) throws -> LocalPhoto? {
    try database.read { db in
      guard let bytes = try Data.fetchOne(db, sql: Self.ownedOriginalQuery,
        arguments: [accountId, digest]) else { return nil }
      return rebased(try Wire.decode(LocalPhoto.self, bytes))
    }
  }
  func cursor() throws -> String? {
    try database.read { try String.fetchOne($0, sql: "SELECT value FROM state WHERE key='cursor'") }
  }
  func uploadsPaused() throws -> Bool {
    // Absent means manual Files imports are allowed before Photos sync is selected.
    try database.read {
      try String.fetchOne($0, sql: "SELECT value FROM state WHERE key='uploadsPaused'") == "1"
    }
  }
  func setSyncIntent(enabled: Bool, uploadsPaused: Bool) throws {
    try database.write { db in
      for (key, value) in [("syncEnabled", enabled), ("uploadsPaused", uploadsPaused)] {
        try db.execute(
          sql: "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [key, value ? "1" : "0"])
      }
    }
  }
  func automaticPhotoSyncPreference() throws -> AutomaticPhotoSyncPreference {
    try database.read { db in
      guard let value = try String.fetchOne(db, sql: "SELECT value FROM state WHERE key='automaticPhotoSync'"),
        let bytes = Data(base64Encoded: value) else { return AutomaticPhotoSyncPreference() }
      return try Wire.decode(AutomaticPhotoSyncPreference.self, bytes)
    }
  }
  func automaticPhotoSyncIntake(origin: String) throws -> AutomaticPhotoSyncIntake? {
    try database.read { db in
      guard let value = try String.fetchOne(db, sql: "SELECT value FROM state WHERE key=?",
        arguments: ["automaticPhotoSyncIntake:" + origin]), let bytes = Data(base64Encoded: value) else { return nil }
      return try Wire.decode(AutomaticPhotoSyncIntake.self, bytes)
    }
  }
  func setAutomaticPhotoSyncIntake(_ intake: AutomaticPhotoSyncIntake, origin: String) throws {
    try database.write { db in
      try db.execute(sql: "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        arguments: ["automaticPhotoSyncIntake:" + origin, try Wire.encode(intake).base64EncodedString()])
    }
  }
  func setAutomaticPhotoSyncPreference(_ preference: AutomaticPhotoSyncPreference,
    uploadsPaused: Bool? = nil) throws {
    try database.write { db in
      try db.execute(sql: "INSERT INTO state(key,value) VALUES('automaticPhotoSync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        arguments: [try Wire.encode(preference).base64EncodedString()])
      if let uploadsPaused {
        try db.execute(sql: "INSERT INTO state(key,value) VALUES('uploadsPaused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [uploadsPaused ? "1" : "0"])
      }
    }
  }
  // A verified caller supplies decoded catalog records; the page and cursor commit together.
  func apply(_ page: ChangePageV1, verified: [String: LocalPhoto]) throws {
    guard page.version == 1 else { throw FotoroError("Unsupported change version") }
    try database.write { db in
      for change in page.changes where change.entity == "photo" {
        if change.deleted {
          try db.execute(sql: "DELETE FROM photos WHERE id=?", arguments: [change.entityId])
          try db.execute(sql: "DELETE FROM annotations WHERE id=?", arguments: [change.entityId])
        } else {
          guard var photo = verified[change.entityId], photo.photoId == change.entityId else {
            throw FotoroError("Unverified catalog change")
          }
          if let bytes = try Data.fetchOne(db, sql: "SELECT value FROM photos WHERE id=?", arguments: [photo.id]),
            let previous = try? Wire.decode(LocalPhoto.self, bytes),
            previous.manifest == photo.manifest, previous.metadata == photo.metadata {
            // A verified rescan changes neither the original nor its local immutable copies.
            let cached = rebased(previous)
            photo.originalURL = photo.originalURL ?? cached.originalURL
            photo.thumbnailURL = photo.thumbnailURL ?? cached.thumbnailURL
            photo.previewURL = photo.previewURL ?? cached.previewURL
            photo.staged = cached.staged.merging(photo.staged) { _, current in current }
          }
          try put(photo, db: db)
        }
      }
      if let cursor = page.nextCursor {
        try db.execute(
          sql:
            "INSERT INTO state(key,value) VALUES('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          arguments: [cursor])
      }
    }
  }
  func apply(_ page: ChangePageV1) throws {
    guard page.changes.allSatisfy({ $0.deleted || $0.entity != "photo" }) else {
      throw FotoroError("Decrypt and verify change records before applying")
    }
    try apply(page, verified: [:])
  }
  func existingOperation<T: Decodable>(_ id: String, as type: T.Type) throws -> T? {
    try database.read { db in
      guard
        let bytes = try Data.fetchOne(
          db, sql: "SELECT value FROM operations WHERE id=?", arguments: [id])
      else { return nil }
      return try Wire.decode(type, bytes)
    }
  }
  func operations<T: Decodable>(prefix: String, as type: T.Type) throws -> [T] {
    try database.read { db in
      try Data.fetchAll(
        db, sql: "SELECT value FROM operations WHERE id LIKE ?", arguments: [prefix + "%"]
      ).map { try Wire.decode(type, $0) }
    }
  }
  func operation<T: Codable>(_ id: String, create: () throws -> T) throws -> T {
    try database.write { db in
      if let bytes = try Data.fetchOne(
        db, sql: "SELECT value FROM operations WHERE id=?", arguments: [id])
      {
        return try Wire.decode(T.self, bytes)
      }
      let value = try create()
      try db.execute(
        sql: "INSERT INTO operations(id,value) VALUES(?,?)",
        arguments: [id, try Wire.encode(value)])
      return value
    }
  }
  func removeAll() throws {
    try database.write {
      try $0.execute(sql: "DELETE FROM annotations; DELETE FROM photos; DELETE FROM state; DELETE FROM transfers")
    }
  }
  func write(_ bytes: Data, name: String, pending: Bool = false) throws -> URL {
    let dir = root.appendingPathComponent(pending ? "Pending" : "Media", isDirectory: true)
    try FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let url = dir.appendingPathComponent(name)
    try bytes.write(to: url, options: [.atomic, .completeFileProtection])
    if name.hasPrefix("cache-") { try trimReadCache() }
    return url
  }
  func trimReadCache(limit: Int = 500 * 1024 * 1024) throws {
    let directory = root.appendingPathComponent("Media")
    guard
      let files = try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
    else { return }
    let candidates = try files.filter { $0.lastPathComponent.hasPrefix("cache-") }.map { url in
      (url, try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]))
    }.sorted {
      ($0.1.contentModificationDate ?? .distantPast)
        < ($1.1.contentModificationDate ?? .distantPast)
    }
    var bytes = candidates.reduce(0) { $0 + ($1.1.fileSize ?? 0) }
    for (url, values) in candidates where bytes > limit {
      try FileManager.default.removeItem(at: url)
      bytes -= values.fileSize ?? 0
    }
  }
  func clearDecryptedMedia() throws {
    let path = root.appendingPathComponent("Media")
    if FileManager.default.fileExists(atPath: path.path) {
      try FileManager.default.removeItem(at: path)
    }
  }
}
