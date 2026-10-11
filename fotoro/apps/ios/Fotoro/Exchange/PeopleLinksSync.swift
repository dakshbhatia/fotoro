import Foundation
import GRDB

struct TripPersonAliasV1: Codable, Equatable, Sendable {
  var card: AccountCardV1
  var name: String
  var key: String { [card.accountId, card.signingPublicKey, card.boxPublicKey, name].map { Data($0.utf8).b64 }.joined(separator: ":") }
  var canonicalKey: String {
    let fields: [Any] = [[card.accountId, card.boxPublicKey, card.signingPublicKey, card.version] as [Any], name]
    return String(decoding: (try? JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes])) ?? Data(), as: UTF8.self)
  }
  static func == (lhs: Self, rhs: Self) -> Bool { lhs.card == rhs.card && Data(lhs.name.utf8) == Data(rhs.name.utf8) }
}
struct TripPersonLinkV1: Codable, Equatable, Sendable, Identifiable {
  var id: String
  var origin: String
  var albumId: String
  var ownerCard: AccountCardV1
  var name: String
  var aliases: [TripPersonAliasV1]
  var deleted: Bool
  var scope: String { [origin, albumId, ownerCard.accountId, ownerCard.signingPublicKey, ownerCard.boxPublicKey].map { Data($0.utf8).b64 }.joined(separator: ":") }
  var canonical: Self { var value = self; value.aliases.sort { $0.canonicalKey.utf16.lexicographicallyPrecedes($1.canonicalKey.utf16) }; return value }
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.id == rhs.id && lhs.origin == rhs.origin && lhs.albumId == rhs.albumId && lhs.ownerCard == rhs.ownerCard
      && Data(lhs.name.utf8) == Data(rhs.name.utf8) && lhs.aliases == rhs.aliases && lhs.deleted == rhs.deleted
  }
}
enum TripPersonLinkScope {
  static func active(_ links: [TripPersonLinkV1], origin: String, albumID: String,
    owner: AccountCardV1, contributors: [AccountCardV1]) -> [TripPersonLinkV1] {
    links.compactMap { link in
      guard !link.deleted, link.origin == origin, link.albumId == albumID, link.ownerCard == owner else { return nil }
      var projected = link
      projected.aliases = link.aliases.filter { contributors.contains($0.card) }
      return projected.aliases.isEmpty ? nil : projected
    }
  }
}
struct AccountPeopleLinksV1: Codable, Equatable, Sendable {
  var version = 1
  var ownerAccountId: String
  var links: [TripPersonLinkV1] = []
  var canonical: Self { var value = self; value.links = links.map(\.canonical).sorted { $0.id < $1.id }; return value }
}
struct AccountPeopleLinksUpdateV1: Codable, Sendable { var version = 1; var revision: Int; var encrypted: WrappedKeyV1 }
struct AccountPeopleLinksReplyV1: Codable, Sendable { var version: Int; var peopleLinks: SignedPayloadV1? }
struct PeopleLinksReview: Equatable {
  var owner: String
  var origin: String
  var epoch: UUID
  var local: AccountPeopleLinksV1
  var synced: AccountPeopleLinksV1
}
enum PeopleLinksMerge {
  static func merge(base: AccountPeopleLinksV1, local: AccountPeopleLinksV1, remote: AccountPeopleLinksV1, unresolved: Bool = false) throws -> (value: AccountPeopleLinksV1, conflict: Bool) {
    for book in [base, local, remote] { try PeopleLinksCrypto.validate(book, owner: local.ownerAccountId) }
    let base = base.canonical, local = local.canonical, remote = remote.canonical
    if local == remote { return (local, false) }
    if unresolved { return (local, true) }
    if local == base { return (remote, false) }
    if remote == base { return (local, false) }
    return (local, true)
  }
}
enum PeopleLinksCrypto {
  static let maximumRevision = 2_147_483_647
  static func uuid(_ value: String) -> Bool { value.range(of: "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", options: .regularExpression) != nil }
  static func keys(_ object: Any, _ allowed: Set<String>) throws {
    guard let fields = object as? [String: Any], Set(fields.keys) == allowed else { throw FotoroError("Unsupported contact fields.") }
  }
  static func validate(_ book: AccountPeopleLinksV1, owner: String) throws {
    guard book.version == 1, uuid(owner), book.ownerAccountId == owner, book.links.count <= 256 else { throw FotoroError("Invalid People links account.") }
    var ids = Set<String>(), sources = Set<String>()
    for link in book.links {
      guard uuid(link.id), uuid(link.albumId), ids.insert(link.id).inserted,
        let url = URL(string: link.origin), origin(url) == link.origin,
        ["https", "http"].contains(url.scheme ?? ""), validName(link.name), link.aliases.count <= 32,
        link.deleted || link.aliases.count >= 2 else { throw FotoroError("Invalid People link.") }
      _ = try FotoroShareLinks.validatePublicAccountCard(link.ownerCard)
      var aliases = Set<String>()
      for alias in link.aliases {
        _ = try FotoroShareLinks.validatePublicAccountCard(alias.card)
        guard validName(alias.name), link.deleted || aliases.insert(alias.key).inserted else { throw FotoroError("Invalid linked name.") }
        let source = link.scope + "|" + alias.key
        if !link.deleted, !sources.insert(source).inserted { throw FotoroError("A name already belongs to another People link.") }
      }
    }
  }
  // URL.origin wire semantics omit a scheme's default port.
  static func origin(_ url: URL) -> String? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: true), let scheme = c.scheme?.lowercased(),
      ["http", "https"].contains(scheme), let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil else { return nil }
    let port = c.port
    return scheme + "://" + host + (port == nil || port == (scheme == "https" ? 443 : 80) ? "" : ":" + String(port!))
  }
  static func validName(_ value: String) -> Bool {
    // Match JavaScript trim validation without normalizing the reviewed name.
    value.utf16.count <= 80 && value.unicodeScalars.contains { scalar in
      let n = scalar.value
      return !((9...13).contains(n) || [32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279].contains(n) || (8192...8202).contains(n))
    }
  }
  static func decodeBook(_ data: Data, owner: String) throws -> AccountPeopleLinksV1 {
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "ownerAccountId", "links"])
    guard let links = (raw as? [String: Any])?["links"] as? [[String: Any]] else { throw FotoroError("Invalid People links.") }
    for link in links {
      try keys(link, ["id", "origin", "albumId", "ownerCard", "name", "aliases", "deleted"])
      try keys(link["ownerCard"] ?? NSNull(), ["version", "accountId", "signingPublicKey", "boxPublicKey"])
      guard let aliases = link["aliases"] as? [[String: Any]] else { throw FotoroError("Invalid aliases.") }
      for alias in aliases {
        try keys(alias, ["card", "name"])
        try keys(alias["card"] ?? NSNull(), ["version", "accountId", "signingPublicKey", "boxPublicKey"])
      }
    }
    let book = try Wire.decode(AccountPeopleLinksV1.self, data)
    try validate(book, owner: owner); return book.canonical
  }
  static func seal(_ book: AccountPeopleLinksV1, revision: Int, bundle: AccountBundle) throws -> SignedPayloadV1 {
    try validate(book, owner: book.ownerAccountId)
    guard (1...maximumRevision).contains(revision) else { throw FotoroError("Invalid people links revision.") }
    let encrypted = try CryptoAdapter().wrap(Wire.encode(book.canonical), key: Data(b64: bundle.vaultKey))
    guard encrypted.ciphertext.count <= 262_144 else { throw FotoroError("People links are too large.") }
    return try CryptoAdapter().sign(AccountPeopleLinksUpdateV1(revision: revision, encrypted: encrypted), kind: "account-people-links",
      accountId: book.ownerAccountId, secret: Data(b64: bundle.signingSecretKey))
  }
  static func open(_ signed: SignedPayloadV1, card: AccountCardV1, bundle: AccountBundle) throws -> (revision: Int, book: AccountPeopleLinksV1) {
    let data = try CryptoAdapter().verify(signed, card: card, kind: "account-people-links")
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "revision", "encrypted"])
    try keys((raw as? [String: Any])?["encrypted"] ?? NSNull(), ["version", "nonce", "ciphertext"])
    let update = try Wire.decode(AccountPeopleLinksUpdateV1.self, data)
    guard update.version == 1, (1...maximumRevision).contains(update.revision), update.encrypted.ciphertext.count <= 262_144 else { throw FotoroError("Invalid people links revision.") }
    return (update.revision, try decodeBook(CryptoAdapter().unwrap(update.encrypted, key: Data(b64: bundle.vaultKey)), owner: card.accountId))
  }
  static func reply(_ data: Data) throws -> AccountPeopleLinksReplyV1 {
    let raw = try JSONSerialization.jsonObject(with: data)
    try keys(raw, ["version", "peopleLinks"])
    if let signed = (raw as? [String: Any])?["peopleLinks"], !(signed is NSNull) {
      try keys(signed, ["version", "kind", "accountId", "body", "signature"])
    }
    let value = try Wire.decode(AccountPeopleLinksReplyV1.self, data)
    guard value.version == 1 else { throw FotoroError("Unsupported people links version.") }; return value
  }
}

struct PeopleLinksLedgerState: Codable {
  var version = 1
  var owner: String
  var origin: String
  var revision = 0
  var accepted: SignedPayloadV1?
  var base: AccountPeopleLinksV1
  var draft: AccountPeopleLinksV1
  var editID = Wire.id()
  var pending: SignedPayloadV1?
  var pendingBytes: Data?
  var pendingEditID: String?
  var conflict = false
}
final class PeopleLinksLedger {
  let store: LibraryStore
  let owner: String
  let origin: String
  let bundle: AccountBundle
  let card: AccountCardV1
  var key: String { "people-links-sync:" + Data(origin.utf8).digest }
  init(store: LibraryStore, owner: String, origin: String, bundle: AccountBundle, card: AccountCardV1) {
    self.store = store; self.owner = owner; self.origin = origin; self.bundle = bundle; self.card = card
  }
  private func read(_ db: Database) throws -> PeopleLinksLedgerState? {
    guard let bytes = try Data.fetchOne(db, sql: "SELECT value FROM operations WHERE id=?", arguments: [key]) else { return nil }
    let wrapped = try Wire.decode(WrappedKeyV1.self, bytes)
    let state = try Wire.decode(PeopleLinksLedgerState.self, CryptoAdapter().unwrap(wrapped, key: Data(b64: bundle.vaultKey)))
    guard state.version == 1, state.owner == owner, state.origin == origin, (0...PeopleLinksCrypto.maximumRevision).contains(state.revision) else { throw FotoroError("Invalid People links state.") }
    try PeopleLinksCrypto.validate(state.base, owner: owner); try PeopleLinksCrypto.validate(state.draft, owner: owner)
    return state
  }
  private func save(_ state: PeopleLinksLedgerState, _ db: Database) throws {
    let wrapped = try CryptoAdapter().wrap(Wire.encode(state), key: Data(b64: bundle.vaultKey))
    try db.execute(sql: "INSERT INTO operations(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", arguments: [key, try Wire.encode(wrapped)])
  }
  func state() throws -> PeopleLinksLedgerState { try store.database.read { db in guard let value = try read(db) else { throw FotoroError("Open People links first.") }; return value } }
  func bootstrap() throws {
    try store.database.write { db in
      guard try read(db) == nil else { return }
      let empty = AccountPeopleLinksV1(ownerAccountId: owner)
      try save(PeopleLinksLedgerState(owner: owner, origin: origin, base: empty, draft: empty), db)
    }
  }
  func edit(_ link: TripPersonLinkV1) throws {
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open People links first.") }
      state.draft.links.removeAll { $0.id == link.id }; state.draft.links.append(link); state.draft = state.draft.canonical
      try PeopleLinksCrypto.validate(state.draft, owner: owner)
      state.editID = Wire.id()
      // A local edit is not permission to overwrite an unresolved synced book.
      try save(state, db)
    }
  }
  func remove(_ expected: TripPersonLinkV1) throws {
    try store.database.write { db in
      guard var state = try read(db), let index = state.draft.links.firstIndex(where: { $0.id == expected.id }),
        state.draft.links[index] == expected, !expected.deleted else { throw FotoroError("This People link changed. Review again.") }
      state.draft.links[index].deleted = true; state.editID = Wire.id()
      try save(state, db)
    }
  }
  func receive(_ signed: SignedPayloadV1?) throws {
    let opened = try signed.map { try PeopleLinksCrypto.open($0, card: card, bundle: bundle) }
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open People links first.") }
      guard let signed, let opened else { guard state.revision == 0 else { throw FotoroError("People links rolled back.") }; return }
      guard opened.revision >= state.revision else { throw FotoroError("People links rolled back.") }
      if opened.revision == state.revision { guard state.accepted == signed else { throw FotoroError("People links changed at the same revision.") }; return }
      if state.pending == signed {
        if state.editID == state.pendingEditID { state.draft = opened.book }
        state.conflict = false
      } else {
        let merged = try PeopleLinksMerge.merge(base: state.base, local: state.draft, remote: opened.book, unresolved: state.conflict)
        state.draft = merged.value; state.conflict = merged.conflict; state.editID = Wire.id()
      }
      state.base = opened.book; state.accepted = signed; state.revision = opened.revision
      state.pending = nil; state.pendingBytes = nil; state.pendingEditID = nil
      try save(state, db)
    }
  }
  func prepare() throws -> Data? {
    try store.database.write { db in
      guard var state = try read(db) else { throw FotoroError("Open People links first.") }
      guard !state.conflict else { return nil }
      if let pending = state.pending {
        guard let bytes = state.pendingBytes, try Wire.decode(SignedPayloadV1.self, bytes) == pending else { throw FotoroError("Invalid People links retry.") }
        return bytes
      }
      guard state.draft.canonical != state.base.canonical else { return nil }
      guard state.revision < PeopleLinksCrypto.maximumRevision else { throw FotoroError("People links revision limit.") }
      let pending = try PeopleLinksCrypto.seal(state.draft, revision: state.revision + 1, bundle: bundle)
      let bytes = try Wire.encode(pending)
      state.pending = pending; state.pendingBytes = bytes; state.pendingEditID = state.editID
      try save(state, db); return bytes
    }
  }
  func resolve(_ expected: PeopleLinksReview, keepLocal: Bool) throws {
    try store.database.write { db in
      guard var state = try read(db), state.conflict, expected.owner == owner, expected.origin == origin,
        state.draft == expected.local, state.base == expected.synced else { throw FotoroError("People links changed. Review again.") }
      if !keepLocal { state.draft = state.base }
      state.conflict = false; state.editID = Wire.id(); state.pending = nil; state.pendingBytes = nil; state.pendingEditID = nil
      try save(state, db)
    }
  }
}
private struct PeopleLinksSyncContext: Equatable {
  let access: PhotoAccountAccess
  let origin: String
  let url: URL
  let card: AccountCardV1
  let token: String?
  let fixture: Bool
  let epoch: UUID
}
@MainActor final class PeopleLinksSync {
  private weak var services: AppServices?
  private var epoch = UUID()
  private var work: Task<Void, Error>?
  private var polling: Task<Void, Never>?
  private var requested = false
  init(services: AppServices) { self.services = services }
  private func context() throws -> PeopleLinksSyncContext {
    try Task.checkCancellation()
    guard let services, let access = services.photoAccountAccess,
      let origin = BackgroundUploadPolicy.origin(services.api.baseURL) else { throw CancellationError() }
    let card = try services.session.requireCard(access.account)
    return PeopleLinksSyncContext(access: access, origin: origin, url: services.api.baseURL, card: card,
      token: services.session.bearerToken, fixture: services.session.fixture, epoch: epoch)
  }
  private func fence(_ captured: PeopleLinksSyncContext) throws {
    try Task.checkCancellation(); guard try context() == captured else { throw CancellationError() }
  }
  private func ledger(_ captured: PeopleLinksSyncContext) throws -> PeopleLinksLedger {
    guard let services else { throw CancellationError() }
    try fence(captured)
    return PeopleLinksLedger(store: services.store, owner: captured.access.account, origin: captured.origin,
      bundle: try services.vault.requireBundle(), card: captured.card)
  }
  func activate() throws {
    let captured = try context(), ledger = try ledger(captured)
    guard let services else { throw CancellationError() }
    try ledger.bootstrap()
    try publish(ledger, captured: captured)
    if services.contactSyncForeground { foreground(true) }
  }
  private func publish(_ ledger: PeopleLinksLedger, captured: PeopleLinksSyncContext) throws {
    try fence(captured)
    guard let services else { throw CancellationError() }
    let state = try ledger.state()
    services.peopleLinks = state.conflict ? [] : state.draft.links
    services.peopleLinksReview = state.conflict ? PeopleLinksReview(owner: captured.access.account, origin: captured.origin, epoch: epoch, local: state.draft, synced: state.base) : nil
    services.peopleLinksPending = state.pending != nil || state.draft.canonical != state.base.canonical || state.conflict
    NativeDiagnosticTrace.current?.completed(.persist)
    services.recordContactSyncState(completed: state.base.links.filter { !$0.deleted }.count,
      pending: services.peopleLinksPending ? 1 : 0)
  }
  func edit(_ link: TripPersonLinkV1) throws {
    let captured = try context(), ledger = try ledger(captured)
    try ledger.edit(link); try publish(ledger, captured: captured); kick()
  }
  func remove(_ expected: TripPersonLinkV1) throws {
    let captured = try context(), ledger = try ledger(captured)
    try ledger.remove(expected); try publish(ledger, captured: captured); kick()
  }
  func resolve(_ expected: PeopleLinksReview, keepLocal: Bool) throws {
    guard expected.epoch == epoch else { throw FotoroError("People links changed. Review again.") }
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
    services?.peopleLinksSyncBusy = false
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
    work = task; services?.peopleLinksSyncBusy = true; services?.peopleLinksSyncMessage = nil
    defer { if epoch == token { work = nil; services?.peopleLinksSyncBusy = false } }
    do { try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
    catch {
      if epoch == token, !(error is CancellationError), !Task.isCancelled {
        services?.peopleLinksSyncMessage = "People links could not sync. Try again."
      }
      throw error
    }
  }
  private func fetch(_ captured: PeopleLinksSyncContext) async throws -> SignedPayloadV1? {
    try fence(captured); guard let services else { throw CancellationError() }
    let bytes = try await services.api.request("/v1/people-links")
    try fence(captured); return try PeopleLinksCrypto.reply(bytes).peopleLinks
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
      let reply = try await services.api.request("/v1/people-links", method: "PUT", body: bytes)
      try fence(captured)
      guard try PeopleLinksCrypto.reply(reply).peopleLinks == pending else { throw FotoroError("People links update reply did not match.") }
      try ledger.receive(pending); try publish(ledger, captured: captured)
    } catch let error as FotoroError where error.statusCode == 409 {
      let current = try await fetch(captured)
      try fence(captured); try ledger.receive(current); try publish(ledger, captured: captured)
      guard try ledger.state().pending != pending else { throw error }
    }
    let state = try ledger.state()
    if !state.conflict, state.draft.canonical != state.base.canonical { requested = true }
  }
}
