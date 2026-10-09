import Foundation
import GRDB

struct AccountContactV1: Codable, Equatable, Sendable {
  var accountId: String
  var card: AccountCardV1?
  var name: String
  enum CodingKeys: String, CodingKey { case accountId, card, name }
  init(accountId: String, card: AccountCardV1?, name: String) { self.accountId = accountId; self.card = card; self.name = name }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    guard values.contains(.card) else { throw FotoroError("Invalid contact entry.") }
    accountId = try values.decode(String.self, forKey: .accountId)
    card = try values.decodeIfPresent(AccountCardV1.self, forKey: .card)
    name = try values.decode(String.self, forKey: .name)
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(accountId, forKey: .accountId)
    if let card { try values.encode(card, forKey: .card) } else { try values.encodeNil(forKey: .card) }
    try values.encode(name, forKey: .name)
  }
}
struct AccountContactsV1: Codable, Equatable, Sendable {
  var version = 1
  var ownerAccountId: String
  var entries: [AccountContactV1] = []
  var canonical: Self { var value = self; value.entries.sort { $0.accountId < $1.accountId }; return value }
}
struct AccountContactsUpdateV1: Codable, Sendable { var version = 1; var revision: Int; var encrypted: WrappedKeyV1 }
struct AccountContactsReplyV1: Codable, Sendable { var version: Int; var contacts: SignedPayloadV1? }
struct ContactConflict: Codable, Equatable, Sendable { var accountId: String; var fields: [String] }
struct ContactSyncConflict: Identifiable, Equatable {
  var owner: String
  var origin: String
  var scopeID = UUID()
  var accountId: String
  var fields: [String]
  var local: AccountContactV1?
  var synced: AccountContactV1?
  var id: String { accountId }
}

enum ContactCrypto {
  static let maximumRevision = 2_147_483_647
  static func uuid(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", options: .regularExpression) != nil }
  static func keys(_ object: Any, _ allowed: Set<String>) throws {
    guard let fields = object as? [String: Any], Set(fields.keys) == allowed else { throw FotoroError("Unsupported contact fields.") }
  }
  static func validate(_ book: AccountContactsV1, owner: String) throws {
    guard book.version == 1, uuid(owner), book.ownerAccountId == owner, book.entries.count <= 500 else { throw FotoroError("Contacts belong to another account or are too large.") }
    var ids = Set<String>()
    for entry in book.entries {
      guard uuid(entry.accountId), entry.accountId != owner, ids.insert(entry.accountId).inserted,
        entry.name.utf16.count <= 80 else { throw FotoroError("Invalid contact entry.") }
      if let card = entry.card {
        guard card.accountId == entry.accountId, uuid(card.accountId) else { throw FotoroError("Contact identity does not match.") }
        _ = try FotoroShareLinks.validatePublicAccountCard(card)
      } else if !entry.name.isEmpty { throw FotoroError("A removed contact cannot have a name.") }
    }
  }
  static func decodeBook(_ data: Data, owner: String) throws -> AccountContactsV1 {
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "ownerAccountId", "entries"])
    guard let entries = (raw as? [String: Any])?["entries"] as? [[String: Any]] else { throw FotoroError("Invalid contacts.") }
    for entry in entries {
      try keys(entry, ["accountId", "card", "name"])
      if !(entry["card"] is NSNull) { try keys(entry["card"] ?? NSNull(), ["version", "accountId", "signingPublicKey", "boxPublicKey"]) }
    }
    let book = try Wire.decode(AccountContactsV1.self, data)
    try validate(book, owner: owner); return book.canonical
  }
  static func seal(_ book: AccountContactsV1, revision: Int, bundle: AccountBundle) throws -> SignedPayloadV1 {
    try validate(book, owner: book.ownerAccountId)
    guard (1...maximumRevision).contains(revision) else { throw FotoroError("Invalid contacts revision.") }
    let encrypted = try CryptoAdapter().wrap(Wire.encode(book.canonical), key: Data(b64: bundle.vaultKey))
    guard encrypted.ciphertext.count <= 262_144 else { throw FotoroError("Contacts are too large.") }
    return try CryptoAdapter().sign(AccountContactsUpdateV1(revision: revision, encrypted: encrypted), kind: "account-contacts",
      accountId: book.ownerAccountId, secret: Data(b64: bundle.signingSecretKey))
  }
  static func open(_ signed: SignedPayloadV1, card: AccountCardV1, bundle: AccountBundle) throws -> (revision: Int, book: AccountContactsV1) {
    let data = try CryptoAdapter().verify(signed, card: card, kind: "account-contacts")
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "revision", "encrypted"])
    try keys((raw as? [String: Any])?["encrypted"] ?? NSNull(), ["version", "nonce", "ciphertext"])
    let update = try Wire.decode(AccountContactsUpdateV1.self, data)
    guard update.version == 1, (1...maximumRevision).contains(update.revision), update.encrypted.ciphertext.count <= 262_144 else { throw FotoroError("Invalid contacts revision.") }
    return (update.revision, try decodeBook(CryptoAdapter().unwrap(update.encrypted, key: Data(b64: bundle.vaultKey)), owner: card.accountId))
  }
  static func reply(_ data: Data) throws -> AccountContactsReplyV1 {
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "contacts"])
    if let signed = (raw as? [String: Any])?["contacts"], !(signed is NSNull) {
      try keys(signed, ["version", "kind", "accountId", "body", "signature"])
    }
    let value = try Wire.decode(AccountContactsReplyV1.self, data)
    guard value.version == 1 else { throw FotoroError("Unsupported contacts version.") }; return value
  }
}

enum ContactMerge {
  struct Result { var value: AccountContactsV1; var conflicts: [ContactConflict] }
  static func merge(base: AccountContactsV1, local: AccountContactsV1, remote: AccountContactsV1,
    unresolved: [ContactConflict] = []) throws -> Result {
    for book in [base, local, remote] { try ContactCrypto.validate(book, owner: local.ownerAccountId) }
    let books = [base, local, remote].map { Dictionary(uniqueKeysWithValues: $0.entries.map { ($0.accountId, $0) }) }
    var entries: [AccountContactV1] = [], conflicts: [ContactConflict] = []
    for id in Set(books.flatMap { $0.keys }).sorted() {
      let before = books[0][id], mine = books[1][id], theirs = books[2][id]
      var value: AccountContactV1?, fields = Set<String>()
      if mine == nil { value = theirs ?? before }
      else if theirs == nil { value = mine }
      else if let mine, let theirs {
        if mine.card == nil || theirs.card == nil {
          if mine == theirs { value = mine }
          else if mine == before { value = theirs }
          else if theirs == before { value = mine }
          else { value = mine; fields.insert("deleted") }
        } else {
          if mine.card != theirs.card && theirs.card != before?.card { fields.insert("card") }
          var name = mine.name
          if mine.name == before?.name { name = theirs.name }
          else if theirs.name != before?.name && theirs.name != mine.name { fields.insert("name") }
          value = AccountContactV1(accountId: id, card: mine.card, name: name)
        }
      }
      for field in unresolved.first(where: { $0.accountId == id })?.fields ?? [] {
        let different = field == "name" ? mine?.name != theirs?.name : field == "card" ? mine?.card != theirs?.card : mine != theirs
        if different {
          fields.insert(field)
          if field == "name", value?.card != nil, mine?.card != nil { value?.name = mine?.name ?? "" }
          else if field == "card", value?.card != nil, mine?.card != nil { value?.card = mine?.card }
          else { value = mine }
        }
      }
      if let value { entries.append(value) }
      if !fields.isEmpty { conflicts.append(ContactConflict(accountId: id, fields: fields.sorted())) }
    }
    let value = AccountContactsV1(ownerAccountId: local.ownerAccountId, entries: entries)
    try ContactCrypto.validate(value, owner: local.ownerAccountId)
    return Result(value: value, conflicts: conflicts)
  }
  static func choosingSynced(_ local: AccountContactV1?, remote: AccountContactV1?, fields: [String]) -> AccountContactV1? {
    guard let remote else { return local }
    if fields.contains("deleted") { return remote }
    guard var value = local else { return remote }
    if fields.contains("card") { value.card = remote.card }
    if fields.contains("name") { value.name = remote.name }
    if value.card == nil { value.name = "" }; return value
  }
}

struct ContactLedgerState: Codable {
  var version = 1
  var owner: String
  var origin: String
  var revision = 0
  var accepted: SignedPayloadV1?
  var base: AccountContactsV1
  var draft: AccountContactsV1
  var editID = Wire.id()
  var pending: SignedPayloadV1?
  var pendingBytes: Data?
  var pendingEditID: String?
  var conflicts: [ContactConflict] = []
}
final class ContactLedger {
  let store: LibraryStore
  let owner: String
  let origin: String
  let bundle: AccountBundle
  let card: AccountCardV1
  var key: String { "contact-sync:" + Data(origin.utf8).digest }
  init(store: LibraryStore, owner: String, origin: String, bundle: AccountBundle, card: AccountCardV1) {
    self.store = store; self.owner = owner; self.origin = origin; self.bundle = bundle; self.card = card
  }
  private func read(_ db: Database) throws -> ContactLedgerState? {
    guard let bytes = try Data.fetchOne(db, sql: "SELECT value FROM operations WHERE id=?", arguments: [key]) else { return nil }
    let wrapped = try Wire.decode(WrappedKeyV1.self, bytes)
    let state = try Wire.decode(ContactLedgerState.self, CryptoAdapter().unwrap(wrapped, key: Data(b64: bundle.vaultKey)))
    guard state.version == 1, state.owner == owner, state.origin == origin, state.revision >= 0,
      state.revision <= ContactCrypto.maximumRevision else { throw FotoroError("Invalid local contacts state.") }
    try ContactCrypto.validate(state.base, owner: owner); try ContactCrypto.validate(state.draft, owner: owner)
    return state
  }
  private func save(_ state: ContactLedgerState, _ db: Database) throws {
    let wrapped = try CryptoAdapter().wrap(Wire.encode(state), key: Data(b64: bundle.vaultKey))
    try db.execute(sql: "INSERT INTO operations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", arguments: [key, try Wire.encode(wrapped)])
  }
  func state() throws -> ContactLedgerState { try store.database.read { db in guard let state = try read(db) else { throw FotoroError("Open contacts first.") }; return state } }
  func bootstrap(_ local: AccountContactsV1) throws {
    try ContactCrypto.validate(local, owner: owner)
    try store.database.write { db in
      guard try read(db) == nil else { return }
      try save(ContactLedgerState(owner: owner, origin: origin, base: AccountContactsV1(ownerAccountId: owner), draft: local.canonical), db)
    }
  }
  func edit(_ card: AccountCardV1, name: String?) throws {
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open contacts first.") }
      let prior = state.draft.entries.first { $0.accountId == card.accountId }
      let entry = AccountContactV1(accountId: card.accountId, card: card, name: name ?? prior?.name ?? "")
      state.draft.entries.removeAll { $0.accountId == card.accountId }; state.draft.entries.append(entry); state.draft = state.draft.canonical
      try ContactCrypto.validate(state.draft, owner: owner)
      state.editID = Wire.id()
      state.conflicts = state.conflicts.compactMap { conflict in
        guard conflict.accountId == card.accountId else { return conflict }
        let remaining = conflict.fields.filter { $0 != "card" && $0 != "deleted" && !(name != nil && $0 == "name") }
        return remaining.isEmpty ? nil : ContactConflict(accountId: card.accountId, fields: remaining)
      }
      try save(state, db)
    }
  }
  func receive(_ signed: SignedPayloadV1?) throws {
    let opened = try signed.map { try ContactCrypto.open($0, card: card, bundle: bundle) }
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open contacts first.") }
      guard let signed, let opened else {
        guard state.revision == 0 else { throw FotoroError("Contacts service returned an older version.") }; return
      }
      guard opened.revision >= state.revision else { throw FotoroError("Contacts service returned an older version.") }
      if opened.revision == state.revision {
        guard state.accepted == signed else { throw FotoroError("Contacts changed at the same revision.") }; return
      }
      if state.pending == signed {
        if state.editID == state.pendingEditID { state.draft = opened.book }
        state.conflicts = []
      } else {
        let merged = try ContactMerge.merge(base: state.base, local: state.draft, remote: opened.book, unresolved: state.conflicts)
        state.draft = merged.value; state.conflicts = merged.conflicts; state.editID = Wire.id()
      }
      state.base = opened.book; state.accepted = signed; state.revision = opened.revision
      state.pending = nil; state.pendingBytes = nil; state.pendingEditID = nil
      try save(state, db)
    }
  }
  func prepare() throws -> Data? {
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open contacts first.") }
      guard state.conflicts.isEmpty else { return nil }
      if let pending = state.pending {
        guard let bytes = state.pendingBytes, try Wire.decode(SignedPayloadV1.self, bytes) == pending else { throw FotoroError("Invalid pending contact update.") }
        return bytes
      }
      guard state.draft.canonical != state.base.canonical else { return nil }
      guard state.revision < ContactCrypto.maximumRevision else { throw FotoroError("Contacts revision limit reached.") }
      let pending = try ContactCrypto.seal(state.draft, revision: state.revision + 1, bundle: bundle)
      let bytes = try Wire.encode(pending)
      state.pending = pending; state.pendingBytes = bytes; state.pendingEditID = state.editID
      try save(state, db); return bytes
    }
  }
  func resolve(_ expected: ContactSyncConflict, keepLocal: Bool) throws {
    let account = expected.accountId
    try store.database.write { db in
      guard var state = try read(db), let conflict = state.conflicts.first(where: { $0.accountId == account }) else { throw FotoroError("Refresh contacts before choosing a version.") }
      guard expected.owner == owner, expected.origin == origin,
        conflict.fields == expected.fields,
        state.draft.entries.first(where: { $0.accountId == account }) == expected.local,
        state.base.entries.first(where: { $0.accountId == account }) == expected.synced else {
        throw FotoroError("This contact changed. Review the latest version before choosing.")
      }
      if !keepLocal {
        let choice = ContactMerge.choosingSynced(state.draft.entries.first { $0.accountId == account },
          remote: state.base.entries.first { $0.accountId == account }, fields: conflict.fields)
        state.draft.entries.removeAll { $0.accountId == account }
        if let choice { state.draft.entries.append(choice) }
      }
      state.draft = state.draft.canonical; try ContactCrypto.validate(state.draft, owner: owner)
      state.conflicts.removeAll { $0.accountId == account }; state.editID = Wire.id()
      state.pending = nil; state.pendingBytes = nil; state.pendingEditID = nil
      try save(state, db)
    }
  }
}

private struct ContactSyncContext: Equatable {
  let access: PhotoAccountAccess
  let origin: String
  let url: URL
  let card: AccountCardV1
  let token: String?
  let fixture: Bool
  let epoch: UUID
}
@MainActor final class ContactSync {
  private weak var services: AppServices?
  private var epoch = UUID()
  private var work: Task<Void, Error>?
  private var polling: Task<Void, Never>?
  private var requested = false
  init(services: AppServices) { self.services = services }
  private func context() throws -> ContactSyncContext {
    try Task.checkCancellation()
    guard let services, let access = services.photoAccountAccess,
      let origin = BackgroundUploadPolicy.origin(services.api.baseURL) else { throw CancellationError() }
    let card = try services.session.requireCard(access.account)
    return ContactSyncContext(access: access, origin: origin, url: services.api.baseURL, card: card,
      token: services.session.bearerToken, fixture: services.session.fixture, epoch: epoch)
  }
  private func fence(_ captured: ContactSyncContext) throws {
    try Task.checkCancellation(); guard try context() == captured else { throw CancellationError() }
  }
  private func ledger(_ captured: ContactSyncContext) throws -> ContactLedger {
    guard let services else { throw CancellationError() }
    try fence(captured)
    return ContactLedger(store: services.store, owner: captured.access.account, origin: captured.origin,
      bundle: try services.vault.requireBundle(), card: captured.card)
  }
  func activate() throws {
    let captured = try context(), ledger = try ledger(captured)
    guard let services else { throw CancellationError() }
    let entries = try services.session.pinnedCards.values.filter { $0.accountId != captured.access.account }.map {
      AccountContactV1(accountId: $0.accountId, card: $0, name: (try? services.storedContactName($0.accountId)) ?? "")
    }
    try ledger.bootstrap(AccountContactsV1(ownerAccountId: captured.access.account, entries: entries))
    try publish(ledger, captured: captured)
    if services.contactSyncForeground { foreground(true) }
  }
  private func publish(_ ledger: ContactLedger, captured: ContactSyncContext) throws {
    try fence(captured)
    guard let services else { throw CancellationError() }
    let state = try ledger.state()
    try services.applyContactProjection(state.draft, owner: captured.access.account)
    let conflicts = state.conflicts.map { conflict in
      ContactSyncConflict(owner: captured.access.account, origin: captured.origin, scopeID: epoch,
        accountId: conflict.accountId, fields: conflict.fields,
        local: state.draft.entries.first { $0.accountId == conflict.accountId }, synced: state.base.entries.first { $0.accountId == conflict.accountId })
    }
    if services.contactsSyncConflicts != conflicts { services.contactsSyncConflicts = conflicts }
    NativeDiagnosticTrace.current?.completed(.persist)
    services.recordContactSyncState(completed: state.base.entries.filter { $0.card != nil }.count,
      pending: Set(state.draft.entries.filter { entry in state.base.entries.first { $0.accountId == entry.accountId } != entry }.map(\.accountId) + state.conflicts.map(\.accountId)).count)
  }
  func edit(_ card: AccountCardV1, name: String?) throws {
    let captured = try context(), ledger = try ledger(captured)
    // A previously labelled invitation may not yet have a trusted pin. Preserve
    // that encrypted label on first explicit acceptance, but never revive a tombstone.
    let existing = try ledger.state().draft.entries.contains { $0.accountId == card.accountId }
    let chosenName = name ?? (existing ? nil : (try? services?.storedContactName(card.accountId)))
    try ledger.edit(card, name: chosenName); try publish(ledger, captured: captured); kick()
  }
  func resolve(_ expected: ContactSyncConflict, keepLocal: Bool) throws {
    guard expected.scopeID == epoch else { throw FotoroError("This contact changed. Review the latest version before choosing.") }
    let captured = try context(), ledger = try ledger(captured)
    try ledger.resolve(expected, keepLocal: keepLocal); try publish(ledger, captured: captured); kick()
  }
  private var automaticAllowed: Bool {
    guard let services else { return false }
    return services.session.isSignedIn && !services.session.fixture && services.photoAccountAccess != nil
      && NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: false)
  }
  func kick() {
    guard automaticAllowed else { return }
    Task { [weak self] in try? await self?.syncNow() }
  }
  func foreground(_ active: Bool) {
    polling?.cancel(); polling = nil
    guard active, automaticAllowed else { if !active { pause() }; return }
    // Restore the durable review projection even when the network is unavailable.
    if let captured = try? context(), let ledger = try? ledger(captured) { try? publish(ledger, captured: captured) }
    kick()
    polling = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
        guard let self else { return }; self.kick()
      }
    }
  }
  func pause() {
    epoch = UUID(); work?.cancel(); work = nil; polling?.cancel(); polling = nil; requested = false
    services?.contactsSyncBusy = false
  }
  func syncNow() async throws {
    guard automaticAllowed else { return }
    if let work { requested = true; try await work.value; return }
    let token = epoch
    requested = true
    let task = Task {
      guard let services else { throw CancellationError() }
      try await services.withDiagnosticAction(.share) {
        while requested {
          requested = false
          try await runOnce()
        }
      }
    }
    work = task; services?.contactsSyncBusy = true; services?.contactsSyncMessage = nil
    defer { if epoch == token { work = nil; services?.contactsSyncBusy = false } }
    do { try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
    catch {
      if epoch == token, !(error is CancellationError), !Task.isCancelled {
        services?.contactsSyncMessage = "Contacts could not sync. Try again."
      }
      throw error
    }
  }
  private func fetch(_ captured: ContactSyncContext) async throws -> SignedPayloadV1? {
    try fence(captured); guard let services else { throw CancellationError() }
    let bytes = try await services.api.request("/v1/contacts")
    try fence(captured); return try ContactCrypto.reply(bytes).contacts
  }
  private func runOnce() async throws {
    let captured = try context(), ledger = try ledger(captured)
    let remote = try await fetch(captured)
    try fence(captured); try ledger.receive(remote); NativeDiagnosticTrace.current?.completed(.verify); try publish(ledger, captured: captured)
    guard let bytes = try ledger.prepare() else { return }
    guard let services else { throw CancellationError() }
    let pending = try Wire.decode(SignedPayloadV1.self, bytes)
    do {
      try fence(captured)
      let reply = try await services.api.request("/v1/contacts", method: "PUT", body: bytes)
      try fence(captured)
      guard try ContactCrypto.reply(reply).contacts == pending else { throw FotoroError("Contact update reply did not match.") }
      try ledger.receive(pending); try publish(ledger, captured: captured)
    } catch let error as FotoroError where error.statusCode == 409 {
      let current = try await fetch(captured)
      try fence(captured); try ledger.receive(current); try publish(ledger, captured: captured)
      guard try ledger.state().pending != pending else { throw error }
    }
    let state = try ledger.state()
    if state.conflicts.isEmpty, state.draft.canonical != state.base.canonical { requested = true }
  }
}
