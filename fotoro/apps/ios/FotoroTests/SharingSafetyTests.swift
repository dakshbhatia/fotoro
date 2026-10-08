import GRDB
import XCTest

@testable import Fotoro

final class SharingSafetyTests: XCTestCase {
  @MainActor func testReviewedContactDoesNotBecomeTrustedForAnotherOwner() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 0)
    defer { context.restore() }
    var contact = context.cards[1]; contact.accountId = Wire.id()
    try services.acceptContact(contact, name: "Public test contact")
    XCTAssertEqual(try services.session.requireCard(contact.accountId), contact)
    XCTAssertEqual(services.contactName(contact.accountId), "Public test contact")
    try await context.changeAccount(to: 1)
    XCTAssertNil(services.session.pinnedCards[contact.accountId])
    XCTAssertThrowsError(try services.session.requireCard(contact.accountId))
    try await context.changeAccount(to: 0)
    XCTAssertEqual(try services.session.requireCard(contact.accountId), contact)
    XCTAssertEqual(services.contactName(contact.accountId), "Public test contact")
  }
  @MainActor func testInvitationPasswordRetryKeepsTheOriginalAccountWorkAndReopensOnlyAfterExplicitAuthorization() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 0)
    let originalCatalog = services.store, originalLedger = services.annotations.ledger
    let originalAccount = context.cards[0].accountId
    defer {
      UserDefaults.standard.removeObject(forKey: "fotoro.manualLock." + originalAccount)
      context.restore()
    }
    var original = context.server.source
    original.transferState = "committed"
    try originalCatalog.put(original)
    try services.reload()
    try services.setLabels(["Unsent family edit"], photo: original)
    let pending = try context.pendingSave()
    _ = try originalCatalog.operation("kept-save") { pending }
    let invitation = FotoroMomentInvitation(grantId: context.server.grant.grantId, senderCard: context.cards[0])
    let link = FotoroShareLink.moment(invitation), origin = services.api.origin
    var retry = IncomingInvitationPasswordRetry(link: link, origin: origin)
    XCTAssertNil(retry.consume(active: true, access: services.photoAccountAccess, origin: origin), "Opening another password must be explicit")
    services.lockAccount()
    XCTAssertTrue(Keychain.contains(originalAccount), "Switching passwords is a memory lock, not sign-out")
    XCTAssertEqual(try originalLedger.pendingIDs(), [original.id])
    XCTAssertNotNil(try originalCatalog.existingOperation("kept-save", as: PendingSave.self))
    XCTAssertTrue(retry.awaitingPassword)
    XCTAssertTrue(context.server.requests.isEmpty)
    try await context.changeAccount(to: 1)
    let invitedAccess = try XCTUnwrap(services.photoAccountAccess)
    retry.authorize(invitedAccess, origin: origin)
    XCTAssertNil(retry.consume(active: false, access: invitedAccess, origin: origin))
    XCTAssertNil(retry.consume(active: true, access: invitedAccess, origin: "https://another.invalid"))
    let reopened = try XCTUnwrap(retry.consume(active: true, access: invitedAccess, origin: origin))
    XCTAssertEqual(reopened, link)
    XCTAssertTrue(retry.presented)
    XCTAssertNil(retry.consume(active: true, access: invitedAccess, origin: origin), "One password success cannot open duplicate sheets")
    XCTAssertTrue(context.server.requests.isEmpty, "Restoring the invitation does not auto-accept it")
    try await services.openMoment(invitation)
    XCTAssertEqual(services.selectedGrant?.grantId, invitation.grantId)
    XCTAssertFalse(services.received.isEmpty)
    XCTAssertEqual(try originalLedger.pendingIDs(), [original.id])
    XCTAssertNotNil(try originalCatalog.existingOperation("kept-save", as: PendingSave.self))
    XCTAssertTrue(try originalCatalog.photos().contains { $0.id == original.id })
  }

  @MainActor func testCancelledInvitationPasswordRetryCannotBeRevivedByLateAuthenticationOrAnotherAccountBinding() async throws {
    let context = try SharingSafetyContext(), services = try await context.open(index: 1)
    defer { context.restore() }
    let link = FotoroShareLink.moment(FotoroMomentInvitation(grantId: context.server.grant.grantId, senderCard: context.cards[0]))
    let access = try XCTUnwrap(services.photoAccountAccess), origin = services.api.origin
    var cancelled = IncomingInvitationPasswordRetry(link: link, origin: origin)
    cancelled.cancel(); cancelled.authorize(access, origin: origin)
    XCTAssertFalse(cancelled.awaitingPassword)
    XCTAssertNil(cancelled.consume(active: true, access: access, origin: origin))
    var retry = IncomingInvitationPasswordRetry(link: link, origin: origin)
    retry.authorize(access, origin: origin)
    try await context.changeAccount(to: 0)
    XCTAssertFalse(retry.isAuthorized(services.photoAccountAccess, origin: origin))
    XCTAssertNil(retry.consume(active: true, access: services.photoAccountAccess, origin: origin))
    XCTAssertTrue(context.server.requests.isEmpty)
  }

  @MainActor func testActiveInboxUpdatesKeepAlreadyOpenedReceivedPhotos() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 1)
    defer { context.restore() }
    let opened = context.server.grant
    try await services.receive(opened)
    let photoIDs = services.received.map(\.id)
    var current = opened
    current.version += 1
    current.expiresAt = Wire.date(Date().addingTimeInterval(900))
    context.server.setInbox([current])
    try await services.refreshSharedMoments()
    XCTAssertEqual(services.selectedGrant, current)
    XCTAssertEqual(services.received.map(\.id), photoIDs)
    XCTAssertTrue(services.isReceivedGrantCurrent(opened), "A higher active version keeps existing photo access")
    current.revokedAt = Wire.date()
    context.server.setInbox([current])
    try await services.refreshSharedMoments()
    XCTAssertFalse(services.isReceivedGrantCurrent(opened))
    XCTAssertTrue(services.received.isEmpty)
  }

  @MainActor func testInboxRefreshWithdrawsUnavailableReceivedPhotosAndKeepsOwnedCopies() async throws {
    for change in ["revoked", "expired", "missing", "binding"] {
      let context = try SharingSafetyContext()
      let services = try await context.open(index: 1)
      defer { context.restore() }
      try await services.receive(context.server.grant)
      XCTAssertFalse(services.received.isEmpty)
      let pending = try context.pendingSave()
      _ = try services.store.operation("save-fixture") { pending }
      try await services.resumeSaves()
      let savedID = pending.request.save.photoId
      var updated = context.server.grant
      switch change {
      case "revoked": updated.revokedAt = Wire.date(); updated.version += 1
      case "expired": updated.expiresAt = "2000-01-01T00:00:00Z"
      case "binding": updated.momentId = Wire.id()
      default: break
      }
      context.server.setInbox(change == "missing" ? [] : [updated])
      let before = context.server.requests.count
      try await services.refreshSharedMoments()
      XCTAssertNil(services.selectedGrant, change)
      XCTAssertTrue(services.received.isEmpty, change)
      XCTAssertNotNil(try services.consumerSavedPhoto(savedID), "Saved copies belong to the recipient")
      XCTAssertNotNil(try services.store.existingOperation("save-fixture", as: PendingSave.self))
      XCTAssertEqual(context.server.requests.dropFirst(before).map(\.path), ["/v1/grants"])
    }
  }

  @MainActor func testInboxReadsCoalesceAndFailureDoesNotMeanAccessEnded() async throws {
    let gate = SharingResponseGate(suffix: "/v1/grants", started: expectation(description: "inbox"))
    let context = try SharingSafetyContext(gate: gate)
    let services = try await context.open(index: 1)
    defer { gate.release.signal(); context.restore() }
    try await services.receive(context.server.grant)
    let first = Task { try await services.refreshSharedMoments() }
    await fulfillment(of: [gate.started], timeout: 3)
    let second = Task { try await services.refreshSharedMoments() }
    await Task.yield()
    gate.release.signal()
    try await first.value; try await second.value
    XCTAssertEqual(context.server.requests.filter { $0.path == "/v1/grants" }.count, 1)
    XCTAssertEqual(services.selectedGrant, context.server.grant)
    context.server.failInbox = true
    do { try await services.refreshSharedMoments(); XCTFail("A failed inbox read must surface failure") } catch {}
    XCTAssertEqual(services.selectedGrant, context.server.grant)
    XCTAssertFalse(services.received.isEmpty, "A network failure must not invent revoked access")
  }

  @MainActor func testWithdrawalDoesNotCancelAnOwnedSaveReceiptAlreadyInFlight() async throws {
    let gate = SharingResponseGate(suffix: "/v1/saves", started: expectation(description: "owned save"))
    let context = try SharingSafetyContext(gate: gate)
    let services = try await context.open(index: 1)
    defer { gate.release.signal(); context.restore() }
    try await services.receive(context.server.grant)
    let pending = try context.pendingSave()
    _ = try services.store.operation("save-fixture") { pending }
    let saving = Task { try await services.resumeSaves() }
    await fulfillment(of: [gate.started], timeout: 3)
    context.server.setInbox([])
    try await services.refreshSharedMoments()
    XCTAssertNil(services.selectedGrant)
    XCTAssertTrue(services.received.isEmpty)
    gate.release.signal()
    try await saving.value
    XCTAssertNotNil(try services.consumerSavedPhoto(pending.request.save.photoId))
  }

  @MainActor func testCancelledInboxReadCannotWithdrawTheNextForegroundPresentation() async throws {
    let gate = SharingResponseGate(suffix: "/v1/grants", started: expectation(description: "old foreground"))
    let context = try SharingSafetyContext(gate: gate)
    let services = try await context.open(index: 1)
    defer { gate.release.signal(); context.restore() }
    try await services.receive(context.server.grant)
    context.server.setInbox([])
    let old = Task { try await services.refreshSharedMoments() }
    await fulfillment(of: [gate.started], timeout: 3)
    services.cancelSharedMomentRefresh()
    context.server.setInbox([context.server.grant])
    let next = Task { try await services.refreshSharedMoments() }
    gate.release.signal()
    do { try await old.value; XCTFail("An old lifecycle read must lose authority") }
    catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
    try await next.value
    XCTAssertEqual(services.selectedGrant, context.server.grant)
    XCTAssertFalse(services.received.isEmpty)
    XCTAssertEqual(context.server.requests.filter { $0.path == "/v1/grants" }.count, 2)
  }

  @MainActor func testKnownExpiryWithdrawsTheReceivedPresentationWithoutNetworkOrOwnedChanges() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 1)
    defer { context.restore() }
    try await services.receive(context.server.grant)
    let pending = try context.pendingSave()
    _ = try services.store.operation("save-fixture") { pending }
    try await services.resumeSaves()
    let expiry = Date().addingTimeInterval(60)
    var temporary = context.server.grant; temporary.expiresAt = Wire.date(expiry)
    services.selectedGrant = temporary
    let before = context.server.requests.count
    services.withdrawExpiredReceivedMoment(now: expiry.addingTimeInterval(-1))
    XCTAssertNotNil(services.selectedGrant)
    services.withdrawExpiredReceivedMoment(now: expiry.addingTimeInterval(1))
    XCTAssertNil(services.selectedGrant); XCTAssertTrue(services.received.isEmpty)
    XCTAssertNotNil(try services.consumerSavedPhoto(pending.request.save.photoId))
    XCTAssertEqual(context.server.requests.count, before)
  }

  @MainActor func testDelayedGrantOptionsCannotSendAfterLockAccountOrTrustChange() async throws {
    for change in ["lock", "account", "trust", "cancel"] {
      let gate = SharingResponseGate(suffix: "/grants/options", started: expectation(description: change))
      let context = try SharingSafetyContext(gate: gate)
      let services = try await context.open(index: 0)
      defer { gate.release.signal(); context.restore() }
      try services.store.put(context.server.source)
      let operation = Task { try await services.share([context.server.source], recipient: context.cards[1], temporary: false) }
      await fulfillment(of: [gate.started], timeout: 3)
      switch change {
      case "lock": services.vault.lock()
      case "account": try await context.changeAccount(to: 1)
      case "cancel": operation.cancel()
      default:
        var renewed = context.cards[1]
        renewed.boxPublicKey = Data(repeating: 0, count: 32).b64
        try services.session.pin(renewed)
      }
      gate.release.signal()
      do { _ = try await operation.value; XCTFail("Delayed invitation must lose authority after \(change)") }
      catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
      XCTAssertEqual(context.server.requests.filter { $0.path.hasSuffix("/grants") }.count, 0)
      XCTAssertFalse(context.server.requests.contains { $0.path.contains("/uploads") })
    }
  }

  @MainActor func testDelayedReceivedDownloadCannotPublishAfterVaultOrTrustChange() async throws {
    for change in ["lock", "account", "trust", "cancel"] {
      let gate = SharingResponseGate(suffix: "/v1/objects/" + SharingSafetyServer.metadataObjectID,
        started: expectation(description: "download " + change))
      let context = try SharingSafetyContext(gate: gate)
      let services = try await context.open(index: 1)
      defer { gate.release.signal(); context.restore() }
      let operation = Task { try await services.receive(context.server.grant) }
      await fulfillment(of: [gate.started], timeout: 3)
      switch change {
      case "lock": services.vault.lock()
      case "account": try await context.changeAccount(to: 0)
      case "cancel": operation.cancel()
      default:
        var renewed = context.cards[0]
        renewed.signingPublicKey = Data(repeating: 0, count: 32).b64
        try services.session.pin(renewed)
      }
      gate.release.signal()
      do { try await operation.value; XCTFail("Delayed received content must lose authority after \(change)") }
      catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
      XCTAssertTrue(services.received.isEmpty)
      XCTAssertNil(services.selectedGrant)
      XCTAssertFalse(context.server.requests.contains { $0.path.hasSuffix("/viewed") })
      XCTAssertTrue(try services.store.photos().isEmpty)
    }
  }

  @MainActor func testChangedServerSenderKeysFailBeforeFetchingAnyPhoto() async throws {
    let context = try SharingSafetyContext(changedSender: true)
    let services = try await context.open(index: 1)
    defer { context.restore() }
    do { try await services.receive(context.server.grant); XCTFail("Changed sender keys must require renewed acceptance") }
    catch { XCTAssertTrue(error.localizedDescription.contains("changed")) }
    XCTAssertFalse(context.server.requests.contains { $0.path.hasPrefix("/v1/objects/") })
    XCTAssertTrue(services.received.isEmpty)
    XCTAssertNil(services.selectedGrant)
    XCTAssertEqual(try services.session.requireCard(context.cards[0].accountId), context.cards[0], "A supplied card must not replace trusted identity")
  }

  @MainActor func testShareAndContributionLeaveUnrelatedImportsQueued() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 0)
    defer { context.restore() }
    let selected = context.server.source
    try services.store.put(selected)
    var unrelated = selected
    unrelated.photoId = Wire.id()
    unrelated.manifest.photoId = unrelated.photoId
    unrelated.metadata.filename = "unrelated-public-test.jpg"
    unrelated.transferState = "pending"
    try services.store.put(unrelated)
    try services.journal.enqueue(unrelated)
    _ = try await services.share([selected], recipient: context.cards[1], temporary: false)
    XCTAssertEqual(context.server.createdPhotoIDs, [selected.id])
    XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [unrelated.id])
    XCTAssertFalse(context.server.requests.contains { $0.path.contains("/uploads") || $0.path == "/v1/photos" })

    try await context.changeAccount(to: 1)
    let contribution = try context.server.photo(owner: 1)
    try services.store.put(contribution)
    unrelated = contribution
    unrelated.photoId = Wire.id()
    unrelated.manifest.photoId = unrelated.photoId
    unrelated.transferState = "pending"
    try services.store.put(unrelated)
    try services.journal.enqueue(unrelated)
    services.selectedGrant = context.server.grant
    try await services.contribute([contribution])
    XCTAssertEqual(context.server.contributedPhotoIDs, [contribution.id])
    XCTAssertEqual(try services.journal.entries().map { $0.photo.id }, [unrelated.id])
    XCTAssertFalse(context.server.requests.contains { $0.path.contains("/uploads") || $0.path == "/v1/photos" })
  }

  @MainActor func testContactNamesAreEncryptedAndRemainBoundToTheirAccount() async throws {
    let context = try SharingSafetyContext()
    let services = try await context.open(index: 0)
    defer { context.restore() }
    let name = "Fixture contact Ω  with spaces"
    try services.acceptContact(context.cards[1], name: name)
    XCTAssertEqual(services.contactName(context.cards[1].accountId), name)
    let contactID = context.cards[1].accountId
    let storedName: String? = try await services.store.database.read { db in
      try String.fetchOne(db, sql: "SELECT value FROM state WHERE key=?", arguments: ["contact-name:" + contactID])
    }
    let raw = try XCTUnwrap(storedName)
    XCTAssertFalse(raw.contains(name))
    let wrapped = try Wire.decode(WrappedKeyV1.self, Data(b64: raw))
    let decrypted = try services.crypto.unwrap(wrapped, key: Data(b64: context.secrets[0].vaultKey))
    let value = try Wire.decode([String: String].self, decrypted)
    XCTAssertEqual(value, ["accountId": context.cards[1].accountId, "name": name])
    XCTAssertThrowsError(try services.crypto.unwrap(wrapped, key: Data(b64: context.secrets[1].vaultKey)))
    services.vault.lock()
    XCTAssertFalse(services.contactName(context.cards[1].accountId).contains(name))
    try await context.changeAccount(to: 1)
    XCTAssertFalse(services.contactName(context.cards[1].accountId).contains(name))
    XCTAssertTrue(context.server.requests.isEmpty, "Accepting a contact must stay local")
  }

  @MainActor func testForgedSaveReceiptsNeverEnterTheCatalogAndKeepTheRetryRequest() async throws {
    for mode in [SharingSafetyServer.ReceiptMode.wrongPhoto, .badSignature] {
      let context = try SharingSafetyContext(receiptMode: mode)
      let services = try await context.open(index: 1)
      defer { context.restore() }
      let pending = try context.pendingSave()
      _ = try services.store.operation("save-fixture") { pending }
      do { try await services.resumeSaves(); XCTFail("Forged save receipt must not be accepted") }
      catch {}
      XCTAssertTrue(try services.store.photos().isEmpty)
      XCTAssertTrue(services.photos.isEmpty)
      XCTAssertNotNil(try services.store.existingOperation("save-fixture", as: PendingSave.self))
      XCTAssertEqual(context.server.requests.map(\.path), ["/v1/saves"])
    }
  }

  @MainActor func testDelayedSaveReceiptCannotWriteIntoLockedOrReplacementCatalog() async throws {
    for change in ["lock", "account", "cancel"] {
      let gate = SharingResponseGate(suffix: "/v1/saves", started: expectation(description: "save " + change))
      let context = try SharingSafetyContext(gate: gate)
      let services = try await context.open(index: 1)
      defer { gate.release.signal(); context.restore() }
      let pending = try context.pendingSave()
      let originalCatalog = services.store
      _ = try originalCatalog.operation("save-fixture") { pending }
      let operation = Task { try await services.resumeSaves() }
      await fulfillment(of: [gate.started], timeout: 3)
      if change == "lock" { services.vault.lock() }
      else if change == "account" { try await context.changeAccount(to: 0) }
      else { operation.cancel() }
      gate.release.signal()
      do { try await operation.value; XCTFail("Delayed save must lose authority after \(change)") }
      catch { XCTAssertTrue(error is CancellationError || (error as? URLError)?.code == .cancelled) }
      XCTAssertTrue(try originalCatalog.photos().isEmpty)
      XCTAssertTrue(try services.store.photos().isEmpty)
      XCTAssertNotNil(try originalCatalog.existingOperation("save-fixture", as: PendingSave.self))
      XCTAssertTrue(services.photos.isEmpty)
    }
  }
}

@MainActor private final class SharingSafetyContext {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("sharing-safety-" + Wire.id())
  let cards: [AccountCardV1]
  let secrets: [FixtureSecrets]
  let server: SharingSafetyServer
  private let previousCards: Any?
  private var services: AppServices?
  init(gate: SharingResponseGate? = nil, changedSender: Bool = false,
    receiptMode: SharingSafetyServer.ReceiptMode = .valid) throws {
    previousCards = UserDefaults.standard.object(forKey: "fotoro.pinnedCards")
    let publicFixture = try fixture(FixtureAccounts.self, "accounts")
    cards = publicFixture.accounts.map { original in var card = original; card.accountId = Wire.id(); return card }
    secrets = publicFixture.testSecrets
    server = try SharingSafetyServer(cards: cards, secrets: secrets, gate: gate, changedSender: changedSender, receiptMode: receiptMode)
    SharingSafetyProtocol.server = server
  }
  func open(index: Int) async throws -> AppServices {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SharingSafetyProtocol.self]
    let services = try AppServices(root: root, networkConfiguration: configuration,
      diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    self.services = services
    services.api.baseURL = URL(string: "http://127.0.0.1:8797")!
    try await changeAccount(to: index)
    return services
  }
  func changeAccount(to index: Int) async throws {
    let services = try XCTUnwrap(services)
    services.vault.lock()
    services.session.accountId = cards[index].accountId
    services.session.fixture = true
    // Each public-fixture owner explicitly trusts these test peers independently.
    for card in cards { try services.session.pin(card) }
    let secret = secrets[index]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    try services.activateAccount()
  }
  func pendingSave() throws -> PendingSave {
    let services = try XCTUnwrap(services), source = server.source
    var manifest = source.manifest
    manifest.photoId = Wire.id()
    manifest.ownerAccountId = cards[1].accountId
    manifest.ownerWrappedMetadataKey = try services.crypto.wrap(server.metadataKey, key: Data(b64: secrets[1].vaultKey))
    let signed = try services.crypto.sign(manifest, kind: "photo-manifest", accountId: cards[1].accountId,
      secret: Data(b64: secrets[1].signingSecretKey))
    let save = SavedPhotoV1(operationId: Wire.id(), photoId: manifest.photoId, sourceGrantId: server.grant.grantId,
      sourcePhotoId: source.id, manifest: manifest, signedPayload: signed)
    return PendingSave(request: SaveRequestV1(expectedGrantVersion: 1, save: save), local: source)
  }
  func restore() {
    services?.vault.lock()
    SharingSafetyProtocol.server = nil
    for card in cards {
      Keychain.remove(card.accountId)
      UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards.v2." + card.accountId.lowercased())
    }
    if let previousCards { UserDefaults.standard.set(previousCards, forKey: "fotoro.pinnedCards") }
    else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
    try? FileManager.default.removeItem(at: root)
  }
}

private final class SharingResponseGate: @unchecked Sendable {
  let suffix: String
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var used = false
  init(suffix: String, started: XCTestExpectation) { self.suffix = suffix; self.started = started }
  func visit(_ path: String) {
    lock.lock()
    let pause = path.hasSuffix(suffix) && !used
    if pause { used = true }
    lock.unlock()
    if pause { started.fulfill(); _ = release.wait(timeout: .now() + 5) }
  }
}

private final class SharingSafetyServer: @unchecked Sendable {
  enum ReceiptMode { case valid, wrongPhoto, badSignature }
  struct Request { var path: String; var method: String }
  static let metadataObjectID = "00000000-0000-4000-8000-000000000099"
  let source: LocalPhoto
  let metadataKey: Data
  let grant: GrantV1
  private let cards: [AccountCardV1]
  private let secrets: [FixtureSecrets]
  private let detail: GrantDetailV1
  private let objects: [String: Data]
  private let gate: SharingResponseGate?
  private let receiptMode: ReceiptMode
  private let lock = NSLock()
  private var recorded: [Request] = []
  private var created: [String] = []
  private var contributed: [String] = []
  private var inbox: [GrantV1] = []
  var failInbox = false
  init(cards: [AccountCardV1], secrets: [FixtureSecrets], gate: SharingResponseGate?,
    changedSender: Bool, receiptMode: ReceiptMode) throws {
    self.cards = cards; self.secrets = secrets; self.gate = gate; self.receiptMode = receiptMode
    let crypto = CryptoAdapter(), key = crypto.randomKey(), id = Wire.id()
    metadataKey = key
    let metadata = PhotoMetadataV1(filename: "public-sharing-fixture.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(),
      dateSource: "import", originalBytes: 3, originalSha256: Data("jpg".utf8).digest, representationKeys: [:])
    let binding = MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata")
    let ciphertext = try crypto.encrypt(Wire.encode(metadata), key: key, binding: binding)
    let rep = RepresentationV1(binding: binding, objectId: Self.metadataObjectID, header: ciphertext.prefix(24).b64,
      ciphertextBytes: ciphertext.count, ciphertextSha256: ciphertext.digest)
    let manifest = PhotoManifestV1(photoId: id, ownerAccountId: cards[0].accountId, representations: [], metadataRepresentation: rep,
      ownerWrappedMetadataKey: try crypto.wrap(key, key: Data(b64: secrets[0].vaultKey)))
    source = LocalPhoto(photoId: id, manifest: manifest, metadata: metadata, transferState: "committed")
    grant = GrantV1(grantId: Wire.id(), momentId: Wire.id(), ownerAccountId: cards[0].accountId,
      recipientAccountId: cards[1].accountId, role: "contributor", expiresAt: nil, revokedAt: nil, version: 1)
    inbox = [grant]
    let signed = try crypto.sign(manifest, kind: "photo-manifest", accountId: cards[0].accountId, secret: Data(b64: secrets[0].signingSecretKey))
    let envelope = try crypto.share(key, grantId: grant.grantId, photoId: id, sender: cards[0].accountId,
      recipient: cards[1], signingKey: Data(b64: secrets[0].signingSecretKey))
    var supplied = cards
    if changedSender { supplied[0].signingPublicKey = Data(repeating: 0, count: 32).b64 }
    detail = GrantDetailV1(version: 1, grant: grant, envelopes: [envelope], manifests: [signed], cards: supplied)
    objects = [Self.metadataObjectID: ciphertext]
  }
  var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
  var createdPhotoIDs: [String] { lock.lock(); defer { lock.unlock() }; return created }
  var contributedPhotoIDs: [String] { lock.lock(); defer { lock.unlock() }; return contributed }
  func setInbox(_ grants: [GrantV1]) { lock.lock(); inbox = grants; lock.unlock() }
  func photo(owner index: Int) throws -> LocalPhoto {
    var photo = source
    photo.photoId = Wire.id(); photo.manifest.photoId = photo.photoId
    photo.manifest.ownerAccountId = cards[index].accountId
    photo.manifest.ownerWrappedMetadataKey = try CryptoAdapter().wrap(metadataKey, key: Data(b64: secrets[index].vaultKey))
    return photo
  }
  func response(_ request: URLRequest) throws -> Data {
    let path = try XCTUnwrap(request.url?.path)
    lock.lock(); recorded.append(Request(path: path, method: request.httpMethod ?? "GET")); lock.unlock()
    if path == "/v1/grants" {
      lock.lock(); let current = inbox, failing = failInbox; lock.unlock()
      gate?.visit(path)
      if failing { throw URLError(.notConnectedToInternet) }
      return try Wire.encode(GrantInboxV1(version: 1, grants: current))
    }
    gate?.visit(path)
    if path == "/v1/grants/" + grant.grantId { return try Wire.encode(detail) }
    if let data = objects[String(path.split(separator: "/").last ?? "")], path.hasPrefix("/v1/objects/") { return data }
    if path.hasSuffix("/viewed") { return Data("{}".utf8) }
    if path.hasSuffix("/grants/options") {
      let options = try Wire.decode(GrantOptions.self, body(request))
      let moment = String(path.split(separator: "/")[2])
      return try Wire.encode(GrantV1(grantId: Wire.id(), momentId: moment, ownerAccountId: cards[0].accountId,
        recipientAccountId: options.recipientAccountId, role: options.role, expiresAt: nil, revokedAt: nil, version: 1))
    }
    if path.hasSuffix("/grants"), request.httpMethod == "POST" {
      let create = try Wire.decode(CreateGrantV1.self, body(request))
      lock.lock(); created = create.envelopes.map(\.photoId); lock.unlock()
      return try Wire.encode(create.grant)
    }
    if path.hasSuffix("/contributions") {
      let contribution = try Wire.decode(ContributionV1.self, body(request))
      lock.lock(); contributed = contribution.envelopes.map(\.photoId); lock.unlock()
      return try Wire.encode(ContributionResult(version: 1, operationId: contribution.operationId, accepted: contribution.manifests.count))
    }
    if path == "/v1/saves" {
      var saved = try Wire.decode(SaveRequestV1.self, body(request)).save
      if receiptMode == .wrongPhoto { saved.photoId = Wire.id() }
      if receiptMode == .badSignature { saved.signedPayload.signature = Data(repeating: 0, count: 64).b64 }
      return try Wire.encode(saved)
    }
    throw FotoroError("Unexpected controlled sharing request")
  }
  private func body(_ request: URLRequest) throws -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { throw FotoroError("Missing controlled sharing body") }
    stream.open(); defer { stream.close() }
    var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count < 0 { throw stream.streamError ?? FotoroError("Cannot read controlled sharing body") }
      if count == 0 { return result }
      result.append(contentsOf: buffer.prefix(count))
    }
  }
}

private final class SharingSafetyProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var server: SharingSafetyServer?
  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == 8797 }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let server = try XCTUnwrap(Self.server), url = try XCTUnwrap(request.url)
      let data = try server.response(request)
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
