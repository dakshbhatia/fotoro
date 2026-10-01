import GRDB
import XCTest

@testable import Fotoro

final class AnnotationTests: XCTestCase {
  private func context() throws -> (LibraryStore, LocalPhoto, AccountBundle, AccountCardV1) {
    let store = try LibraryStore(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let secret = accounts.testSecrets[0]
    let bundle = AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey)
    let id = Wire.id()
    let rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: Wire.id(), header: Data(repeating: 0, count: 24).b64, ciphertextBytes: 45, ciphertextSha256: Data("encrypted".utf8).digest)
    let photo = LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: secret.accountId, representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "one.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "photos", originalBytes: 5, originalSha256: Data("photo".utf8).digest, representationKeys: [:]), transferState: "committed")
    try store.put(photo)
    return (store, photo, bundle, accounts.accounts[0])
  }
  func testVerifiedSidecarRejectsWrongOwnerPhotoDigestKindAndSignature() throws {
    let (_, photo, bundle, card) = try context()
    let value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["  Rónald  "])
    let signed = try AnnotationCrypto.seal(value, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle)
    XCTAssertEqual(try AnnotationCrypto.open(signed, photo: photo, card: card, bundle: bundle).annotations.labels, ["  Rónald  "])
    var wrong = photo
    wrong.photoId = Wire.id()
    XCTAssertThrowsError(try AnnotationCrypto.open(signed, photo: wrong, card: card, bundle: bundle))
    wrong = photo
    wrong.metadata.originalSha256 = Data("edited".utf8).digest
    XCTAssertThrowsError(try AnnotationCrypto.open(signed, photo: wrong, card: card, bundle: bundle))
    wrong = photo
    wrong.manifest.ownerAccountId = Wire.id()
    XCTAssertThrowsError(try AnnotationCrypto.open(signed, photo: wrong, card: card, bundle: bundle))
    var tampered = signed
    tampered.kind = "photo-manifest"
    XCTAssertThrowsError(try AnnotationCrypto.open(tampered, photo: photo, card: card, bundle: bundle))
    tampered = signed
    tampered.signature = Data(repeating: 0, count: 64).b64
    XCTAssertThrowsError(try AnnotationCrypto.open(tampered, photo: photo, card: card, bundle: bundle))
  }
  func testRetryIsIdenticalAndNewerEditSurvivesAcknowledgementAndRestart() throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    var value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["First"])
    try ledger.edit(value, photo: photo, bundle: bundle, card: card)
    let first = try XCTUnwrap(ledger.prepare(photo: photo, bundle: bundle))
    value.labels = ["  Latest  "]
    try ledger.edit(value, photo: photo, bundle: bundle, card: card)
    let reopened = AnnotationLedger(store: try LibraryStore(root: store.root), accountId: card.accountId)
    XCTAssertEqual(try reopened.prepare(photo: photo, bundle: bundle), first)
    try reopened.receive(first, photo: photo, bundle: bundle, card: card)
    XCTAssertEqual(try reopened.current(photo: photo, bundle: bundle, card: card)?.labels, ["  Latest  "])
    let next = try XCTUnwrap(reopened.prepare(photo: photo, bundle: bundle))
    XCTAssertEqual(try AnnotationCrypto.open(next, photo: photo, card: card, bundle: bundle).revision, 2)
    let bytes = try store.database.read { try Data.fetchOne($0, sql: "SELECT value FROM annotations WHERE id=?", arguments: [photo.id]) }
    XCTAssertFalse(String(decoding: try XCTUnwrap(bytes), as: UTF8.self).contains("Latest"))
  }
  func testConflictPreservesLocalLabelsUntilExplicitChoice() throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    let mine = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Mine"])
    try ledger.edit(mine, photo: photo, bundle: bundle, card: card)
    _ = try ledger.prepare(photo: photo, bundle: bundle)
    let other = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Other device"])
    let remote = try AnnotationCrypto.seal(other, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle)
    try ledger.receive(remote, photo: photo, bundle: bundle, card: card)
    XCTAssertTrue(try XCTUnwrap(ledger.state(photo.id)).conflict)
    XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: card)?.labels, ["Mine"])
    XCTAssertNil(try ledger.prepare(photo: photo, bundle: bundle))
    try ledger.resolve(photo.id, keepLocal: true)
    let next = try XCTUnwrap(ledger.prepare(photo: photo, bundle: bundle))
    XCTAssertEqual(try AnnotationCrypto.open(next, photo: photo, card: card, bundle: bundle).revision, 2)
  }
  func testEditedSourceAndDifferentAccountCannotPublishCachedLabels() throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    let value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Mine"])
    try ledger.edit(value, photo: photo, bundle: bundle, card: card)
    var edited = photo
    edited.metadata.originalSha256 = Data("new source".utf8).digest
    XCTAssertThrowsError(try ledger.prepare(photo: edited, bundle: bundle))
    let stranger = AnnotationLedger(store: store, accountId: Wire.id())
    XCTAssertThrowsError(try stranger.current(photo: photo, bundle: bundle, card: card))
    XCTAssertFalse(AnnotationSourceBinding.accepts(sourceRevision: "old", recordRevision: "new"))
    XCTAssertFalse(AnnotationSourceBinding.accepts(sourceRevision: nil, recordRevision: "new"))
  }
  @MainActor func testVaultFencePreventsAcknowledgementAfterInFlightLock() async throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    try ledger.edit(PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Mine"]), photo: photo, bundle: bundle, card: card)
    var valid = true
    let journal = AnnotationSync(ledger: ledger)
    await journal.resume(bundle: bundle, card: card, valid: { valid }, send: { _ in valid = false })
    XCTAssertNotNil(try ledger.state(photo.id)?.pending)
    XCTAssertNotNil(try ledger.state(photo.id)?.draft)
    XCTAssertEqual(try ledger.state(photo.id)?.revision, 0)
  }
  func testImportedTextCannotRecreateRemovedOrChangedPhotosAndDoesNotCrossProcessor() throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "asset")
    record.revision = "old"
    try index.replacePermitted([record])
    let value = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("photo".utf8).digest, labels: ["Original label"], ocr: PhotoAnnotationsV1.OCR(text: "receipt", confidence: 0.9, processor: "vision-text-v1"))
    XCTAssertFalse(try index.applyAnnotations(value, photoID: "asset", revision: "new", accountId: "owner"))
    XCTAssertEqual(try index.record("asset")?.labels, [])
    XCTAssertTrue(try index.applyAnnotations(value, photoID: "asset", revision: "old", accountId: "owner"))
    XCTAssertEqual(try index.record("asset")?.ocrText, "receipt")
    record.revision = "new"
    try index.replacePermitted([record])
    var otherProcessor = value
    otherProcessor.ocr?.processor = "other-processor"
    XCTAssertTrue(try index.applyAnnotations(otherProcessor, photoID: "asset", revision: "new", accountId: "owner"))
    XCTAssertEqual(try index.record("asset")?.ocrText, "")
    XCTAssertEqual(try index.record("asset")?.ocrStatus, .pending)
    try index.replacePermitted([])
    XCTAssertFalse(try index.applyAnnotations(value, photoID: "asset", revision: "old", accountId: "owner"))
    XCTAssertNil(try index.record("asset"))
  }

  func testLockRemovesAccountAnnotationsWithoutDiscardingDeviceLabels() throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "asset")
    record.labels = ["Device label"]
    try index.replacePermitted([record])
    let value = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("photo".utf8).digest, labels: ["Private owner label"])
    XCTAssertTrue(try index.applyAnnotations(value, photoID: "asset", revision: "1", accountId: "owner"))
    XCTAssertEqual(try index.record("asset")?.labels, ["Private owner label"])
    try index.clearSyncedAnnotations()
    XCTAssertEqual(try index.record("asset")?.labels, ["Device label"])
    XCTAssertNil(try index.record("asset")?.syncedAccountId)
    XCTAssertNil(try index.search("private").leading)
  }

  func testWireBoundsCountUnicodeScalarsAndRejectUnknownEncryptedFields() throws {
    let (_, photo, bundle, card) = try context()
    var value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: [String(repeating: "👩", count: 120)])
    XCTAssertNoThrow(try AnnotationCrypto.seal(value, revision: 2147483647, photo: photo, accountId: card.accountId, bundle: bundle))
    XCTAssertThrowsError(try AnnotationCrypto.seal(value, revision: 2147483648, photo: photo, accountId: card.accountId, bundle: bundle))
    value.labels = [String(repeating: "a\u{0301}", count: 61)]
    XCTAssertThrowsError(try AnnotationCrypto.seal(value, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle))
    value.labels = ["Known"]
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Wire.encode(value)) as? [String: Any])
    object["unknown"] = "must not be accepted"
    let encrypted = try CryptoAdapter().wrap(JSONSerialization.data(withJSONObject: object), key: Data(b64: bundle.vaultKey))
    let signed = try CryptoAdapter().sign(PhotoAnnotationsUpdateV1(photoId: photo.id, revision: 1, encrypted: encrypted), kind: "photo-annotations", accountId: card.accountId, secret: Data(b64: bundle.signingSecretKey))
    XCTAssertThrowsError(try AnnotationCrypto.open(signed, photo: photo, card: card, bundle: bundle))
  }

  @MainActor func testRealAuthenticatedSecondDeviceHydratesCloudLabelsAndOCRForSearch() async throws {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let secret = accounts.testSecrets[0]
    let first = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try first.configureAPI("http://127.0.0.1:8787")
    try await first.auth.recover("fotoro1.\(secret.accountId).\(secret.recoverySecret)")
    try first.activateAccount()
    let bytes = try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
    var photo = try await first.importer.build(bytes: bytes, filename: "public-annotation-fixture.jpg", accountId: secret.accountId, bundle: first.vault.requireBundle())
    var representations = photo.manifest.representations + [photo.manifest.metadataRepresentation]
    for index in representations.indices {
      let rep = representations[index]
      let reservation: UploadReservationV1 = try await first.api.post("/v1/uploads/reserve", ReserveUploadV1(binding: rep.binding, ciphertextBytes: rep.ciphertextBytes, ciphertextSha256: rep.ciphertextSha256, operationId: rep.binding.representationId))
      try await first.api.upload(Data(contentsOf: try XCTUnwrap(photo.staged[rep.binding.representationId])), to: reservation.stagingUrl)
      let committed = try await first.api.commit(reservation.uploadId)
      representations[index].objectId = committed.objectId
    }
    photo.manifest.metadataRepresentation = representations.removeLast()
    photo.manifest.representations = representations
    photo.transferState = "committed"
    let signed = try CryptoAdapter().sign(photo.manifest, kind: "photo-manifest", accountId: secret.accountId, secret: Data(b64: secret.signingSecretKey))
    _ = try await first.api.request("/v1/photos", method: "POST", body: Wire.encode(signed))
    try first.store.put(photo)
    let value = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["  Private fixture label  "], ocr: PhotoAnnotationsV1.OCR(text: "cloud receipt 4821", confidence: 0.9, processor: "vision-text-v1"))
    try first.annotations.ledger.edit(value, photo: photo, bundle: first.vault.requireBundle(), card: accounts.accounts[0])
    await first.syncAnnotations()
    XCTAssertTrue(first.annotations.errors.isEmpty, "\(first.annotations.errors)")
    XCTAssertTrue(try first.annotations.ledger.pendingIDs().isEmpty)
    let second = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()))
    try second.configureAPI("http://127.0.0.1:8787")
    try await second.auth.recover("fotoro1.\(secret.accountId).\(secret.recoverySecret)")
    try second.activateAccount()
    try await second.sync()
    let restored = try XCTUnwrap(second.photos.first { $0.id == photo.id })
    XCTAssertEqual(second.annotation(restored).labels, ["  Private fixture label  "])
    XCTAssertEqual(second.annotation(restored).ocr?.text, "cloud receipt 4821")
    XCTAssertTrue(second.matches(restored, query: "private fixture"))
    XCTAssertTrue(second.matches(restored, query: "4821"))
    XCTAssertEqual(restored.metadata.originalSha256, bytes.digest)
    second.vault.lock()
    XCTAssertTrue(second.photoAnnotations.isEmpty)
  }

  @MainActor func testExplicitAccountLockSurvivesForegroundAndProcessRestoration() async throws {
    let account = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    defer { UserDefaults.standard.removeObject(forKey: "fotoro.manualLock." + account.accountId) }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let service = try AppServices(root: root)
    try service.configureAPI("http://127.0.0.1:8787")
    try await service.auth.recover("fotoro1.\(account.accountId).\(account.recoverySecret)")
    try service.activateAccount()
    service.lockAccount()
    await service.resumeSavedAccount()
    XCTAssertFalse(service.vault.isUnlocked)
    let restarted = try AppServices(root: root)
    await restarted.resumeSavedAccount(initialRestoration: true)
    XCTAssertFalse(restarted.vault.isUnlocked)
    try await restarted.vault.unlock(.localKeychain)
    try restarted.activateAccount()
    XCTAssertTrue(restarted.vault.isUnlocked)
    XCTAssertFalse(UserDefaults.standard.bool(forKey: "fotoro.manualLock." + account.accountId))
  }

  func testDisjointLabelAndRemoteOCRChangesMergeWithoutConflict() throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    let base = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Old"])
    try ledger.receive(AnnotationCrypto.seal(base, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
    var mine = base
    mine.labels = ["Mine"]
    try ledger.edit(mine, photo: photo, bundle: bundle, card: card)
    _ = try ledger.prepare(photo: photo, bundle: bundle)
    var remote = base
    remote.ocr = PhotoAnnotationsV1.OCR(text: "Remote receipt", confidence: 0.8, processor: "vision-text-v1")
    try ledger.receive(AnnotationCrypto.seal(remote, revision: 2, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
    XCTAssertFalse(try XCTUnwrap(ledger.state(photo.id)).conflict)
    let next = try XCTUnwrap(ledger.prepare(photo: photo, bundle: bundle))
    let merged = try AnnotationCrypto.open(next, photo: photo, card: card, bundle: bundle)
    XCTAssertEqual(merged.revision, 3)
    XCTAssertEqual(merged.annotations.labels, ["Mine"])
    XCTAssertEqual(merged.annotations.ocr?.text, "Remote receipt")
  }
  func testBothConflictChoicesPreserveUnrelatedLocalAndRemoteFields() throws {
    for keepLocal in [true, false] {
      let (store, photo, bundle, card) = try context()
      let ledger = AnnotationLedger(store: store, accountId: card.accountId)
      let base = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Old"])
      try ledger.receive(AnnotationCrypto.seal(base, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
      var mine = base
      mine.labels = ["Mine"]
      mine.keywords = ["Local keyword"]
      try ledger.edit(mine, photo: photo, bundle: bundle, card: card)
      _ = try ledger.prepare(photo: photo, bundle: bundle)
      var remote = base
      remote.labels = ["Other device"]
      remote.ocr = PhotoAnnotationsV1.OCR(text: "Remote receipt", confidence: 0.8, processor: "vision-text-v1")
      try ledger.receive(AnnotationCrypto.seal(remote, revision: 2, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
      XCTAssertTrue(try XCTUnwrap(ledger.state(photo.id)).conflict)
      XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: card)?.ocr?.text, "Remote receipt")
      try ledger.resolve(photo.id, keepLocal: keepLocal)
      let next = try XCTUnwrap(ledger.prepare(photo: photo, bundle: bundle))
      let merged = try AnnotationCrypto.open(next, photo: photo, card: card, bundle: bundle).annotations
      XCTAssertEqual(merged.labels, keepLocal ? ["Mine"] : ["Other device"])
      XCTAssertEqual(merged.keywords, ["Local keyword"])
      XCTAssertEqual(merged.ocr?.text, "Remote receipt")
    }
  }
  func testLocalLabelDeltasSurviveLockWithoutCopyingPrivateOverlay() throws {
    let index = try SearchIndex()
    var record = SearchRecord(id: "asset")
    record.labels = ["Device A", "Device B"]
    try index.replacePermitted([record])
    let value = PhotoAnnotationsV1(photoId: Wire.id(), originalSha256: Data("photo".utf8).digest, labels: ["Device B", "Private owner label"])
    XCTAssertTrue(try index.applyAnnotations(value, photoID: "asset", revision: "1", accountId: "owner"))
    XCTAssertTrue(try index.setLabels(["Private owner label", "  New local label  "], photoID: "asset"))
    try index.clearSyncedAnnotations()
    XCTAssertEqual(try index.record("asset")?.labels, ["Device A", "  New local label  "])
    XCTAssertNil(try index.search("private").leading)
  }
  @MainActor func testCloudLabelSearchReachesBeyondFirstThousandPhotos() async throws {
    let (store, prototype, bundle, card) = try context()
    let service = try AppServices(root: store.root.deletingLastPathComponent().appendingPathComponent(Wire.id()))
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    try service.configureAPI("http://127.0.0.1:8787")
    try await service.auth.recover("fotoro1.\(secret.accountId).\(secret.recoverySecret)")
    try service.activateAccount()
    var oldest = prototype
    for index in 0...1000 {
      var photo = prototype
      photo.photoId = Wire.id()
      photo.manifest.photoId = photo.id
      photo.metadata.sourceDate = Wire.date(Date(timeIntervalSince1970: 1_700_000_000 - Double(index)))
      try service.store.put(photo)
      if index == 1000 { oldest = photo }
    }
    let value = PhotoAnnotationsV1(photoId: oldest.id, originalSha256: oldest.metadata.originalSha256, labels: ["Unique older cloud label"], caption: "Kept caption", facts: ["receipt"], ocr: PhotoAnnotationsV1.OCR(text: "Kept text", confidence: 0.8, processor: "vision-text-v1"))
    try service.annotations.ledger.receive(AnnotationCrypto.seal(value, revision: 1, photo: oldest, accountId: card.accountId, bundle: bundle), photo: oldest, bundle: bundle, card: card)
    try service.reload()
    XCTAssertEqual(service.photos.count, 1000)
    XCTAssertFalse(service.photos.contains { $0.id == oldest.id })
    let matches = try await service.searchCatalog("older cloud")
    XCTAssertEqual(matches.map(\.id), [oldest.id])
    XCTAssertEqual(service.annotation(oldest).labels, ["Unique older cloud label"])
    try service.setLabels(["Edited older label"], photo: oldest)
    let edited = try service.annotations.ledger.current(photo: oldest, bundle: bundle, card: card)
    XCTAssertEqual(edited?.labels, ["Edited older label"])
    XCTAssertEqual(edited?.caption, "Kept caption")
    XCTAssertEqual(edited?.facts, ["receipt"])
    XCTAssertEqual(edited?.ocr?.text, "Kept text")
    service.vault.lock()
  }

  func testUnresolvedLabelConflictSurvivesLaterRemoteOCRRevision() throws {
    let (store, photo, bundle, card) = try context()
    let ledger = AnnotationLedger(store: store, accountId: card.accountId)
    let base = PhotoAnnotationsV1(photoId: photo.id, originalSha256: photo.metadata.originalSha256, labels: ["Old"])
    try ledger.receive(AnnotationCrypto.seal(base, revision: 1, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
    var mine = base
    mine.labels = ["Mine"]
    try ledger.edit(mine, photo: photo, bundle: bundle, card: card)
    _ = try ledger.prepare(photo: photo, bundle: bundle)
    var remote = base
    remote.labels = ["Other device"]
    try ledger.receive(AnnotationCrypto.seal(remote, revision: 2, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
    remote.ocr = PhotoAnnotationsV1.OCR(text: "Latest receipt", confidence: 0.9, processor: "vision-text-v1")
    try ledger.receive(AnnotationCrypto.seal(remote, revision: 3, photo: photo, accountId: card.accountId, bundle: bundle), photo: photo, bundle: bundle, card: card)
    XCTAssertTrue(try XCTUnwrap(ledger.state(photo.id)).conflict)
    XCTAssertNil(try ledger.prepare(photo: photo, bundle: bundle))
    XCTAssertEqual(try ledger.current(photo: photo, bundle: bundle, card: card)?.ocr?.text, "Latest receipt")
    try ledger.resolve(photo.id, keepLocal: false)
    let next = try XCTUnwrap(ledger.prepare(photo: photo, bundle: bundle))
    let chosen = try AnnotationCrypto.open(next, photo: photo, card: card, bundle: bundle)
    XCTAssertEqual(chosen.revision, 4)
    XCTAssertEqual(chosen.annotations.labels, ["Other device"])
    XCTAssertEqual(chosen.annotations.ocr?.text, "Latest receipt")
  }

}
