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
          "CREATE TABLE IF NOT EXISTS backupSources (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, sourceDate TEXT NOT NULL, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value BLOB NOT NULL)"
      )
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
  func ownedOriginal(digest: String, accountId: String) throws -> LocalPhoto? {
    try database.read { db in
      let cursor = try Row.fetchCursor(db, sql: "SELECT value FROM photos")
      while let row = try cursor.next() {
        let photo = try Wire.decode(LocalPhoto.self, row["value"] as Data)
        if photo.manifest.ownerAccountId == accountId, photo.metadata.originalSha256 == digest,
          ["pending", "committed", "saved"].contains(photo.transferState)
        {
          return rebased(photo)
        }
      }
      return nil
    }
  }
  func cursor() throws -> String? {
    try database.read { try String.fetchOne($0, sql: "SELECT value FROM state WHERE key='cursor'") }
  }
  // A verified caller supplies decoded catalog records; the page and cursor commit together.
  func apply(_ page: ChangePageV1, verified: [String: LocalPhoto]) throws {
    guard page.version == 1 else { throw FotoroError("Unsupported change version") }
    try database.write { db in
      for change in page.changes where change.entity == "photo" {
        if change.deleted {
          try db.execute(sql: "DELETE FROM photos WHERE id=?", arguments: [change.entityId])
        } else {
          guard let photo = verified[change.entityId], photo.photoId == change.entityId else {
            throw FotoroError("Unverified catalog change")
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
      try $0.execute(sql: "DELETE FROM photos; DELETE FROM state; DELETE FROM transfers")
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
