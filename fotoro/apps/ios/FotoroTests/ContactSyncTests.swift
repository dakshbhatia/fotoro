import GRDB
import XCTest
@testable import Fotoro

private struct ContactVectors: Decodable {
  struct MergeCase: Decodable {
    var name: String
    var base: AccountContactsV1
    var local: AccountContactsV1
    var remote: AccountContactsV1
    var unresolved: [ContactConflict]
    var expected: AccountContactsV1
    var conflicts: [ContactConflict]
  }
  struct Crypto: Decodable { var book: AccountContactsV1; var update: AccountContactsUpdateV1; var signed: SignedPayloadV1 }
  var ownerAccountId: String
  var mergeCases: [MergeCase]
  var crypto: Crypto
}

final class ContactSyncTests: XCTestCase {
  func testSharedMergeVectorsPreserveIndependentFieldsAndStickyReviews() throws {
    let vectors = try fixture(ContactVectors.self, "contact-sync-v1")
    XCTAssertEqual(vectors.mergeCases.count, 22)
    for vector in vectors.mergeCases {
      let result = try ContactMerge.merge(base: vector.base, local: vector.local, remote: vector.remote, unresolved: vector.unresolved)
      XCTAssertEqual(result.value, vector.expected, vector.name)
      XCTAssertEqual(result.conflicts, vector.conflicts, vector.name)
    }
  }
  func testSharedSignedEncryptedBookRoundTripsUnicodeAndExplicitTombstone() throws {
    let vectors = try fixture(ContactVectors.self, "contact-sync-v1"), accounts = try fixture(FixtureAccounts.self, "accounts")
    let bundle = bundle(accounts)
    let opened = try ContactCrypto.open(vectors.crypto.signed, card: accounts.accounts[0], bundle: bundle)
    XCTAssertEqual(opened.revision, vectors.crypto.update.revision)
    XCTAssertEqual(opened.book, vectors.crypto.book.canonical)
    let encoded = try Wire.encode(opened.book)
    XCTAssertTrue(String(decoding: encoded, as: UTF8.self).contains("\"card\":null"))
    XCTAssertEqual(try ContactCrypto.decodeBook(encoded, owner: vectors.ownerAccountId), opened.book)
    var wrong = accounts.accounts[0]; wrong.accountId = Wire.id()
    XCTAssertThrowsError(try ContactCrypto.open(vectors.crypto.signed, card: wrong, bundle: bundle))
    var changed = vectors.crypto.signed; changed.kind = "photo-annotations"
    XCTAssertThrowsError(try ContactCrypto.open(changed, card: accounts.accounts[0], bundle: bundle))
    var invalid = vectors.crypto.book
    invalid.entries[0].name = String(repeating: "😀", count: 41)
    XCTAssertThrowsError(try ContactCrypto.validate(invalid, owner: vectors.ownerAccountId))
    var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    raw["unexpected"] = 1
    XCTAssertThrowsError(try ContactCrypto.decodeBook(JSONSerialization.data(withJSONObject: raw), owner: vectors.ownerAccountId))
  }
  func testEncryptedPendingRetrySurvivesReopenAndAcknowledgementKeepsLaterEdits() throws {
    let (ledger, accounts) = try ledger()
    defer { try? FileManager.default.removeItem(at: ledger.store.root) }
    let peer = accounts.accounts[1]
    try ledger.edit(peer, name: "First name")
    let pending = try XCTUnwrap(ledger.prepare())
    let reopened = ContactLedger(store: ledger.store, owner: ledger.owner, origin: ledger.origin, bundle: ledger.bundle, card: ledger.card)
    XCTAssertEqual(try reopened.prepare(), pending, "Retry must retain the same nonce, signature and bytes")
    let stored = try XCTUnwrap(ledger.store.database.read { try Data.fetchOne($0, sql: "SELECT value FROM operations WHERE id=?", arguments: [ledger.key]) })
    XCTAssertFalse(String(decoding: stored, as: UTF8.self).contains("First name"))
    XCTAssertFalse(String(decoding: stored, as: UTF8.self).contains(peer.signingPublicKey))
    try reopened.edit(peer, name: "Edited during upload")
    try reopened.receive(Wire.decode(SignedPayloadV1.self, pending))
    XCTAssertEqual(try reopened.state().draft.entries.first?.name, "Edited during upload")
    XCTAssertEqual(try reopened.state().base.entries.first?.name, "First name")
    let next = try XCTUnwrap(reopened.prepare())
    XCTAssertEqual(try ContactCrypto.open(Wire.decode(SignedPayloadV1.self, next), card: ledger.card, bundle: ledger.bundle).revision, 2)
  }
  func testKeyReviewSurvivesRefreshAndRejectsAChangedReviewSnapshot() throws {
    let (ledger, accounts) = try ledger()
    defer { try? FileManager.default.removeItem(at: ledger.store.root) }
    let peer = accounts.accounts[1]
    try ledger.edit(peer, name: "Mum")
    try ledger.receive(Wire.decode(SignedPayloadV1.self, XCTUnwrap(ledger.prepare())))
    var changed = peer; changed.boxPublicKey = Data(repeating: 8, count: 32).b64
    let remote = AccountContactsV1(ownerAccountId: ledger.owner, entries: [.init(accountId: peer.accountId, card: changed, name: "Mum")])
    try ledger.receive(ContactCrypto.seal(remote, revision: 2, bundle: ledger.bundle))
    let review = ContactSyncConflict(owner: ledger.owner, origin: ledger.origin, accountId: peer.accountId, fields: ["card"], local: try ledger.state().draft.entries.first, synced: remote.entries.first)
    XCTAssertNil(try ledger.prepare(), "Unreviewed changed keys must never upload or replace trusted keys")
    var renamed = remote; renamed.entries[0].name = "Mom"
    try ledger.receive(ContactCrypto.seal(renamed, revision: 3, bundle: ledger.bundle))
    XCTAssertEqual(try ledger.state().draft.entries.first?.name, "Mom")
    XCTAssertEqual(try ledger.state().draft.entries.first?.card, peer)
    XCTAssertEqual(try ledger.state().conflicts.first?.fields, ["card"])
    XCTAssertThrowsError(try ledger.resolve(review, keepLocal: false), "An earlier review cannot approve a later changed entry")
    let fresh = ContactSyncConflict(owner: ledger.owner, origin: ledger.origin, accountId: peer.accountId, fields: ["card"], local: try ledger.state().draft.entries.first, synced: renamed.entries.first)
    try ledger.resolve(fresh, keepLocal: true)
    XCTAssertEqual(try ledger.state().draft.entries.first?.name, "Mom")
    XCTAssertEqual(try ledger.state().draft.entries.first?.card, peer)
    XCTAssertNotNil(try ledger.prepare())
  }
  func testRemoteDeletionConcurrentWithLocalRenameRequiresExplicitChoice() throws {
    let (ledger, accounts) = try ledger()
    defer { try? FileManager.default.removeItem(at: ledger.store.root) }
    let peer = accounts.accounts[1]
    try ledger.edit(peer, name: "Dad")
    try ledger.receive(Wire.decode(SignedPayloadV1.self, XCTUnwrap(ledger.prepare())))
    try ledger.edit(peer, name: "Father")
    let tombstone = AccountContactV1(accountId: peer.accountId, card: nil, name: "")
    let remote = AccountContactsV1(ownerAccountId: ledger.owner, entries: [tombstone])
    let signed = try ContactCrypto.seal(remote, revision: 2, bundle: ledger.bundle)
    try ledger.receive(signed); try ledger.receive(signed)
    XCTAssertEqual(try ledger.state().conflicts.first?.fields, ["deleted"])
    XCTAssertNil(try ledger.prepare())
    let review = ContactSyncConflict(owner: ledger.owner, origin: ledger.origin, accountId: peer.accountId, fields: ["deleted"], local: try ledger.state().draft.entries.first, synced: tombstone)
    try ledger.resolve(review, keepLocal: false)
    XCTAssertEqual(try ledger.state().draft, remote)
    XCTAssertNil(try ledger.prepare())
  }
  @MainActor func testLostUploadReplyReconcilesExactlyAndPhotosPauseDoesNotPauseContacts() async throws {
    let context = try ContactNetworkContext(), services = try await context.open()
    defer { context.close() }
    try services.acceptContact(context.peer, name: "Family")
    services.session.fixture = false
    context.server.loseNextReply = true
    do { try await services.syncContacts(); XCTFail("The first upload response must be lost") } catch {}
    let uploaded = try XCTUnwrap(context.server.current)
    XCTAssertEqual(context.server.putBodies.count, 1)
    XCTAssertNotNil(services.contactsSyncMessage)
    try await services.syncContacts()
    XCTAssertEqual(context.server.current, uploaded)
    XCTAssertEqual(context.server.putBodies.count, 1, "GET reconciles the acknowledged exact update without another upload")
    XCTAssertNil(services.contactsSyncMessage)
    XCTAssertFalse(try services.store.automaticPhotoSyncPreference().enabled)
    XCTAssertEqual(services.contactName(context.peer.accountId), "Family")
  }
  @MainActor func testDelayedDownloadCannotApplyAcrossAccountVaultCatalogOrOriginChanges() async throws {
    for change in ["account", "vault", "catalog", "origin", "token", "cancel", "background"] {
      let context = try ContactNetworkContext(), services = try await context.open()
      defer { context.close() }
      context.server.current = try ContactCrypto.seal(AccountContactsV1(ownerAccountId: context.owner.accountId,
        entries: [.init(accountId: context.peer.accountId, card: context.peer, name: "Remote name")]), revision: 1, bundle: context.bundle)
      let gate = ContactResponseGate(started: expectation(description: change))
      context.server.gate = gate
      services.session.fixture = false
      let operation = Task { try await services.syncContacts() }
      await fulfillment(of: [gate.started], timeout: 3)
      switch change {
      case "account": services.session.accountId = Wire.id()
      case "vault": services.vault.lock()
      case "catalog": services.store = try LibraryStore(root: context.root.appendingPathComponent("replacement"))
      case "origin": services.api.baseURL = URL(string: "https://another-contact-test.invalid")!
      case "token": services.session.bearerToken = "changed test token"
      case "background": services.setPhotoSyncForeground(false)
      default: operation.cancel()
      }
      gate.release.signal()
      do { try await operation.value; XCTFail("Late contact download must be fenced: \(change)") } catch {}
      XCTAssertNil(services.session.pinnedCards[context.peer.accountId], change)
      XCTAssertEqual(services.contactName(context.peer.accountId), "Contact " + context.peer.accountId.suffix(8), change)
      XCTAssertTrue(context.server.putBodies.isEmpty, change)
      XCTAssertFalse(services.contactsSyncBusy, "Cancelled work must not leave review permanently disabled")
    }
  }
  @MainActor func testOwnerApprovedRemoteContactRestoresButChangedKeysRequireCurrentReview() async throws {
    let context = try ContactNetworkContext(), services = try await context.open()
    defer { context.close() }
    var remote = AccountContactsV1(ownerAccountId: context.owner.accountId,
      entries: [.init(accountId: context.peer.accountId, card: context.peer, name: "Remote family")])
    context.server.current = try ContactCrypto.seal(remote, revision: 1, bundle: context.bundle)
    services.session.fixture = false
    try await services.syncContacts()
    XCTAssertEqual(try services.session.requireCard(context.peer.accountId), context.peer)
    XCTAssertEqual(services.contactName(context.peer.accountId), "Remote family")
    var second = context.peer; second.boxPublicKey = Data(repeating: 2, count: 32).b64
    remote.entries[0].card = second
    context.server.current = try ContactCrypto.seal(remote, revision: 2, bundle: context.bundle)
    try await services.syncContacts()
    let review = try XCTUnwrap(services.contactsSyncConflicts.first)
    XCTAssertEqual(try services.session.requireCard(context.peer.accountId), context.peer)
    var third = second; third.boxPublicKey = Data(repeating: 3, count: 32).b64
    remote.entries[0].card = third
    context.server.current = try ContactCrypto.seal(remote, revision: 3, bundle: context.bundle)
    try await services.syncContacts()
    XCTAssertThrowsError(try services.resolveContactSyncConflict(review, keepLocal: false))
    XCTAssertEqual(try services.session.requireCard(context.peer.accountId), context.peer)
    let staleScopeReview = try XCTUnwrap(services.contactsSyncConflicts.first)
    services.vault.lock()
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: context.secret.recoverySecret), wrapper: context.secret.encryptedBundle))
    try services.activateAccount()
    XCTAssertThrowsError(try services.resolveContactSyncConflict(staleScopeReview, keepLocal: false), "A review from a previous unlock is no longer active")
    let currentReview = try XCTUnwrap(services.contactsSyncConflicts.first)
    try services.resolveContactSyncConflict(currentReview, keepLocal: false)
    XCTAssertEqual(try services.session.requireCard(context.peer.accountId), third)
    XCTAssertTrue(services.contactsSyncConflicts.isEmpty)
    try await services.syncContacts()
    XCTAssertTrue(context.server.putBodies.isEmpty)
  }
  @MainActor func testSyncDiagnosticsKeepOneParentTraceAndExcludeContactContent() async throws {
    let context = try ContactNetworkContext(), services = try await context.open()
    defer { context.close() }
    try services.acceptContact(context.peer, name: "Private family name")
    services.session.fixture = false
    try await services.syncContacts()
    let json = services.diagnosticsJSON()
    XCTAssertFalse(json.contains("Private family name"))
    XCTAssertFalse(json.contains(context.peer.signingPublicKey))
    XCTAssertFalse(json.contains(context.owner.accountId))
    let events = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]])
    let starts = events.filter { $0["phase"] as? String == "share" && $0["step"] as? String == "action" && $0["outcome"] as? String == "started" }
    let start = try XCTUnwrap(starts.last), trace = try XCTUnwrap(start["traceId"] as? String)
    let children = events.filter { $0["traceId"] as? String == trace }
    XCTAssertTrue(children.contains { $0["method"] as? String == "GET" && $0["endpoint"] as? String == "exchange" })
    XCTAssertTrue(children.contains { $0["method"] as? String == "PUT" && $0["endpoint"] as? String == "exchange" })
    XCTAssertTrue(children.contains { $0["phase"] as? String == "share" && $0["step"] as? String == "action" && $0["outcome"] as? String == "completed" })
    XCTAssertTrue(children.contains { $0["completed"] as? Int == 1 && $0["pending"] as? Int == 0 })
  }
  @MainActor func testCASConflictMergesAnotherDeviceContactAndRetriesNewRevision() async throws {
    let context = try ContactNetworkContext(), services = try await context.open()
    defer { context.close() }
    try services.acceptContact(context.peer, name: "Local family")
    var another = context.peer; another.accountId = Wire.id()
    let remote = AccountContactsV1(ownerAccountId: context.owner.accountId,
      entries: [.init(accountId: another.accountId, card: another, name: "Another device family")])
    context.server.competingUpdate = try ContactCrypto.seal(remote, revision: 1, bundle: context.bundle)
    services.session.fixture = false
    try await services.syncContacts()
    XCTAssertEqual(context.server.putBodies.count, 2)
    let final = try ContactCrypto.open(XCTUnwrap(context.server.current), card: context.owner, bundle: context.bundle)
    XCTAssertEqual(final.revision, 2)
    XCTAssertEqual(Set(final.book.entries.map(\.accountId)), [context.peer.accountId, another.accountId])
    XCTAssertEqual(services.contactName(context.peer.accountId), "Local family")
    XCTAssertEqual(services.contactName(another.accountId), "Another device family")
    XCTAssertTrue(services.contactsSyncConflicts.isEmpty)
  }
  @MainActor func testFixtureNeverUploadsAndLegacyUnpinnedNameSurvivesExplicitAcceptance() async throws {
    let context = try ContactNetworkContext(), services = try await context.open()
    defer { context.close() }
    let wrapped = try CryptoAdapter().wrap(Wire.encode(["accountId": context.peer.accountId, "name": "Existing label"]), key: Data(b64: context.bundle.vaultKey))
    try await services.store.database.write { db in
      try db.execute(sql: "INSERT INTO state(key,value) VALUES(?,?)", arguments: ["contact-name:" + context.peer.accountId, try Wire.encode(wrapped).b64])
    }
    try services.acceptContact(context.peer, name: nil)
    XCTAssertEqual(services.contactName(context.peer.accountId), "Existing label")
    try await services.syncContacts()
    XCTAssertTrue(context.server.putBodies.isEmpty)
    XCTAssertEqual(context.server.getCount, 0)
  }
  private func bundle(_ accounts: FixtureAccounts) -> AccountBundle {
    let secret = accounts.testSecrets[0]
    return AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
  }
  private func ledger() throws -> (ContactLedger, FixtureAccounts) {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let ledger = ContactLedger(store: store, owner: accounts.accounts[0].accountId, origin: "https://contact-test.invalid", bundle: bundle(accounts), card: accounts.accounts[0])
    try ledger.bootstrap(AccountContactsV1(ownerAccountId: ledger.owner))
    return (ledger, accounts)
  }
}

private final class ContactResponseGate: @unchecked Sendable {
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  init(started: XCTestExpectation) { self.started = started }
}
private final class ContactTestServer: @unchecked Sendable {
  var current: SignedPayloadV1?
  var putBodies: [Data] = []
  var getCount = 0
  var loseNextReply = false
  var competingUpdate: SignedPayloadV1?
  var gate: ContactResponseGate?
  func respond(_ request: URLRequest) throws -> Data {
    guard request.url?.path == "/v1/contacts" else { throw FotoroError("Unexpected controlled contact route") }
    if request.httpMethod == "PUT" {
      let body: Data
      if let bytes = request.httpBody { body = bytes }
      else {
        guard let stream = request.httpBodyStream else { throw FotoroError("Missing controlled contact body") }
        stream.open(); defer { stream.close() }; var bytes = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          guard count >= 0 else { throw URLError(.cannotDecodeRawData) }
          if count == 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
        }
        body = bytes
      }
      putBodies.append(body)
      if let competingUpdate {
        current = competingUpdate; self.competingUpdate = nil
        throw FotoroError("CONTACTS_REVISION_CONFLICT", statusCode: 409)
      }
      current = try Wire.decode(SignedPayloadV1.self, body)
      if loseNextReply { loseNextReply = false; throw URLError(.networkConnectionLost) }
    } else {
      getCount += 1
      if let gate { self.gate = nil; gate.started.fulfill(); _ = gate.release.wait(timeout: .now() + 10) }
    }
    return try JSONSerialization.data(withJSONObject: ["version": 1, "contacts": try current.map { try JSONSerialization.jsonObject(with: Wire.encode($0)) } ?? NSNull()])
  }
}
private final class ContactTestProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var server: ContactTestServer?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    DispatchQueue.global().async { [self] in
      do {
        let server = try XCTUnwrap(Self.server), data = try server.respond(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
      } catch let error as FotoroError where error.statusCode == 409 {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 409, httpVersion: nil, headerFields: nil) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{\"code\":\"CONTACTS_REVISION_CONFLICT\"}".utf8))
        client?.urlProtocolDidFinishLoading(self)
      } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
  }
  override func stopLoading() {}
}
@MainActor private final class ContactNetworkContext {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
  let owner: AccountCardV1
  let peer: AccountCardV1
  let secret: FixtureSecrets
  let bundle: AccountBundle
  let server = ContactTestServer()
  var services: AppServices?
  init() throws {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    var owner = accounts.accounts[0]; owner.accountId = Wire.id(); self.owner = owner
    var peer = accounts.accounts[1]; peer.accountId = Wire.id(); self.peer = peer
    secret = accounts.testSecrets[0]
    bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    ContactTestProtocol.server = server
  }
  func open() async throws -> AppServices {
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [ContactTestProtocol.self]
    let services = try AppServices(root: root, networkConfiguration: configuration, diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    self.services = services
    services.api.baseURL = URL(string: "https://contact-test.invalid")!
    services.session.accountId = owner.accountId; services.session.fixture = true; services.session.bearerToken = "controlled test token"
    try services.session.pin(owner)
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
    return services
  }
  func close() {
    services?.vault.lock(); server.gate?.release.signal(); ContactTestProtocol.server = nil
    Keychain.remove(owner.accountId)
    UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards.v2." + owner.accountId)
    try? FileManager.default.removeItem(at: root)
  }
}
