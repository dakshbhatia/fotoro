import Foundation
import GRDB

enum SearchAnalysisStage: String, Codable, Sendable, CaseIterable { case ocr, visual, semantic }
enum SearchAnalysisOutcome: String, Sendable { case unavailable, failed, modelDeferred }
struct SearchStageCoverage: Sendable {
  let stage: SearchAnalysisStage
  let total: Int
  let complete: Int
  let pending: Int
  let failed: Int
  let unavailable: Int
  let deferred: Int
  let modelDeferred: Int
  let nextRetry: Date?
  var lastAttemptAt: Date? = nil
  var lastCompleteAt: Date? = nil
}
struct SearchAnalysisWork: Sendable {
  let record: SearchRecord
  let stages: Set<SearchAnalysisStage>
}
struct SearchOCRCheckpoint: Sendable {
  var result: SearchOCRResult?
  var status: SearchOCRStatus
  var processor: String?
}
struct SearchVisualCheckpoint: Sendable {
  var result: SearchVisualResult?
  var status: SearchVisualStatus
  var processor: String?
}
struct SearchAnalysisCheckpoint: Sendable {
  var photoID: String
  var revision: String
  var attemptedAt: Date?
  var ocr: SearchOCRCheckpoint? = nil
  var visual: SearchVisualCheckpoint? = nil
}

// A device-local index. Network synchronization is handled by the owner annotation journal.
final class SearchIndex: @unchecked Sendable {
  let database: DatabaseQueue
  // Used only by put(..., db:) on the serialized database connection.
  private let captureDayFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withFullDate]; formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter
  }()
  private let generationLock = NSLock()
  private var workGeneration: UInt64 = 0
  init(root: URL? = nil) throws {
    var configuration = Configuration()
    configuration.prepareDatabase { db in
      db.add(function: DatabaseFunction("photoMetadataMatch", argumentCount: 2, pure: true) { values in
        guard let bytes = Data.fromDatabaseValue(values[0]),
          let record = try? JSONDecoder().decode(SearchRecord.self, from: bytes),
          let text = String.fromDatabaseValue(values[1]) else { return false }
        return PhotoAnalysisScope.matchesMetadata(record, text: text)
      })
      #if !FOTORO_LOCAL_PREVIEW
      db.add(function: DatabaseFunction("searchPeopleMatch", argumentCount: 3, pure: true) { values in
        guard let bytes = Data.fromDatabaseValue(values[0]),
          let record = try? JSONDecoder().decode(SearchRecord.self, from: bytes),
          let ids = String.fromDatabaseValue(values[1])?.data(using: .utf8),
          let selected = try? JSONDecoder().decode(Set<String>.self, from: ids),
          let mode = String.fromDatabaseValue(values[2]).flatMap(PeopleSearchMatch.init(rawValue:)) else { return false }
        let people = PhotoPeopleFacts.read(record.facts, originalSha256: record.scope == "saved" ? record.revision : nil, enforceWireLimits: false)
        return PeopleSearchSelection(personIDs: selected, match: mode).matches(Set(people.map(\.p)))
      })
      db.add(function: DatabaseFunction("semanticSimilarity", argumentCount: 2, pure: true) { values in
        guard let image = Data.fromDatabaseValue(values[0]).flatMap(SemanticVector.values),
          let text = Data.fromDatabaseValue(values[1]).flatMap(SemanticVector.values) else { return -1.0 }
        return SemanticVector.similarity(image, text)
      })
      #endif
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
              && tokens.contains { last.contains(where: \.isLetter) ? $0.hasPrefix(last) : $0 == last }
          }
          if matches((record.captions + record.keywords).joined(separator: " ")) { return 2 }
          if matches((PhotoOrganizationFacts.name(record.facts, original: record.filename) as NSString).deletingPathExtension) { return 3 }
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
          CREATE TABLE IF NOT EXISTS searchRecords(id TEXT PRIMARY KEY, scope TEXT NOT NULL, capture REAL, favorite INTEGER NOT NULL, moment INTEGER NOT NULL, ocrState TEXT NOT NULL, visualState TEXT NOT NULL DEFAULT 'pending', preview INTEGER NOT NULL, burst TEXT, value BLOB NOT NULL);
          CREATE INDEX IF NOT EXISTS searchSourceDate ON searchRecords(scope,capture);
          CREATE TABLE IF NOT EXISTS searchVectors(photo TEXT PRIMARY KEY REFERENCES searchRecords(id) ON DELETE CASCADE, revision TEXT NOT NULL, processor TEXT NOT NULL, vector BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS searchAnalysisAttempts(photo TEXT NOT NULL REFERENCES searchRecords(id) ON DELETE CASCADE, stage TEXT NOT NULL, revision TEXT NOT NULL, processor TEXT NOT NULL, outcome TEXT NOT NULL, attempts INTEGER NOT NULL, retryAfter REAL NOT NULL, PRIMARY KEY(photo,stage));
          CREATE INDEX IF NOT EXISTS searchAnalysisRetryAt ON searchAnalysisAttempts(retryAfter);
          CREATE TABLE IF NOT EXISTS searchAnalysisProgress(stage TEXT PRIMARY KEY, lastAttempt REAL NOT NULL, lastComplete REAL);
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
      if !(try db.columns(in: "searchRecords")).contains(where: { $0.name == "visualState" }) {
        try db.execute(sql: "ALTER TABLE searchRecords ADD COLUMN visualState TEXT NOT NULL DEFAULT 'pending'")
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
  func records(_ ids: [String]) throws -> [String: SearchRecord] {
    let ids = Array(Set(ids))
    guard !ids.isEmpty else { return [:] }
    return try database.read { db in
      var records: [String: SearchRecord] = [:]
      for start in stride(from: 0, to: ids.count, by: 400) {
        try Task.checkCancellation()
        let batch = Array(ids[start..<min(ids.count, start + 400)])
        let placeholders = Array(repeating: "?", count: batch.count).joined(separator: ",")
        for row in try Row.fetchAll(db, sql: "SELECT value FROM searchRecords WHERE id IN (\(placeholders))",
          arguments: StatementArguments(batch)) {
          let record = try decode(row)
          records[record.id] = record
        }
      }
      return records
    }
  }
  #if !FOTORO_LOCAL_PREVIEW
  func pendingSemanticRecords(after: String? = nil, limit: Int = 64, scope: PhotoAnalysisScope? = nil) throws -> [SearchRecord] {
    var conditions = ["(? IS NULL OR r.id>?)",
      "(v.photo IS NULL OR v.processor!=? OR v.revision!=json_extract(r.value,'$.revision'))"]
    var arguments: StatementArguments = [after, after, SemanticVector.processor]
    if let scope {
      conditions.append("r.scope='saved'")
      if let from = scope.scope.from { conditions.append("r.capture>=?"); arguments += [from.timeIntervalSince1970] }
      if let through = scope.scope.through { conditions.append("r.capture<=?"); arguments += [through.timeIntervalSince1970] }
      if let until = scope.scope.until { conditions.append("r.capture<?"); arguments += [until.timeIntervalSince1970] }
    }
    let condition = conditions.joined(separator: " AND ")
    return try database.read { db in
      try Row.fetchAll(db, sql: """
        SELECT r.value FROM searchRecords r LEFT JOIN searchVectors v ON v.photo=r.id
        WHERE \(condition) ORDER BY r.id LIMIT ?
        """, arguments: arguments + [max(1, min(limit, 128))]).map(decode)
    }
  }
  func needsSemantic(photoID: String, revision: String) throws -> Bool {
    try database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchVectors WHERE photo=? AND revision=? AND processor=?",
      arguments: [photoID, revision, SemanticVector.processor]) == 0 }
  }
  @discardableResult func applySemantic(_ vector: [Float], photoID: String, revision: String,
    generation: UInt64? = nil, attemptedAt: Date = Date()) throws -> Bool {
    guard let normalized = SemanticVector.normalized(vector) else { return false }
    return try database.write { db in
      guard acceptsGeneration(generation), let current = try Row.fetchOne(db,
        sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]).map(decode),
        current.revision == revision else { return false }
      try db.execute(sql: "INSERT OR REPLACE INTO searchVectors(photo,revision,processor,vector) VALUES(?,?,?,?)",
        arguments: [photoID, revision, SemanticVector.processor, SemanticVector.data(normalized)])
      try clearAnalysisAttempt(photoID: photoID, stage: .semantic, db: db)
      try recordAnalysisProgress(stage: .semantic, completed: true, at: attemptedAt, db: db)
      return true
    }
  }
  func addingSemantic(_ vector: [Float], to base: SearchResponse, now: Date = Date()) throws -> SearchResponse {
    guard base.permitsSemanticMatches, let normalized = SemanticVector.normalized(vector) else { return base }
    return try database.read { db -> SearchResponse in
      let (condition, args) = filter(base.scope)
      let vectorArguments: StatementArguments = [SemanticVector.data(normalized), SemanticVector.processor]
      let rows: [Row] = try Row.fetchAll(db, sql: """
        SELECT r.id,r.preview,r.burst,semanticSimilarity(v.vector,?) similarity
        FROM searchVectors v JOIN searchRecords r ON r.id=v.photo
        WHERE v.processor=? AND v.revision=json_extract(r.value,'$.revision') AND \(condition)
          AND similarity>=0.20
        ORDER BY similarity DESC,r.favorite DESC,r.capture DESC,r.id LIMIT 100
        """, arguments: vectorArguments + args)
      var result = base
      var included = Set(base.results.flatMap { [$0.id] + $0.children })
      var bursts: [String: Int] = [:]
      for row in rows {
        let id: String = row["id"]
        guard included.insert(id).inserted else { continue }
        let burst: String? = row["burst"]
        if let burst, let index = bursts[burst] { result.results[index].children.append(id); continue }
        if let burst { bursts[burst] = result.results.count }
        let previewAvailable: Bool = row["preview"]
        result.results.append(SearchHit(id: id, evidenceClass: 6, reason: "Visual similarity", previewAvailable: previewAvailable))
      }
      return result
    }
  }
  #endif
  func applyOCR(
    _ result: SearchOCRResult?, status: SearchOCRStatus, photoID: String, revision: String,
    generation: UInt64? = nil, attemptedAt: Date? = nil, expectedProcessor: String? = nil
  ) throws -> Bool {
    try !applyAnalysisBatch([SearchAnalysisCheckpoint(photoID: photoID, revision: revision,
      attemptedAt: attemptedAt, ocr: SearchOCRCheckpoint(result: result, status: status, processor: expectedProcessor))],
      generation: generation).isEmpty
  }
  @discardableResult func applyVisual(
    _ result: SearchVisualResult?, status: SearchVisualStatus, photoID: String, revision: String,
    generation: UInt64? = nil, attemptedAt: Date? = nil, expectedProcessor: String? = nil
  ) throws -> Bool {
    try !applyAnalysisBatch([SearchAnalysisCheckpoint(photoID: photoID, revision: revision,
      attemptedAt: attemptedAt, visual: SearchVisualCheckpoint(result: result, status: status, processor: expectedProcessor))],
      generation: generation).isEmpty
  }
  // OCR and classification share one decode, transaction and posting rebuild.
  // A bounded caller may group ready checkpoints; no inference occurs under SQL.
  func applyAnalysisBatch(_ checkpoints: [SearchAnalysisCheckpoint], generation: UInt64? = nil) throws -> [SearchRecord] {
    guard checkpoints.count <= 32 else { throw FotoroError("Photo analysis batch exceeds 32 photos") }
    guard !checkpoints.isEmpty else { return [] }
    do {
      return try database.write { db in
        guard acceptsGeneration(generation) else { return [] }
        var committed: [SearchRecord] = []
        for checkpoint in checkpoints {
          guard acceptsGeneration(generation) else { throw CancellationError() }
          guard checkpoint.ocr != nil || checkpoint.visual != nil,
            var record = try Row.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [checkpoint.photoID]).map(decode),
            record.revision == checkpoint.revision else { continue }
          if let ocr = checkpoint.ocr, let processor = ocr.processor, processor != record.processor { continue }
          if let visual = checkpoint.visual {
            guard visual.processor == nil || visual.processor == record.visualProcessor,
              visual.result == nil || visual.result?.processor == record.visualProcessor else { continue }
          }
          let prior = record
          if let ocr = checkpoint.ocr {
            record.ocrText = ocr.result?.text ?? ""; record.ocrConfidence = ocr.result?.confidence ?? 0
            record.ocrStatus = ocr.status
            record.previewAvailable = ocr.result != nil || ocr.status == .failed
            if record.beforeSync != nil {
              record.beforeSync?.ocrText = record.ocrText; record.beforeSync?.ocrConfidence = record.ocrConfidence
              record.beforeSync?.ocrStatus = record.ocrStatus
            }
          }
          if let visual = checkpoint.visual {
            record.visualLabels = visual.result.map { SearchVisualPolicy.validated($0.labels, processor: $0.processor) } ?? []
            record.visualStatus = visual.status
            record.previewAvailable = record.previewAvailable || visual.result != nil || visual.status == .failed
            if record.beforeSync != nil {
              record.beforeSync?.visualLabels = record.visualLabels; record.beforeSync?.visualStatus = record.visualStatus
              record.beforeSync?.visualProcessor = record.visualProcessor
            }
          }
          if record != prior { try put(record, db: db) }
          if let ocr = checkpoint.ocr {
            try updateAnalysisAttempt(record: record, stage: .ocr, processor: record.processor,
              outcome: ocr.status == .unavailable ? .unavailable : ocr.status == .failed ? .failed : nil,
              attemptedAt: checkpoint.attemptedAt, db: db)
          }
          if let visual = checkpoint.visual {
            try updateAnalysisAttempt(record: record, stage: .visual, processor: record.visualProcessor,
              outcome: visual.status == .unavailable ? .unavailable : visual.status == .failed ? .failed : nil,
              attemptedAt: checkpoint.attemptedAt, db: db)
          }
          committed.append(record)
        }
        guard acceptsGeneration(generation) else { throw CancellationError() }
        return committed
      }
    } catch is CancellationError { return [] }
  }
  #if !FOTORO_LOCAL_PREVIEW
  struct AnnotationUpdate: Sendable {
    let value: PhotoAnnotationsV1
    let photoID: String
    let revision: String
    let accountId: String
  }
  struct AnnotationBatchResult: Sendable {
    var acceptedPhotoIDs: Set<String> = []
    var changedRecords: [SearchRecord] = []
    var organizationChanged = false
  }
  @discardableResult func applyAnnotations(_ value: PhotoAnnotationsV1, photoID: String, revision: String, accountId: String) throws -> Bool {
    try applyAnnotationsBatch([AnnotationUpdate(value: value, photoID: photoID, revision: revision, accountId: accountId)])
      .acceptedPhotoIDs.contains(photoID)
  }
  func applyAnnotationsBatch(_ updates: [AnnotationUpdate]) throws -> AnnotationBatchResult {
    guard updates.count <= 200 else { throw FotoroError("Photo annotation batch exceeds 200 photos") }
    guard !updates.isEmpty else { return AnnotationBatchResult() }
    return try database.write { db in
      // Read the current OCR/beforeSync baseline inside this transaction. A
      // snapshot captured before admission could overwrite newly completed work.
      let ids = Array(Set(updates.map(\.photoID)))
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ",")
      var records: [String: SearchRecord] = [:]
      for row in try Row.fetchAll(db, sql: "SELECT value FROM searchRecords WHERE id IN (\(placeholders))", arguments: StatementArguments(ids)) {
        let record = try decode(row); records[record.id] = record
      }
      var result = AnnotationBatchResult()
      for update in updates {
        guard let prior = records[update.photoID], prior.revision == update.revision else { continue }
        let record = try applyingAnnotations(update.value, to: prior, accountId: update.accountId)
        result.acceptedPhotoIDs.insert(record.id)
        guard record != prior else { continue }
        let organization = { (record: SearchRecord) in record.facts.filter { PhotoOrganizationFacts.category($0) != nil } }
        result.organizationChanged = result.organizationChanged || organization(record) != organization(prior)
        try put(record, db: db)
        records[record.id] = record
        result.changedRecords.append(record)
      }
      return result
    }
  }
  private func applyingAnnotations(_ value: PhotoAnnotationsV1, to prior: SearchRecord, accountId: String) throws -> SearchRecord {
    var record = prior
    if record.beforeSync == nil {
      record.beforeSync = LocalSearchFields(labels: record.labels, captions: record.captions, keywords: record.keywords, facts: record.facts, favorite: record.favorite, ocrText: record.ocrText, ocrConfidence: record.ocrConfidence, ocrStatus: record.ocrStatus,
        visualLabels: record.visualLabels, visualStatus: record.visualStatus, visualProcessor: record.visualProcessor, captureMetadata: record.captureMetadata)
    }
    record.syncedAccountId = accountId
    let capture = PhotoCaptureFacts.read(value.facts, originalSha256: value.originalSha256)
    let localCapture = record.beforeSync?.captureMetadata ?? PhotoCaptureMetadata()
    record.captureMetadata = record.scope == "photos" ? (capture ?? PhotoCaptureMetadata()).merging(localCapture) : capture
    record.labels = value.labels ?? []
    record.captions = value.caption.map { [$0] } ?? []
    record.keywords = value.keywords ?? []
    record.facts = PhotoLocationFacts.userFacts(value.facts).filter { !PhotoPeopleFacts.isReserved($0) && !PhotoCaptureFacts.isReserved($0) } + (value.location?.searchTerms ?? [])
    record.facts = try PhotoPeopleFacts.replacing(record.facts, with: PhotoPeopleFacts.read(value.facts ?? [], originalSha256: value.originalSha256), enforceWireLimits: false)
    record.favorite = value.favorite ?? record.favorite
    if let ocr = value.ocr, ocr.processor == record.processor {
      record.ocrText = ocr.text
      record.ocrConfidence = ocr.confidence
      record.ocrStatus = .complete
    } else {
      record.ocrText = record.beforeSync?.ocrText ?? ""
      record.ocrConfidence = record.beforeSync?.ocrConfidence ?? 0
      record.ocrStatus = record.beforeSync?.ocrStatus ?? .pending
    }
    if let visual = value.visual, visual.processor == record.visualProcessor,
      visual.processor == SearchVisualPolicy.processor {
      record.visualLabels = SearchVisualPolicy.validated(visual)
      record.visualStatus = .complete
    } else {
      record.visualLabels = record.beforeSync?.visualLabels ?? []
      record.visualStatus = record.beforeSync?.visualStatus ?? .pending
      record.visualProcessor = record.beforeSync?.visualProcessor ?? SearchVisualPolicy.processor
    }
    return record
  }
  #endif
  @discardableResult func applyCaptureMetadata(_ value: PhotoCaptureMetadata, photoID: String, revision: String, generation: UInt64? = nil) throws -> Bool {
    try database.write { db in
      guard acceptsGeneration(generation), var record = try Row.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]).map(decode),
        record.scope == "photos", record.revision == revision else { return false }
      let original = PhotoCaptureMetadata(items: value.items.filter { $0.p == .original && PhotoCaptureMetadata.validated($0) })
      record.captureMetadata = (record.captureMetadata ?? PhotoCaptureMetadata()).merging(original)
      if var before = record.beforeSync {
        before.captureMetadata = (before.captureMetadata ?? PhotoCaptureMetadata()).merging(original)
        record.beforeSync = before
      }
      try put(record, db: db)
      return true
    }
  }
  func clearSyncedAnnotations() throws {
    try database.write { db in
      let records = try Row.fetchAll(db, sql: "SELECT value FROM searchRecords").map(decode)
      for var record in records where record.syncedAccountId != nil {
        if let prior = record.beforeSync {
          record.labels = prior.labels; record.captions = prior.captions; record.keywords = prior.keywords
          record.facts = prior.facts; record.favorite = prior.favorite
          record.captureMetadata = prior.captureMetadata
          record.ocrText = prior.ocrText; record.ocrConfidence = prior.ocrConfidence; record.ocrStatus = prior.ocrStatus
          record.visualLabels = prior.visualLabels ?? []; record.visualStatus = prior.visualStatus ?? .pending
          record.visualProcessor = prior.visualProcessor ?? SearchVisualPolicy.processor
        } else {
          record.captureMetadata = nil
          record.labels = []; record.ocrText = ""; record.ocrConfidence = 0; record.ocrStatus = .pending
          record.visualLabels = []; record.visualStatus = .pending; record.visualProcessor = SearchVisualPolicy.processor
        }
        record.syncedAccountId = nil; record.beforeSync = nil
        try put(record, db: db)
        try db.execute(sql: "DELETE FROM searchPins WHERE photo=?; DELETE FROM searchEvents WHERE photo=?", arguments: [record.id, record.id])
      }
      try db.execute(sql: "DELETE FROM searchTerms WHERE meaning NOT IN (SELECT meaning FROM searchPostings)")
    }
  }
  func pendingRecords(retryFailed: Bool = false) throws -> [SearchRecord] {
    try database.read { db in
      try Row.fetchAll(
        db,
        sql:
          "SELECT value FROM searchRecords WHERE ocrState IN ('pending','unavailable') OR (? AND ocrState='failed') ORDER BY favorite DESC,capture DESC,id",
        arguments: [retryFailed]
      ).map(decode)
    }
  }
  func metadataAnalysisFilter(_ scope: PhotoAnalysisScope, after: PhotoAnalysisCursor? = nil) -> (String, StatementArguments) {
    var conditions = ["r.scope='photos'"]
    var arguments = StatementArguments()
    if !scope.metadataText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      conditions.append("photoMetadataMatch(r.value,?)=1"); arguments += [scope.metadataText]
    }
    if let from = scope.scope.from { conditions.append("r.capture>=?"); arguments += [from.timeIntervalSince1970] }
    if let through = scope.scope.through { conditions.append("(r.capture IS NULL OR r.capture<=?)"); arguments += [through.timeIntervalSince1970] }
    if let until = scope.scope.until { conditions.append("r.capture<?"); arguments += [until.timeIntervalSince1970] }
    if !scope.scope.people.isEmpty {
      #if FOTORO_LOCAL_PREVIEW
      conditions.append("0")
      #else
      conditions.append("searchPeopleMatch(r.value,?,?)=1")
      arguments += [String(decoding: (try? JSONEncoder().encode(scope.scope.people.personIDs)) ?? Data(), as: UTF8.self), scope.scope.people.match.rawValue]
      #endif
    }
    if let after {
      if let date = after.capturedAt {
        conditions.append("(r.capture<? OR r.capture IS NULL OR (r.capture=? AND r.id>?))")
        arguments += [date.timeIntervalSince1970, date.timeIntervalSince1970, after.id]
      } else { conditions.append("r.capture IS NULL AND r.id>?"); arguments += [after.id] }
    }
    return (conditions.joined(separator: " AND "), arguments)
  }
  private func analysisStageConditions(retryFailed: Bool, now: Date, bypassDeferred: Bool) -> [(SearchAnalysisStage, String, StatementArguments)] {
    var stages: [(SearchAnalysisStage, String, StatementArguments)] = []
    for (stage, state, processor) in [(SearchAnalysisStage.ocr, "r.ocrState", "json_extract(r.value,'$.processor')"),
      (.visual, "r.visualState", "json_extract(r.value,'$.visualProcessor')")] {
      let matching = "a.photo=r.id AND a.stage='\(stage.rawValue)' AND a.revision=json_extract(r.value,'$.revision') AND a.processor=\(processor)"
      // A scheduled failure retries when due even during a metadata-only refresh.
      let failed = retryFailed ? "\(state)='failed'" : "(\(state)='failed' AND EXISTS(SELECT 1 FROM searchAnalysisAttempts a WHERE \(matching)))"
      var sql = "(\(state) IN ('pending','unavailable') OR \(failed))"
      var arguments = StatementArguments()
      if !bypassDeferred {
        sql += " AND NOT EXISTS(SELECT 1 FROM searchAnalysisAttempts a WHERE \(matching) AND a.retryAfter>?)"
        arguments += [now.timeIntervalSince1970]
      }
      stages.append((stage, sql, arguments))
    }
    #if !FOTORO_LOCAL_PREVIEW
    var semantic = "(v.photo IS NULL OR v.processor!=? OR v.revision!=json_extract(r.value,'$.revision'))"
    var arguments: StatementArguments = [SemanticVector.processor]
    if !bypassDeferred {
      semantic += " AND NOT EXISTS(SELECT 1 FROM searchAnalysisAttempts a WHERE a.photo=r.id AND a.stage='semantic' AND a.revision=json_extract(r.value,'$.revision') AND a.processor=? AND a.retryAfter>?)"
      arguments += [SemanticVector.processor, now.timeIntervalSince1970]
    }
    stages.append((.semantic, semantic, arguments))
    #endif
    return stages
  }
  private var analysisJoin: String {
    #if !FOTORO_LOCAL_PREVIEW
    "FROM searchRecords r LEFT JOIN searchVectors v ON v.photo=r.id"
    #else
    "FROM searchRecords r"
    #endif
  }
  // Support export only: one read transaction, no decoded records or text output.
  // This describes the permitted local Photos catalog, independently of a query,
  // traversal cursor or the in-memory batch's progress counters.
  func analysisCoverage(now: Date = Date(), scope: PhotoAnalysisScope? = nil) throws -> [SearchStageCoverage] {
    try database.read { db in
      let (filter, filterArguments) = scope.map { metadataAnalysisFilter($0) } ?? ("r.scope='photos'", StatementArguments())
      return try SearchAnalysisStage.allCases.compactMap { stage in
        let state: String, processor: String, join: String
        switch stage {
        case .ocr: state = "r.ocrState"; processor = "json_extract(r.value,'$.processor')"; join = ""
        case .visual: state = "r.visualState"; processor = "json_extract(r.value,'$.visualProcessor')"; join = ""
        case .semantic:
          #if FOTORO_LOCAL_PREVIEW
          return nil
          #else
          state = "CASE WHEN v.photo IS NOT NULL AND v.revision=json_extract(r.value,'$.revision') AND v.processor=? THEN 'complete' WHEN a.outcome IN ('failed','unavailable') THEN a.outcome ELSE 'pending' END"
          processor = "?"; join = " LEFT JOIN searchVectors v ON v.photo=r.id"
          #endif
        }
        var arguments = StatementArguments()
        if stage == .semantic {
          #if !FOTORO_LOCAL_PREVIEW
          arguments += [SemanticVector.processor]
          #endif
        }
        arguments += [stage.rawValue]
        if stage == .semantic {
          #if !FOTORO_LOCAL_PREVIEW
          arguments += [SemanticVector.processor]
          #endif
        }
        arguments += filterArguments
        arguments += [now.timeIntervalSince1970, now.timeIntervalSince1970]
        let row = try Row.fetchOne(db, sql: """
          WITH coverage AS (
            SELECT \(state) state,a.outcome,a.retryAfter
            FROM searchRecords r \(join)
            LEFT JOIN searchAnalysisAttempts a ON a.photo=r.id AND a.stage=?
              AND a.revision=json_extract(r.value,'$.revision') AND a.processor=\(processor)
            WHERE \(filter)
          )
          SELECT count(*) total,coalesce(sum(state='complete'),0) complete,
            coalesce(sum(state='pending'),0) pending,coalesce(sum(state='failed'),0) failed,
            coalesce(sum(state='unavailable'),0) unavailable,
            coalesce(sum(state!='complete' AND retryAfter>?),0) deferred,
            coalesce(sum(state!='complete' AND outcome='modelDeferred'),0) modelDeferred,
            min(CASE WHEN state!='complete' AND retryAfter>? THEN retryAfter END) nextRetry
          FROM coverage
          """, arguments: arguments)!
        let next: Double? = row["nextRetry"]
        let progress = try Row.fetchOne(db, sql: "SELECT lastAttempt,lastComplete FROM searchAnalysisProgress WHERE stage=?", arguments: [stage.rawValue])
        let lastAttempt: Double? = progress?["lastAttempt"], lastComplete: Double? = progress?["lastComplete"]
        return SearchStageCoverage(stage: stage, total: row["total"], complete: row["complete"],
          pending: row["pending"], failed: row["failed"], unavailable: row["unavailable"],
          deferred: row["deferred"], modelDeferred: row["modelDeferred"],
          nextRetry: next.map(Date.init(timeIntervalSince1970:)),
          lastAttemptAt: lastAttempt.map(Date.init(timeIntervalSince1970:)),
          lastCompleteAt: lastComplete.map(Date.init(timeIntervalSince1970:)))
      }
    }
  }
  func pendingMetadataAnalysisCount(scope: PhotoAnalysisScope, after: PhotoAnalysisCursor? = nil,
    retryFailed: Bool = false, now: Date = Date(), bypassDeferred: Bool = false) throws -> Int {
    let (filter, filterArguments) = metadataAnalysisFilter(scope, after: after)
    let stages = analysisStageConditions(retryFailed: retryFailed, now: now, bypassDeferred: bypassDeferred)
    var arguments = filterArguments
    for stage in stages { arguments += stage.2 }
    let pending = stages.map { "("+$0.1+")" }.joined(separator: " OR ")
    return try database.read { try Int.fetchOne($0, sql: "SELECT count(*) "+analysisJoin+" WHERE "+filter+" AND ("+pending+")", arguments: arguments) ?? 0 }
  }
  func pendingMetadataAnalysisWork(scope: PhotoAnalysisScope, after: PhotoAnalysisCursor? = nil,
    retryFailed: Bool = false, now: Date = Date(), bypassDeferred: Bool = false, limit: Int = 500) throws -> [SearchAnalysisWork] {
    let (filter, filterArguments) = metadataAnalysisFilter(scope, after: after)
    let stages = analysisStageConditions(retryFailed: retryFailed, now: now, bypassDeferred: bypassDeferred)
    let columns = stages.map { "CASE WHEN "+$0.1+" THEN 1 ELSE 0 END AS "+$0.0.rawValue+"Due" }.joined(separator: ",")
    let pending = stages.map { "("+$0.1+")" }.joined(separator: " OR ")
    var arguments = StatementArguments()
    for stage in stages { arguments += stage.2 }
    arguments += filterArguments
    for stage in stages { arguments += stage.2 }
    arguments += [min(500, max(0, limit))]
    return try database.read { db in
      try Row.fetchAll(db, sql: "SELECT r.value,"+columns+" "+analysisJoin+" WHERE "+filter+" AND ("+pending+") ORDER BY r.capture DESC,r.id LIMIT ?", arguments: arguments).map { row in
        SearchAnalysisWork(record: try decode(row), stages: Set(stages.compactMap { stage in
          let due: Bool = row[stage.0.rawValue+"Due"]
          return due ? stage.0 : nil
        }))
      }
    }
  }
  func pendingMetadataAnalysisRecords(scope: PhotoAnalysisScope, after: PhotoAnalysisCursor? = nil,
    retryFailed: Bool = false, now: Date = Date(), bypassDeferred: Bool = false, limit: Int = 500) throws -> [SearchRecord] {
    try pendingMetadataAnalysisWork(scope: scope, after: after, retryFailed: retryFailed,
      now: now, bypassDeferred: bypassDeferred, limit: limit).map(\.record)
  }
  func nextMetadataAnalysisRetry(scope: PhotoAnalysisScope, now: Date = Date()) throws -> Date? {
    let (filter, filterArguments) = metadataAnalysisFilter(scope)
    let stages = analysisStageConditions(retryFailed: true, now: now, bypassDeferred: true)
    var arguments = filterArguments
    let pending = stages.map { stage -> String in
      arguments += stage.2
      let processor: String
      switch stage.0 {
      case .ocr: processor = "json_extract(r.value,'$.processor')"
      case .visual: processor = "json_extract(r.value,'$.visualProcessor')"
      case .semantic:
        #if !FOTORO_LOCAL_PREVIEW
        processor = "?"; arguments += [SemanticVector.processor]
        #else
        processor = "''"
        #endif
      }
      return "(a.stage='\(stage.0.rawValue)' AND (\(stage.1)) AND a.processor=\(processor))"
    }.joined(separator: " OR ")
    return try database.read { db in
      // Include deadlines that elapsed while later sources were being processed.
      // The owner clamps an overdue wakeup to zero and restarts the transient cursor.
      try Double.fetchOne(db, sql: "SELECT MIN(a.retryAfter) "+analysisJoin+" JOIN searchAnalysisAttempts a ON a.photo=r.id AND a.revision=json_extract(r.value,'$.revision') WHERE "+filter+" AND ("+pending+")", arguments: arguments).map(Date.init(timeIntervalSince1970:))
    }
  }
  private func clearAnalysisAttempt(photoID: String, stage: SearchAnalysisStage, db: Database) throws {
    try db.execute(sql: "DELETE FROM searchAnalysisAttempts WHERE photo=? AND stage=?", arguments: [photoID, stage.rawValue])
  }
  private func recordAnalysisProgress(stage: SearchAnalysisStage, completed: Bool, at: Date, db: Database) throws {
    let time = at.timeIntervalSince1970
    guard time.isFinite, time >= 0 else { return }
    try db.execute(sql: """
      INSERT INTO searchAnalysisProgress(stage,lastAttempt,lastComplete) VALUES(?,?,?)
      ON CONFLICT(stage) DO UPDATE SET lastAttempt=max(lastAttempt,excluded.lastAttempt),
        lastComplete=CASE WHEN excluded.lastComplete IS NULL THEN lastComplete
          ELSE max(coalesce(lastComplete,0),excluded.lastComplete) END
      """, arguments: [stage.rawValue, time, completed ? time : nil])
  }
  private func updateAnalysisAttempt(record: SearchRecord, stage: SearchAnalysisStage, processor: String,
    outcome: SearchAnalysisOutcome?, attemptedAt: Date?, db: Database) throws {
    let completed = outcome == nil && (stage == .ocr ? record.ocrStatus == .complete : record.visualStatus == .complete)
    try recordAnalysisProgress(stage: stage, completed: completed, at: attemptedAt ?? Date(), db: db)
    guard let outcome, let attemptedAt else {
      try clearAnalysisAttempt(photoID: record.id, stage: stage, db: db)
      return
    }
    let prior = try Int.fetchOne(db, sql: "SELECT attempts FROM searchAnalysisAttempts WHERE photo=? AND stage=? AND revision=? AND processor=? AND outcome=?",
      arguments: [record.id, stage.rawValue, record.revision, processor, outcome.rawValue]) ?? 0
    let attempts = min(16, prior + 1)
    let initial: Double = outcome == .failed ? 30 : outcome == .unavailable ? 300 : 60
    let delay = min(outcome == .unavailable ? 3600 : 900, initial * pow(2, Double(min(6, attempts - 1))))
    try db.execute(sql: "INSERT INTO searchAnalysisAttempts(photo,stage,revision,processor,outcome,attempts,retryAfter) VALUES(?,?,?,?,?,?,?) ON CONFLICT(photo,stage) DO UPDATE SET revision=excluded.revision,processor=excluded.processor,outcome=excluded.outcome,attempts=excluded.attempts,retryAfter=excluded.retryAfter",
      arguments: [record.id, stage.rawValue, record.revision, processor, outcome.rawValue, attempts, attemptedAt.addingTimeInterval(delay).timeIntervalSince1970])
  }
  #if !FOTORO_LOCAL_PREVIEW
  @discardableResult func deferSemantic(_ outcome: SearchAnalysisOutcome, photoID: String, revision: String,
    attemptedAt: Date, generation: UInt64? = nil) throws -> Bool {
    try database.write { db in
      guard acceptsGeneration(generation), let record = try Row.fetchOne(db,
        sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]).map(decode),
        record.revision == revision else { return false }
      guard try Int.fetchOne(db, sql: "SELECT count(*) FROM searchVectors WHERE photo=? AND revision=? AND processor=?",
        arguments: [photoID, revision, SemanticVector.processor]) == 0 else { return false }
      try updateAnalysisAttempt(record: record, stage: .semantic, processor: SemanticVector.processor,
        outcome: outcome, attemptedAt: attemptedAt, db: db)
      return true
    }
  }
  @discardableResult func releaseModelDeferredAnalysis(generation: UInt64? = nil) throws -> Bool {
    try database.write { db in
      guard acceptsGeneration(generation) else { return false }
      try db.execute(sql: "DELETE FROM searchAnalysisAttempts WHERE stage='semantic' AND outcome='modelDeferred' AND processor=? AND revision=(SELECT json_extract(value,'$.revision') FROM searchRecords WHERE id=photo)", arguments: [SemanticVector.processor])
      return db.changesCount > 0
    }
  }
  #endif
  func pendingAnalysisRecords(retryFailed: Bool = false) throws -> [SearchRecord] {
    try database.read { db in
      try Row.fetchAll(db, sql: """
        SELECT value FROM searchRecords
        WHERE ocrState IN ('pending','unavailable') OR visualState IN ('pending','unavailable')
          OR (? AND (ocrState='failed' OR visualState='failed'))
        ORDER BY favorite DESC,capture DESC,id
        """, arguments: [retryFailed]).map(decode)
    }
  }
  func setWorkGeneration(_ generation: UInt64) throws {
    generationLock.lock()
    defer { generationLock.unlock() }
    workGeneration = generation
  }
  func acceptsGeneration(_ generation: UInt64?) -> Bool {
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
          var unchanged = false
          if let old = try Row.fetchOne(
            db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [r.id]
          ).map(decode) {
            r.labels = old.revision == r.revision ? old.labels : (old.beforeSync?.labels ?? old.labels)
            #if !FOTORO_LOCAL_PREVIEW
            if old.revision == r.revision {
              r.facts = try PhotoPeopleFacts.replacing(r.facts, with: PhotoPeopleFacts.read(old.beforeSync?.facts ?? old.facts, enforceWireLimits: false), enforceWireLimits: false)
            }
            #endif
            if old.revision == r.revision {
              r.facts = r.facts.filter { PhotoOrganizationFacts.category($0) == nil } + old.facts.filter { PhotoOrganizationFacts.category($0) != nil }
              if let prior = old.captureMetadata {
                let original = PhotoCaptureMetadata(items: prior.items.filter { $0.p == .original })
                r.captureMetadata = (r.captureMetadata ?? PhotoCaptureMetadata()).merging(original)
              }
              r.syncedAccountId = old.syncedAccountId
              r.beforeSync = old.beforeSync
            }
            if old.revision == r.revision, old.processor == r.processor {
              r.ocrText = old.ocrText
              r.ocrConfidence = old.ocrConfidence
              r.ocrStatus = old.ocrStatus
              r.previewAvailable = old.previewAvailable
            }
            if old.revision == r.revision, old.visualProcessor == r.visualProcessor {
              r.visualLabels = old.visualLabels
              r.visualStatus = old.visualStatus
              r.previewAvailable = r.previewAvailable || old.previewAvailable
            }
            // Compare after restoring cached analysis and owner evidence. Even
            // same-revision Photos metadata changes must rebuild searchable terms.
            unchanged = r == old
          }
          if !unchanged { try put(r, db: db) }
          progress?(offset + 1)
        }
        guard acceptsGeneration(generation) else { throw CancellationError() }
        try db.execute(
          sql:
            "DELETE FROM searchFTS WHERE id NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchRecords WHERE id NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchPins WHERE photo NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchEvents WHERE photo != '' AND photo NOT IN (SELECT id FROM permittedSearchIDs); DELETE FROM searchTerms WHERE meaning NOT IN (SELECT meaning FROM searchPostings)"
        )
        try db.execute(sql: "DELETE FROM searchVectors WHERE photo NOT IN (SELECT id FROM searchRecords) OR revision!= (SELECT json_extract(value,'$.revision') FROM searchRecords WHERE id=photo)")
        #if !FOTORO_LOCAL_PREVIEW
        if try db.tableExists("peopleFaces") {
          try db.execute(sql: "DELETE FROM peopleFaces WHERE photo NOT IN (SELECT id FROM searchRecords) OR revision!=(SELECT json_extract(value,'$.revision') FROM searchRecords WHERE id=photo); DELETE FROM peopleScans WHERE photo NOT IN (SELECT id FROM searchRecords) OR revision!=(SELECT json_extract(value,'$.revision') FROM searchRecords WHERE id=photo)")
        }
        #endif
        if records.isEmpty {
          try db.execute(sql: "DELETE FROM searchEvents; DELETE FROM searchPins; DELETE FROM searchAnalysisProgress")
        }
        return true
      }
    } catch is CancellationError { return false }
  }
  func put(_ record: SearchRecord) throws { try database.write { try put(record, db: $0) } }
  func put(_ r: SearchRecord, db: Database) throws {
    try db.cachedStatement(
      sql:
        "INSERT INTO searchRecords(id,scope,capture,favorite,moment,ocrState,visualState,preview,burst,value) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,capture=excluded.capture,favorite=excluded.favorite,moment=excluded.moment,ocrState=excluded.ocrState,visualState=excluded.visualState,preview=excluded.preview,burst=excluded.burst,value=excluded.value")
      .execute(arguments: [
        r.id, r.scope, r.capturedAt?.timeIntervalSince1970, r.favorite, r.currentMoment,
        r.ocrStatus.rawValue, r.visualStatus.rawValue, r.previewAvailable, r.burstID, try JSONEncoder().encode(r),
      ])
    try db.cachedStatement(sql: "DELETE FROM searchPostings WHERE photo=?").execute(arguments: [r.id])
    try db.cachedStatement(sql: "DELETE FROM searchFTS WHERE id=?").execute(arguments: [r.id])
    try db.cachedStatement(sql: "INSERT INTO searchFTS(id,text) VALUES(?,?)").execute(arguments: [
        r.id,
        (r.captions + r.keywords + [PhotoOrganizationFacts.name(r.facts, original: r.filename), r.ocrStatus == .complete ? r.ocrText : ""]).joined(
          separator: " "),
      ])
    let terms = try db.cachedStatement(sql: "INSERT OR IGNORE INTO searchTerms(meaning,term,display,relation) VALUES(?,?,?,?)")
    let postings = try db.cachedStatement(sql: "INSERT INTO searchPostings(meaning,photo,evidence,confidence,display) VALUES(?,?,?,?,?) ON CONFLICT(meaning,photo) DO UPDATE SET evidence=min(evidence,excluded.evidence),confidence=max(confidence,excluded.confidence),display=excluded.display")
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
        try terms.execute(arguments: [meaning, word, display, relation.rawValue])
      }
      try postings.execute(arguments: [meaning, r.id, evidence, confidence, display])
    }
    for label in r.labels { try add(label, relation: .label, evidence: 0, supplied: true) }
    if r.visualStatus == .complete {
      for label in SearchVisualPolicy.validated(r.visualLabels, processor: r.visualProcessor) {
        try add(label.label, relation: .visual, evidence: 5, confidence: label.confidence)
      }
    }
    if let metadata = r.captureMetadata { try add(metadata.searchText, relation: .metadata, evidence: 1, supplied: true) }
    let screenshot = PhotoOrganizationFacts.screenshot(r.facts, detected: r.captureMetadata?.items.contains { $0.k == "subtypes" && $0.p == .photos && $0.v.split(separator: ",").contains("screenshot") } == true)
    if screenshot { try add("Screenshot", relation: .metadata, evidence: 1, supplied: true) }
    for fact in r.facts {
      if fact == "screenshot" && !screenshot { continue }
      if PhotoCaptureFacts.isReserved(fact) || PhotoOrganizationFacts.category(fact) != nil { continue }
      #if !FOTORO_LOCAL_PREVIEW
      if PhotoPeopleFacts.isReserved(fact) || fact.hasPrefix("fotoro.ai.v1:") { continue }
      #endif
      try add(fact, relation: .metadata, evidence: 1, supplied: true)
    }
    #if !FOTORO_LOCAL_PREVIEW
    for person in PhotoPeopleFacts.read(r.facts, enforceWireLimits: false) { try add(person.n, relation: .label, evidence: 0, supplied: true) }
    #endif
    if r.favorite { try add("favorite", relation: .metadata, evidence: 1) }
    if let date = r.capturedAt {
      try add(captureDayFormatter.string(from: date), relation: .metadata, evidence: 1, supplied: true)
      for word in Self.words(date.formatted(date: .complete, time: .omitted))
      where Self.suggestible(word) { try add(word, relation: .metadata, evidence: 1) }
    }
    for caption in r.captions + r.keywords {
      for word in Self.words(caption) where Self.suggestible(word) {
        try add(word, relation: .text, evidence: 2)
      }
    }
    for word in Self.words((PhotoOrganizationFacts.name(r.facts, original: r.filename) as NSString).deletingPathExtension)
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
  private static func permitsTermPrefix(_ query: String) -> Bool {
    if query.allSatisfy(\.isNumber) { return false }
    guard let last = query.split(separator: " ").last else { return false }
    let parts = last.split(separator: "-", omittingEmptySubsequences: false)
    return !(parts.count > 1 && parts[0].count == 4 && parts[0].allSatisfy(\.isNumber))
  }
  private static let noise: Set<String> = [
    "a", "an", "the", "and", "or", "of", "on", "in", "to", "for", "is", "it", "at", "by", "with",
    "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "img", "dsc", "dcim",
  ]
  private static func suggestible(_ word: String) -> Bool {
    word.count > 1 && !noise.contains(word) && word.contains(where: { $0.isLetter })
  }
  @discardableResult func setOrganization(_ change: PhotoOrganizationChange, photoID: String) throws -> Bool {
    try database.write { db in
      guard var record = try Row.fetchOne(db, sql: "SELECT value FROM searchRecords WHERE id=?", arguments: [photoID]).map(decode) else { return false }
      if case .name(let name) = change, let name,
        (name as NSString).pathExtension.lowercased() != (record.filename as NSString).pathExtension.lowercased() { throw PhotoOrganizationError.invalid }
      record.facts = try PhotoOrganizationFacts.replacing(record.facts, change: change)
      try put(record, db: db)
      return true
    }
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
    var sql = "r.scope=? AND NOT ((SELECT count(*) FROM json_each(r.value,'$.facts') WHERE value LIKE 'fotoro.trash.v1:%')=1 AND EXISTS(SELECT 1 FROM json_each(r.value,'$.facts') WHERE value='fotoro.trash.v1:true'))"
    var args: StatementArguments = [scope.source]
    if let from = scope.from {
      sql += " AND r.capture>=?"
      args += [from.timeIntervalSince1970]
    }
    if let through = scope.through {
      sql += " AND r.capture<=?"
      args += [through.timeIntervalSince1970]
    }
    if let until = scope.until {
      sql += " AND r.capture<?"
      args += [until.timeIntervalSince1970]
    }
    if !scope.people.isEmpty {
      #if FOTORO_LOCAL_PREVIEW
      sql += " AND 0"
      #else
      let ids = String(decoding: (try? JSONEncoder().encode(scope.people.personIDs)) ?? Data(), as: UTF8.self)
      sql += " AND searchPeopleMatch(r.value,?,?)=1"
      args += [ids, scope.people.match.rawValue]
      #endif
    }
    return (sql, args)
  }
  func search(
    _ query: String, scope: SearchScope = SearchScope(), acceptedMeaningID: String? = nil,
    previous: SearchResponse? = nil, now: Date = Date(), generation: UInt64 = 0,
    calendar: Calendar = .current
  ) throws -> SearchResponse {
    try database.read { db in
      try performSearch(query, scope: scope, acceptedMeaningID: acceptedMeaningID,
        previous: previous, now: now, generation: generation, calendar: calendar, db: db)
    }
  }
  func searchAsync(
    _ query: String, scope: SearchScope = SearchScope(), acceptedMeaningID: String? = nil,
    previous: SearchResponse? = nil, now: Date = Date(), generation: UInt64 = 0,
    calendar: Calendar = .current
  ) async throws -> SearchResponse {
    // GRDB's async read interrupts only this operation on cancellation, then
    // resets the connection before admitting the next read or analysis write.
    try await database.read { db in
      try self.performSearch(query, scope: scope, acceptedMeaningID: acceptedMeaningID,
        previous: previous, now: now, generation: generation, calendar: calendar, db: db)
    }
  }
  private func performSearch(
    _ query: String, scope: SearchScope, acceptedMeaningID: String?,
    previous: SearchResponse?, now: Date, generation: UInt64,
    calendar: Calendar, db: Database
  ) throws -> SearchResponse {
    let parsed = NaturalDateQuery.parse(query, scope: scope, now: now, calendar: calendar)
    let scope = parsed.scope
    let previousQuery = previous.map {
      NaturalDateQuery.parse($0.query, now: now, calendar: calendar).text
    } ?? ""
    var response = SearchResponse(query: query, generation: generation)
    response.scope = scope
    response.datePhrase = parsed.datePhrase
    let (condition, scopeArgs) = filter(scope)
    let coverage = try Row.fetchOne(
      db,
      sql:
        "SELECT count(*) total,sum(ocrState='complete') ocrComplete,sum(preview) previews FROM searchRecords r WHERE \(condition)",
      arguments: scopeArgs)!
    response.total = coverage["total"]
    response.indexed = coverage["ocrComplete"] ?? 0
    response.availablePreviews = coverage["previews"] ?? 0
    let q = parsed.text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else {
      return parsed.datePhrase == nil && scope.people.isEmpty ? response : try dateOnly(response, scope: scope, now: now, db: db)
    }
    // Keep the indexed prefix range outermost. A source-first plan multiplies
    // the full library by every matching term during short-prefix typing.
    // Scope and eligibility still apply before the result limit.
    var meaningArgs: StatementArguments = [
      q, now.timeIntervalSince1970, scope.key, q, q + "\u{10ffff}", Self.permitsTermPrefix(q), q,
    ]
    meaningArgs += scopeArgs
    meaningArgs += [acceptedMeaningID ?? ""]
    let rows = try Row.fetchAll(
      db,
      sql: """
        SELECT t.meaning,min(t.term) term,min(p.display) display,t.relation,min(p.evidence) evidence,count(DISTINCT p.photo) eligible,
          max(t.term=?) exact,max(r.moment) moment,
          coalesce((SELECT sum(searchDecay(e.at,?)) FROM searchEvents e WHERE e.kind='accept' AND e.meaning=t.meaning AND e.scope=?),0) accepted
        FROM searchTerms t INDEXED BY searchTermPrefix
        CROSS JOIN searchPostings p ON p.meaning=t.meaning
        CROSS JOIN searchRecords r ON r.id=p.photo
        WHERE t.term>=? AND t.term<? AND (? OR t.term=?) AND \(condition)
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
      previous?.scope == scope, q.hasPrefix(previousQuery),
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
      previous?.scope == scope, q.count >= previousQuery.count, q.hasPrefix(previousQuery),
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
  private static func reason(evidence: Int) -> String {
    switch evidence {
    case 0: return "Supplied label"
    case 1: return "Photos metadata"
    case 2: return "Caption or keyword"
    case 3: return "Filename mention"
    case 5: return "Inferred scene"
    default: return "Text in photo"
    }
  }
  private static func dateMeaningID(_ scope: SearchScope) -> String { "date:" + scope.key }
  private func dateOnly(_ response: SearchResponse, scope: SearchScope, now: Date, db: Database) throws -> SearchResponse {
    var response = response
    let (condition, args) = filter(scope)
    let meaningID = Self.dateMeaningID(scope)
    let pin = try String.fetchOne(db, sql: "SELECT photo FROM searchPins WHERE meaning=? AND scope=?",
      arguments: [meaningID, scope.key])
    let rows = try Row.fetchAll(db, sql: """
      SELECT r.id,r.preview FROM searchRecords r WHERE \(condition)
      ORDER BY (r.id=?) DESC,r.moment DESC,r.favorite DESC,
        CASE WHEN r.capture<=? THEN r.capture END DESC,r.id LIMIT 200
      """, arguments: args + [pin ?? "", now.timeIntervalSince1970])
    let meaning = SearchMeaning(id: meaningID, term: response.datePhrase ?? "", display: response.datePhrase ?? "",
      relation: .metadata, evidenceClass: 1, eligibleCount: response.total)
    response.meaning = meaning
    response.meanings = [meaning]
    response.results = rows.map { row in
      let id: String = row["id"]
      return SearchHit(id: id, evidenceClass: 1, reason: (id == pin ? "Your representative · " : "") + "Photos metadata",
        pinned: id == pin, previewAvailable: row["preview"])
    }
    return response
  }
  private static func fullTextMatch(_ query: String) -> String {
    let words = words(query)
    return words.enumerated().map { offset, word in
      "\"" + word + "\"" + (offset == words.count - 1 && word.contains(where: \.isLetter) ? "*" : "")
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
    if meaning.hasPrefix("date:") {
      guard meaning == Self.dateMeaningID(scope), scope.from != nil || scope.until != nil || !scope.people.isEmpty else { return 0 }
      return try Int.fetchOne(db, sql: "SELECT count(*) FROM searchRecords r WHERE \(condition)" + photoFilter,
        arguments: scopeArgs + photoArgs) ?? 0
    }
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
