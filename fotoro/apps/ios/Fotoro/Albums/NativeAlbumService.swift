import Foundation
import Observation
import Nuke
import GRDB

struct NativeAlbumSummary: Identifiable {
  let overview: AlbumOverviewV1
  let definition: AlbumDefinitionV1
  let title: String?
  let needsTrust: Bool
  var id: String { definition.albumId }
}
struct NativeAlbumItem: Identifiable {
  let entry: SignedPayloadV1
  let signedManifest: SignedPayloadV1
  let photo: LocalPhoto
  var id: String { photo.id }
}
struct NativeAlbumContext: Equatable {
  let photo: PhotoAccountAccess
  let origin: String
  let apiOrigin: String
  let cards: [String: AccountCardV1]
  let token: String?
  let fixture: Bool
  let epoch: UUID
}
struct NativeAlbumPendingCreate: Codable { var version = 1; var origin: String; var accountId: String; var definition: SignedPayloadV1 }
struct NativeAlbumPendingAppend: Codable {
  var version = 1
  var origin: String
  var accountId: String
  var albumId: String
  var definition: SignedPayloadV1
  var request: AlbumAppendV1
}
struct NativeAlbumAccess {
  let context: NativeAlbumContext
  let albumID: String
  let signedDefinition: SignedPayloadV1
  let definition: AlbumDefinitionV1
  let key: Data
}

@MainActor @Observable final class NativeAlbumService {
  let services: AppServices
  private(set) var albums: [NativeAlbumSummary] = []
  private(set) var inboxError: String?
  private(set) var opened: NativeAlbumSummary?
  private(set) var items: [NativeAlbumItem] = []
  private(set) var directory: URL?
  private var access: NativeAlbumAccess?
  private(set) var nextCursor: String?
  private var cursors = Set<String>()
  private(set) var sharedFacts: [String: AlbumPhotoFactsContentV1] = [:]
  private(set) var factsSupported: Bool?
  private(set) var factsError: String?
  private(set) var factsNextCursor: String?
  private(set) var factsPageLoaded = false
  private var pendingFacts: [String: AlbumPhotoFactsContentV1] = [:]
  private var factsCursors = Set<String>()
  private var factsListedIDs = Set<String>()
  private var factsLoadedPages = 0
  private var refreshingFacts: UUID?
  private var epoch = UUID()
  private let crypto = NativeAlbumCrypto()
  private static var cleanedStaleCaches = false
  init(services: AppServices) {
    self.services = services
    if !Self.cleanedStaleCaches {
      Self.cleanedStaleCaches = true
      let temporary = FileManager.default.temporaryDirectory
      for url in (try? FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent.hasPrefix("fotoro-album-") {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }
  func clear() {
    epoch = UUID(); access = nil; opened = nil; items = []; albums = []; inboxError = nil; nextCursor = nil; cursors = []
    clearFacts()
    if let directory { try? FileManager.default.removeItem(at: directory) }
    directory = nil; ImageCache.shared.removeAll()
  }
  private func context() throws -> NativeAlbumContext {
    try Task.checkCancellation()
    guard let photo = services.photoAccountAccess, services.session.isSignedIn,
      let origin = BackgroundUploadPolicy.origin(services.api.baseURL) else { throw FotoroError("Open Fotoro to use albums.") }
    return NativeAlbumContext(photo: photo, origin: origin, apiOrigin: services.api.origin,
      cards: services.session.pinnedCards, token: services.session.bearerToken, fixture: services.session.fixture, epoch: epoch)
  }
  func isCurrent(_ expected: NativeAlbumContext) -> Bool {
    (try? context()) == expected
  }
  var currentOpenedPhotoAccess: PhotoAccountAccess? {
    guard let captured = access?.context, opened != nil,
      captured.photo == services.photoAccountAccess,
      captured.origin == BackgroundUploadPolicy.origin(services.api.baseURL),
      captured.apiOrigin == services.api.origin, captured.cards == services.session.pinnedCards,
      captured.token == services.session.bearerToken, captured.fixture == services.session.fixture,
      captured.epoch == epoch else { return nil }
    return captured.photo
  }
  private func check(_ expected: NativeAlbumContext) throws {
    try Task.checkCancellation()
    guard isCurrent(expected) else {
      if expected.epoch == epoch { clear() }
      throw CancellationError()
    }
  }
  func discardOpenedAlbum() { clearOpen() }
  private func request<T: Codable>(_ type: T.Type, path: String, context: NativeAlbumContext, body: Data? = nil, method: String? = nil) async throws -> T {
    try check(context)
    let bytes: Data
    do { bytes = try await services.api.request(path, method: method ?? (body == nil ? "GET" : "POST"), body: body) }
    catch let error as FotoroError where error.statusCode == 403 {
      if isCurrent(context) { clearOpen() }
      throw error
    }
    try check(context)
    return try NativeAlbumWire.decode(type, bytes)
  }
  private func summary(_ overview: AlbumOverviewV1, context: NativeAlbumContext) throws -> NativeAlbumSummary {
    let definition = try NativeAlbumWire.overview(overview)
    let own = try services.session.requireCard(context.photo.account)
    guard definition.members.contains(where: { $0.card == own }),
      let candidate = definition.members.first(where: { $0.card.accountId == definition.ownerAccountId })?.card else { throw FotoroError("Album is for another account.") }
    guard let owner = context.cards[definition.ownerAccountId], owner == candidate else {
      _ = try CryptoAdapter().verify(overview.definition, card: candidate, kind: "album-v1")
      return NativeAlbumSummary(overview: overview, definition: definition, title: nil, needsTrust: true)
    }
    let (_, _, title) = try crypto.open(overview.definition, expectedID: definition.albumId, trustedOwner: owner, recipient: own,
      bundle: services.vault.requireBundle(), trusted: context.cards)
    return NativeAlbumSummary(overview: overview, definition: definition, title: title, needsTrust: false)
  }
  func refresh() async throws {
    let refreshEpoch = epoch
    do { try await refreshInbox() }
    catch { if refreshEpoch == epoch { clearOpen() }; throw error }
    try await refreshSharedDetails()
  }
  private func refreshInbox() async throws {
    let captured = try context()
    let capabilities = try await request(AlbumCapabilitiesV1.self, path: "/v1/albums/capabilities", context: captured)
    guard capabilities.version == 1, capabilities.albumsVersion == 1, capabilities.maxMembers == 12,
      capabilities.maxPhotos == 1000, capabilities.pageSize == 100 else { throw FotoroError("Albums need a newer Fotoro version.") }
    let inbox = try await request(AlbumInboxV1.self, path: "/v1/albums", context: captured)
    guard inbox.version == 1, inbox.albums.count <= 100 else { throw FotoroError("Invalid album inbox.") }
    _ = try services.session.requireCard(captured.photo.account)
    var ids = Set<String>(), next: [NativeAlbumSummary] = [], invalid = false
    for overview in inbox.albums {
      do {
        let value = try summary(overview, context: captured)
        guard ids.insert(value.id).inserted else { throw FotoroError("Duplicate album in inbox.") }
        next.append(value)
      } catch {
        try check(captured)
        invalid = true
      }
    }
    try check(captured); albums = next
    inboxError = invalid ? "An album could not be verified. Refresh or ask its owner for a new invitation." : nil
    if let opened, !next.contains(where: { $0.id == opened.id && $0.overview.definition == opened.overview.definition && $0.overview.endedAt == nil && $0.overview.membership == "accepted" && !$0.needsTrust }) {
      clearOpen()
    }
  }
  private func clearOpen() {
    epoch = UUID(); access = nil; opened = nil; items = []; nextCursor = nil; cursors = []
    clearFacts()
    if let directory { try? FileManager.default.removeItem(at: directory) }; directory = nil; ImageCache.shared.removeAll()
  }
  private func clearFacts() {
    sharedFacts = [:]; pendingFacts = [:]; factsCursors = []; factsListedIDs = []; factsNextCursor = nil
    factsSupported = nil; factsError = nil; factsPageLoaded = false; factsLoadedPages = 0; refreshingFacts = nil
  }
  private func creationID(_ captured: NativeAlbumContext) -> String { "albumcreate-" + Data(captured.origin.utf8).digest }
  var hasPendingCreation: Bool {
    guard let captured = try? context() else { return false }
    return (try? services.store.existingOperation(creationID(captured), as: NativeAlbumPendingCreate.self)) != nil
  }
  func create(title: String, members: [AccountCardV1]) async throws -> String {
    let captured = try context(), owner = try services.session.requireCard(captured.photo.account)
    guard members.allSatisfy({ captured.cards[$0.accountId] == $0 && $0.accountId != owner.accountId }) else { throw FotoroError("Choose confirmed contacts for this album.") }
    guard try services.store.existingOperation(creationID(captured), as: NativeAlbumPendingCreate.self) == nil else { throw FotoroError("Retry the pending album creation first.") }
    let definition = try crypto.make(title: title, owner: owner, members: members, bundle: services.vault.requireBundle())
    _ = try services.store.operation(creationID(captured)) {
      NativeAlbumPendingCreate(origin: captured.origin, accountId: captured.photo.account, definition: definition)
    }
    return try await retryCreation()
  }
  func retryCreation() async throws -> String {
    let captured = try context()
    guard let pending = try services.store.existingOperation(creationID(captured), as: NativeAlbumPendingCreate.self),
      pending.version == 1, pending.origin == captured.origin, pending.accountId == captured.photo.account else { throw FotoroError("No pending album creation for this account.") }
    let definition = try NativeAlbumWire.signedBody(AlbumDefinitionV1.self, pending.definition, kind: "album-v1")
    let owner = try services.session.requireCard(captured.photo.account)
    _ = try crypto.open(pending.definition, expectedID: definition.albumId, trustedOwner: owner, recipient: owner,
      bundle: services.vault.requireBundle(), trusted: captured.cards)
    guard definition.members.allSatisfy({ captured.cards[$0.card.accountId] == $0.card }) else { throw FotoroError("A pending album contact changed. Confirm their original identity first.") }
    let overview = try await request(AlbumOverviewV1.self, path: "/v1/albums", context: captured, body: Wire.encode(CreateAlbumV1(definition: pending.definition)))
    guard overview.definition == pending.definition, overview.membership == "accepted", overview.endedAt == nil else { throw FotoroError("Album creation binding failed.") }
    let value = try summary(overview, context: captured), completedID = creationID(captured)
    try await services.store.database.write { db in try db.execute(sql: "DELETE FROM operations WHERE id=?", arguments: [completedID]) }
    try check(captured); albums.removeAll { $0.id == value.id }; albums.insert(value, at: 0)
    return value.id
  }
  func invitation(_ id: String) throws -> URL {
    let captured = try context()
    guard let value = albums.first(where: { $0.id == id }), value.overview.endedAt == nil,
      value.overview.membership == "accepted", let owner = captured.cards[value.definition.ownerAccountId] else { throw FotoroError("Album is unavailable.") }
    return try NativeAlbumLinks.make(FotoroAlbumInvitation(albumId: id, ownerCard: owner), origin: captured.apiOrigin)
  }
  func accept(_ id: String, expectedOwner: AccountCardV1? = nil) async throws {
    let captured = try context()
    guard let value = albums.first(where: { $0.id == id }), !value.needsTrust, value.overview.endedAt == nil,
      expectedOwner.map({ captured.cards[value.definition.ownerAccountId] == $0 }) ?? true else { throw FotoroError("Confirm the album owner's contact first.") }
    let action = try crypto.action(value.overview.definition, albumId: id, card: services.session.requireCard(captured.photo.account), bundle: services.vault.requireBundle(), ending: false)
    let result = try await request(AlbumOverviewV1.self, path: "/v1/albums/\(id)/accept", context: captured, body: Wire.encode(AlbumActionRequestV1(action: action)))
    guard result.definition == value.overview.definition, result.membership == "accepted", result.endedAt == nil else { throw FotoroError("Album acceptance binding failed.") }
    let next = try summary(result, context: captured); albums.removeAll { $0.id == id }; albums.insert(next, at: 0)
  }
  func end(_ id: String) async throws {
    let captured = try context()
    guard let value = albums.first(where: { $0.id == id }), !value.needsTrust, value.definition.ownerAccountId == captured.photo.account else { throw FotoroError("Only the owner can end album access.") }
    let action = try crypto.action(value.overview.definition, albumId: id, card: services.session.requireCard(captured.photo.account), bundle: services.vault.requireBundle(), ending: true)
    let result = try await request(AlbumOverviewV1.self, path: "/v1/albums/\(id)/end", context: captured, body: Wire.encode(AlbumActionRequestV1(action: action)))
    guard result.definition == value.overview.definition, result.endedAt != nil else { throw FotoroError("Album end binding failed.") }
    let next = try summary(result, context: captured)
    clearOpen(); albums.removeAll { $0.id == id }; albums.insert(next, at: 0)
  }
  private func validate(_ detail: AlbumDetailV1, access: NativeAlbumAccess) throws {
    _ = try NativeAlbumWire.overview(detail.overview)
    guard detail.version == 1, detail.definition == access.signedDefinition, detail.membership == "accepted", detail.endedAt == nil,
      detail.entries.count == detail.manifests.count, detail.entries.count <= 100, detail.entries.count <= detail.photoCount,
      detail.hasMore == (detail.nextCursor != nil), detail.nextCursor.map({ !$0.isEmpty && $0.utf8.count <= 256 && $0.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil }) ?? true else { throw FotoroError("Album access has ended or changed.") }
  }
  private func membership(_ access: NativeAlbumAccess, preservingTransientFailure: Bool = false) async throws {
    do {
      let value = try await request(AlbumOverviewV1.self, path: "/v1/albums/\(access.albumID)/access", context: access.context)
      _ = try NativeAlbumWire.overview(value)
      guard value.definition == access.signedDefinition, value.membership == "accepted", value.endedAt == nil else { throw FotoroError("Album access has ended or changed.") }
      try check(access.context)
    } catch {
      let status = (error as? FotoroError)?.statusCode ?? 0
      let transient = (error as? URLError).map { $0.code != .cancelled } ?? (status == 408 || status == 429 || (500...599).contains(status))
      if preservingTransientFailure && transient { try check(access.context) }
      else if isCurrent(access.context) { clearOpen() }
      throw error
    }
  }
  private func object(_ rep: RepresentationV1, key: Data, access: NativeAlbumAccess) async throws -> Data {
    try await membership(access)
    let ciphertext = try await services.api.request("/v1/objects/\(rep.objectId)")
    try check(access.context); try await membership(access)
    let bytes = try await Task.detached { try CryptoAdapter().decrypt(ciphertext, key: key, representation: rep) }.value
    try check(access.context); try await membership(access); try check(access.context); return bytes
  }
  private func write(_ bytes: Data, name: String, access: NativeAlbumAccess) throws -> URL {
    try check(access.context)
    if directory == nil {
      let next = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-album-" + Wire.id())
      try FileManager.default.createDirectory(at: next, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
      directory = next
    }
    let url = directory!.appendingPathComponent(name)
    try bytes.write(to: url, options: [.atomic, .completeFileProtection]); return url
  }
  private func photo(_ entry: SignedPayloadV1, manifestSigned: SignedPayloadV1, access: NativeAlbumAccess) async throws -> NativeAlbumItem {
    let (manifest, key) = try crypto.photo(entry, manifestSigned: manifestSigned, definition: access.definition, key: access.key)
    let bytes = try await object(manifest.metadataRepresentation, key: key, access: access)
    let metadata = try NativeAlbumWire.decode(PhotoMetadataV1.self, bytes)
    guard metadata.version == 1, CameraMedia.supportedTypes.contains(metadata.mediaType),
      metadata.originalBytes > 0, metadata.originalBytes <= CameraMedia.maximumOriginalBytes,
      try Data(b64: metadata.originalSha256).count == 32,
      manifestSigned.kind == CameraMedia.manifestKind(for: metadata.mediaType),
      Set(metadata.representationKeys.keys) == Set(manifest.representations.map(\.binding.representationId)) else { throw FotoroError("Invalid album original metadata.") }
    for encoded in metadata.representationKeys.values { try NativeAlbumWire.bytes(encoded, 32) }
    // Contributions stay outside the owner's Saved catalog and annotation index.
    let photo = LocalPhoto(photoId: manifest.photoId, manifest: manifest, metadata: metadata, transferState: "album")
    return NativeAlbumItem(entry: entry, signedManifest: manifestSigned, photo: photo)
  }
  func open(_ id: String) async throws {
    clearOpen()
    let captured = try context()
    guard let value = albums.first(where: { $0.id == id }), value.overview.membership == "accepted", value.overview.endedAt == nil,
      let owner = captured.cards[value.definition.ownerAccountId] else { throw FotoroError("Accept the album invitation first.") }
    let (definition, key, _) = try crypto.open(value.overview.definition, expectedID: id, trustedOwner: owner,
      recipient: services.session.requireCard(captured.photo.account), bundle: services.vault.requireBundle(), trusted: captured.cards)
    let reading = NativeAlbumAccess(context: captured, albumID: id, signedDefinition: value.overview.definition, definition: definition, key: key)
    access = reading; opened = value
    do { try await loadPage(reading, cursor: nil) }
    catch { if access?.context == captured { clearOpen() }; throw error }
    do { try await loadMoreSharedDetails() }
    catch is CancellationError {
      if access?.context == captured { clearOpen() }
      throw CancellationError()
    }
    catch {
      if NativeDiagnosticOutcome.failure(for: error, taskCancelled: Task.isCancelled) == .cancelled {
        if access?.context == captured { clearOpen() }
        throw CancellationError()
      }
      try check(captured)
      factsError = error.localizedDescription
    }
  }
  func loadMore() async throws {
    guard let reading = access, let cursor = nextCursor else { return }
    try await loadPage(reading, cursor: cursor)
  }
  private func loadPage(_ reading: NativeAlbumAccess, cursor: String?) async throws {
    let captured = reading.context
    let path = "/v1/albums/\(reading.albumID)" + (cursor.map { "?cursor=" + $0 } ?? "")
    let detail = try await request(AlbumDetailV1.self, path: path, context: captured)
    try validate(detail, access: reading)
    var nextItems = items, seen = Set(items.map(\.id))
    // Four metadata reads at a time keeps the first page responsive and memory bounded.
    for offset in stride(from: 0, to: detail.entries.count, by: 4) {
      let end = min(offset + 4, detail.entries.count)
      let batch = try await withThrowingTaskGroup(of: (Int, NativeAlbumItem).self) { group in
        for i in offset..<end {
          let entry = detail.entries[i], manifest = detail.manifests[i]
          group.addTask { @MainActor in (i, try await self.photo(entry, manifestSigned: manifest, access: reading)) }
        }
        var values: [(Int, NativeAlbumItem)] = []
        for try await item in group { values.append(item) }
        return values.sorted { $0.0 < $1.0 }.map(\.1)
      }
      try check(captured)
      for item in batch {
        guard seen.insert(item.id).inserted, nextItems.count < 1000 else { throw FotoroError("Duplicate or oversized album.") }
        nextItems.append(item)
      }
    }
    try await membership(reading); try check(captured)
    var nextCursors = cursors
    if let cursor = detail.nextCursor { guard nextCursors.insert(cursor).inserted else { throw FotoroError("Invalid album pagination.") } }
    let nextFacts: [String: AlbumPhotoFactsContentV1]
    var invalidFacts: String?
    do { nextFacts = try boundSharedDetails(pendingFacts, for: nextItems) }
    catch { nextFacts = [:]; invalidFacts = error.localizedDescription }
    // A failed continuation must leave its cursor and verified page intact for retry.
    items = nextItems; cursors = nextCursors; nextCursor = detail.nextCursor; sharedFacts = nextFacts
    if let invalidFacts { pendingFacts = [:]; factsError = invalidFacts }
  }
  private func bindSharedDetails() throws {
    sharedFacts = try boundSharedDetails(pendingFacts)
  }
  private func boundSharedDetails(_ facts: [String: AlbumPhotoFactsContentV1], for candidateItems: [NativeAlbumItem]? = nil) throws -> [String: AlbumPhotoFactsContentV1] {
    var values: [String: AlbumPhotoFactsContentV1] = [:]
    for item in candidateItems ?? items {
      if let value = facts[item.id] { try NativeAlbumFacts.bind(value, to: item); values[item.id] = value }
    }
    return values
  }
  private func readFactsPage(_ reading: NativeAlbumAccess, cursor: String?, cursors: Set<String>,
    listed: Set<String>, values: [String: AlbumPhotoFactsContentV1]) async throws
    -> (values: [String: AlbumPhotoFactsContentV1], listed: Set<String>, cursor: String?) {
    let path = "/v1/albums/\(reading.albumID)/photo-facts" + (cursor.map { "?cursor=" + $0 } ?? "")
    let page = try await request(AlbumPhotoFactsPageV1.self, path: path, context: reading.context)
    guard page.version == 1, page.facts.count <= 100, page.hasMore == (page.nextCursor != nil),
      page.nextCursor.map({ $0.range(of: "^[1-9][0-9]{0,14}$", options: .regularExpression) != nil && !page.facts.isEmpty
        && (Int($0) ?? 0) > (Int(cursor ?? "0") ?? 0) && !cursors.contains($0) }) ?? true
    else { throw FotoroError("Invalid shared details pagination.") }
    var next = values, ids = listed
    for signed in page.facts {
      let value = try NativeAlbumFacts.readEnvelope(signed, access: reading)
      guard ids.insert(value.photoId).inserted, next[value.photoId] != nil || next.count < 1000
      else { throw FotoroError("Duplicate or oversized shared details.") }
      if let item = items.first(where: { $0.id == value.photoId }) { try NativeAlbumFacts.bind(value, to: item) }
      if (next[value.photoId]?.revision ?? 0) <= value.revision { next[value.photoId] = value }
    }
    return (next, ids, page.nextCursor)
  }
  func loadMoreSharedDetails() async throws {
    guard refreshingFacts == nil else { return }
    guard let reading = access else { throw FotoroError("Open an accepted album first.") }
    do {
      if factsSupported == nil {
        do {
          let capability = try await request(AlbumFactsCapabilitiesV1.self, path: "/v1/album-photo-facts/capabilities", context: reading.context)
          guard capability.version == 1, capability.albumFactsVersion == 1 else { throw FotoroError("Shared details need a newer Fotoro version.") }
          factsSupported = true
        } catch let error as FotoroError where [404, 501].contains(error.statusCode ?? 0) {
          try check(reading.context); factsSupported = false; factsError = nil; return
        }
      }
      guard factsSupported == true, !factsPageLoaded || factsNextCursor != nil else { return }
      try await membership(reading)
      let page = try await readFactsPage(reading, cursor: factsNextCursor, cursors: factsCursors,
        listed: factsListedIDs, values: pendingFacts)
      try await membership(reading); try check(reading.context)
      pendingFacts = page.values; factsPageLoaded = true; factsLoadedPages += 1; factsNextCursor = page.cursor
      factsListedIDs = page.listed
      if let cursor = page.cursor { factsCursors.insert(cursor) }
      try bindSharedDetails(); factsError = nil
    } catch {
      if isCurrent(reading.context) { factsError = error.localizedDescription }
      throw error
    }
  }
  // Refresh only the already loaded facts window; keep verified results until every
  // replacement page and the final membership check have succeeded.
  private func refreshSharedDetails() async throws {
    guard let reading = access, factsSupported == true, factsLoadedPages > 0, refreshingFacts == nil else { return }
    let refreshID = UUID()
    refreshingFacts = refreshID
    defer { if refreshingFacts == refreshID { refreshingFacts = nil } }
    let previous = pendingFacts, pageLimit = factsLoadedPages
    var replacement: [String: AlbumPhotoFactsContentV1] = [:]
    var listed = Set<String>(), seenCursors = Set<String>(), cursor: String?
    var loaded = 0
    do {
      try await membership(reading, preservingTransientFailure: true)
      for _ in 0..<pageLimit {
        let page = try await readFactsPage(reading, cursor: cursor, cursors: seenCursors, listed: listed, values: replacement)
        replacement = page.values; listed = page.listed; loaded += 1; cursor = page.cursor
        if let cursor { seenCursors.insert(cursor) } else { break }
      }
      try await membership(reading, preservingTransientFailure: true); try check(reading.context)
      // A confirmed local write that completed during these reads must survive.
      for (id, value) in pendingFacts where value.revision > (previous[id]?.revision ?? 0) {
        if value.revision > (replacement[id]?.revision ?? 0) { replacement[id] = value }
      }
      let bound = try boundSharedDetails(replacement)
      pendingFacts = replacement; sharedFacts = bound
      factsListedIDs = listed; factsCursors = seenCursors; factsNextCursor = cursor
      factsLoadedPages = loaded; factsPageLoaded = true; factsError = nil
    } catch {
      if isCurrent(reading.context) { factsError = error.localizedDescription }
      throw error
    }
  }
  func prepareSharedDetails(_ item: NativeAlbumItem) async throws -> NativeAlbumFactsReview {
    guard let reading = access, factsSupported == true,
      items.contains(where: { $0.id == item.id && $0.signedManifest == item.signedManifest && $0.entry == item.entry }),
      let source = try services.consumerSavedPhoto(item.id), source.manifest == item.photo.manifest,
      source.metadata == item.photo.metadata, source.manifest.ownerAccountId == reading.context.photo.account
    else { throw FotoroError("Only your current contributed Saved photo can share details.") }
    let annotation = services.annotation(source)
    guard annotation.photoId == source.id, annotation.originalSha256 == source.metadata.originalSha256 else { throw FotoroError("Photo details changed. Review the photo again.") }
    let reply = try await request(AlbumPhotoFactsReplyV1.self, path: "/v1/albums/\(reading.albumID)/photo-facts/\(item.id)", context: reading.context)
    guard reply.version == 1 else { throw FotoroError("Invalid shared photo details.") }
    let current = try reply.facts.map { try NativeAlbumFacts.read($0, item: item, access: reading) }
    try await membership(reading); try check(reading.context)
    let review = NativeAlbumFactsReview(item: item, context: reading.context, source: source, annotation: annotation,
      revision: current?.revision ?? 0,
      people: Dictionary(PhotoPeopleFacts.read(annotation.facts ?? [], originalSha256: source.metadata.originalSha256).map { (Data($0.n.utf8).b64, $0.n) },
        uniquingKeysWith: { first, _ in first }).values.sorted(),
      location: annotation.location, shared: current)
    try checkReview(review, reading: reading)
    if let current { pendingFacts[item.id] = current } else { pendingFacts.removeValue(forKey: item.id) }
    try bindSharedDetails()
    return review
  }
  private func checkReview(_ review: NativeAlbumFactsReview, reading: NativeAlbumAccess) throws {
    try check(review.context)
    guard reading.context == review.context, let current = try services.consumerSavedPhoto(review.item.id),
      current.manifest == review.source.manifest, current.metadata == review.source.metadata,
      services.annotation(current) == review.annotation else { throw FotoroError("Photo details changed. Review the photo again.") }
  }
  func shareDetails(_ review: NativeAlbumFactsReview, names: [String], includeLocation: Bool) async throws {
    guard let reading = access, Set(names.map { Data($0.utf8) }).isSubset(of: Set(review.people.map { Data($0.utf8) })) else { throw FotoroError("Choose only reviewed names from this photo.") }
    try checkReview(review, reading: reading); try await membership(reading); try checkReview(review, reading: reading)
    let signed = try NativeAlbumFacts.make(item: review.item, access: reading, people: names.sorted(),
      location: includeLocation ? review.location : nil, revision: review.revision + 1,
      card: services.session.requireCard(reading.context.photo.account), bundle: services.vault.requireBundle())
    do {
      let reply = try await request(AlbumPhotoFactsReplyV1.self, path: "/v1/albums/\(reading.albumID)/photo-facts/\(review.item.id)",
        context: reading.context, body: Wire.encode(AlbumPhotoFactsRequestV1(facts: signed)), method: "PUT")
      guard reply.version == 1, reply.facts == signed else { throw FotoroError("Shared details update binding failed.") }
      let current = try NativeAlbumFacts.read(signed, item: review.item, access: reading)
      try await membership(reading); try checkReview(review, reading: reading)
      pendingFacts[review.item.id] = current; try bindSharedDetails()
    } catch let error as FotoroError where error.statusCode == 409 {
      _ = try await prepareSharedDetails(review.item)
      throw FotoroError("Shared details changed. Refresh and review before updating.")
    }
  }
  func thumbnail(_ item: NativeAlbumItem) async throws -> URL? {
    guard let reading = access, items.contains(where: { $0.id == item.id && $0.entry == item.entry && $0.signedManifest == item.signedManifest }),
      let rep = item.photo.manifest.representations.first(where: { $0.binding.kind == "thumbnail" }),
      let encoded = item.photo.metadata.representationKeys[rep.binding.representationId] else { return nil }
    let bytes = try await object(rep, key: Data(b64: encoded), access: reading)
    return try write(bytes, name: item.id + "-thumbnail.jpg", access: reading)
  }
  func preview(_ item: NativeAlbumItem) async throws -> URL? {
    guard let reading = access, items.contains(where: { $0.id == item.id && $0.entry == item.entry && $0.signedManifest == item.signedManifest }) else { throw CancellationError() }
    try await membership(reading)
    if let rep = item.photo.manifest.representations.first(where: { $0.binding.kind == "preview" }), let encoded = item.photo.metadata.representationKeys[rep.binding.representationId] {
      let bytes = try await object(rep, key: Data(b64: encoded), access: reading)
      return try write(bytes, name: item.id + "-preview.jpg", access: reading)
    }
    return try await thumbnail(item)
  }
  func export(_ item: NativeAlbumItem) async throws -> [URL] {
    guard let reading = access, items.contains(where: { $0.id == item.id && $0.entry == item.entry && $0.signedManifest == item.signedManifest }),
      let rep = item.photo.manifest.representations.first(where: { $0.binding.kind == "original" }),
      let encoded = item.photo.metadata.representationKeys[rep.binding.representationId] else { throw CancellationError() }
    let bytes = try await object(rep, key: Data(b64: encoded), access: reading)
    guard bytes.count == item.photo.metadata.originalBytes, bytes.digest == item.photo.metadata.originalSha256 else { throw FotoroError("Album original verification failed.") }
    try await membership(reading)
    _ = try write(Data(), name: "export-marker", access: reading)
    let output = directory!.appendingPathComponent("original-" + Wire.id())
    let urls = try CameraMedia.exportOriginals(bytes, metadata: item.photo.metadata, directory: output)
    try check(reading.context); return urls
  }
  private func journalID(_ reading: NativeAlbumAccess) -> String {
    "albumappend-" + Data((reading.context.origin + "|" + reading.albumID).utf8).digest
  }
  var hasPendingAddition: Bool {
    guard let reading = access else { return false }
    return (try? services.store.existingOperation(journalID(reading), as: NativeAlbumPendingAppend.self)) != nil
  }
  private func selected(_ photos: [LocalPhoto], reading: NativeAlbumAccess) throws -> [LocalPhoto] {
    try check(reading.context)
    guard !photos.isEmpty, photos.count <= 1000, Set(photos.map(\.id)).count == photos.count else { throw FotoroError("Choose 1–1000 Saved photos.") }
    return try photos.map { photo in
      guard let fresh = try services.consumerSavedPhoto(photo.id), fresh.manifest == photo.manifest, fresh.metadata == photo.metadata,
        fresh.manifest.ownerAccountId == reading.context.photo.account, ["saved", "committed"].contains(fresh.transferState) else { throw FotoroError("A selected Saved photo changed. Select it again.") }
      return fresh
    }
  }
  private func existing(_ photos: [LocalPhoto], reading: NativeAlbumAccess) async throws -> Set<String> {
    let wanted = Dictionary(uniqueKeysWithValues: photos.map { ($0.id, $0) })
    var found = Set<String>(), seen = Set<String>(), cursor: String?, pages = 0
    repeat {
      pages += 1; guard pages <= 11 else { throw FotoroError("Invalid album pagination.") }
      let detail = try await request(AlbumDetailV1.self, path: "/v1/albums/\(reading.albumID)" + (cursor.map { "?cursor=" + $0 } ?? ""), context: reading.context)
      try validate(detail, access: reading)
      for (entry, signed) in zip(detail.entries, detail.manifests) {
        let (manifest, key) = try crypto.photo(entry, manifestSigned: signed, definition: reading.definition, key: reading.key)
        if let own = wanted[manifest.photoId] {
          guard manifest == own.manifest, key == (try services.crypto.unwrap(own.manifest.ownerWrappedMetadataKey, key: Data(b64: services.vault.requireBundle().vaultKey))) else { throw FotoroError("An existing album original changed.") }
          found.insert(own.id)
        }
      }
      cursor = detail.nextCursor
      if let cursor { guard seen.insert(cursor).inserted else { throw FotoroError("Invalid album pagination.") } }
    } while cursor != nil && found.count < wanted.count
    return found
  }
  private func send(_ pending: NativeAlbumPendingAppend, reading: NativeAlbumAccess) async throws {
    guard pending.version == 1, pending.origin == reading.context.origin, pending.accountId == reading.context.photo.account,
      pending.albumId == reading.albumID, pending.definition == reading.signedDefinition else { throw FotoroError("Pending album addition belongs to another context.") }
    guard NativeAlbumWire.uuid(pending.request.operationId), pending.request.version == 1,
      (1...100).contains(pending.request.entries.count), pending.request.entries.count == pending.request.manifests.count else { throw FotoroError("Invalid pending album addition.") }
    try await membership(reading)
    // Recheck each source before retrying the exact signed bytes after a lost response.
    for (entry, signed) in zip(pending.request.entries, pending.request.manifests) {
      let (manifest, _) = try crypto.photo(entry, manifestSigned: signed, definition: reading.definition, key: reading.key)
      guard let current = try services.consumerSavedPhoto(manifest.photoId), current.manifest == manifest else { throw FotoroError("A pending Saved photo changed. Its album addition cannot be retried.") }
    }
    let result = try await request(AlbumAppendResultV1.self, path: "/v1/albums/\(reading.albumID)/photos", context: reading.context, body: Wire.encode(pending.request))
    guard result.version == 1, result.albumId == reading.albumID, result.operationId == pending.request.operationId,
      (0...pending.request.entries.count).contains(result.added), (0...1000).contains(result.photoCount) else { throw FotoroError("Album contribution binding failed.") }
    try await membership(reading); try check(reading.context)
    let completedID = journalID(reading)
    try await services.store.database.write { db in try db.execute(sql: "DELETE FROM operations WHERE id=?", arguments: [completedID]) }
    try await refresh(); try await open(reading.albumID)
  }
  func retryAddition() async throws {
    guard let reading = access, let pending = try services.store.existingOperation(journalID(reading), as: NativeAlbumPendingAppend.self) else { return }
    try await send(pending, reading: reading)
  }
  func append(_ photos: [LocalPhoto]) async throws {
    guard let reading = access else { throw FotoroError("Open an accepted album first.") }
    let current = try selected(photos, reading: reading), original = reading.context
    for offset in stride(from: 0, to: current.count, by: 100) {
      let now = try context()
      guard now.photo == original.photo, now.origin == original.origin, now.apiOrigin == original.apiOrigin,
        now.cards == original.cards, now.token == original.token, now.fixture == original.fixture else { throw CancellationError() }
      try await appendBatch(Array(current[offset..<min(offset + 100, current.count)]))
    }
  }
  private func appendBatch(_ photos: [LocalPhoto]) async throws {
    guard let reading = access else { throw FotoroError("Open an accepted album first.") }
    if try services.store.existingOperation(journalID(reading), as: NativeAlbumPendingAppend.self) != nil {
      throw FotoroError("Retry the previous addition before choosing more photos.")
    }
    try await membership(reading)
    let current = try selected(photos, reading: reading), already = try await existing(current, reading: reading)
    _ = try selected(current, reading: reading)
    let missing = current.filter { !already.contains($0.id) }
    guard !missing.isEmpty else { return }
    let captured = reading.context, card = try services.session.requireCard(captured.photo.account), bundle = try services.vault.requireBundle()
    var pairs: [(SignedPayloadV1, SignedPayloadV1)] = []
    for photo in missing {
      // Reuse the server's original signed bytes; a browser-created body can have a different JSON key order.
      let original = try await request(SignedPayloadV1.self, path: "/v1/photos/\(photo.id)/manifest", context: captured)
      let manifest = try NativeAlbumWire.decode(PhotoManifestV1.self, services.crypto.verify(original, card: card, kind: CameraMedia.acceptedManifestKind(original)))
      guard manifest == photo.manifest else { throw FotoroError("Saved source changed before album addition.") }
      _ = try selected([photo], reading: reading)
      let pair = try crypto.append(photo, definition: reading.definition, albumKey: reading.key, card: card, bundle: bundle)
      pairs.append((pair.0, original))
    }
    _ = try selected(current, reading: reading)
    let pending = try services.store.operation(journalID(reading)) {
      NativeAlbumPendingAppend(origin: captured.origin, accountId: captured.photo.account, albumId: reading.albumID,
        definition: reading.signedDefinition, request: AlbumAppendV1(operationId: Wire.id(), entries: pairs.map(\.0), manifests: pairs.map(\.1)))
    }
    try await send(pending, reading: reading)
  }
}
