import Foundation
import GRDB
import Observation
import Photos

enum AnnotationSourceBinding {
  static func accepts(sourceRevision: String?, recordRevision: String) -> Bool {
    sourceRevision == recordRevision && sourceRevision != nil
  }
  static func permitsAutomaticDerived(resourceTypes: [PHAssetResourceType]) -> Bool {
    !resourceTypes.contains(.adjustmentData)
  }
}
enum AnnotationCrypto {
  struct Opened { var revision: Int; var annotations: PhotoAnnotationsV1 }
  private static func checkKeys(_ data: Data, allowed: Set<String>) throws {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(object.keys).isSubset(of: allowed), object.values.allSatisfy({ !($0 is NSNull) }) else {
      throw FotoroError("Unsupported photo labels fields")
    }
  }
  private static func validVisual(_ visual: PhotoAnnotationsV1.Visual) -> Bool {
    !visual.processor.isEmpty && visual.processor.unicodeScalars.count <= 120
      && visual.labels.count <= SearchVisualPolicy.maximumLabels && visual.labels.allSatisfy {
        !$0.label.isEmpty && $0.label.unicodeScalars.count <= 120
          && !$0.identifier.isEmpty && $0.identifier.unicodeScalars.count <= 120
          && $0.confidence.isFinite && (0...1).contains($0.confidence)
      }
  }
  static func validate(_ value: PhotoAnnotationsV1, photo: LocalPhoto, accountId: String) throws {
    func strings(_ values: [String]?, max: Int) -> Bool {
      guard let values else { return true }
      return values.count <= 64 && values.allSatisfy { !$0.isEmpty && $0.unicodeScalars.count <= max }
    }
    guard value.version == 1, UUID(uuidString: value.photoId) != nil,
      value.photoId == photo.photoId, photo.manifest.photoId == photo.photoId,
      photo.manifest.ownerAccountId == accountId,
      value.originalSha256 == photo.metadata.originalSha256,
      try Data(b64: value.originalSha256).count == 32,
      strings(value.labels, max: 120), strings(value.keywords, max: 120), strings(value.facts, max: 240),
      (value.caption?.unicodeScalars.count ?? 0) <= 2000
    else { throw FotoroError("Photo labels do not match this original or account") }
    if let ocr = value.ocr {
      guard ocr.text.unicodeScalars.count <= 131072, ocr.confidence.isFinite, (0...1).contains(ocr.confidence),
        !ocr.processor.isEmpty, ocr.processor.unicodeScalars.count <= 120
      else { throw FotoroError("Photo text is too large or invalid") }
    }
    if let visual = value.visual, !validVisual(visual) { throw FotoroError("Photo scenes are invalid") }
  }
  static func seal(_ value: PhotoAnnotationsV1, revision: Int, photo: LocalPhoto, accountId: String, bundle: AccountBundle) throws -> SignedPayloadV1 {
    try validate(value, photo: photo, accountId: accountId)
    guard revision > 0, revision <= 2147483647 else { throw FotoroError("Invalid labels revision") }
    var outgoing = value
    if !SearchVisualPolicy.publicationEnabled { outgoing.visual = nil }
    let encrypted = try CryptoAdapter().wrap(Wire.encode(outgoing), key: Data(b64: bundle.vaultKey))
    guard encrypted.ciphertext.count <= 262144 else { throw FotoroError("Photo labels are too large") }
    return try CryptoAdapter().sign(PhotoAnnotationsUpdateV1(photoId: photo.id, revision: revision, encrypted: encrypted), kind: "photo-annotations", accountId: accountId, secret: Data(b64: bundle.signingSecretKey))
  }
  static func publicationAllowed(_ signed: SignedPayloadV1, bundle: AccountBundle) throws -> Bool {
    guard !SearchVisualPolicy.publicationEnabled else { return true }
    let update = try Wire.decode(PhotoAnnotationsUpdateV1.self, Data(b64: signed.body))
    let raw = try CryptoAdapter().unwrap(update.encrypted, key: Data(b64: bundle.vaultKey))
    guard let fields = try JSONSerialization.jsonObject(with: raw) as? [String: Any] else { return false }
    // An exact frozen retry containing a new field cannot be rewritten under its old revision.
    return fields["visual"] == nil
  }
  static func open(_ signed: SignedPayloadV1, photo: LocalPhoto, card: AccountCardV1, bundle: AccountBundle) throws -> Opened {
    guard signed.accountId == photo.manifest.ownerAccountId else { throw FotoroError("Labels belong to another account") }
    let crypto = CryptoAdapter()
    let body = try crypto.verify(signed, card: card, kind: "photo-annotations")
    try checkKeys(body, allowed: ["version", "photoId", "revision", "encrypted"])
    if let object = try JSONSerialization.jsonObject(with: body) as? [String: Any], let encrypted = object["encrypted"] {
      try checkKeys(JSONSerialization.data(withJSONObject: encrypted), allowed: ["version", "nonce", "ciphertext"])
    }
    let update = try Wire.decode(PhotoAnnotationsUpdateV1.self, body)
    guard update.version == 1, update.photoId == photo.id, update.revision > 0, update.revision <= 2147483647,
      update.encrypted.ciphertext.count <= 262144
    else { throw FotoroError("Invalid labels revision or photo") }
    let plaintext = try crypto.unwrap(update.encrypted, key: Data(b64: bundle.vaultKey))
    guard var fields = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any] else { throw FotoroError("Unsupported photo labels fields") }
    let requiredFields = fields.filter { $0.key != "visual" }
    try checkKeys(JSONSerialization.data(withJSONObject: requiredFields), allowed: ["version", "photoId", "originalSha256", "labels", "caption", "keywords", "facts", "favorite", "ocr"])
    if let object = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any], let ocr = object["ocr"] {
      try checkKeys(JSONSerialization.data(withJSONObject: ocr), allowed: ["text", "confidence", "processor"])
    }
    if let visual = fields["visual"] {
      // Invalid optional scene data must not hide a verified original or valid supplied labels.
      do {
        guard let object = visual as? [String: Any], let labels = object["labels"] as? [[String: Any]] else { throw FotoroError("Invalid scenes") }
        let data = try JSONSerialization.data(withJSONObject: object)
        try checkKeys(data, allowed: ["processor", "labels"])
        for label in labels { try checkKeys(JSONSerialization.data(withJSONObject: label), allowed: ["label", "identifier", "confidence"]) }
        guard validVisual(try Wire.decode(PhotoAnnotationsV1.Visual.self, data)) else { throw FotoroError("Invalid scenes") }
      } catch { fields.removeValue(forKey: "visual") }
    }
    let value = try Wire.decode(PhotoAnnotationsV1.self, JSONSerialization.data(withJSONObject: fields))
    try validate(value, photo: photo, accountId: card.accountId)
    return Opened(revision: update.revision, annotations: value)
  }
}

enum AnnotationMerge {
  static let factCategories = ["supplied", "people", "location", "capture", "observation", "reserved"]
  static func factCategory(_ fact: String) -> String {
    if PhotoPeopleFacts.isReserved(fact) { return "people" }
    if PhotoLocationFacts.isReserved(fact) { return "location" }
    if PhotoCaptureFacts.isReserved(fact) { return "capture" }
    if fact.hasPrefix("fotoro.ai.v1:") { return "observation" }
    return fact.hasPrefix("fotoro.") || fact.hasPrefix("fotoro:") ? "reserved" : "supplied"
  }
  static func factGroup(_ facts: [String]?, _ category: String) -> [String] {
    (facts ?? []).filter { factCategory($0) == category }
  }
  struct Result { var local: PhotoAnnotationsV1; var remote: PhotoAnnotationsV1; var conflicts: [String] }
  static func merge(base: PhotoAnnotationsV1, local: PhotoAnnotationsV1, remote: PhotoAnnotationsV1) -> Result {
    var mine = local
    var theirs = local
    var conflicts: [String] = []
    func field<T: Equatable>(_ base: T, _ local: T, _ remote: T, _ name: String) -> (T, T) {
      if local == base { return (remote, remote) }
      if remote == base || local == remote { return (local, local) }
      conflicts.append(name)
      return (local, remote)
    }
    (mine.labels, theirs.labels) = field(base.labels, local.labels, remote.labels, "labels")
    (mine.caption, theirs.caption) = field(base.caption, local.caption, remote.caption, "caption")
    (mine.keywords, theirs.keywords) = field(base.keywords, local.keywords, remote.keywords, "keywords")
    if local.facts == base.facts { mine.facts = remote.facts; theirs.facts = remote.facts }
    else if remote.facts == base.facts || local.facts == remote.facts { mine.facts = local.facts; theirs.facts = local.facts }
    else {
      mine.facts = []; theirs.facts = []
      for category in factCategories {
        let (localGroup, remoteGroup) = field(factGroup(base.facts, category), factGroup(local.facts, category), factGroup(remote.facts, category), "facts." + category)
        mine.facts?.append(contentsOf: localGroup); theirs.facts?.append(contentsOf: remoteGroup)
      }
    }
    (mine.favorite, theirs.favorite) = field(base.favorite, local.favorite, remote.favorite, "favorite")
    (mine.ocr, theirs.ocr) = field(base.ocr, local.ocr, remote.ocr, "ocr")
    (mine.visual, theirs.visual) = field(base.visual, local.visual, remote.visual, "visual")
    return Result(local: mine, remote: theirs, conflicts: conflicts)
  }
  static func stillConflicting(_ fields: [String], local: PhotoAnnotationsV1, remote: PhotoAnnotationsV1) -> [String] {
    fields.filter {
      switch $0 {
      case "labels": return local.labels != remote.labels
      case "caption": return local.caption != remote.caption
      case "keywords": return local.keywords != remote.keywords
      case "facts": return local.facts != remote.facts
      case "favorite": return local.favorite != remote.favorite
      case "ocr": return local.ocr != remote.ocr
      case "visual": return local.visual != remote.visual
      default:
        if $0.hasPrefix("facts.") { return factGroup(local.facts, String($0.dropFirst(6))) != factGroup(remote.facts, String($0.dropFirst(6))) }
        return false
      }
    }
  }
  static func choosingRemote(_ fields: [String], local: PhotoAnnotationsV1, remote: PhotoAnnotationsV1) -> PhotoAnnotationsV1 {
    var value = local
    if fields.contains("labels") { value.labels = remote.labels }
    if fields.contains("caption") { value.caption = remote.caption }
    if fields.contains("keywords") { value.keywords = remote.keywords }
    if fields.contains("facts") { value.facts = remote.facts }
    else {
      let categories = factCategories.filter { fields.contains("facts." + $0) }
      if !categories.isEmpty {
        value.facts = factCategories.flatMap { factGroup(categories.contains($0) ? remote.facts : local.facts, $0) }
      }
    }
    if fields.contains("favorite") { value.favorite = remote.favorite }
    if fields.contains("ocr") { value.ocr = remote.ocr }
    if fields.contains("visual") { value.visual = remote.visual }
    return value
  }
}

struct AnnotationState: Codable, Sendable {
  var accountId: String
  var photoId: String
  var originalSha256: String
  var revision = 0
  var accepted: SignedPayloadV1?
  var draft: WrappedKeyV1?
  var editId: String?
  var pending: SignedPayloadV1?
  var pendingEditId: String?
  var conflict = false
  var base: WrappedKeyV1?
  var remoteChoice: WrappedKeyV1?
  var conflictingFields: [String]?
}
// Account scoped state keeps both local edits and the exact retry payload encrypted at rest.
final class AnnotationLedger: @unchecked Sendable {
  let store: LibraryStore
  let accountId: String
  init(store: LibraryStore, accountId: String) { self.store = store; self.accountId = accountId }
  func state(_ id: String) throws -> AnnotationState? {
    try store.database.read { db in
      try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [id]).map { try Wire.decode(AnnotationState.self, $0) }
    }
  }
  private func save(_ state: AnnotationState, db: Database) throws {
    try db.execute(sql: "INSERT INTO annotations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", arguments: [state.photoId, try Wire.encode(state)])
  }
  // Intake can seed a new private draft in the same transaction as its original.
  // Existing overlays are never overwritten by an import or a duplicate source.
  func seedLocation(_ location: PhotoLocationV1?, photo: LocalPhoto, bundle: AccountBundle, db: Database) throws {
    try seedMetadata(location: location, capture: nil, photo: photo, bundle: bundle, db: db)
  }
  func seedMetadata(location: PhotoLocationV1?, capture: PhotoCaptureMetadata?, photo: LocalPhoto, bundle: AccountBundle, db: Database) throws {
    let facts = capture?.facts(originalSha256: photo.metadata.originalSha256) ?? []
    guard location != nil || !facts.isEmpty else { return }
    // A duplicate import must not replace an existing owner's private overlay.
    guard try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [photo.id]) == nil else { return }
    var value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    if !facts.isEmpty { value.facts = facts }
    try value.setLocation(location)
    try AnnotationCrypto.validate(value, photo: photo, accountId: accountId)
    let key = try Data(b64: bundle.vaultKey)
    let base = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    try save(AnnotationState(accountId: accountId, photoId: photo.id, originalSha256: photo.metadata.originalSha256,
      draft: CryptoAdapter().wrap(Wire.encode(value), key: key), editId: Wire.id(),
      base: CryptoAdapter().wrap(Wire.encode(base), key: key)), db: db)
  }
  private func checked(_ state: AnnotationState, photo: LocalPhoto) throws {
    guard state.accountId == accountId, state.photoId == photo.id,
      photo.manifest.ownerAccountId == accountId, state.originalSha256 == photo.metadata.originalSha256
    else { throw FotoroError("Photo changed; labels cannot be attached to this original") }
  }
  func current(photo: LocalPhoto, bundle: AccountBundle, card: AccountCardV1) throws -> PhotoAnnotationsV1? {
    guard photo.manifest.ownerAccountId == accountId, card.accountId == accountId else { throw FotoroError("Labels belong to another account") }
    guard let state = try state(photo.id) else { return nil }
    try checked(state, photo: photo)
    if let draft = state.draft {
      let value = try Wire.decode(PhotoAnnotationsV1.self, CryptoAdapter().unwrap(draft, key: Data(b64: bundle.vaultKey)))
      try AnnotationCrypto.validate(value, photo: photo, accountId: accountId)
      return value
    }
    return try state.accepted.map { try AnnotationCrypto.open($0, photo: photo, card: card, bundle: bundle).annotations }
  }
  func edit(_ value: PhotoAnnotationsV1, photo: LocalPhoto, bundle: AccountBundle, card: AccountCardV1) throws {
    try AnnotationCrypto.validate(value, photo: photo, accountId: accountId)
    if try current(photo: photo, bundle: bundle, card: card) == value { return }
    let prior = try current(photo: photo, bundle: bundle, card: card) ?? PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
    let encrypted = try CryptoAdapter().wrap(Wire.encode(value), key: Data(b64: bundle.vaultKey))
    guard encrypted.ciphertext.count <= 262144 else { throw FotoroError("Photo labels are too large") }
    try store.database.write { db in
      var state = try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [photo.id]).map { try Wire.decode(AnnotationState.self, $0) } ?? AnnotationState(accountId: accountId, photoId: photo.id, originalSha256: photo.metadata.originalSha256)
      try checked(state, photo: photo)
      if state.draft == nil { state.base = try CryptoAdapter().wrap(Wire.encode(prior), key: Data(b64: bundle.vaultKey)) }
      state.draft = encrypted
      state.editId = Wire.id()
      if state.conflict, let accepted = state.accepted, let fields = state.conflictingFields {
        let remote = try AnnotationCrypto.open(accepted, photo: photo, card: card, bundle: bundle).annotations
        let alternative = AnnotationMerge.choosingRemote(fields, local: value, remote: remote)
        state.remoteChoice = try CryptoAdapter().wrap(Wire.encode(alternative), key: Data(b64: bundle.vaultKey))
      }
      try save(state, db: db)
    }
  }
  func prepare(photo: LocalPhoto, bundle: AccountBundle, card: AccountCardV1? = nil, derivedOnly: Bool = false) throws -> SignedPayloadV1? {
    try store.database.write { db in
      guard var state = try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [photo.id]).map({ try Wire.decode(AnnotationState.self, $0) }) else { return nil }
      try checked(state, photo: photo)
      guard !state.conflict else { return nil }
      func eligible(_ value: PhotoAnnotationsV1) throws -> Bool {
        guard derivedOnly else { return true }
        guard let card, card.accountId == accountId else { throw FotoroError("Labels belong to another account") }
        let base = try state.accepted.map { try AnnotationCrypto.open($0, photo: photo, card: card, bundle: bundle).annotations }
          ?? PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256)
        let suppliedFacts = PhotoLocationFacts.userFacts(value.facts).filter { !PhotoCaptureFacts.isReserved($0) }
        let priorSuppliedFacts = PhotoLocationFacts.userFacts(base.facts).filter { !PhotoCaptureFacts.isReserved($0) }
        let captureAllowed = PhotoCaptureFacts.isDerivedAddition(value.facts, from: base.facts, originalSha256: photo.metadata.originalSha256)
        let locationsUnchanged = (value.facts ?? []).filter(PhotoLocationFacts.isReserved) == (base.facts ?? []).filter(PhotoLocationFacts.isReserved)
        let locationAllowed = locationsUnchanged || value.location.map { ["exif", "photos"].contains($0.source) } == true
        // Automatic sync never publishes an unfinished supplied-field edit, including a frozen retry.
        return value.labels == base.labels && value.caption == base.caption && value.keywords == base.keywords
          && captureAllowed && locationAllowed && suppliedFacts == priorSuppliedFacts
          && value.favorite == base.favorite
          && (value.ocr == base.ocr || value.ocr?.processor == "vision-text-v1")
          && (value.visual == base.visual || (value.visual?.processor == SearchVisualPolicy.processor
            && value.visual?.labels == SearchVisualPolicy.validated(value.visual).map {
              PhotoAnnotationsV1.Visual.Label(label: $0.label, identifier: $0.identifier, confidence: $0.confidence)
            }))
      }
      if let pending = state.pending {
        guard try AnnotationCrypto.publicationAllowed(pending, bundle: bundle) else { return nil }
        if derivedOnly {
          guard let card else { throw FotoroError("Labels belong to another account") }
          guard try eligible(AnnotationCrypto.open(pending, photo: photo, card: card, bundle: bundle).annotations) else { return nil }
        }
        return pending
      }
      guard let draft = state.draft, state.revision < 2147483647 else { return nil }
      let value = try Wire.decode(PhotoAnnotationsV1.self, CryptoAdapter().unwrap(draft, key: Data(b64: bundle.vaultKey)))
      guard try eligible(value) else { return nil }
      state.pending = try AnnotationCrypto.seal(value, revision: state.revision + 1, photo: photo, accountId: accountId, bundle: bundle)
      state.pendingEditId = state.editId
      try save(state, db: db)
      return state.pending
    }
  }
  func receive(_ signed: SignedPayloadV1, photo: LocalPhoto, bundle: AccountBundle, card: AccountCardV1) throws {
    guard card.accountId == accountId else { throw FotoroError("Labels belong to another account") }
    let opened = try AnnotationCrypto.open(signed, photo: photo, card: card, bundle: bundle)
    try store.database.write { db in
      var state = try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [photo.id]).map { try Wire.decode(AnnotationState.self, $0) } ?? AnnotationState(accountId: accountId, photoId: photo.id, originalSha256: photo.metadata.originalSha256)
      try checked(state, photo: photo)
      guard opened.revision >= state.revision else { return }
      if opened.revision == state.revision, let accepted = state.accepted, accepted != signed { throw FotoroError("Conflicting signed labels at the same revision") }
      if state.pending == signed {
        if state.editId == state.pendingEditId { state.draft = nil; state.editId = nil }
        state.base = try CryptoAdapter().wrap(Wire.encode(opened.annotations), key: Data(b64: bundle.vaultKey))
        state.remoteChoice = nil; state.conflictingFields = nil
        state.pending = nil
        state.pendingEditId = nil
        state.conflict = false
      } else if let draft = state.draft, opened.revision > state.revision {
        let key = try Data(b64: bundle.vaultKey)
        let local = try Wire.decode(PhotoAnnotationsV1.self, CryptoAdapter().unwrap(draft, key: key))
        let base: PhotoAnnotationsV1
        if let encryptedBase = state.base { base = try Wire.decode(PhotoAnnotationsV1.self, CryptoAdapter().unwrap(encryptedBase, key: key)) }
        else if let accepted = state.accepted { base = try AnnotationCrypto.open(accepted, photo: photo, card: card, bundle: bundle).annotations }
        else { base = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256) }
        let merged = AnnotationMerge.merge(base: base, local: local, remote: opened.annotations)
        let unresolved = state.conflict ? AnnotationMerge.stillConflicting(state.conflictingFields ?? [], local: merged.local, remote: opened.annotations) : []
        let conflicts = Array(Set(merged.conflicts + unresolved)).sorted()
        state.conflict = !conflicts.isEmpty
        state.conflictingFields = conflicts
        state.draft = try CryptoAdapter().wrap(Wire.encode(merged.local), key: key)
        let alternative = AnnotationMerge.choosingRemote(conflicts, local: merged.remote, remote: opened.annotations)
        state.remoteChoice = try CryptoAdapter().wrap(Wire.encode(alternative), key: key)
        state.base = try CryptoAdapter().wrap(Wire.encode(opened.annotations), key: key)
        state.editId = Wire.id()
        if !state.conflict { state.pending = nil; state.pendingEditId = nil }
      }
      state.revision = opened.revision
      state.accepted = signed
      try save(state, db: db)
    }
  }
  func markConflict(_ id: String) throws {
    try store.database.write { db in
      guard var state = try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [id]).map({ try Wire.decode(AnnotationState.self, $0) }), state.accountId == accountId else { return }
      state.conflict = true
      try save(state, db: db)
    }
  }
  func resolve(_ id: String, keepLocal: Bool) throws {
    try store.database.write { db in
      guard var state = try Data.fetchOne(db, sql: "SELECT value FROM annotations WHERE id=?", arguments: [id]).map({ try Wire.decode(AnnotationState.self, $0) }), state.accountId == accountId,
        state.conflict, state.accepted != nil else { throw FotoroError("Refresh labels before choosing a version") }
      state.pending = nil; state.pendingEditId = nil; state.conflict = false
      if !keepLocal {
        state.draft = state.remoteChoice
        state.editId = state.draft == nil ? nil : Wire.id()
      }
      state.remoteChoice = nil; state.conflictingFields = nil
      try save(state, db: db)
    }
  }
  func pendingIDs() throws -> [String] {
    try store.database.read { db in
      try Data.fetchAll(db, sql: "SELECT value FROM annotations ORDER BY id").compactMap {
        let state = try Wire.decode(AnnotationState.self, $0)
        return state.accountId == accountId && state.draft != nil ? state.photoId : nil
      }
    }
  }
}

@MainActor @Observable final class AnnotationSync {
  let ledger: AnnotationLedger
  private(set) var busy = false
  private(set) var errors: [String: String] = [:]
  private var requestedDrain: (derivedOnly: Bool, action: () async -> Void)?
  init(ledger: AnnotationLedger) { self.ledger = ledger }
  func resume(bundle: AccountBundle, card: AccountCardV1, derivedOnly: Bool = false, eligible: @escaping (LocalPhoto) -> Bool = { _ in true }, valid: @escaping () -> Bool, send: @escaping (SignedPayloadV1) async throws -> Void) async {
    guard valid() else { return }
    if busy {
      // Preserve the requesting mode and its source/account fences. An automatic wakeup
      // cannot broaden an earlier explicit Save into another manual publication pass.
      if requestedDrain == nil || !derivedOnly {
        requestedDrain = (derivedOnly, { [weak self] in
          await self?.resume(bundle: bundle, card: card, derivedOnly: derivedOnly, eligible: eligible, valid: valid, send: send)
        })
      }
      return
    }
    busy = true
    do {
      let pending = try ledger.pendingIDs()
      let pendingSet = Set(pending)
      errors = errors.filter { $0.key == "sync" || pendingSet.contains($0.key) }
      for id in pending {
        guard valid(), !Task.isCancelled else { throw CancellationError() }
        guard let photo = try ledger.store.backupPhoto(id), ["committed", "saved"].contains(photo.transferState) else { continue }
        guard eligible(photo) else { continue }
        while let signed = try ledger.prepare(photo: photo, bundle: bundle, card: card, derivedOnly: derivedOnly) {
          guard valid(), !Task.isCancelled else { throw CancellationError() }
          guard eligible(photo) else { break }
          do {
            try await send(signed)
            guard valid(), !Task.isCancelled else { throw CancellationError() }
            guard eligible(photo) else { break }
            try ledger.receive(signed, photo: photo, bundle: bundle, card: card)
            errors.removeValue(forKey: id)
          } catch {
            guard valid(), !Task.isCancelled else { throw CancellationError() }
            if (error as? FotoroError)?.message == "VERSION_CONFLICT" {
              try ledger.markConflict(id)
              errors[id] = "Labels changed on another device. Your edits are still saved here."
            } else { errors[id] = "Labels are saved here and will sync when you reconnect." }
            break
          }
        }
      }
      guard valid(), !Task.isCancelled else { throw CancellationError() }
      let remaining = Set(try ledger.pendingIDs())
      errors = errors.filter { $0.key != "sync" && remaining.contains($0.key) }
    } catch is CancellationError {
    } catch { errors["sync"] = error.localizedDescription }
    busy = false
    let next = requestedDrain
    requestedDrain = nil
    if !Task.isCancelled { await next?.action() }
  }
}
