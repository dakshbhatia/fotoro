import XCTest
@testable import Fotoro

final class NativeAlbumTests: XCTestCase {
  func testIncomingAlbumInvitationDoesNotResolveUnrelatedStaleSavedSelection() throws {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let incoming = FotoroAlbumInvitation(albumId: Wire.id(), ownerCard: accounts.accounts[0])
    var selectionReads = 0
    let presentation = try NativeAlbumPresentation.opening(incoming: incoming) {
      selectionReads += 1
      throw FotoroError("A selected photo changed.")
    }
    XCTAssertEqual(presentation.incoming, incoming)
    XCTAssertTrue(presentation.selected.isEmpty)
    XCTAssertEqual(selectionReads, 0)
    XCTAssertThrowsError(try NativeAlbumPresentation.opening(incoming: nil) {
      selectionReads += 1
      throw FotoroError("A selected photo changed.")
    })
    XCTAssertEqual(selectionReads, 1, "Explicit contributions still validate the selected Saved sources")
  }
  func testPublicAlbumLinkMatchesBrowserAndRejectsHiddenFieldsAndForeignOrigin() throws {
    let fixture = try fixture(FixtureAccounts.self, "accounts")
    let invitation = FotoroAlbumInvitation(albumId: "11111111-1111-4111-8111-111111111111", ownerCard: fixture.accounts[0])
    let expected = "https://fotoro.cloud/#album=eyJhbGJ1bUlkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwib3duZXJDYXJkIjp7ImFjY291bnRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImJveFB1YmxpY0tleSI6Ikd4dFkzVkRxRkxZTm9YdDVETkFuVk5sd3licTRaT3V6d1BNQmItVWRQMWMiLCJzaWduaW5nUHVibGljS2V5IjoiN1Vrb3hpalJ3c2JxNlFNNGtGbVZZU2xaSnpwY1lfazJOc0ZHRkt5SE45RSIsInZlcnNpb24iOjF9LCJ2ZXJzaW9uIjoxfQ"
    XCTAssertEqual(try NativeAlbumLinks.make(invitation).absoluteString, expected)
    XCTAssertEqual(try NativeAlbumLinks.parse(URL(string: expected)!), invitation)
    XCTAssertThrowsError(try NativeAlbumLinks.parse(URL(string: expected.replacingOccurrences(of: "fotoro.cloud", with: "example.com"))!))
    var hidden = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(invitation)) as? [String: Any]); hidden["extra"] = true
    let url = URL(string: "https://fotoro.cloud/#album=" + (try JSONSerialization.data(withJSONObject: hidden, options: [.sortedKeys])).b64)!
    XCTAssertThrowsError(try NativeAlbumLinks.parse(url))
    XCTAssertThrowsError(try NativeAlbumWire.decode(AlbumActionV1.self, Data("{\"version\":1,\"version\":1,\"albumId\":\"11111111-1111-4111-8111-111111111111\",\"definitionSignature\":\"bad\"}".utf8)))
  }
  func testSealedAlbumKeyTitleAndRosterAreBoundToTrustedOwnerAndRecipient() throws {
    let f = try fixture(FixtureAccounts.self, "accounts"), c = NativeAlbumCrypto()
    let signed = try c.make(title: "Family 👨‍👩‍👧", owner: f.accounts[0], members: [f.accounts[1]], bundle: bundle(f.testSecrets[0]))
    let definition = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, signed, kind: "album-v1")
    let opened = try c.open(signed, expectedID: definition.albumId, trustedOwner: f.accounts[0], recipient: f.accounts[1], bundle: bundle(f.testSecrets[1]), trusted: Dictionary(uniqueKeysWithValues: f.accounts.map { ($0.accountId, $0) }))
    XCTAssertEqual(opened.2, "Family 👨‍👩‍👧"); XCTAssertEqual(opened.1.count, 32)
    XCTAssertThrowsError(try c.open(signed, expectedID: Wire.id(), trustedOwner: f.accounts[0], recipient: f.accounts[1], bundle: bundle(f.testSecrets[1]), trusted: [:]))
    XCTAssertThrowsError(try c.open(signed, expectedID: definition.albumId, trustedOwner: f.accounts[1], recipient: f.accounts[1], bundle: bundle(f.testSecrets[1]), trusted: [:]))
    XCTAssertThrowsError(try c.open(signed, expectedID: definition.albumId, trustedOwner: f.accounts[0], recipient: f.accounts[1], bundle: bundle(f.testSecrets[0]), trusted: [:]))
    XCTAssertThrowsError(try c.make(title: "Family", owner: f.accounts[0], members: [f.accounts[0]], bundle: bundle(f.testSecrets[0])))
    XCTAssertThrowsError(try c.make(title: " ", owner: f.accounts[0], members: [f.accounts[1]], bundle: bundle(f.testSecrets[0])))
    XCTAssertThrowsError(try NativeAlbumWire.title(String(repeating: "a", count: 81)))
  }
  func testContributionPreservesOriginalOwnerAndDoesNotIncludePrivateAnnotations() throws {
    let server = try AlbumTestServer(), c = NativeAlbumCrypto()
    let opened = try c.open(server.signed, expectedID: server.definition.albumId, trustedOwner: server.cards[0], recipient: server.cards[1], bundle: server.bundles[1], trusted: [:])
    let pair = try c.append(server.source, definition: opened.0, albumKey: opened.1, card: server.cards[0], bundle: server.bundles[0])
    let (manifest, key) = try c.photo(pair.0, manifestSigned: pair.1, definition: opened.0, key: opened.1)
    XCTAssertEqual(manifest, server.source.manifest); XCTAssertEqual(key, server.metadataKey)
    let text = String(data: try Data(b64: pair.0.body), encoding: .utf8)!
    XCTAssertFalse(text.contains("caption")); XCTAssertFalse(text.contains("facts")); XCTAssertFalse(text.contains("people"))
    var pending = server.source; pending.transferState = "pending"
    XCTAssertThrowsError(try c.append(pending, definition: opened.0, albumKey: opened.1, card: server.cards[0], bundle: server.bundles[0]))
    XCTAssertThrowsError(try c.append(server.source, definition: opened.0, albumKey: opened.1, card: server.cards[1], bundle: server.bundles[1]))
    var other = pair.1; other.accountId = server.cards[1].accountId
    XCTAssertThrowsError(try c.photo(pair.0, manifestSigned: other, definition: opened.0, key: opened.1))
  }
  func testActionsBindImmutableDefinitionAndOnlyOwnerCanEnd() throws {
    let server = try AlbumTestServer(), c = NativeAlbumCrypto()
    let accepted = try c.action(server.signed, albumId: server.definition.albumId, card: server.cards[1], bundle: server.bundles[1], ending: false)
    let body = try NativeAlbumWire.signedBody(AlbumActionV1.self, accepted, kind: "album-accept-v1")
    XCTAssertEqual(body.definitionSignature, server.signed.signature)
    _ = try CryptoAdapter().verify(accepted, card: server.cards[1], kind: "album-accept-v1")
    XCTAssertThrowsError(try c.action(server.signed, albumId: server.definition.albumId, card: server.cards[1], bundle: server.bundles[1], ending: true))
    XCTAssertThrowsError(try c.action(server.signed, albumId: Wire.id(), card: server.cards[0], bundle: server.bundles[0], ending: true))
  }
  @MainActor func testAcceptedMemberReadsContributionWithoutCreatingOwnedSavedPhotoAndClearsCaches() async throws {
    try await withAlbum { services, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      XCTAssertEqual(item.photo.transferState, "album"); XCTAssertEqual(item.photo.manifest.ownerAccountId, server.cards[0].accountId)
      XCTAssertNil(try services.consumerSavedPhoto(item.id)); XCTAssertEqual(try services.store.photos().count, 0)
      let thumbnail = try await model.thumbnail(item), preview = try await model.preview(item)
      XCTAssertNotNil(thumbnail); XCTAssertNotNil(preview)
      let urls = try await model.export(item); XCTAssertEqual(try Data(contentsOf: urls[0]).digest, server.source.metadata.originalSha256)
      let directory = try XCTUnwrap(model.directory); XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
      model.clear(); XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.opened)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
      XCTAssertGreaterThanOrEqual(server.accessReads, 8)
    }
  }
  @MainActor func testInvitedRosterRequiresExplicitAcceptBeforeAnyObjectRead() async throws {
    try await withAlbum(invited: true) { _, server, model in
      try await model.refresh()
      do { try await model.open(server.definition.albumId); XCTFail("Invitation opened before acceptance") } catch {}
      XCTAssertEqual(server.objectReads, 0)
      try await model.accept(server.definition.albumId, expectedOwner: server.cards[0])
      try await model.open(server.definition.albumId); XCTAssertEqual(model.items.count, 1)
      XCTAssertTrue(server.accepted)
    }
  }
  @MainActor func testEndDuringObjectFetchDiscardsPlaintextAndAlbumAccess() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); server.endOnObject = true
      do { try await model.open(server.definition.albumId); XCTFail("Ended album opened") } catch {}
      XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.directory); XCTAssertNil(model.opened)
    }
  }
  @MainActor func testAccountOriginAndPinnedCardChangesInvalidateAlbumContext() async throws {
    try await withAlbum { services, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      services.api.baseURL = URL(string: "http://localhost:8798")!
      do { _ = try await model.export(item); XCTFail("Old origin retained access") } catch {}
      XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.directory)
      services.api.baseURL = URL(string: "http://127.0.0.1:8798")!
      try await model.refresh(); try await model.open(server.definition.albumId)
      let again = try XCTUnwrap(model.items.first)
      services.vault.lock()
      do { _ = try await model.preview(again); XCTFail("Locked vault retained access") } catch {}
      XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.directory)
    }
  }
  @MainActor func testDuplicateReaddVerifiesExistingEntryWithoutFreshWrappingOrPosting() async throws {
    try await withAlbum(owner: true) { services, server, model in
      try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      try await model.append([server.source]); try await model.append([server.source])
      XCTAssertEqual(server.appendBodies.count, 0)
      XCTAssertFalse(model.hasPendingAddition)
    }
  }
  @MainActor func testLostAppendResponseRetriesDurableExactBodyAndOriginalBrowserSignature() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false; server.loseAppendResponse = true
      try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      do { try await model.append([server.source]); XCTFail("Lost response reported success") } catch {}
      XCTAssertTrue(model.hasPendingAddition); XCTAssertEqual(server.appendBodies.count, 1)
      let first = server.appendBodies[0]
      let request = try NativeAlbumWire.decode(AlbumAppendV1.self, first)
      XCTAssertEqual(request.manifests[0], server.manifest)
      XCTAssertNotEqual(server.manifest.body, try Wire.encode(server.source.manifest).b64)
      model.clear()
      let reopened = NativeAlbumService(services: services)
      try await reopened.refresh(); try await reopened.open(server.definition.albumId)
      XCTAssertTrue(reopened.hasPendingAddition)
      try await reopened.retryAddition()
      XCTAssertEqual(server.appendBodies.count, 2); XCTAssertEqual(server.appendBodies[1], first)
      XCTAssertFalse(reopened.hasPendingAddition); XCTAssertEqual(reopened.items.count, 1)
      reopened.clear()
    }
  }
  @MainActor func testLostCreationResponseRetriesTheSameSignedRosterAfterReopening() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false; server.loseCreateResponse = true
      do { _ = try await model.create(title: "Trip album", members: [server.cards[1]]); XCTFail("Lost response reported success") } catch {}
      XCTAssertTrue(model.hasPendingCreation); XCTAssertEqual(server.creationBodies.count, 1)
      let first = server.creationBodies[0], expectedID = server.definition.albumId
      model.clear(); let reopened = NativeAlbumService(services: services)
      XCTAssertTrue(reopened.hasPendingCreation)
      let result = try await reopened.retryCreation()
      XCTAssertEqual(result, expectedID); XCTAssertEqual(server.creationBodies.count, 2)
      XCTAssertEqual(server.creationBodies[1], first); XCTAssertFalse(reopened.hasPendingCreation)
      reopened.clear()
    }
  }
  @MainActor func testRefreshFailureClearsOpenMediaAndKeys() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first), url = try await model.thumbnail(item)
      XCTAssertNotNil(url); let directory = try XCTUnwrap(model.directory)
      server.failInbox = true
      do { try await model.refresh(); XCTFail("Failed refresh reported success") } catch {}
      XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.opened); XCTAssertNil(model.directory)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }
  }
  @MainActor func testCapturedExpectedAccountHeaderRejectsSwappedMemberTokenAndAuthHasNoHeader() async throws {
    try await withAlbum { services, server, model in
      services.session.fixture = false; services.session.bearerToken = server.cards[0].accountId
      do { try await model.refresh(); XCTFail("Another member's token loaded this account's albums") } catch {}
      XCTAssertEqual(server.accountMismatchCount, 1); XCTAssertEqual(server.objectReads, 0)
      _ = try await services.api.request("/v1/auth/header-fixture")
      XCTAssertNil(server.authAccountHeader)
    }
  }
  @MainActor func testChosenPhotosLargerThanWirePageUseBoundedBatchesWithoutDroppingSelection() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false
      let photos = try server.extraOwnedPhotos(count: 101)
      for photo in photos { try services.store.put(photo) }
      try services.reload(); try await model.refresh(); try await model.open(server.definition.albumId)
      try await model.append(photos)
      let requests = try server.appendBodies.map { try NativeAlbumWire.decode(AlbumAppendV1.self, $0) }
      XCTAssertEqual(requests.map { $0.entries.count }, [100, 1])
      let submitted = try requests.flatMap { try $0.entries.map { try NativeAlbumWire.signedBody(AlbumPhotoV1.self, $0, kind: "album-photo-v1").photoId } }
      XCTAssertEqual(Set(submitted), Set(photos.map(\.id)))
      XCTAssertEqual(model.items.count, 100); try await model.loadMore(); XCTAssertEqual(model.items.count, 101)
      XCTAssertFalse(model.hasPendingAddition)
    }
  }
  @MainActor private func withAlbum(invited: Bool = false, owner: Bool = false, _ run: (AppServices, AlbumTestServer, NativeAlbumService) async throws -> Void) async throws {
    let previous = UserDefaults.standard.object(forKey: "fotoro.pinnedCards")
    let server = try AlbumTestServer(); server.accepted = !invited; AlbumTestProtocol.server = server
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("album-test-" + Wire.id())
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AlbumTestProtocol.self]
    let services = try AppServices(root: root, networkConfiguration: config, diagnostics: NativeDiagnostics(fileURL: nil, emitSystemLog: false))
    services.api.baseURL = URL(string: "http://127.0.0.1:8798")!
    let index = owner ? 0 : 1
    services.session.accountId = server.cards[index].accountId; services.session.fixture = true
    services.session.pinnedCards = Dictionary(uniqueKeysWithValues: server.cards.map { ($0.accountId, $0) })
    let f = try fixture(FixtureAccounts.self, "accounts"), secret = f.testSecrets[index]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle)); try services.activateAccount()
    let model = NativeAlbumService(services: services)
    defer {
      model.clear(); services.vault.lock(); Keychain.remove(server.cards[index].accountId); AlbumTestProtocol.server = nil
      if let previous { UserDefaults.standard.set(previous, forKey: "fotoro.pinnedCards") } else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
      try? FileManager.default.removeItem(at: root)
    }
    try await run(services, server, model)
  }
  private func bundle(_ value: FixtureSecrets) -> AccountBundle { AccountBundle(vaultKey: value.vaultKey, boxSecretKey: value.boxSecretKey, signingSecretKey: value.signingSecretKey) }
}

private final class AlbumTestServer: @unchecked Sendable {
  let cards: [AccountCardV1]; let bundles: [AccountBundle]; var signed: SignedPayloadV1; var definition: AlbumDefinitionV1
  let source: LocalPhoto; let metadataKey: Data; let entry: SignedPayloadV1; let manifest: SignedPayloadV1
  private let objects: [String: Data]
  var accepted = true; var endOnObject = false; var ended = false
  var included = true; var loseAppendResponse = false; var appendBodies: [Data] = []
  private var receipts: [String: (Data, AlbumAppendResultV1)] = [:]
  private var contributions: [(SignedPayloadV1, SignedPayloadV1)] = []
  private var extraObjects: [String: Data] = [:]
  private var owned: [String: SignedPayloadV1] = [:]
  var creationBodies: [Data] = []; var loseCreateResponse = false; var failInbox = false
  var accountMismatchCount = 0; var authAccountHeader: String?
  private let lock = NSLock(); private var objectCount = 0; private var accessCount = 0
  var objectReads: Int { lock.lock(); defer { lock.unlock() }; return objectCount }
  var accessReads: Int { lock.lock(); defer { lock.unlock() }; return accessCount }
  init() throws {
    let f = try fixture(FixtureAccounts.self, "accounts")
    cards = f.accounts.prefix(2).map { var value = $0; value.accountId = Wire.id(); return value }
    bundles = f.testSecrets.prefix(2).map { AccountBundle(vaultKey: $0.vaultKey, boxSecretKey: $0.boxSecretKey, signingSecretKey: $0.signingSecretKey) }
    let c = NativeAlbumCrypto(); signed = try c.make(title: "Public fixture album", owner: cards[0], members: [cards[1]], bundle: bundles[0])
    definition = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, signed, kind: "album-v1")
    let (_, key, _) = try c.open(signed, expectedID: definition.albumId, trustedOwner: cards[0], recipient: cards[0], bundle: bundles[0], trusted: [:])
    let crypto = CryptoAdapter(), photoID = Wire.id(), metaKey = crypto.randomKey(); metadataKey = metaKey
    let bytes = try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    var keys: [String: String] = [:], reps: [RepresentationV1] = [], encrypted: [String: Data] = [:]
    for kind in ["original", "thumbnail", "preview"] {
      let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: kind), secret = crypto.randomKey()
      let container = try crypto.encrypt(bytes, key: secret, binding: binding), objectID = Wire.id()
      reps.append(RepresentationV1(binding: binding, objectId: objectID, header: container.prefix(24).b64, ciphertextBytes: container.count, ciphertextSha256: container.digest))
      keys[binding.representationId] = secret.b64; encrypted[objectID] = container
    }
    let metadata = PhotoMetadataV1(filename: "public-album-fixture.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "import", originalBytes: bytes.count, originalSha256: bytes.digest, representationKeys: keys)
    let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata"), container = try crypto.encrypt(Wire.encode(metadata), key: metaKey, binding: binding), id = Wire.id()
    let rep = RepresentationV1(binding: binding, objectId: id, header: container.prefix(24).b64, ciphertextBytes: container.count, ciphertextSha256: container.digest)
    encrypted[id] = container; objects = encrypted
    let value = PhotoManifestV1(photoId: photoID, ownerAccountId: cards[0].accountId, representations: reps, metadataRepresentation: rep, ownerWrappedMetadataKey: try crypto.wrap(metaKey, key: Data(b64: bundles[0].vaultKey)))
    source = LocalPhoto(photoId: photoID, manifest: value, metadata: metadata, transferState: "committed")
    entry = try c.append(source, definition: definition, albumKey: key, card: cards[0], bundle: bundles[0]).0
    func text<T: Encodable>(_ value: T) throws -> String { String(data: try Wire.encode(value), encoding: .utf8)! }
    let browserBody = try "{\"version\":1,\"photoId\":" + text(value.photoId) + ",\"ownerAccountId\":" + text(value.ownerAccountId) + ",\"representations\":" + text(value.representations) + ",\"metadataRepresentation\":" + text(value.metadataRepresentation) + ",\"ownerWrappedMetadataKey\":" + text(value.ownerWrappedMetadataKey) + "}"
    manifest = try crypto.signBytes(Data(browserBody.utf8), kind: "photo-manifest", accountId: cards[0].accountId, secret: Data(b64: bundles[0].signingSecretKey))
  }
  func extraOwnedPhotos(count: Int) throws -> [LocalPhoto] {
    let crypto = CryptoAdapter(); var photos: [LocalPhoto] = []
    for _ in 0..<count {
      let photoID = Wire.id(), originalKey = crypto.randomKey(), key = crypto.randomKey()
      let bytes = Data("public batch fixture".utf8), originalBinding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "original")
      let original = try crypto.encrypt(bytes, key: originalKey, binding: originalBinding), originalID = Wire.id()
      let rep = RepresentationV1(binding: originalBinding, objectId: originalID, header: original.prefix(24).b64, ciphertextBytes: original.count, ciphertextSha256: original.digest)
      let metadata = PhotoMetadataV1(filename: "public-batch.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "import", originalBytes: bytes.count, originalSha256: bytes.digest, representationKeys: [originalBinding.representationId: originalKey.b64])
      let metaBinding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata"), meta = try crypto.encrypt(Wire.encode(metadata), key: key, binding: metaBinding), metaID = Wire.id()
      let metaRep = RepresentationV1(binding: metaBinding, objectId: metaID, header: meta.prefix(24).b64, ciphertextBytes: meta.count, ciphertextSha256: meta.digest)
      let value = PhotoManifestV1(photoId: photoID, ownerAccountId: cards[0].accountId, representations: [rep], metadataRepresentation: metaRep, ownerWrappedMetadataKey: try crypto.wrap(key, key: Data(b64: bundles[0].vaultKey)))
      let signed = try crypto.sign(value, kind: "photo-manifest", accountId: cards[0].accountId, secret: Data(b64: bundles[0].signingSecretKey))
      extraObjects[originalID] = original; extraObjects[metaID] = meta; owned[photoID] = signed
      photos.append(LocalPhoto(photoId: photoID, manifest: value, metadata: metadata, transferState: "committed"))
    }
    return photos
  }
  func response(_ request: URLRequest) throws -> (Int, Data) {
    lock.lock(); defer { lock.unlock() }
    let path = request.url!.path
    if path.hasPrefix("/v1/auth/") { authAccountHeader = request.value(forHTTPHeaderField: "X-Fotoro-Account-Id"); return (200, Data()) }
    let actor = request.value(forHTTPHeaderField: "Authorization").map { String($0.dropFirst(7)) } ?? request.value(forHTTPHeaderField: "x-fotoro-fixture-account")
    if actor != request.value(forHTTPHeaderField: "X-Fotoro-Account-Id") { accountMismatchCount += 1; return (403, Data("{\"code\":\"ACCOUNT_MISMATCH\"}".utf8)) }
    func body() -> Data {
      request.httpBody ?? request.httpBodyStream.flatMap { stream -> Data? in
        stream.open(); defer { stream.close() }; var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }; return data
      } ?? Data()
    }
    if path == "/v1/albums", request.httpMethod == "POST" {
      let bytes = body(), input = try NativeAlbumWire.decode(CreateAlbumV1.self, bytes)
      creationBodies.append(bytes)
      if let first = creationBodies.first, first != bytes { return (409, Data()) }
      signed = input.definition; definition = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, signed, kind: "album-v1")
      if loseCreateResponse { loseCreateResponse = false; throw URLError(.networkConnectionLost) }
      return (200, try Wire.encode(AlbumOverviewV1(definition: signed, membership: "accepted", endedAt: nil, photoCount: 0)))
    }
    let all = (included ? [(entry, manifest)] : []) + contributions
    let overview = AlbumOverviewV1(definition: signed, membership: accepted ? "accepted" : "invited", endedAt: ended ? NativeAlbumWire.date() : nil, photoCount: all.count)
    if path.hasSuffix("/capabilities") { return (200, try Wire.encode(AlbumCapabilitiesV1(version: 1, albumsVersion: 1, maxMembers: 12, maxPhotos: 1000, pageSize: 100))) }
    if path == "/v1/albums" { if failInbox { throw URLError(.notConnectedToInternet) }; return (200, try Wire.encode(AlbumInboxV1(version: 1, albums: [overview]))) }
    if path.hasSuffix("/accept") { accepted = true; var value = overview; value.membership = "accepted"; return (200, try Wire.encode(value)) }
    if path.hasPrefix("/v1/photos/"), path.hasSuffix("/manifest") {
      let id = String(path.split(separator: "/")[2])
      if let signed = owned[id] { return (200, try Wire.encode(signed)) }
      return id == source.id ? (200, try Wire.encode(manifest)) : (404, Data())
    }
    if path.hasSuffix("/photos") {
      let bytes = body()
      let body = try NativeAlbumWire.decode(AlbumAppendV1.self, bytes)
      appendBodies.append(bytes)
      if let (priorBody, receipt) = receipts[body.operationId] {
        guard priorBody == bytes else { return (409, Data()) }
        return (200, try Wire.encode(receipt))
      }
      for original in body.manifests {
        let value = try NativeAlbumWire.signedBody(PhotoManifestV1.self, original, kind: original.kind)
        guard original == (owned[value.photoId] ?? manifest) else { return (403, Data()) }
      }
      contributions += Array(zip(body.entries, body.manifests))
      let result = AlbumAppendResultV1(version: 1, albumId: definition.albumId, operationId: body.operationId, added: body.entries.count, photoCount: all.count + body.entries.count)
      receipts[body.operationId] = (bytes, result)
      if loseAppendResponse { loseAppendResponse = false; throw URLError(.networkConnectionLost) }
      return (200, try Wire.encode(result))
    }
    if path.hasSuffix("/access") { accessCount += 1; return accepted && !ended ? (200, try Wire.encode(overview)) : (403, Data("{\"code\":\"ALBUM_INACTIVE\"}".utf8)) }
    if path.hasPrefix("/v1/objects/") {
      objectCount += 1; if endOnObject { ended = true }
      return (extraObjects[request.url!.lastPathComponent] ?? objects[request.url!.lastPathComponent]).map { (200, $0) } ?? (404, Data())
    }
    if path == "/v1/albums/" + definition.albumId {
      let cursor = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: true)?.queryItems?.first(where: { $0.name == "cursor" })?.value ?? "0") ?? 0
      let slice = accepted && !ended ? Array(all.dropFirst(cursor).prefix(100)) : []
      let next = cursor + slice.count < all.count ? String(cursor + slice.count) : nil
      return (200, try Wire.encode(AlbumDetailV1(version: 1, definition: signed, membership: overview.membership, endedAt: overview.endedAt, photoCount: all.count, entries: slice.map(\.0), manifests: slice.map(\.1), nextCursor: next, hasMore: next != nil)))
    }
    return (404, Data())
  }
}
private final class AlbumTestProtocol: URLProtocol, @unchecked Sendable {
  static var server: AlbumTestServer?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      let (status, data) = try Self.server!.response(request)
      client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}
