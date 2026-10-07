import Foundation
import GRDB

struct PhotoPeopleFace: Codable, Identifiable, Sendable {
  var id: String
  var photoID: String
  var revision: String
  var groupID: String
  var box: [Int]
  var vector: [Float]
  var confirmed = false
  var rejected = false
}
struct PhotoPeopleGroup: Identifiable, Sendable {
  var id: String
  var name: String?
  var faces: [PhotoPeopleFace]
  var confirmedCount: Int { faces.filter(\.confirmed).count }
}
typealias PhotoPeopleScanScope = PhotoAnalysisScope

extension SearchIndex {
  func preparePeopleTables() throws {
    try database.write { db in
      try db.execute(sql: """
        CREATE TABLE IF NOT EXISTS peopleState(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS peopleGroups(id TEXT PRIMARY KEY,name TEXT);
        CREATE TABLE IF NOT EXISTS peopleFaces(id TEXT PRIMARY KEY,photo TEXT NOT NULL REFERENCES searchRecords(id) ON DELETE CASCADE,revision TEXT NOT NULL,groupId TEXT NOT NULL,value BLOB NOT NULL);
        CREATE INDEX IF NOT EXISTS peopleGroupFaces ON peopleFaces(groupId);
        CREATE TABLE IF NOT EXISTS peopleScans(photo TEXT PRIMARY KEY REFERENCES searchRecords(id) ON DELETE CASCADE,revision TEXT NOT NULL,processor TEXT NOT NULL);
        """)
    }
  }
  func peopleEnabled() throws -> Bool {
    try preparePeopleTables()
    return try database.read { try String.fetchOne($0, sql: "SELECT value FROM peopleState WHERE key='enabled'") == "1" }
  }
  func setPeopleEnabled(_ enabled: Bool) throws {
    try preparePeopleTables()
    try database.write { try $0.execute(sql: "INSERT INTO peopleState(key,value) VALUES('enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [enabled ? "1" : "0"]) }
  }
  private func pendingPeopleQuery(_ scope: PhotoPeopleScanScope, after: PhotoAnalysisCursor?) -> (String, StatementArguments) {
    let (condition, arguments) = metadataAnalysisFilter(scope, after: after)
    return ("FROM searchRecords r LEFT JOIN peopleScans p ON p.photo=r.id WHERE " + condition +
      " AND (p.photo IS NULL OR p.revision!=json_extract(r.value,'$.revision') OR p.processor!=?)", arguments + [PhotoFaceVector.processor])
  }
  func pendingPeopleCount(scope: PhotoPeopleScanScope, after: PhotoAnalysisCursor? = nil) throws -> Int {
    try preparePeopleTables()
    let (sql, arguments) = pendingPeopleQuery(scope, after: after)
    return try database.read { try Int.fetchOne($0, sql: "SELECT count(*) "+sql, arguments: arguments) ?? 0 }
  }
  func pendingPeopleRecords(scope: PhotoPeopleScanScope = PhotoPeopleScanScope(), after: PhotoAnalysisCursor? = nil, limit: Int? = nil) throws -> [SearchRecord] {
    try preparePeopleTables()
    let (sql, arguments) = pendingPeopleQuery(scope, after: after)
    return try database.read { db in
      // SQL eligibility precedes the optional explicit batch; the count remains uncapped.
      let limitSQL = limit.map { " LIMIT \(max(0, $0))" } ?? ""
      return try Row.fetchAll(db, sql: "SELECT r.value "+sql+" ORDER BY r.capture DESC,r.id"+limitSQL,
        arguments: arguments).map { try JSONDecoder().decode(SearchRecord.self, from: $0["value"] as Data) }
    }
  }
  func peopleGroups() throws -> [PhotoPeopleGroup] {
    try preparePeopleTables()
    return try database.read { db in
      let names = try Row.fetchAll(db, sql: "SELECT g.id,g.name FROM peopleGroups g WHERE EXISTS(SELECT 1 FROM peopleFaces f WHERE f.groupId=g.id AND json_extract(f.value,'$.rejected')=0) ORDER BY g.name IS NULL,g.name,g.id LIMIT 200")
      let ids: [String] = names.map { $0["id"] }
      guard !ids.isEmpty else { return [] }
      let faces = try Data.fetchAll(db, sql: "SELECT f.value FROM peopleFaces f JOIN searchRecords r ON r.id=f.photo WHERE f.revision=json_extract(r.value,'$.revision') AND f.groupId IN ("+ids.map { _ in "?" }.joined(separator: ",")+") ORDER BY f.photo,f.id", arguments: StatementArguments(ids))
        .map { try JSONDecoder().decode(PhotoPeopleFace.self, from: $0) }.filter { !$0.rejected }
      let grouped = Dictionary(grouping: faces, by: \.groupID)
      return names.compactMap { row in
        let id: String = row["id"], members = grouped[id] ?? []
        return members.isEmpty ? nil : PhotoPeopleGroup(id: id, name: row["name"], faces: members)
      }.sorted { ($0.name ?? "").localizedStandardCompare($1.name ?? "") == .orderedAscending }
    }
  }
  @discardableResult func applyPeople(_ embeddings: [PhotoFaceEmbedding], photoID: String, revision: String, generation: UInt64) throws -> Bool {
    try preparePeopleTables()
    return try database.write { db in
      guard acceptsGeneration(generation), try String.fetchOne(db, sql: "SELECT value FROM peopleState WHERE key='enabled'") == "1",
        let record = try recordInPeopleTransaction(photoID, db: db), record.revision == revision else { return false }
      try db.execute(sql: "DELETE FROM peopleFaces WHERE photo=?", arguments: [photoID])
      var pool = try Data.fetchAll(db, sql: "SELECT f.value FROM peopleFaces f JOIN searchRecords r ON r.id=f.photo WHERE f.revision=json_extract(r.value,'$.revision') ORDER BY json_extract(f.value,'$.confirmed') DESC,r.capture DESC LIMIT 2000")
        .map { try JSONDecoder().decode(PhotoPeopleFace.self, from: $0) }.filter { !$0.rejected }
      var usedGroups = Set<String>()
      for (offset, embedding) in embeddings.prefix(20).enumerated() {
        try Task.checkCancellation()
        guard acceptsGeneration(generation) else { throw CancellationError() }
        guard let vector = PhotoFaceVector.normalized(embedding.vector), PhotoPersonAssignment(p: UUID().uuidString, n: "face", b: embedding.box).valid else { continue }
        // Matches are tentative. Names never propagate to newly inferred faces until reviewed.
        let matches = pool.filter { !usedGroups.contains($0.groupID) }.map { ($0.groupID, PhotoFaceVector.similarity(vector, $0.vector)) }
          .sorted { $0.1 > $1.1 }
        let best = matches.first
        let runnerUp = matches.first { $0.0 != best?.0 }
        let group = best.flatMap { $0.1 >= 0.6 && (runnerUp == nil || $0.1-(runnerUp?.1 ?? 0) >= 0.08) ? $0.0 : nil } ?? UUID().uuidString.lowercased()
        try db.execute(sql: "INSERT OR IGNORE INTO peopleGroups(id) VALUES(?)", arguments: [group])
        usedGroups.insert(group)
        let face = PhotoPeopleFace(id: photoID+"|"+revision+"|"+String(offset), photoID: photoID,
          revision: revision, groupID: group, box: embedding.box, vector: vector)
        try writePeopleFace(face, db: db); pool.append(face)
      }
      try db.execute(sql: "INSERT OR REPLACE INTO peopleScans(photo,revision,processor) VALUES(?,?,?)", arguments: [photoID,revision,PhotoFaceVector.processor])
      return true
    }
  }
  // Returns changed permitted records so only explicit correction saves reach the owner annotation journal.
  func namePeopleGroup(_ id: String, name: String) throws -> [SearchRecord] {
    try database.write { db in
      guard PhotoPersonAssignment(p: id, n: name, b: [0,0,1,1]).valid else { throw FotoroError("Use a person name of up to 80 characters.") }
      let faces = try peopleFaces(groupID: id, db: db)
      guard !faces.isEmpty else { throw FotoroError("These photos are no longer permitted.") }
      try db.execute(sql: "UPDATE peopleGroups SET name=? WHERE id=?", arguments: [name,id])
      for var face in faces where !face.rejected { face.confirmed = true; try writePeopleFace(face, db: db) }
      return try updatePeopleFacts(Set(faces.map(\.photoID)), db: db)
    }
  }
  func mergePeopleGroups(_ source: String, into target: String) throws -> [SearchRecord] {
    try database.write { db in
      guard source != target, !(try peopleFaces(groupID: target, db: db)).isEmpty else { throw FotoroError("Choose another person group.") }
      let faces = try peopleFaces(groupID: source, db: db)
      for var face in faces { face.groupID = target; face.confirmed = false; try writePeopleFace(face, db: db) }
      return try updatePeopleFacts(Set(faces.map(\.photoID)), db: db)
    }
  }
  func splitPeopleFace(_ id: String, reject: Bool = false) throws -> [SearchRecord] {
    try database.write { db in
      guard let bytes = try Data.fetchOne(db, sql: "SELECT value FROM peopleFaces WHERE id=?", arguments: [id]) else { return [] }
      var face = try JSONDecoder().decode(PhotoPeopleFace.self, from: bytes)
      face.groupID = UUID().uuidString.lowercased(); face.confirmed = false; face.rejected = reject
      try db.execute(sql: "INSERT INTO peopleGroups(id) VALUES(?)", arguments: [face.groupID])
      try writePeopleFace(face, db: db)
      return try updatePeopleFacts([face.photoID], db: db)
    }
  }
  func erasePeople() throws -> [SearchRecord] {
    try preparePeopleTables()
    return try database.write { db in
      let ids = Set(try String.fetchAll(db, sql: "SELECT DISTINCT photo FROM peopleFaces"))
      try db.execute(sql: "DELETE FROM peopleFaces; DELETE FROM peopleScans; DELETE FROM peopleGroups; DELETE FROM peopleState")
      return try updatePeopleFacts(ids, db: db)
    }
  }
  private func recordInPeopleTransaction(_ id: String, db: Database) throws -> SearchRecord? {
    try Data.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [id]).map { try JSONDecoder().decode(SearchRecord.self, from: $0) }
  }
  private func peopleFaces(groupID: String, db: Database) throws -> [PhotoPeopleFace] {
    try Data.fetchAll(db, sql: "SELECT f.value FROM peopleFaces f JOIN searchRecords r ON r.id=f.photo WHERE f.groupId=? AND f.revision=json_extract(r.value,'$.revision')", arguments: [groupID])
      .map { try JSONDecoder().decode(PhotoPeopleFace.self, from: $0) }
  }
  private func writePeopleFace(_ face: PhotoPeopleFace, db: Database) throws {
    try db.execute(sql: "INSERT OR REPLACE INTO peopleFaces(id,photo,revision,groupId,value) VALUES(?,?,?,?,?)",
      arguments: [face.id,face.photoID,face.revision,face.groupID,try JSONEncoder().encode(face)])
  }
  private func updatePeopleFacts(_ ids: Set<String>, db: Database) throws -> [SearchRecord] {
    var changed: [SearchRecord] = []
    for id in ids {
      guard var record = try recordInPeopleTransaction(id, db: db) else { continue }
      let rows = try Row.fetchAll(db, sql: "SELECT f.value,g.name FROM peopleFaces f JOIN peopleGroups g ON g.id=f.groupId WHERE f.photo=? AND f.revision=?", arguments: [id, record.revision])
      let assignments = try rows.compactMap { row -> PhotoPersonAssignment? in
        let face = try JSONDecoder().decode(PhotoPeopleFace.self, from: row["value"] as Data)
        guard face.confirmed, !face.rejected, let name: String = row["name"] else { return nil }
        return PhotoPersonAssignment(p: face.groupID, n: name, b: face.box)
      }
      record.facts = try PhotoPeopleFacts.replacing(record.facts, with: assignments, enforceWireLimits: false)
      if var prior = record.beforeSync {
        prior.facts = try PhotoPeopleFacts.replacing(prior.facts, with: assignments, enforceWireLimits: false)
        record.beforeSync = prior
      }
      try put(record, db: db); changed.append(record)
    }
    return changed
  }
}
