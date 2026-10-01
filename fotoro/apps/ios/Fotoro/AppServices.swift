import Foundation
import Nuke
import Observation

struct PendingSave: Codable {
  var request: SaveRequestV1
  var local: LocalPhoto
}

@MainActor @Observable final class AppServices {
  let deviceTrust: DeviceTrust
  let auth: NativeAuth
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  var store: LibraryStore
  var importer: PhotoImport
  var journal: TransferJournal
  let storageRoot: URL
  var photos: [LocalPhoto] = []
  var received: [LocalPhoto] = []
  var grants: [GrantV1] = []
  var error: String?
  var notices: [String] = []
  var busy = false
  var fixtureAccounts: FixtureAccounts?
  var selectedGrant: GrantV1?
  let crypto = CryptoAdapter()
  init(root: URL? = nil) throws {
    session = AccountSession()
    api = APIClient(
      session: session,
      baseURL: URL(
        string: UserDefaults.standard.string(forKey: "fotoro.api") ?? "https://fotoro.cloud")!)
    vault = VaultStore(session: session, api: api)
    auth = NativeAuth(session: session, api: api, vault: vault)
    deviceTrust = DeviceTrust(session: session, api: api, vault: vault)
    let path =
      root
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Fotoro")
    storageRoot = path
    let initialStore = try LibraryStore(
      root: path.appendingPathComponent(session.accountId ?? "locked"))
    store = initialStore
    importer = PhotoImport(store: initialStore)
    journal = TransferJournal(store: initialStore, api: api, vault: vault)
    ImageCache.shared.costLimit = 48 * 1024 * 1024
    vault.onLock = { [weak self] in
      self?.photos = []
      self?.received = []
      self?.grants = []
      self?.selectedGrant = nil
      self?.auth.pending = nil
      self?.deviceTrust.pending = nil
      ImageCache.shared.removeAll()
    }
  }
  func activateAccount() throws {
    guard let id = session.accountId else { throw FotoroError("Authenticate first") }
    store = try LibraryStore(root: storageRoot.appendingPathComponent(id))
    importer = PhotoImport(store: store)
    journal = TransferJournal(store: store, api: api, vault: vault)
    try reload()
  }
  func configureAPI(_ value: String) throws {
    guard let url = URL(string: value),
      url.scheme == "https"
        || (["localhost", "127.0.0.1"].contains(url.host ?? "") && url.scheme == "http")
    else { throw FotoroError("Use HTTPS or a loopback API") }
    vault.lock()
    session.fixture = false
    session.bearerToken = nil
    api.baseURL = url
    UserDefaults.standard.set(value, forKey: "fotoro.api")
  }
  func loadMore() throws {
    guard let last = photos.last else { return }
    let page = try store.photos(after: last.id, limit: 1000)
    photos += page.filter { $0.manifest.ownerAccountId == session.accountId }
  }
  func reload() throws {
    guard vault.isUnlocked else { return }
    photos = try store.photos(limit: 1000).filter {
      $0.manifest.ownerAccountId == session.accountId
    }
  }
  #if DEBUG
    func fixtureUnlock(index: Int) async throws {
      vault.lock()
      api.baseURL = URL(string: "http://127.0.0.1:8790")!
      let accounts: FixtureAccounts = try await api.get("/__fixtures/accounts")
      fixtureAccounts = accounts
      // Explicit public fixture account cards, never production server trust.
      for card in accounts.accounts { try session.pin(card) }
      session.fixture = true
      session.accountId = accounts.accounts[index].accountId
      UserDefaults.standard.set(session.accountId, forKey: "fotoro.fixtureAccount")
      store = try LibraryStore(root: storageRoot.appendingPathComponent(session.accountId!))
      importer = PhotoImport(store: store)
      journal = TransferJournal(store: store, api: api, vault: vault)
      try await vault.recover(secret: Data(b64: accounts.testSecrets[index].recoverySecret))
      try reload()
      try await sync()
    }
  #endif
  func signOut(discardPending: Bool) throws {
    if try !discardPending && !journal.entries().isEmpty {
      throw FotoroError("Pending unsent imports will be removed. Confirm sign-out to discard them.")
    }
    let root = store.root
    if let id = session.accountId { Keychain.remove("device-request-" + id) }
    try vault.signOut()
    Keychain.remove("session")
    UserDefaults.standard.removeObject(forKey: "fotoro.account")
    UserDefaults.standard.removeObject(forKey: "fotoro.fixtureAccount")
    try? FileManager.default.removeItem(at: root)
  }
  func load(_ manifest: PhotoManifestV1, key: Data, original: Bool = false) async throws
    -> LocalPhoto
  {
    let authorizedAccount = session.accountId
    guard manifest.version == 1 else { throw FotoroError("Unsupported photo version") }
    let meta = try await api.request("/v1/objects/\(manifest.metadataRepresentation.objectId)")
    let metadata = try Wire.decode(
      PhotoMetadataV1.self,
      crypto.decrypt(meta, key: key, representation: manifest.metadataRepresentation))
    guard metadata.version == 1, ["image/jpeg", "image/png"].contains(metadata.mediaType),
      metadata.originalBytes > 0, metadata.originalBytes <= 50 * 1024 * 1024,
      try Data(b64: metadata.originalSha256).count == 32
    else { throw FotoroError("Unsupported original metadata") }
    var result = LocalPhoto(
      photoId: manifest.photoId, manifest: manifest, metadata: metadata,
      transferState: manifest.ownerAccountId == session.accountId ? "committed" : "received")
    for rep in manifest.representations {
      if (rep.binding.kind == "original" || rep.binding.kind == "preview") && !original { continue }
      guard let encoded = metadata.representationKeys[rep.binding.representationId] else {
        throw FotoroError("Representation key missing")
      }
      let bytes = try await api.request("/v1/objects/\(rep.objectId)")
      let representationKey = try Data(b64: encoded)
      let plain = try await Task.detached {
        try CryptoAdapter().decrypt(bytes, key: representationKey, representation: rep)
      }.value
      guard vault.isUnlocked, session.accountId == authorizedAccount
      else { throw FotoroError("Vault locked during download") }
      if rep.binding.kind == "original" {
        guard plain.digest == metadata.originalSha256, plain.count == metadata.originalBytes else {
          throw FotoroError("Original digest mismatch")
        }
        result.originalURL = try store.write(
          plain,
          name: "cache-" + manifest.photoId + "-original."
            + (metadata.mediaType == "image/png" ? "png" : "jpg"))
      }
      if rep.binding.kind == "thumbnail" {
        result.thumbnailURL = try store.write(
          plain, name: "cache-" + manifest.photoId + "-thumbnail.jpg")
      }
      if rep.binding.kind == "preview" {
        result.previewURL = try store.write(
          plain, name: "cache-" + manifest.photoId + "-preview.jpg")
      }
    }
    return result
  }
  func ensurePreview(_ photo: LocalPhoto) async throws {
    if let url = photo.previewURL, FileManager.default.fileExists(atPath: url.path) { return }
    guard let rep = photo.manifest.representations.first(where: { $0.binding.kind == "preview" }),
      let key = photo.metadata.representationKeys[rep.binding.representationId]
    else { return }
    let account = session.accountId
    let bytes = try await api.request("/v1/objects/\(rep.objectId)")
    let secret = try Data(b64: key)
    let plain = try await Task.detached {
      try CryptoAdapter().decrypt(bytes, key: secret, representation: rep)
    }.value
    guard vault.isUnlocked, session.accountId == account else {
      throw FotoroError("Vault locked during preview download")
    }
    var updated = photo
    updated.previewURL = try store.write(plain, name: "cache-" + photo.photoId + "-preview.jpg")
    try store.put(updated)
    if let i = photos.firstIndex(where: { $0.id == photo.id }) { photos[i] = updated }
    if let i = received.firstIndex(where: { $0.id == photo.id }) { received[i] = updated }
  }
  func sync() async throws {
    let bundle = try vault.requireBundle()
    let authorizedAccount = session.accountId
    var more = true
    while more {
      let cursor = try store.cursor()
      let page: ChangePageV1 = try await api.get(
        "/v1/changes?limit=100" + (cursor.map { "&cursor=\($0)" } ?? ""))
      guard vault.isUnlocked, session.accountId == authorizedAccount else {
        throw FotoroError("Vault changed during sync")
      }
      var verified: [String: LocalPhoto] = [:]
      var ownedChanges: [ChangeV1] = []
      for c in page.changes where c.entity == "photo" && !c.deleted {
        guard let signed = c.payload else { throw FotoroError("Missing signed change") }
        let card = try session.requireCard(signed.accountId)
        let manifest = try Wire.decode(
          PhotoManifestV1.self, crypto.verify(signed, card: card, kind: "photo-manifest"))
        guard manifest.photoId == c.entityId else { throw FotoroError("Catalog binding mismatch") }
        if manifest.ownerAccountId != session.accountId { continue }
        ownedChanges.append(c)
        verified[c.entityId] = try await load(
          manifest,
          key: crypto.unwrap(manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)))
      }
      let ownedPage = ChangePageV1(
        version: page.version,
        changes: ownedChanges + page.changes.filter { $0.deleted || $0.entity != "photo" },
        nextCursor: page.nextCursor, hasMore: page.hasMore)
      try store.apply(ownedPage, verified: verified)
      more = page.hasMore
    }
    try reload()
    let inbox: GrantInboxV1 = try await api.get("/v1/grants")
    grants = inbox.grants
  }
  func importFiles(_ urls: [URL]) async throws {
    let result = try await importer.importResources(
      urls.map {
        SelectedResource(id: Wire.id(), origin: .file, resourceIdentifier: $0.path, fileURL: $0)
      }, accountId: session.accountId!, bundle: vault.requireBundle())
    for photo in result { try journal.enqueue(photo) }
    notices = await importer.notices
    notices += await importer.failures.map { $0.message }
    try reload()
  }
  func share(_ selected: [LocalPhoto], recipient: AccountCardV1, temporary: Bool) async throws
    -> GrantV1
  {
    guard !selected.isEmpty, selected.count <= 100 else {
      throw FotoroError("Choose between 1 and 100 photos")
    }
    await journal.resumePending()
    try reload()
    let bundle = try vault.requireBundle()
    let moment = Wire.id()
    let grant: GrantV1 = try await api.post(
      "/v1/moments/\(moment)/grants/options",
      GrantOptions(
        recipientAccountId: recipient.accountId, role: "contributor",
        access: temporary ? "temporary" : "ongoing"))
    let current = try selected.map { p in
      guard let photo = photos.first(where: { $0.id == p.id }),
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Upload must commit before sharing") }
      return photo
    }
    let envelopes = try current.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: session.accountId!,
        recipient: recipient, signingKey: Data(b64: bundle.signingSecretKey))
    }
    let signed = try crypto.sign(
      GrantBody(grant: grant, envelopes: envelopes), kind: "grant", accountId: session.accountId!,
      secret: Data(b64: bundle.signingSecretKey))
    return try await api.post(
      "/v1/moments/\(moment)/grants",
      CreateGrantV1(grant: grant, envelopes: envelopes, signedPayload: signed))
  }
  func receive(_ grant: GrantV1) async throws {
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)")
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(session.accountId!)
    var loaded: [LocalPhoto] = []
    for signed in detail.manifests {
      let sender = try session.requireCard(signed.accountId)
      let manifest = try Wire.decode(
        PhotoManifestV1.self, crypto.verify(signed, card: sender, kind: "photo-manifest"))
      guard manifest.ownerAccountId == sender.accountId,
        let e = detail.envelopes.first(where: {
          $0.photoId == manifest.photoId && $0.recipientAccountId == recipient.accountId
        })
      else { continue }
      let key = try crypto.openShare(
        e, grantId: grant.grantId, photoId: manifest.photoId, sender: sender, recipient: recipient,
        boxSecret: Data(b64: bundle.boxSecretKey))
      loaded.append(try await load(manifest, key: key))
    }
    received = loaded
    selectedGrant = detail.grant
    if grant.recipientAccountId == session.accountId {
      _ = try await api.request("/v1/grants/\(grant.grantId)/viewed", method: "POST")
    }
  }
  func save(_ photo: LocalPhoto) async throws {
    guard let grant = selectedGrant else { throw FotoroError("Select a shared moment") }
    let operationKey = "save-" + grant.grantId + "-" + photo.photoId
    if let pending = try store.existingOperation(operationKey, as: PendingSave.self) {
      try await finishSave(pending)
      return
    }
    let detail: GrantDetailV1 = try await api.get("/v1/grants/\(grant.grantId)")
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(session.accountId!)
    guard
      let e = detail.envelopes.first(where: {
        $0.photoId == photo.photoId && $0.recipientAccountId == recipient.accountId
      })
    else { throw FotoroError("Missing save envelope") }
    let key = try crypto.openShare(
      e, grantId: grant.grantId, photoId: photo.photoId,
      sender: session.requireCard(e.senderAccountId), recipient: recipient,
      boxSecret: Data(b64: bundle.boxSecretKey))
    let verifiedOriginal = try await load(photo.manifest, key: key, original: true)
    guard let original = verifiedOriginal.originalURL,
      try Data(contentsOf: original).digest == photo.metadata.originalSha256
    else { throw FotoroError("Verify original before saving") }
    let input: PendingSave = try store.operation(operationKey) {
      var manifest = photo.manifest
      manifest.photoId = Wire.id()
      manifest.ownerAccountId = recipient.accountId
      manifest.ownerWrappedMetadataKey = try crypto.wrap(key, key: Data(b64: bundle.vaultKey))
      let signed = try crypto.sign(
        manifest, kind: "photo-manifest", accountId: recipient.accountId,
        secret: Data(b64: bundle.signingSecretKey))
      let save = SavedPhotoV1(
        operationId: Wire.id(), photoId: manifest.photoId, sourceGrantId: grant.grantId,
        sourcePhotoId: photo.photoId, manifest: manifest, signedPayload: signed)
      return PendingSave(
        request: SaveRequestV1(expectedGrantVersion: grant.version, save: save),
        local: verifiedOriginal)
    }
    try await finishSave(input)
  }
  func resumeSaves() async throws {
    for pending in try store.operations(prefix: "save-", as: PendingSave.self) {
      try await finishSave(pending)
    }
  }
  private func finishSave(_ pending: PendingSave) async throws {
    _ = try vault.requireBundle()
    let saved: SavedPhotoV1 = try await api.post("/v1/saves", pending.request)
    var local = pending.local
    local.photoId = saved.photoId
    local.manifest = saved.manifest
    local.transferState = "saved"
    try store.put(local)
    try reload()
  }
  func contribute(_ photos: [LocalPhoto]) async throws {
    guard let grant = selectedGrant, grant.role == "contributor", photos.count <= 100 else {
      throw FotoroError("An active contributor grant is required")
    }
    await journal.resumePending()
    try reload()
    let bundle = try vault.requireBundle()
    let recipient = try session.requireCard(grant.ownerAccountId)
    let committed = try photos.map { selected in
      guard let photo = self.photos.first(where: { $0.id == selected.id }),
        ["committed", "saved"].contains(photo.transferState)
      else { throw FotoroError("Upload must commit before contribution") }
      return photo
    }
    let manifests = try committed.map { photo in
      try crypto.sign(
        photo.manifest, kind: "photo-manifest", accountId: session.accountId!,
        secret: Data(b64: bundle.signingSecretKey))
    }
    let envelopes = try committed.map { photo in
      try crypto.share(
        crypto.unwrap(photo.manifest.ownerWrappedMetadataKey, key: Data(b64: bundle.vaultKey)),
        grantId: grant.grantId, photoId: photo.photoId, sender: session.accountId!,
        recipient: recipient, signingKey: Data(b64: bundle.signingSecretKey))
    }
    let input: ContributionV1 = try store.operation(
      "contribute-" + grant.grantId + "-" + committed.map { $0.id }.sorted().joined(separator: "-")
    ) {
      ContributionV1(
        operationId: Wire.id(), expectedGrantVersion: grant.version, manifests: manifests,
        envelopes: envelopes)
    }
    let _: ContributionResult = try await api.post(
      "/v1/moments/\(grant.momentId)/contributions", input)
  }
  func run(_ action: @escaping @MainActor () async throws -> Void) {
    Task {
      guard !busy else { return }
      busy = true
      defer { busy = false }
      do { try await action() } catch { self.error = error.localizedDescription }
    }
  }
}
