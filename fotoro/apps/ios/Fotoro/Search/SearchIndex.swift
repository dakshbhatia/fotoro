import Foundation
import GRDB

/// A device-local index. Network synchronization is handled by the owner annotation journal.
final class SearchIndex: @unchecked Sendable {
  let database: DatabaseQueue
  private let generationLock = NSLock()
  private var workGeneration: UInt64 = 0
  init(root: URL? = nil) throws {
    var configuration = Configuration()
    configuration.prepareDatabase { db in
      db.add(
        function: DatabaseFunction("searchDecay", argumentCount: 2, pure: true) { values in
          guard let at = Double.fromDatabaseValue(values[0]),
            let now = Double.fromDatabaseValue(values[1])
          else { return 0.0 }
          return pow(0.5, max(0, now - at) / (30 * 86400))
        })
      db.add(
        function: DatabaseFunction("searchTextEvidence", argumentCount: 2, pure: true) { values in
          guard let data = Data.fromDatabaseValue(values[0]),
            let query = String.fromDatabaseValue(values[1]),
            let record = try? JSONDecoder().decode(SearchRecord.self, from: data)
          else { return -1 }
          let words = Self.words(query)
          func matches(_ source: String) -> Bool {
            let tokens = Set(Self.words(source))
            guard let last = words.last else { return false }
            return words.dropLast().allSatisfy { tokens.contains($0) }
              && tokens.contains { $0.hasPrefix(last) }
          }
          if matches((record.captions + record.keywords).joined(separator: " ")) { return 2 }
          if matches((record.filename as NSString).deletingPathExtension) { return 3 }
          if record.ocrStatus == .complete, matches(record.ocrText) { return 4 }
          return -1
        })
    }
    if var root {
      try FileManager.default.createDirectory(
        at: root, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try root.setResourceValues(values)
      database = try DatabaseQueue(
        path: root.appendingPathComponent("search.sqlite").path, configuration: configuration)
    } else {
      database = try DatabaseQueue(configuration: configuration)
    }
    try database.write { db in
      try db.execute(
        sql: """
          CREATE TABLE IF NOT EXISTS searchRecords(id TEXT PRIMARY KEY, scope TEXT NOT NULL, capture REAL, favorite INTEGER NOT NULL, moment INTEGER NOT NULL, ocrState TEXT NOT NULL, preview INTEGER NOT NULL, burst TEXT, value BLOB NOT NULL);
          CREATE INDEX IF NOT EXISTS searchSourceDate ON searchRecords(scope,capture);
          CREATE TABLE IF NOT EXISTS searchTerms(meaning TEXT NOT NULL, term TEXT NOT NULL, display TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY(meaning,term));
          CREATE INDEX IF NOT EXISTS searchTermPrefix ON searchTerms(term,meaning);
          CREATE TABLE IF NOT EXISTS searchPostings(meaning TEXT NOT NULL, photo TEXT NOT NULL REFERENCES searchRecords(id) ON DELETE CASCADE, evidence INTEGER NOT NULL, confidence REAL NOT NULL, display TEXT NOT NULL DEFAULT '', PRIMARY KEY(meaning,photo));
          CREATE INDEX IF NOT EXISTS searchEvidence ON searchPostings(meaning,evidence,photo);
          CREATE TABLE IF NOT EXISTS searchEvents(kind TEXT NOT NULL, meaning TEXT NOT NULL, photo TEXT NOT NULL, scope TEXT NOT NULL, session TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(kind,meaning,photo,scope,session));
          CREATE INDEX IF NOT EXISTS searchHistory ON searchEvents(kind,meaning,scope,photo,at);
          CREATE TABLE IF NOT EXISTS searchPins(meaning TEXT NOT NULL, scope TEXT NOT NULL, photo TEXT NOT NULL, PRIMARY KEY(meaning,scope));
          CREATE VIRTUAL TABLE IF NOT EXISTS searchFTS USING fts5(id UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
          """)
      if !(try db.columns(in: "searchPostings")).contains(where: { $0.name == "display" }) {
        try db.execute(
          sql: "ALTER TABLE searchPostings ADD COLUMN display TEXT NOT NULL DEFAULT ''")
      }
    }
    if let root {
      // Also protect WAL/SHM files, including already-existing stores.
      for file in try FileManager.default.contentsOfDirectory(
        at: root, includingPropertiesForKeys: nil)
      {
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
      }
    }
  }
  private func decode(_ row: Row) throws -> SearchRecord {
    try JSONDecoder().decode(SearchRecord.self, from: row["value"] as Data)
  }
  func record(_ id: String) throws -> SearchRecord? {
    try database.read { db in
      try Row.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [id]).map(
        decode)
    }
  }
  func applyOCR(
    _ result: SearchOCRResult?, status: SearchOCRStatus, photoID: String, revision: String,
    generation: UInt64? = nil
  ) throws -> Bool {
    try database.write { db in
      guard acceptsGeneration(generation) else { return false }
      guard
        var r = try Row.fetchOne(
          db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]
        ).map(decode), r.revision == revision
      else { return false }
      r.ocrText = result?.text ?? ""
      r.ocrConfidence = result?.confidence ?? 0
      r.ocrStatus = status
      r.previewAvailable = result != nil || status == .failed
      try put(r, db: db)
      return true
    }
  }
  #if !FOTORO_LOCAL_PREVIEW
  @discardableResult func applyAnnotations(_ value: PhotoAnnotationsV1, photoID: String, revision: String, accountId: String) throws -> Bool {
    try database.write { db in
      guard var record = try Row.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]).map(decode), record.revision == revision else { return false }
      if record.beforeSync == nil {
        record.beforeSync = LocalSearchFields(labels: record.labels, captions: record.captions, keywords: record.keywords, facts: record.facts, favorite: record.favorite, ocrText: record.ocrText, ocrConfidence: record.ocrConfidence, ocrStatus: record.ocrStatus)
      }
      record.syncedAccountId = accountId
      record.labels = value.labels ?? []
      record.captions = value.caption.map { [$0] } ?? []
      record.keywords = value.keywords ?? []
      record.facts = value.facts ?? []
      record.favorite = value.favorite ?? record.favorite
      if let ocr = value.ocr, ocr.processor == record.processor {
        record.ocrText = ocr.text
        record.ocrConfidence = ocr.confidence
        record.ocrStatus = .complete
      }
      try put(record, db: db)
      return true
    }
  }
  #endif
  func clearSyncedAnnotations() throws {
    try database.write { db in
      let records = try Row.fetchAll(db, sql: "SELECT value FROM searchRecords").map(decode)
      for var record in records where record.syncedAccountId != nil {
        if let prior = record.beforeSync {
          record.labels = prior.labels; record.captions = prior.captions; record.keywords = prior.keywords
          record.facts = prior.facts; record.favorite = prior.favorite
          record.ocrText = prior.ocrText; record.ocrConfidence = prior.ocrConfidence; record.ocrStatus = prior.ocrStatus
        } else { record.labels = []; record.ocrText = ""; record.ocrConfidence = 0; record.ocrStatus = .pending }
        record.syncedAccountId = nil; record.beforeSync = nil
        try put(record, db: db)
        try db.execute(sql: "DELETE FROM searchPins WHERE photo=?; DELETE FROM searchEvents WHERE photo=?", arguments: [record.id, record.id])
      }
      try db.execute(sql: "DELETE FROM searchTerms WHERE meaning NOT IN (SELECT meaning FROM searchPostings)")
    }
  }
  func pendingRecords() throws -> [SearchRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql:
          "SELECT value FROM searchRecords WHERE ocrState IN ('pending','unavailable') ORDER BY favorite DESC,capture DESC,id"
      ).map(decode)
    }
  }
  func setWorkGeneration(_ generation: UInt64) throws {
    generationLock.lock()
    defer { generationLock.unlock() }
    workGeneration = generation
  }
  private func acceptsGeneration(_ generation: UInt64?) -> Bool {
    guard let generation else { return true }
    generationLock.lock()
    defer { generationLock.unlock() }
    return workGeneration == generation
  }
  @discardableResult func replacePermitted(
    _ records: [SearchRecord], generation: UInt64? = nil, progress: (@Sendable (Int) -> Void)? = nil
  ) throws -> Bool {
    do {
      return try database.write { db in
        guard acceptsGeneration(generation) else { return false }
        try db.execute(
          sql:
            "CREATE TEMP TABLE IF NOT EXISTS permittedSearchIDs(id TEXT PRIMARY KEY); DELETE FROM permittedSearchIDs"
        )
        for (offset, incoming) in records.enumerated() {
          guard acceptsGeneration(generation) else { throw CancellationError() }
          try db.execute(
            sql: "INSERT INTO permittedSearchIDs(id) VALUES(?)", arguments: [incoming.id])
          var r = incoming
          if let old = try Row.fetchOne(
            db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [r.id]
          ).map(decode) {
            r.labels = old.revision == r.revision ? old.labels : (old.beforeSync?.labels ?? old.labels)
            if old.revision == r.revision {
              r.syncedAccountId = old.syncedAccountId
              r.beforeSync = old.beforeSync
            }
            if old.revision == r.revision, old.processor == r.processor {
              r.ocrText = old.ocrText
              r.ocrConfidence = old.ocrConfidence
              r.ocrStatus = old.ocrStatus
              r.previewAvailable = old.previewAvailable
            }
          }
          try put(r, db: db)
          progress?(offset + 1)
        }
        guard acceptsGeneration(generation) else { throw CancellationError() }
        try db.execute(
          sql:
            "DELETE FROM searchFTS WHERE id NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchRecords WHERE id NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchPins WHERE photo NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchEvents WHERE photo != '' AND photo NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchTerms WHERE meaning NOT IN (SELECT meaning FROM searchPostings)"
        )
        if records.isEmpty {
          try db.execute(sql: "DELETE FROM searchEvents; DELETE FROM searchPins")
        }
        return true
      }
    } catch is CancellationError { return false }
  }
  func put(_ record: SearchRecord) throws { try database.write { try put(record, db: $0) } }
  private func put(_ r: SearchRecord, db: Database) throws {
    try db.execute(
      sql:
        "INSERT INTO searchRecords(id,scope,capture,favorite,moment,ocrState,preview,burst,value) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,capture=excluded.capture,favorite=excluded.favorite,moment=excluded.moment,ocrState=excluded.ocrState,preview=excluded.preview,burst=excluded.burst,value=excluded.value",
      arguments: [
        r.id, r.scope, r.capturedAt?.timeIntervalSince1970, r.favorite, r.currentMoment,
        r.ocrStatus.rawValue, r.previewAvailable, r.burstID, try JSONEncoder().encode(r),
      ])
    try db.execute(
      sql: "DELETE FROM searchPostings WHERE photo=?; DELETE FROM searchFTS WHERE id=?",
      arguments: [r.id, r.id])
    try db.execute(
      sql: "INSERT INTO searchFTS(id,text) VALUES(?,?)",
      arguments: [
        r.id,
        (r.captions + r.keywords + [r.filename, r.ocrStatus == .complete ? r.ocrText : ""]).joined(
          separator: " "),
      ])
    func add(
      _ display: String, relation: SearchRelation, evidence: Int, confidence: Double = 1,
      supplied: Bool = false
    ) throws {
      let whole = SearchNormalization.text(display).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !whole.isEmpty else { return }
      let words = Self.words(whole).filter { supplied || Self.suggestible($0) }
      guard !words.isEmpty else { return }
      let phrase = supplied ? whole : words.joined(separator: " ")
      let meaning = relation.rawValue + ":" + phrase
      let searchable = Set(words + [phrase])
      for word in searchable {
        try db.execute(
          sql: "INSERT OR IGNORE INTO searchTerms(meaning,term,display,relation) VALUES(?,?,?,?)",
          arguments: [meaning, word, display, relation.rawValue])
      }
      try db.execute(
        sql:
          "INSERT INTO searchPostings(meaning,photo,evidence,confidence,display) VALUES(?,?,?,?,?) ON CONFLICT(meaning,photo) DO UPDATE SET evidence=min(evidence,excluded.evidence),confidence=max(confidence,excluded.confidence),display=excluded.display",
        arguments: [meaning, r.id, evidence, confidence, display])
    }
    for label in r.labels { try add(label, relation: .label, evidence: 0, supplied: true) }
    for fact in r.facts { try add(fact, relation: .metadata, evidence: 1, supplied: true) }
    if r.favorite { try add("favorite", relation: .metadata, evidence: 1) }
    if let date = r.capturedAt {
      let iso = ISO8601DateFormatter()
      iso.formatOptions = [.withFullDate]
      iso.timeZone = TimeZone(secondsFromGMT: 0)
      try add(iso.string(from: date), relation: .metadata, evidence: 1, supplied: true)
      for word in Self.words(date.formatted(date: .complete, time: .omitted))
      where Self.suggestible(word) { try add(word, relation: .metadata, evidence: 1) }
    }
    for caption in r.captions + r.keywords {
      for word in Self.words(caption) where Self.suggestible(word) {
        try add(word, relation: .text, evidence: 2)
      }
    }
    for word in Self.words((r.filename as NSString).deletingPathExtension)
    where Self.suggestible(word) { try add(word, relation: .text, evidence: 3) }
    if r.ocrStatus == .complete {
      for word in Self.words(r.ocrText) where Self.suggestible(word) {
        try add(word, relation: .text, evidence: 4, confidence: r.ocrConfidence)
      }
    }
  }
  private static func words(_ text: String) -> [String] {
    SearchNormalization.text(text).components(separatedBy: CharacterSet.alphanumerics.inverted)
      .filter { !$0.isEmpty }
  }
  private static let noise: Set<String> = [
    "a", "an", "the", "and", "or", "of", "on", "in", "to", "for", "is", "it", "at", "by", "with",
    "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "img", "dsc", "dcim",
  ]
  private static func suggestible(_ word: String) -> Bool {
    word.count > 1 && !noise.contains(word) && word.contains(where: { $0.isLetter })
  }
  @discardableResult func setLabels(_ labels: [String], photoID: String) throws -> Bool {
    try database.write { db in
      guard
        var r = try Row.fetchOne(
          db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]
        ).map(decode)
      else { return false }
      if var prior = r.beforeSync {
        var removed = r.labels
        var added: [String] = []
        for label in labels {
          if let index = removed.firstIndex(of: label) { removed.remove(at: index) }
          else { added.append(label) }
        }
        for label in removed {
          if let index = prior.labels.firstIndex(of: label) { prior.labels.remove(at: index) }
        }
        prior.labels += added
        r.beforeSync = prior
      }
      r.labels = labels
      try put(r, db: db)
      return true
    }
  }
  private func filter(_ scope: SearchScope) -> (String, StatementArguments) {
    var sql = "r.scope=?"
    var args: StatementArguments = [scope.source]
    if let from = scope.from {
      sql += " AND r.capture>=?"
      args += [from.timeIntervalSince1970]
    }
    if let through = scope.through {
      sql += " AND r.capture<=?"
      args += [through.timeIntervalSince1970]
    }
    return (sql, args)
  }
  func search(
    _ query: String, scope: SearchScope = SearchScope(), acceptedMeaningID: String? = nil,
    previous: SearchResponse? = nil, now: Date = Date(), generation: UInt64 = 0
  ) throws -> SearchResponse {
    try database.read { db in
      var response = SearchResponse(query: query, generation: generation)
      let (condition, scopeArgs) = filter(scope)
      let coverage = try Row.fetchOne(
        db,
        sql:
          "SELECT count(*) total,sum(ocrState='complete') ocrComplete,sum(preview) previews FROM searchRecords r WHERE \(condition)",
        arguments: scopeArgs)!
      response.total = coverage["total"]
      response.indexed = coverage["ocrComplete"] ?? 0
      response.availablePreviews = coverage["previews"] ?? 0
      let q = SearchNormalization.text(query).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !q.isEmpty else { return response }
      // Query the full indexed prefix range before LIMIT. Scope and eligibility are applied in SQL.
      var meaningArgs: StatementArguments = [
        q, now.timeIntervalSince1970, scope.key, q, q + "\u{10ffff}",
      ]
      meaningArgs += scopeArgs
      meaningArgs += [acceptedMeaningID ?? ""]
      let rows = try Row.fetchAll(
        db,
        sql: """
          SELECT t.meaning,min(t.term) term,min(p.display) display,t.relation,min(p.evidence) evidence,count(DISTINCT p.photo) eligible,
            max(t.term=?) exact,max(r.moment) moment,
            coalesce((SELECT sum(searchDecay(e.at,?)) FROM searchEvents e WHERE e.kind='accept' AND e.meaning=t.meaning AND e.scope=?),0) accepted
          FROM searchTerms t JOIN searchPostings p ON p.meaning=t.meaning JOIN searchRecords r ON r.id=p.photo
          WHERE t.term>=? AND t.term<? AND \(condition)
          GROUP BY t.meaning
          ORDER BY (t.meaning=?) DESC,exact DESC,accepted DESC,moment DESC,evidence ASC,term ASC,t.meaning ASC LIMIT 6
          """, arguments: meaningArgs)
      response.meanings = rows.map { row in
        SearchMeaning(
          id: row["meaning"], term: row["term"], display: row["display"],
          relation: SearchRelation(rawValue: row["relation"])!, evidenceClass: row["evidence"],
          eligibleCount: row["eligible"])
      }
      guard let meaning = response.meanings.first else {
        return try fullText(q, response: response, scope: scope, now: now, db: db)
      }
      response.meaning = meaning
      let useSQL =
        "coalesce((SELECT sum(searchDecay(e.at,\(now.timeIntervalSince1970))) FROM searchEvents e WHERE e.kind='use' AND e.meaning=p.meaning AND e.photo=r.id AND e.scope=?),0)"
      let base =
        "SELECT r.id,r.preview,r.burst,p.evidence,p.confidence,r.favorite,r.moment,CASE WHEN r.capture<=\(now.timeIntervalSince1970) THEN r.capture END capture,\(useSQL) uses FROM searchPostings p JOIN searchRecords r ON r.id=p.photo WHERE p.meaning=? AND \(condition)"
      let args = StatementArguments([scope.key, meaning.id]) + scopeArgs
      let finalOrder =
        "evidence ASC,uses DESC,moment DESC,favorite DESC,capture DESC,confidence DESC,id ASC"
      // Four ordered heads, at most 200 rows in memory; the evidence lane uses the final ordering.
      var candidates: [String: Row] = [:]
      for (order, limit) in [
        (finalOrder, 148), ("uses DESC," + finalOrder, 20), ("moment DESC," + finalOrder, 15),
        ("favorite DESC,capture DESC," + finalOrder, 15),
      ] {
        for row in try Row.fetchAll(
          db, sql: base + " ORDER BY " + order + " LIMIT \(limit)", arguments: args)
        { candidates[row["id"] as String] = row }
      }
      let pin = try String.fetchOne(
        db, sql: "SELECT photo FROM searchPins WHERE meaning=? AND scope=?",
        arguments: [meaning.id, scope.key])
      if let pin, let row = try Row.fetchOne(db, sql: base + " AND r.id=?", arguments: args + [pin])
      {
        candidates[pin] = row
      }
      let previousID = previous?.leading?.id
      if let previousID, previous?.meaning?.id == meaning.id,
        q.hasPrefix(SearchNormalization.text(previous?.query ?? "")),
        let row = try Row.fetchOne(db, sql: base + " AND r.id=?", arguments: args + [previousID]),
        (row["evidence"] as Int) == meaning.evidenceClass
      {
        candidates[previousID] = row
      }
      let sorted = candidates.values.sorted { a, b in
        let aid: String = a["id"]
        let bid: String = b["id"]
        if (aid == pin) != (bid == pin) { return aid == pin }
        let ae: Int = a["evidence"]
        let be: Int = b["evidence"]
        if ae != be { return ae < be }
        for name in ["uses", "moment", "favorite", "capture", "confidence"] {
          let av: Double = a[name] ?? -Double.greatestFiniteMagnitude
          let bv: Double = b[name] ?? -Double.greatestFiniteMagnitude
          if av != bv { return av > bv }
        }
        return aid < bid
      }
      var stableSorted = sorted
      if pin == nil, let previousID, previous?.meaning?.id == meaning.id,
        q.count >= SearchNormalization.text(previous?.query ?? "").count,
        q.hasPrefix(SearchNormalization.text(previous?.query ?? "")),
        let at = stableSorted.firstIndex(where: {
          ($0["id"] as String) == previousID && ($0["evidence"] as Int) == meaning.evidenceClass
        })
      {
        stableSorted.insert(stableSorted.remove(at: at), at: 0)
      }
      let hits = Array(stableSorted.prefix(200)).map { row -> SearchHit in
        let evidence: Int = row["evidence"]
        let id: String = row["id"]
        let reason = Self.reason(evidence: evidence)
        return SearchHit(
          id: id, evidenceClass: evidence,
          reason: id == pin ? "Your representative · " + reason : reason, pinned: id == pin,
          previewAvailable: row["preview"])
      }
      // Native bursts are known duplicate groups; mere time proximity is never used.
      var burstPositions: [String: Int] = [:]
      var grouped: [SearchHit] = []
      for hit in hits {
        let burst: String? = candidates[hit.id]?["burst"]
        if let burst, let pos = burstPositions[burst] {
          grouped[pos].children.append(hit.id)
        } else {
          if let burst { burstPositions[burst] = grouped.count }
          grouped.append(hit)
        }
      }
      response.results = grouped
      return response
    }
  }
  private static func reason(evidence: Int) -> String {
    switch evidence {
    case 0: return "Supplied label"
    case 1: return "Photos metadata"
    case 2: return "Caption or keyword"
    case 3: return "Filename mention"
    default: return "Text in photo"
    }
  }
  private static func fullTextMatch(_ query: String) -> String {
    words(query).enumerated().map { offset, word in
      "\"" + word + "\"" + (offset == words(query).count - 1 ? "*" : "")
    }.joined(separator: " AND ")
  }
  private func fullText(
    _ q: String, response: SearchResponse, scope: SearchScope, now: Date, db: Database
  ) throws -> SearchResponse {
    var response = response
    let words = Self.words(q)
    guard words.count > 1 || q.count > 1 && q.allSatisfy(\.isNumber) else { return response }
    let match = Self.fullTextMatch(q)
    let meaningID = "fulltext:" + q
    let (condition, scopeArgs) = filter(scope)
    let pin = try String.fetchOne(
      db, sql: "SELECT photo FROM searchPins WHERE meaning=? AND scope=?",
      arguments: [meaningID, scope.key])
    var args: StatementArguments = [q, now.timeIntervalSince1970, meaningID, scope.key, match, q]
    args += scopeArgs
    args += [pin ?? ""]
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT r.id,r.preview,searchTextEvidence(r.value,?) evidence,bm25(searchFTS) textRank,
        coalesce((SELECT sum(searchDecay(e.at,?)) FROM searchEvents e WHERE e.kind='use' AND e.meaning=? AND e.photo=r.id AND e.scope=?),0) uses
        FROM searchFTS JOIN searchRecords r ON r.id=searchFTS.id
        WHERE searchFTS MATCH ? AND searchTextEvidence(r.value,?)>=0 AND \(condition)
        ORDER BY (r.id=?) DESC,evidence ASC,uses DESC,textRank ASC,r.moment DESC,r.favorite DESC,
          CASE WHEN r.capture<=\(now.timeIntervalSince1970) THEN r.capture END DESC,r.id LIMIT 200
        """, arguments: args)
    if let first = rows.first {
      let m = SearchMeaning(
        id: meaningID, term: q, display: q, relation: .text, evidenceClass: first["evidence"],
        eligibleCount: rows.count)
      response.meaning = m
      response.meanings = [m]
      response.results = rows.map { row in
        let id: String = row["id"]
        let evidence: Int = row["evidence"]
        return SearchHit(
          id: id, evidenceClass: evidence,
          reason: (id == pin ? "Your representative · " : "") + Self.reason(evidence: evidence),
          pinned: id == pin, previewAvailable: row["preview"])
      }
    }
    return response
  }
  private func compatibleCount(_ db: Database, meaning: String, photo: String, scope: SearchScope)
    throws -> Int
  {
    let (condition, scopeArgs) = filter(scope)
    let photoFilter = photo.isEmpty ? "" : " AND r.id=?"
    let photoArgs: StatementArguments = photo.isEmpty ? StatementArguments() : [photo]
    if meaning.hasPrefix("fulltext:") {
      let q = String(meaning.dropFirst("fulltext:".count))
      guard !Self.words(q).isEmpty else { return 0 }
      return try Int.fetchOne(
        db,
        sql:
          "SELECT count(*) FROM searchFTS JOIN searchRecords r ON r.id=searchFTS.id WHERE searchFTS MATCH ? AND searchTextEvidence(r.value,?)>=0 AND \(condition)"
          + photoFilter, arguments: [Self.fullTextMatch(q), q] + scopeArgs + photoArgs) ?? 0
    }
    return try Int.fetchOne(
      db,
      sql:
        "SELECT count(*) FROM searchPostings p JOIN searchRecords r ON r.id=p.photo WHERE p.meaning=? AND \(condition)"
        + photoFilter, arguments: [meaning] + scopeArgs + photoArgs) ?? 0
  }
  func acceptMeaning(
    _ meaningID: String, scope: SearchScope = SearchScope(), sessionID: String, now: Date
  ) throws {
    try event("accept", meaning: meaningID, photo: "", scope: scope, session: sessionID, now: now)
  }
  func confirmUse(
    _ meaningID: String, photoID: String, scope: SearchScope = SearchScope(), sessionID: String,
    now: Date
  ) throws {
    try event("use", meaning: meaningID, photo: photoID, scope: scope, session: sessionID, now: now)
  }
  private func event(
    _ kind: String, meaning: String, photo: String, scope: SearchScope, session: String, now: Date
  ) throws {
    try database.write { db in
      guard try compatibleCount(db, meaning: meaning, photo: photo, scope: scope) > 0 else {
        return
      }
      try db.execute(
        sql:
          "INSERT OR IGNORE INTO searchEvents(kind,meaning,photo,scope,session,at) VALUES(?,?,?,?,?,?)",
        arguments: [kind, meaning, photo, scope.key, session, now.timeIntervalSince1970])
    }
  }
  func pinRepresentative(_ meaningID: String, photoID: String, scope: SearchScope = SearchScope())
    throws
  {
    try database.write { db in
      guard try compatibleCount(db, meaning: meaningID, photo: photoID, scope: scope) > 0 else {
        return
      }
      try db.execute(
        sql:
          "INSERT INTO searchPins(meaning,scope,photo) VALUES(?,?,?) ON CONFLICT(meaning,scope) DO UPDATE SET photo=excluded.photo",
        arguments: [meaningID, scope.key, photoID])
    }
  }
  func historyCount(
    kind: String, meaningID: String, photoID: String = "", scope: SearchScope = SearchScope(),
    now: Date
  ) throws -> Double {
    try database.read { db in
      try Double.fetchOne(
        db,
        sql:
          "SELECT coalesce(sum(searchDecay(at,?)),0) FROM searchEvents WHERE kind=? AND meaning=? AND photo=? AND scope=?",
        arguments: [now.timeIntervalSince1970, kind, meaningID, photoID, scope.key]) ?? 0
    }
  }
}
