import XCTest
@testable import Fotoro

final class NativeAlbumTests: XCTestCase {
  func testSharedDetailsSelectionPreservesOnlyExistingCurrentDetails() {
    let location = PhotoLocationV1(latitude: 1.3, longitude: 103.8, source: "photos", name: "Singapore", accuracyMeters: 5)
    let newShare = NativeAlbumFactsSelection(people: ["Mom", "Dad"], location: location, shared: nil)
    XCTAssertTrue(newShare.people.isEmpty); XCTAssertFalse(newShare.includeLocation)
    XCTAssertFalse(newShare.unavailableSharedDetails)
    let shared = AlbumPhotoFactsContentV1(albumId: Wire.id(), photoId: Wire.id(), ownerAccountId: Wire.id(),
      definitionSignature: "test", revision: 1, originalSha256: "test", people: ["Mom"], location: location)
    let reopened = NativeAlbumFactsSelection(people: ["Mom", "Dad"], location: location, shared: shared)
    XCTAssertEqual(reopened.people, ["Mom"], "Unshared names must never gain consent when reopening")
    XCTAssertTrue(reopened.includeLocation); XCTAssertFalse(reopened.unavailableSharedDetails)
    let corrected = NativeAlbumFactsSelection(people: ["Mum", "Dad"], location: nil, shared: shared)
    XCTAssertTrue(corrected.people.isEmpty); XCTAssertFalse(corrected.includeLocation)
    XCTAssertTrue(corrected.unavailableSharedDetails)
    for field in ["latitude", "longitude", "source", "name", "accuracy"] {
      var changed = location
      switch field {
      case "latitude": changed.latitude = 1.4
      case "longitude": changed.longitude = 103.9
      case "source": changed.source = "exif"
      case "name": changed.name = "Another place"
      default: changed.accuracyMeters = 6
      }
      let selection = NativeAlbumFactsSelection(people: ["Mom"], location: changed, shared: shared)
      XCTAssertFalse(selection.includeLocation, field + " must require a new explicit choice")
      XCTAssertTrue(selection.unavailableSharedDetails, field)
    }
    var composed = shared; composed.people = ["\u{00e9}"]
    let renamed = NativeAlbumFactsSelection(people: ["e\u{0301}"], location: location, shared: composed)
    XCTAssertTrue(renamed.people.isEmpty, "Shared labels retain their exact UTF-8 identity")
    XCTAssertTrue(renamed.unavailableSharedDetails)
  }
  @MainActor func testTripPreviewsReuseVerifiedFilesAndRecheckMembershipWithoutReadingOriginals() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      let thumbnail = try await model.thumbnail(item), preview = try await model.preview(item)
      let reads = server.objectReads, accessReads = server.accessReads
      let repeatedThumbnail = try await model.thumbnail(item), repeatedPreview = try await model.preview(item)
      XCTAssertEqual(repeatedThumbnail, thumbnail); XCTAssertEqual(repeatedPreview, preview)
      XCTAssertEqual(server.objectReads, reads); XCTAssertEqual(server.originalReads, 0)
      XCTAssertGreaterThan(server.accessReads, accessReads)
      server.accessStatus = 503
      do { _ = try await model.thumbnail(item, preservingTransientFailure: true); XCTFail("Unavailable membership must not publish a cached thumbnail") } catch {}
      XCTAssertNotNil(model.opened, "Transient review failure keeps the trip retryable")
      server.accessStatus = 403
      do { _ = try await model.thumbnail(item, preservingTransientFailure: true); XCTFail("Revoked access must reject cached media") } catch {}
      XCTAssertNil(model.opened); XCTAssertNil(model.directory)
    }
  }
  func testTripPickScopeFiltersMotionAndDuplicatesBeforeBoundingUniqueImages() throws {
    let server = try AlbumTestServer()
    func item(_ index: Int, type: String = "image/jpeg", digest: String? = nil) -> NativeAlbumItem {
      var photo = server.source
      photo.photoId = "scope-\(index)"; photo.manifest.photoId = photo.id
      photo.metadata.originalSha256 = digest ?? Data("unique-\(index)".utf8).digest
      photo.metadata.mediaType = type
      return NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: photo)
    }
    let images = (0..<205).map { item($0) }
    let videos = (205..<410).map { item($0, type: "video/quicktime") }
    let duplicate = item(411, digest: images[0].photo.metadata.originalSha256)
    let chosen = NativeTripPickScope.items(videos + [duplicate] + images)
    XCTAssertEqual(chosen.count, 200)
    XCTAssertEqual(chosen.first?.id, duplicate.id)
    XCTAssertFalse(chosen.contains { $0.id == images[0].id })
    XCTAssertEqual(chosen.last?.id, images[199].id)
    XCTAssertTrue(chosen.allSatisfy { $0.photo.metadata.mediaType == "image/jpeg" })
    XCTAssertEqual(NativeTripPickScope.items([item(500, type: CameraMedia.liveType)]).count, 1)
  }
  func testTripPickCandidateUsesOnlyGenuineCaptureDateAndAuthenticatedSourceRevision() throws {
    let server = try AlbumTestServer()
    let date = "2026-01-20T12:00:00.000Z"
    for provenance in ["photos", "exif", "import"] {
      var photo = server.source
      photo.metadata.sourceDate = date; photo.metadata.dateSource = provenance
      let item = NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: photo)
      let candidate = NativeTripPickScope.candidate(item, width: 256, height: 180)
      XCTAssertEqual(candidate.sourceRevision, server.manifest.signature)
      XCTAssertEqual(candidate.id, item.id)
      XCTAssertEqual(candidate.capturedAt, provenance == "import" ? nil : Wire.parseDate(date))
      XCTAssertEqual(candidate.width, 256); XCTAssertEqual(candidate.height, 180)
      XCTAssertFalse(candidate.favorite); XCTAssertFalse(candidate.isScreenshot)
      var revisedManifest = server.manifest; revisedManifest.signature = "changed-authenticated-revision"
      let revised = NativeAlbumItem(entry: server.entry, signedManifest: revisedManifest, photo: photo)
      XCTAssertNotEqual(NativeTripPickScope.candidate(revised).sourceRevision, candidate.sourceRevision)
    }
  }
  func testDeviceTripSelectionRequiresBoundedExplicitDistinctRevisions() throws {
    let one = RecentPhotoSource(id: "chosen", revision: "reviewed")
    XCTAssertNoThrow(try NativeAlbumDeviceSelection.validate([one]))
    XCTAssertThrowsError(try NativeAlbumDeviceSelection.validate([]))
    XCTAssertThrowsError(try NativeAlbumDeviceSelection.validate([one, one]))
    XCTAssertThrowsError(try NativeAlbumDeviceSelection.validate([RecentPhotoSource(id: "chosen", revision: "")]))
    XCTAssertThrowsError(try NativeAlbumDeviceSelection.validate((0...100).map { RecentPhotoSource(id: "\($0)", revision: "r") }))
  }
  func testDeviceTripSelectionResolvesOnlyCompleteCurrentCommittedOriginalsAndDedupes() throws {
    let server = try AlbumTestServer(), photo = server.source
    let sources = [RecentPhotoSource(id: "first", revision: "r1"), RecentPhotoSource(id: "second", revision: "r2")]
    var current = sources.map { BackupSource(id: $0.id, photoId: photo.id, phase: .committed,
      sourceRevision: $0.revision, originalSha256: photo.metadata.originalSha256) }
    func resolve(_ available: Bool = true) throws -> [LocalPhoto] {
      try NativeAlbumDeviceSelection.resolve(sources, lookupSource: { id in current.first { $0.id == id } },
        lookupPhoto: { _ in photo }, sourceCurrent: { _ in available })
    }
    XCTAssertEqual(try resolve().map(\.id), [photo.id])
    XCTAssertThrowsError(try resolve(false))
    current[1].phase = .queued
    XCTAssertThrowsError(try resolve())
    current[1].phase = .committed; current[1].sourceRevision = "changed"
    XCTAssertThrowsError(try resolve())
    current[1].sourceRevision = "r2"; current[1].originalSha256 = Data("wrong original".utf8).digest
    XCTAssertThrowsError(try resolve())
    current.removeLast()
    XCTAssertThrowsError(try resolve())
  }
  func testSharedAlbumFactsAuthenticateContributorContextAndOriginalWithoutPrivateFields() throws {
    let server = try AlbumTestServer(), access = try factsAccess(server)
    let item = NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: server.source)
    let location = PhotoLocationV1(latitude: 1.3, longitude: 103.8, source: "photos", name: "Singapore")
    let signed = try NativeAlbumFacts.make(item: item, access: access, people: ["Mom", "Dad"], location: location,
      revision: 1, card: server.cards[0], bundle: server.bundles[0])
    let value = try NativeAlbumFacts.read(signed, item: item, access: access)
    XCTAssertEqual(value.people, ["Mom", "Dad"]); XCTAssertEqual(value.location, location)
    XCTAssertEqual(value.originalSha256, item.photo.metadata.originalSha256)
    let outer = try NativeAlbumWire.signedBody(AlbumPhotoFactsV1.self, signed, kind: NativeAlbumFacts.kind)
    let plain = try CryptoAdapter().unwrap(outer.encrypted, key: access.key)
    let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any]).keys
    XCTAssertEqual(Set(keys), ["version", "albumId", "photoId", "ownerAccountId", "definitionSignature", "revision", "originalSha256", "people", "location"])
    XCTAssertFalse(String(decoding: try Data(b64: signed.body), as: UTF8.self).contains("Mom"))
    var other = item.photo; other.metadata.originalSha256 = Data("another original".utf8).digest
    XCTAssertThrowsError(try NativeAlbumFacts.read(signed, item: NativeAlbumItem(entry: item.entry, signedManifest: item.signedManifest, photo: other), access: access))
    var forged = signed; forged.accountId = server.cards[1].accountId
    XCTAssertThrowsError(try NativeAlbumFacts.read(forged, item: item, access: access))
    XCTAssertThrowsError(try NativeAlbumFacts.make(item: item, access: access, people: ["Mom"], location: nil, revision: 1, card: server.cards[1], bundle: server.bundles[1]))
    XCTAssertThrowsError(try NativeAlbumFacts.make(item: item, access: access, people: ["Mom"], location: nil, revision: 1, card: server.cards[0], bundle: server.bundles[1]))
    let distinctSpellings = ["\u{e9}", "e\u{301}"]
    let exact = try NativeAlbumFacts.make(item: item, access: access, people: distinctSpellings, location: nil,
      revision: 2, card: server.cards[0], bundle: server.bundles[0])
    let exactFacts = try NativeAlbumFacts.read(exact, item: item, access: access)
    XCTAssertEqual(exactFacts.people.map { Data($0.utf8) }, distinctSpellings.map { Data($0.utf8) })
    XCTAssertEqual(NativeAlbumSearch.choices(items: [item], facts: [item.id: exactFacts]).count, 2)
  }
  func testSharedAlbumFactsRejectUnknownDuplicateAndChangedEncryptedContext() throws {
    let server = try AlbumTestServer(), access = try factsAccess(server)
    let item = NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: server.source)
    let signed = try NativeAlbumFacts.make(item: item, access: access, people: ["Mom"], location: nil,
      revision: 1, card: server.cards[0], bundle: server.bundles[0])
    let crypto = CryptoAdapter()
    let outer = try NativeAlbumWire.signedBody(AlbumPhotoFactsV1.self, signed, kind: NativeAlbumFacts.kind)
    let plain = try crypto.unwrap(outer.encrypted, key: access.key)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any])
    for change in ["caption", "revision", "albumId", "photoId", "definitionSignature"] {
      var altered = object
      if change == "revision" { altered[change] = 2 }
      else { altered[change] = change == "definitionSignature" ? Data(repeating: 0, count: 64).b64 : Wire.id() }
      var envelope = outer; envelope.encrypted = try crypto.wrap(JSONSerialization.data(withJSONObject: altered), key: access.key)
      let forged = try crypto.sign(envelope, kind: NativeAlbumFacts.kind, accountId: server.cards[0].accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
      XCTAssertThrowsError(try NativeAlbumFacts.read(forged, item: item, access: access), change)
    }
    let duplicate = Data((String(decoding: plain, as: UTF8.self).dropLast() + ",\"people\":[]}").utf8)
    var envelope = outer; envelope.encrypted = try crypto.wrap(duplicate, key: access.key)
    let forged = try crypto.sign(envelope, kind: NativeAlbumFacts.kind, accountId: server.cards[0].accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
    XCTAssertThrowsError(try NativeAlbumFacts.read(forged, item: item, access: access))
    object["people"] = ["Mom", "Mom"]
    XCTAssertThrowsError(try NativeAlbumFacts.validate(NativeAlbumWire.decode(AlbumPhotoFactsContentV1.self, JSONSerialization.data(withJSONObject: object))))
  }
  func testFamilyAlbumSearchIntersectsContributorNamesPlaceAndGenuineCaptureRangeBeforeGrouping() throws {
    let server = try AlbumTestServer(), access = try factsAccess(server)
    var photo = server.source; photo.metadata.sourceDate = "2026-01-20T12:00:00.000Z"; photo.metadata.dateSource = "photos"
    let item = NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: photo)
    let facts = AlbumPhotoFactsContentV1(albumId: access.albumID, photoId: item.id, ownerAccountId: photo.manifest.ownerAccountId,
      definitionSignature: access.signedDefinition.signature, revision: 1, originalSha256: photo.metadata.originalSha256,
      people: ["Mom", "Dad"], location: PhotoLocationV1(latitude: 1.3, longitude: 103.8, source: "photos", name: "Singapore"))
    let mom = NativeAlbumPersonChoice(contributor: photo.manifest.ownerAccountId, name: "Mom")
    let dad = NativeAlbumPersonChoice(contributor: photo.manifest.ownerAccountId, name: "Dad")
    var filter = NativeAlbumSearchFilter(query: "from 2026-01-01 through 2026-01-31", place: "Singapore", people: [mom.id, dad.id], match: .everyone)
    XCTAssertTrue(filter.includes(item, facts: facts))
    filter.query = "Mom Singapore 2026"; XCTAssertTrue(filter.includes(item, facts: facts), "Explicit shared evidence can match across fields of the same photo")
    filter.query = "from 2026-01-01 through 2026-01-31"
    var incomplete = facts; incomplete.people = ["Mom"]
    XCTAssertFalse(filter.includes(item, facts: incomplete))
    filter.match = .any; XCTAssertTrue(filter.includes(item, facts: incomplete))
    filter.place = "Paris"; XCTAssertFalse(filter.includes(item, facts: facts))
    filter.place = "Singapore"; var imported = photo; imported.metadata.dateSource = "import"
    XCTAssertFalse(filter.includes(NativeAlbumItem(entry: item.entry, signedManifest: item.signedManifest, photo: imported), facts: facts))
    filter.query = "2026-02"; XCTAssertFalse(filter.includes(item, facts: facts))
    filter.query = "2026-01"; filter.match = .everyone
    var copy = photo; copy.photoId = Wire.id(); copy.manifest.photoId = copy.id; copy.manifest.ownerAccountId = server.cards[1].accountId
    let other = NativeAlbumItem(entry: item.entry, signedManifest: item.signedManifest, photo: copy)
    var otherFacts = facts; otherFacts.people = ["Dad"]; otherFacts.ownerAccountId = copy.manifest.ownerAccountId; otherFacts.photoId = copy.id
    let matching = [item, other].filter { filter.includes($0, facts: $0.id == item.id ? incomplete : otherFacts) }
    XCTAssertTrue(NativeAlbumSearch.groups(matching).isEmpty, "Separate copies cannot combine names to satisfy Everyone")
    let choices = NativeAlbumSearch.choices(items: [item, other], facts: [item.id: facts, other.id: otherFacts])
    XCTAssertEqual(choices.filter { $0.name == "Dad" }.count, 2, "Same-name labels remain contributor-scoped")
  }
  func testExactAlbumDuplicateGroupsRetainEveryCopyAndRespectBytesAndMediaType() throws {
    let server = try AlbumTestServer()
    let first = NativeAlbumItem(entry: server.entry, signedManifest: server.manifest, photo: server.source)
    var duplicate = server.source; duplicate.photoId = Wire.id(); duplicate.manifest.photoId = duplicate.id; duplicate.manifest.ownerAccountId = server.cards[1].accountId
    let second = NativeAlbumItem(entry: first.entry, signedManifest: first.signedManifest, photo: duplicate)
    var changed = duplicate; changed.photoId = Wire.id(); changed.metadata.originalBytes += 1
    var motion = duplicate; motion.photoId = Wire.id(); motion.metadata.mediaType = "video/mp4"
    let groups = NativeAlbumSearch.groups([first, second, NativeAlbumItem(entry: first.entry, signedManifest: first.signedManifest, photo: changed), NativeAlbumItem(entry: first.entry, signedManifest: first.signedManifest, photo: motion)])
    XCTAssertEqual(groups.count, 3); XCTAssertEqual(groups[0].copies.map(\.id), [first.id, second.id])
    XCTAssertEqual(Set(groups[0].copies.map { $0.photo.manifest.ownerAccountId }), Set(server.cards.map(\.accountId)))
  }
  @MainActor func testOptionalSharedDetailsFallbackAndRetryPreserveOriginalAlbums() async throws {
    for status in [404, 501, 503] {
      try await withAlbum { _, server, model in
        server.factsCapabilityStatus = status
        try await model.refresh(); try await model.open(server.definition.albumId)
        XCTAssertEqual(model.items.count, 1)
        XCTAssertTrue(model.sharedFacts.isEmpty)
        XCTAssertEqual(server.factsPageReads, 0)
        if status == 503 {
          XCTAssertNotNil(model.factsError); XCTAssertNil(model.factsSupported)
          server.factsCapabilityStatus = 200
          try server.setFacts(server.source, people: ["Mom"])
          try await model.loadMoreSharedDetails()
          XCTAssertEqual(model.sharedFacts[server.source.id]?.people, ["Mom"])
        } else { XCTAssertEqual(model.factsSupported, false); XCTAssertNil(model.factsError) }
      }
    }
  }
  @MainActor func testPagedSharedDetailsDeferUnloadedSourcesAndPreservePageBounds() async throws {
    try await withAlbum { _, server, model in
      server.factsCapabilityStatus = 200
      let extras = try server.extraOwnedPhotos(count: 101)
      try server.contribute(extras)
      for photo in extras { try server.setFacts(photo, people: ["Reviewed name"]) }
      try await model.refresh(); try await model.open(server.definition.albumId)
      XCTAssertEqual(model.items.count, 100)
      XCTAssertEqual(model.sharedFacts.count, 99, "Unmatched facts remain unpublished until their own photo loads")
      XCTAssertEqual(server.factsPageReads, 1)
      XCTAssertNotNil(model.factsNextCursor)
      try await model.loadMore()
      XCTAssertEqual(model.items.count, 102); XCTAssertEqual(model.sharedFacts.count, 100)
      XCTAssertNil(model.sharedFacts[extras.last!.id])
      try await model.loadMoreSharedDetails()
      XCTAssertEqual(model.sharedFacts.count, 101); XCTAssertNil(model.factsNextCursor)
      XCTAssertEqual(server.factsPageReads, 2)
      XCTAssertEqual(server.factsIndividualReads, 0, "Browsing uses pages, not one request per photo")
    }
  }
  @MainActor func testWholeTripSearchFindsLaterPhotoAndDetailsPagesWithoutOriginals() async throws {
    try await withAlbum { _, server, model in
      server.factsCapabilityStatus = 200
      let early = try server.extraOwnedPhotos(count: 99)
      let late = try server.extraOwnedPhotos(count: 2, filename: "later-match.jpg", sourceDate: "2026-01-15T12:00:00.000Z", dateSource: "exif")
      try server.contribute(early + late)
      for photo in early { try server.setFacts(photo, people: ["Earlier name"]) }
      for photo in late { try server.setFacts(photo, people: ["Later name"]) }
      try await model.refresh(); try await model.open(server.definition.albumId)
      let id = model.searchCoverageID
      var filter = NativeAlbumSearchFilter(query: "later-match from 2026-01-01 through 2026-01-31")
      let person = NativeAlbumPersonChoice(contributor: late[0].manifest.ownerAccountId, name: "Later name")
      filter.people = [person.id]
      XCTAssertTrue(model.items.filter { filter.includes($0, facts: model.sharedFacts[$0.id]) }.isEmpty)
      XCTAssertFalse(model.searchMetadataComplete)
      try await model.loadNextSearchMetadataPage(expectedID: id)
      XCTAssertFalse(model.searchMetadataComplete, "Photo completion alone cannot complete shared-name search")
      try await model.loadNextSearchMetadataPage(expectedID: id)
      XCTAssertTrue(model.searchMetadataComplete)
      XCTAssertEqual(Set(model.items.filter { filter.includes($0, facts: model.sharedFacts[$0.id]) }.map(\.id)), Set(late.map(\.id)))
      XCTAssertTrue(NativeAlbumSearch.choices(items: model.items, facts: model.sharedFacts).contains(person))
      XCTAssertEqual(server.factsPageReads, 2); XCTAssertEqual(server.factsIndividualReads, 0)
      XCTAssertEqual(server.originalReads, 0)
    }
  }
  @MainActor func testWholeTripSearchFailurePreservesVerifiedPageAndRequiresExplicitRetry() async throws {
    try await withAlbum { _, server, model in
      let photos = try server.extraOwnedPhotos(count: 101)
      try server.contribute(photos); try await model.refresh(); try await model.open(server.definition.albumId)
      let id = model.searchCoverageID, loaded = model.items.map(\.id)
      server.failObjectOnce = photos[100].manifest.metadataRepresentation.objectId
      do { try await model.loadNextSearchMetadataPage(expectedID: id); XCTFail("Failed metadata page completed") } catch {}
      XCTAssertEqual(model.searchCoverageID, id); XCTAssertEqual(model.items.map(\.id), loaded)
      XCTAssertNotNil(model.nextCursor); XCTAssertFalse(model.searchMetadataComplete)
      try await model.loadNextSearchMetadataPage(expectedID: id)
      XCTAssertEqual(model.items.count, 102); XCTAssertTrue(model.searchMetadataComplete)
      XCTAssertEqual(server.originalReads, 0)
    }
  }
  @MainActor func testWholeTripSearchRetryRevalidatesPreviouslyCompletedFactsWindow() async throws {
    try await withAlbum { _, server, model in
      server.factsCapabilityStatus = 200
      try server.setFacts(server.source, people: ["Before refresh"])
      try await model.refresh(); try await model.open(server.definition.albumId)
      XCTAssertTrue(model.searchMetadataComplete)
      let id = model.searchCoverageID
      server.accessStatus = 503
      do { try await model.refresh(); XCTFail("Transient refresh succeeded") } catch {}
      XCTAssertNotNil(model.factsError); XCTAssertNil(model.factsNextCursor)
      XCTAssertFalse(model.searchMetadataComplete)
      XCTAssertEqual(model.sharedFacts[server.source.id]?.people, ["Before refresh"])
      server.accessStatus = nil
      try server.setFacts(server.source, people: ["After refresh"])
      let reads = server.factsPageReads
      try await model.loadNextSearchMetadataPage(expectedID: id)
      XCTAssertGreaterThan(server.factsPageReads, reads, "Retry must read the completed facts window again")
      XCTAssertEqual(model.sharedFacts[server.source.id]?.people, ["After refresh"])
      XCTAssertNil(model.factsError); XCTAssertTrue(model.searchMetadataComplete)
      XCTAssertEqual(model.searchCoverageID, id); XCTAssertEqual(server.originalReads, 0)
    }
  }
  @MainActor func testCancelledHeldMembershipPreservesTripAndVerifiedPages() async throws {
    for transportCancellation in [false, true] {
      try await withAlbum { _, server, model in
        server.factsCapabilityStatus = 200
        try server.setFacts(server.source, people: ["Reviewed name"])
        try await model.refresh(); try await model.open(server.definition.albumId)
        let id = model.searchCoverageID, items = model.items.map(\.id), facts = model.sharedFacts
        let gate = AlbumFactsRequestGate(started: expectation(description: "Held membership"))
        defer { gate.release.signal() }
        server.accessGate = gate
        let checking = Task { try await model.checkOpenedAccess() }
        await fulfillment(of: [gate.started], timeout: 3)
        if transportCancellation { server.accessStatus = -999 }
        else { checking.cancel() }
        gate.release.signal()
        do { try await checking.value; XCTFail("Cancelled membership succeeded") } catch is CancellationError {} catch { XCTFail("Unexpected cancellation error: \(error)") }
        XCTAssertNotNil(model.opened); XCTAssertEqual(model.searchCoverageID, id)
        XCTAssertEqual(model.items.map(\.id), items); XCTAssertEqual(model.sharedFacts, facts)
        XCTAssertNil(model.factsError)
        server.accessStatus = 403
        do { try await model.checkOpenedAccess(); XCTFail("Denied membership succeeded") } catch {}
        XCTAssertNil(model.opened); XCTAssertTrue(model.items.isEmpty); XCTAssertTrue(model.sharedFacts.isEmpty)
      }
    }
  }
  @MainActor func testWholeTripSearchRejectsLateFactsAfterCancellationOrScopeChange() async throws {
    for change in ["cancel", "close", "reopen", "lock", "account"] {
      let gate = AlbumFactsRequestGate(started: expectation(description: "Search facts " + change))
      defer { gate.release.signal() }
      try await withAlbum { services, server, model in
        server.factsCapabilityStatus = 200
        let photos = try server.extraOwnedPhotos(count: 101)
        try server.contribute(photos)
        for photo in photos { try server.setFacts(photo, people: ["Reviewed name"]) }
        try await model.refresh(); try await model.open(server.definition.albumId)
        let id = model.searchCoverageID
        try await model.loadNextSearchMetadataPage(expectedID: id)
        let prior = model.sharedFacts
        server.factsGate = gate
        let search = Task { try await model.loadNextSearchMetadataPage(expectedID: id) }
        await fulfillment(of: [gate.started], timeout: 3)
        if change == "cancel" { search.cancel() }
        else if change == "close" || change == "reopen" { model.discardOpenedAlbum() }
        else if change == "lock" { services.vault.lock() }
        else { services.session.accountId = server.cards[0].accountId }
        gate.release.signal()
        do { try await search.value; XCTFail("Late search survived " + change) } catch {}
        if change == "cancel" { XCTAssertEqual(model.sharedFacts, prior); XCTAssertNil(model.factsError) }
        else { XCTAssertTrue(model.sharedFacts.isEmpty) }
        if change == "reopen" {
          try await model.open(server.definition.albumId)
          let reopened = model.items.map(\.id)
          do { try await model.loadNextSearchMetadataPage(expectedID: id); XCTFail("Old coverage reopened") } catch {}
          XCTAssertEqual(model.items.map(\.id), reopened)
        }
      }
    }
  }
  @MainActor func testSameCountSharedDetailsRefreshHandlesEditsAndTransientAccessFailures() async throws {
    try await withAlbum { _, server, model in
      server.factsCapabilityStatus = 200
      try server.setFacts(server.source, people: ["Mom"])
      try await model.refresh(); try await model.open(server.definition.albumId)
      let objectReads = server.objectReads
      for people in [["Dad"], [], ["Mom"]] {
        try server.setFacts(server.source, people: people); try await model.refresh()
        XCTAssertEqual(model.sharedFacts[server.source.id]?.people, people)
        XCTAssertEqual(model.items.count, 1)
      }
      XCTAssertEqual(server.objectReads, objectReads, "Metadata refresh cannot fetch media")
      for status in [0, 408, 429, 503] {
        server.accessStatus = status
        do { try await model.refresh(); XCTFail("Failed access refresh reported success") } catch {}
        XCTAssertEqual(model.sharedFacts[server.source.id]?.people, ["Mom"])
        XCTAssertEqual(model.items.count, 1); XCTAssertNotNil(model.opened)
      }
      server.accessStatus = 403
      do { try await model.refresh(); XCTFail("Denied access refresh reported success") } catch {}
      XCTAssertTrue(model.sharedFacts.isEmpty); XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.opened)
    }
  }
  @MainActor func testLateMetadataFailureKeepsAlbumPageAndFactsRetryable() async throws {
    try await withAlbum { _, server, model in
      server.factsCapabilityStatus = 200
      let extras = try server.extraOwnedPhotos(count: 108)
      try server.contribute(extras)
      for photo in extras { try server.setFacts(photo, people: ["Reviewed name"]) }
      try await model.refresh(); try await model.open(server.definition.albumId)
      try await model.loadMoreSharedDetails()
      let firstPageIDs = model.items.map(\.id), firstPageFacts = model.sharedFacts
      let cursor = try XCTUnwrap(model.nextCursor)
      XCTAssertEqual(firstPageIDs.count, 100)
      XCTAssertEqual(firstPageFacts.count, 99)

      // The first four metadata reads in the continuation succeed before this failure.
      server.failObjectOnce = extras[103].manifest.metadataRepresentation.objectId
      do { try await model.loadMore(); XCTFail("An incomplete page reported success") }
      catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
      XCTAssertEqual(model.items.map(\.id), firstPageIDs, "A failed page cannot publish partial contributions")
      XCTAssertEqual(model.sharedFacts, firstPageFacts)
      XCTAssertEqual(model.nextCursor, cursor)
      XCTAssertNotNil(model.opened)

      try await model.loadMore()
      XCTAssertEqual(model.items.count, 109)
      XCTAssertEqual(Set(model.items.map(\.id)).count, 109)
      XCTAssertEqual(model.sharedFacts.count, 108, "Deferred facts publish with their successfully loaded page")
      XCTAssertNil(model.nextCursor)
      XCTAssertNil(model.factsNextCursor)
    }
  }
  @MainActor func testAlbumReturnReopensVerifiedAlbumAfterMediaCleanupAndOfflineRetry() async throws {
    try await withAlbum { services, server, model in
      server.factsCapabilityStatus = 200
      try server.setFacts(server.source, people: ["Mom"])
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      let thumbnail = try await model.thumbnail(item)
      XCTAssertNotNil(thumbnail)
      let directory = try XCTUnwrap(model.directory)
      var filter = NativeAlbumSearchFilter()
      filter.query = "public-album-fixture"
      filter.people = [NativeAlbumPersonChoice(contributor: server.cards[0].accountId, name: "Mom").id]
      filter.match = .everyone
      XCTAssertTrue(filter.includes(item, facts: model.sharedFacts[item.id]))
      let intent = try XCTUnwrap(NativeAlbumReturnIntent(album: model.opened,
        context: NativeAlbumPickerContext.current(services), filter: filter))

      model.clear()
      XCTAssertNil(model.opened); XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.directory)
      XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
      let staleThumbnail = try await model.thumbnail(item)
      XCTAssertNil(staleThumbnail, "Suspension clears access as well as exported media")
      server.failInbox = true
      do { try await model.refresh(); XCTFail("Offline refresh reported success") }
      catch let error as URLError { XCTAssertEqual(error.code, .notConnectedToInternet) }
      XCTAssertNil(model.opened)

      server.failInbox = false
      try await model.refresh()
      let resumed = try await intent.reopen(in: model, services: services)
      let restoredFilter = try XCTUnwrap(resumed)
      XCTAssertEqual(restoredFilter, filter)
      XCTAssertEqual(model.opened?.id, server.definition.albumId)
      XCTAssertEqual(model.opened?.overview.definition, intent.definition)
      let restoredItem = try XCTUnwrap(model.items.first)
      XCTAssertTrue(restoredFilter.includes(restoredItem, facts: model.sharedFacts[restoredItem.id]))
    }
  }
  @MainActor func testAlbumSuspensionCapturesOnlyActualOpenedScopeWithoutTaskCancellationDependency() async throws {
    for change in ["account", "vault", "catalog", "origin", "cards"] {
      try await withAlbum { services, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let capturing = Task { NativeAlbumReturnIntent.capture(from: model, filter: NativeAlbumSearchFilter()) }
        capturing.cancel()
        let captured = await capturing.value
        XCTAssertNotNil(captured, "A cancelled scene task can still preserve the unchanged opened scope")
        switch change {
        case "account":
          services.session.accountId = server.cards[0].accountId
          services.session.pinnedCards = Dictionary(uniqueKeysWithValues: server.cards.map { ($0.accountId, $0) })
          try services.activateAccount()
        case "vault": services.vault.lock()
        case "catalog": try services.activateAccount()
        case "origin": services.api.baseURL = try XCTUnwrap(URL(string: "http://localhost:8798"))
        default: services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
        }
        XCTAssertNotNil(model.opened, "The stale summary exists until suspension clears it")
        XCTAssertNil(NativeAlbumReturnIntent.capture(from: model, filter: NativeAlbumSearchFilter()),
          "An old opened album cannot be rebound to current changed " + change)
      }
    }
  }
  @MainActor func testExplicitAlbumChoiceDiscardsFailedReturnBeforeNextPoll() async throws {
    try await withAlbum { services, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let albumA = try XCTUnwrap(model.opened)
      var resume = NativeAlbumResumeState(intent: try XCTUnwrap(
        NativeAlbumReturnIntent.capture(from: model, filter: NativeAlbumSearchFilter())))
      model.clear(); try await model.refresh()
      server.failObjectOnce = server.source.manifest.metadataRepresentation.objectId
      do { _ = try await resume.reopen(in: model, services: services); XCTFail("Failed return reported success") }
      catch let error as URLError { XCTAssertEqual(error.code, .networkConnectionLost) }
      XCTAssertNotNil(resume.intent, "A transient failure remains retryable until the user chooses another action")

      resume.deliberateNavigation(in: model)
      server.included = false
      server.extraInbox = [albumA.overview]
      let albumB = try await model.create(title: "Explicitly chosen album", members: [server.cards[0]])
      try await model.open(albumB)
      XCTAssertEqual(model.opened?.id, albumB)
      try await model.refresh()
      XCTAssertTrue(model.albums.contains { $0.id == albumA.id }, "The old destination remains available in the inbox")
      let polled = try await resume.reopen(in: model, services: services)
      XCTAssertNil(polled)
      XCTAssertEqual(model.opened?.id, albumB, "A subsequent poll must preserve the explicit choice")
      XCTAssertNil(resume.intent)
    }
  }
  @MainActor func testLateAutomaticReturnCannotClearExplicitlyOpenedAlbum() async throws {
    let gate = AlbumFactsRequestGate(started: expectation(description: "Automatic return facts request"))
    defer { gate.release.signal() }
    try await withAlbum { services, server, model in
      server.factsCapabilityStatus = 200
      try await model.refresh(); try await model.open(server.definition.albumId)
      let albumA = try XCTUnwrap(model.opened)
      var oldFilter = NativeAlbumSearchFilter(); oldFilter.query = "Old album filter"
      var resume = NativeAlbumResumeState(intent: try XCTUnwrap(
        NativeAlbumReturnIntent.capture(from: model, filter: oldFilter)))
      model.clear(); try await model.refresh()
      server.factsGate = gate
      var publishedFilter = NativeAlbumSearchFilter()
      let returning = Task {
        if let filter = try await resume.reopen(in: model, services: services) { publishedFilter = filter }
      }
      await fulfillment(of: [gate.started], timeout: 3)

      resume.deliberateNavigation(in: model)
      server.included = false; server.extraInbox = [albumA.overview]
      let albumB = try await model.create(title: "Chosen while return is in flight", members: [server.cards[0]])
      try await model.open(albumB)
      XCTAssertEqual(model.opened?.id, albumB, "B opens before the old A response is released")
      gate.release.signal()
      do { try await returning.value; XCTFail("Superseded return reported success") }
      catch is CancellationError {}
      XCTAssertFalse(returning.isCancelled, "Supersession must not require cancelling the scene polling task")
      XCTAssertEqual(model.opened?.id, albumB, "The obsolete epoch cannot clear the newer album")
      XCTAssertEqual(publishedFilter, NativeAlbumSearchFilter())
      XCTAssertNil(resume.intent)
      try await model.refresh()
      let polled = try await resume.reopen(in: model, services: services)
      XCTAssertNil(polled); XCTAssertEqual(model.opened?.id, albumB)
    }
  }
  @MainActor func testAlbumReturnRejectsMissingRevokedUnreviewedOrChangedDefinition() async throws {
    for change in ["missing", "ended", "unaccepted", "needsTrust", "definition"] {
      try await withAlbum { services, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let intent = try XCTUnwrap(NativeAlbumReturnIntent(album: model.opened,
          context: NativeAlbumPickerContext.current(services), filter: NativeAlbumSearchFilter()))
        model.clear()
        switch change {
        case "missing": server.hideInboxAlbum = true
        case "ended": server.ended = true
        case "unaccepted": server.accepted = false
        case "needsTrust": services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
        default:
          server.definition.createdAt = "2026-01-01T00:00:00.000Z"
          server.signed = try CryptoAdapter().sign(server.definition, kind: "album-v1",
            accountId: server.cards[0].accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
        }
        try await model.refresh()
        let objectReads = server.objectReads
        let resumed = try await intent.reopen(in: model, services: services)
        XCTAssertNil(resumed, change)
        XCTAssertNil(model.opened, change); XCTAssertTrue(model.items.isEmpty, change)
        XCTAssertEqual(server.objectReads, objectReads, "Rejected return must not read photo metadata: " + change)
        XCTAssertNil(NativeAlbumReturnIntent(album: nil, context: NativeAlbumPickerContext.current(services), filter: intent.filter))
        if let album = model.albums.first {
          XCTAssertNil(NativeAlbumReturnIntent(album: album, context: nil, filter: intent.filter))
          if change != "definition" {
            XCTAssertNil(NativeAlbumReturnIntent(album: album, context: NativeAlbumPickerContext.current(services), filter: intent.filter), change)
          }
        }
      }
    }
  }
  @MainActor func testAlbumReturnRejectsChangedAccountVaultCatalogOrOriginBeforeOpening() async throws {
    for change in ["account", "vault", "catalog", "origin"] {
      try await withAlbum { services, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let intent = try XCTUnwrap(NativeAlbumReturnIntent(album: model.opened,
          context: NativeAlbumPickerContext.current(services), filter: NativeAlbumSearchFilter()))
        model.clear(); try await model.refresh()
        switch change {
        case "account": services.session.accountId = server.cards[0].accountId
        case "vault": services.vault.lock()
        case "catalog": try services.activateAccount()
        default: services.api.baseURL = try XCTUnwrap(URL(string: "http://localhost:8798"))
        }
        let objectReads = server.objectReads
        let resumed = try await intent.reopen(in: model, services: services)
        XCTAssertNil(resumed, change); XCTAssertNil(model.opened, change)
        XCTAssertEqual(server.objectReads, objectReads, change)
      }
    }
  }
  @MainActor func testLateAlbumReturnCannotReopenAfterCancellationOrContextChange() async throws {
    for change in ["cancel", "account", "vault", "catalog", "origin"] {
      let gate = AlbumFactsRequestGate(started: expectation(description: "Returning album " + change))
      defer { gate.release.signal() }
      try await withAlbum { services, server, model in
        server.factsCapabilityStatus = 200
        try await model.refresh(); try await model.open(server.definition.albumId)
        let intent = try XCTUnwrap(NativeAlbumReturnIntent(album: model.opened,
          context: NativeAlbumPickerContext.current(services), filter: NativeAlbumSearchFilter()))
        model.clear(); try await model.refresh()
        server.factsGate = gate
        let reopening = Task { try await intent.reopen(in: model, services: services) }
        await fulfillment(of: [gate.started], timeout: 3)
        switch change {
        case "cancel": reopening.cancel()
        case "account": services.session.accountId = server.cards[0].accountId
        case "vault": services.vault.lock()
        case "catalog": try services.activateAccount()
        default: services.api.baseURL = try XCTUnwrap(URL(string: "http://localhost:8798"))
        }
        gate.release.signal()
        do { _ = try await reopening.value; XCTFail("Late return survived " + change) } catch {}
        XCTAssertNil(model.opened, change); XCTAssertTrue(model.items.isEmpty, change)
        XCTAssertNil(model.directory, change)
      }
    }
  }
  @MainActor func testSharedDetailsWrongDigestAndEndedReadCannotPublishFacts() async throws {
    for interruption in ["digest", "ended"] {
      try await withAlbum { _, server, model in
        server.factsCapabilityStatus = 200
        try server.setFacts(server.source, people: ["Mom"], wrongDigest: interruption == "digest")
        server.endOnFacts = interruption == "ended"
        try await model.refresh()
        if interruption == "ended" {
          do { try await model.open(server.definition.albumId); XCTFail("Ended album read reported success") }
          catch { XCTAssertTrue(error is CancellationError, "Losing album access invalidates the captured context") }
        } else { try await model.open(server.definition.albumId) }
        XCTAssertTrue(model.sharedFacts.isEmpty)
        if interruption == "digest" { XCTAssertEqual(model.items.count, 1); XCTAssertNotNil(model.factsError) }
        else { XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.opened) }
      }
    }
  }
  @MainActor func testSharedDetailsReviewPublishesOnlyChosenOwnFactsAndCanClear() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.factsCapabilityStatus = 200
      try services.store.put(server.source)
      let location = PhotoLocationV1(latitude: 1.3, longitude: 103.8, source: "photos", name: "Singapore")
      var value = PhotoAnnotationsV1(photoId: server.source.id, originalSha256: server.source.metadata.originalSha256)
      value.caption = "Private caption"; value.labels = ["Private label"]
      value.facts = try PhotoPeopleFacts.replacing(["Private user fact"], with: [PhotoPersonAssignment(p: Wire.id(), n: "Mom", b: [0,0,2000,2000]), PhotoPersonAssignment(p: Wire.id(), n: "Dad", b: [3000,0,2000,2000])], originalSha256: value.originalSha256)
      try value.setLocation(location)
      try services.annotations.ledger.edit(value, photo: server.source, bundle: server.bundles[0], card: server.cards[0])
      try services.reload(); try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first), review = try await model.prepareSharedDetails(item)
      XCTAssertEqual(Set(review.people), ["Mom", "Dad"]); XCTAssertEqual(review.location, location)
      XCTAssertEqual(server.factsWriteBodies.count, 0, "Opening review never shares details")
      try await model.shareDetails(review, names: ["Mom"], includeLocation: false)
      let shared = try XCTUnwrap(model.sharedFacts[item.id])
      XCTAssertEqual(shared.people, ["Mom"]); XCTAssertNil(shared.location)
      let json = String(decoding: try Wire.encode(shared), as: UTF8.self)
      for privateText in ["Private caption", "Private label", "Private user fact", "Dad", "ocr", "facts"] { XCTAssertFalse(json.contains(privateText)) }
      let updated = try await model.prepareSharedDetails(item)
      let selection = NativeAlbumFactsSelection(people: updated.people, location: updated.location, shared: updated.shared)
      XCTAssertEqual(selection.people, ["Mom"]); XCTAssertFalse(selection.includeLocation)
      XCTAssertFalse(selection.unavailableSharedDetails)
      try await model.shareDetails(updated, names: [], includeLocation: false)
      XCTAssertEqual(model.sharedFacts[item.id]?.people, []); XCTAssertNil(model.sharedFacts[item.id]?.location)
      XCTAssertEqual(services.annotation(server.source), value, "Shared edits do not rewrite private annotations")
    }
  }
  @MainActor func testSharedDetailsCorrectionSourceAndAccountChangesFenceWrites() async throws {
    for change in ["annotation", "original", "account", "cancel", "end"] {
      try await withAlbum(owner: true) { services, server, model in
        server.factsCapabilityStatus = 200
        try services.store.put(server.source); try services.reload()
        try await model.refresh(); try await model.open(server.definition.albumId)
        let review = try await model.prepareSharedDetails(XCTUnwrap(model.items.first))
        if change == "annotation" { try services.setLabels(["Changed private source"], photo: server.source) }
        if change == "original" { var changed = server.source; changed.metadata.originalSha256 = Data("changed".utf8).digest; try services.store.put(changed) }
        if change == "account" { services.session.accountId = server.cards[1].accountId }
        if change == "end" { server.ended = true }
        if change == "cancel" {
          let task = Task { try await model.shareDetails(review, names: [], includeLocation: false) }
          task.cancel()
          do { try await task.value; XCTFail("Cancelled details write completed") } catch {}
        } else {
          do { try await model.shareDetails(review, names: [], includeLocation: false); XCTFail("Changed \(change) source wrote details") } catch {}
        }
        XCTAssertTrue(server.factsWriteBodies.isEmpty, change)
      }
    }
  }
  @MainActor func testSharedDetailsRevisionConflictRefreshesForExplicitReview() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.factsCapabilityStatus = 200; try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first), review = try await model.prepareSharedDetails(item)
      try server.setFacts(server.source, people: ["Another device's reviewed label"])
      do { try await model.shareDetails(review, names: [], includeLocation: false); XCTFail("Stale review overwrote newer details") }
      catch let error as FotoroError { XCTAssertTrue(error.message.contains("Refresh and review")) }
      XCTAssertEqual(model.sharedFacts[item.id]?.people, ["Another device's reviewed label"])
      let refreshed = try await model.prepareSharedDetails(item)
      XCTAssertEqual(refreshed.revision, 1)
      try await model.shareDetails(refreshed, names: [], includeLocation: false)
      XCTAssertEqual(model.sharedFacts[item.id]?.revision, 2)
    }
  }
  @MainActor func testLateSharedDetailsReadCannotPublishAfterAccountLockOriginOrCancellation() async throws {
    for change in ["account", "lock", "origin", "cancel"] {
      let gate = AlbumFactsRequestGate(started: expectation(description: "Shared facts read " + change))
      defer { gate.release.signal() }
      try await withAlbum { services, server, model in
        server.factsCapabilityStatus = 200; try server.setFacts(server.source, people: ["Mom"])
        server.factsGate = gate
        try await model.refresh()
        let opening = Task { try await model.open(server.definition.albumId) }
        await fulfillment(of: [gate.started], timeout: 3)
        if change == "account" {
          XCTAssertEqual(services.session.accountId, server.cards[1].accountId)
          services.session.accountId = server.cards[0].accountId
        }
        else if change == "lock" { services.vault.lock() }
        else if change == "origin" { services.api.baseURL = URL(string: "http://localhost:8798")! }
        else { opening.cancel() }
        gate.release.signal()
        do { try await opening.value; XCTFail("Late shared details survived " + change) } catch {}
        XCTAssertTrue(model.sharedFacts.isEmpty, change)
      }
    }
  }
  @MainActor func testLostSharedDetailsReplyRequiresFreshReviewOfCommittedRevision() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.factsCapabilityStatus = 200; try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first), review = try await model.prepareSharedDetails(item)
      server.loseFactsWriteResponse = true
      do { try await model.shareDetails(review, names: [], includeLocation: false); XCTFail("Lost reply reported confirmed success") } catch {}
      XCTAssertEqual(server.factsWriteBodies.count, 1)
      let refreshed = try await model.prepareSharedDetails(item)
      XCTAssertEqual(refreshed.revision, 1, "The caller must inspect the committed result before choosing another update")
      try await model.shareDetails(refreshed, names: [], includeLocation: false)
      XCTAssertEqual(model.sharedFacts[item.id]?.revision, 2)
    }
  }
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
  @MainActor func testTripSaveToPhotosExportsVerifiedOriginalsAndCleansTemporaryResources() async throws {
    let archive = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live")))
    let pair = try CameraMedia.decodeLivePhoto(archive)
    let jpeg = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "semantic-fireworks", withExtension: "jpg")))
    for (type, bytes, expected) in [
      ("image/jpeg", jpeg, [jpeg]),
      ("video/quicktime", pair.motion.bytes, [pair.motion.bytes]),
      (CameraMedia.liveType, archive, [pair.still.bytes, pair.motion.bytes]),
    ] {
      try await withAlbum { services, server, model in
        server.included = false
        try server.contribute(server.extraOwnedPhotos(count: 1, originalBytes: bytes, filename: "original", mediaType: type))
        try await model.refresh(); try await model.open(server.definition.albumId)
        let item = try XCTUnwrap(model.items.first)
        var accessReadsAtPrompt = server.accessReads
        var exports: [URL] = [], permissionRequests = 0, creations = 0
        try await model.saveToPhotos(item, requestAccess: {
          permissionRequests += 1; accessReadsAtPrompt = server.accessReads; return .authorized
        },
          restore: { urls, metadata in
            exports = urls; creations += 1
            XCTAssertGreaterThan(server.accessReads, accessReadsAtPrompt, "Fresh membership after permission must precede PhotoKit admission")
            XCTAssertEqual(metadata, item.photo.metadata)
            XCTAssertEqual(try urls.map { try Data(contentsOf: $0) }, expected)
            XCTAssertTrue(urls.allSatisfy { $0.path.contains("/fotoro-share-") })
            await Task.yield()
            XCTAssertTrue(urls.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
          })
        XCTAssertEqual(permissionRequests, 1); XCTAssertEqual(creations, 1)
        XCTAssertEqual(server.originalReads, 1)
        XCTAssertTrue(exports.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        XCTAssertNil(try services.consumerSavedPhoto(item.id), "Photos export must not manufacture an owned Fotoro copy")
      }
    }
  }
  @MainActor func testTripSaveToPhotosKeepsResourcesAliveWhenAlbumClearsDuringCreation() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      var exports: [URL] = []
      do {
        try await model.saveToPhotos(item, requestAccess: { .authorized }, restore: { urls, _ in
          exports = urls
          model.clear()
          await Task.yield()
          XCTAssertEqual(try Data(contentsOf: urls[0]).digest, item.photo.metadata.originalSha256,
            "Album cache withdrawal cannot remove resources while PhotoKit owns them")
        })
        XCTFail("Cleared access must not publish success")
      } catch is CancellationError {}
      XCTAssertFalse(exports.isEmpty)
      XCTAssertTrue(exports.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
    }
  }
  @MainActor func testTripSaveToPhotosRejectsChangedCapturedSourceBeforeReadingOriginal() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first)
      var changed = item.photo
      changed.metadata.filename = "changed.jpg"
      let stale = NativeAlbumItem(entry: item.entry, signedManifest: item.signedManifest, photo: changed)
      do {
        try await model.saveToPhotos(stale, requestAccess: {
          XCTFail("Changed metadata cannot request Photos permission"); return .authorized
        }, restore: { _, _ in XCTFail("Changed metadata cannot reach PhotoKit") })
        XCTFail("Changed captured source must be rejected")
      } catch is CancellationError {}
      XCTAssertEqual(server.originalReads, 0)
    }
  }
  @MainActor func testTripSaveToPhotosRejectsWithdrawalAfterPermissionPromptBeforeCreation() async throws {
    for withdrawal in ["origin", "membership", "source", "permission"] {
      try await withAlbum { services, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let item = try XCTUnwrap(model.items.first)
        let temporary = FileManager.default.temporaryDirectory
        let before = Set(try FileManager.default.contentsOfDirectory(atPath: temporary.path).filter { $0.hasPrefix("fotoro-share-") })
        var creations = 0
        do {
          try await model.saveToPhotos(item, requestAccess: {
            switch withdrawal {
            case "origin": services.api.baseURL = URL(string: "https://withdrawn-trip.test")!
            case "membership": server.accepted = false
            case "source": model.clear()
            default: return .denied
            }
            return .authorized
          }, restore: { _, _ in creations += 1 })
          XCTFail("Withdrawn \(withdrawal) cannot admit PhotoKit creation")
        } catch {}
        XCTAssertEqual(creations, 0)
        let after = Set(try FileManager.default.contentsOfDirectory(atPath: temporary.path).filter { $0.hasPrefix("fotoro-share-") })
        XCTAssertEqual(after, before, "Rejected \(withdrawal) must clean its protected export")
      }
    }
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
  @MainActor func testReviewedFirstContactJoinPinsAcceptsAndOpensExactAlbum() async throws {
    try await withAlbum(invited: true) { services, server, model in
      try services.acceptContact(server.cards[0], name: "Mom")
      services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
      try await model.refresh()
      let reviewed = try XCTUnwrap(model.albums.first)
      XCTAssertTrue(reviewed.needsTrust)
      XCTAssertFalse(server.accepted)
      XCTAssertEqual(server.objectReads, 0)
      try await NativeAlbumReviewedJoin.join(reviewed, incoming: FotoroAlbumInvitation(albumId: reviewed.id, ownerCard: server.cards[0]), services: services, model: model)
      XCTAssertEqual(services.session.pinnedCards[server.cards[0].accountId], server.cards[0])
      XCTAssertEqual(services.contactName(server.cards[0].accountId), "Mom")
      XCTAssertTrue(server.accepted)
      XCTAssertEqual(model.opened?.id, reviewed.id)
    }
  }
  @MainActor func testChangedOwnerContactRequiresReviewAndJoinsWithoutImplicitTrust() async throws {
    try await withAlbum(invited: true) { services, server, model in
      var old = server.cards[0]; old.signingPublicKey = server.cards[1].signingPublicKey
      try services.acceptContact(old, name: "Mom")
      try await model.refresh()
      let reviewed = try XCTUnwrap(model.albums.first)
      XCTAssertTrue(reviewed.needsTrust)
      XCTAssertEqual(services.session.pinnedCards[old.accountId], old)
      XCTAssertFalse(server.accepted); XCTAssertEqual(server.objectReads, 0)
      try await NativeAlbumReviewedJoin.join(reviewed, incoming: FotoroAlbumInvitation(albumId: reviewed.id, ownerCard: server.cards[0]), services: services, model: model)
      XCTAssertEqual(services.session.pinnedCards[old.accountId], server.cards[0])
      XCTAssertEqual(services.contactName(old.accountId), "Mom")
      XCTAssertTrue(server.accepted); XCTAssertEqual(model.opened?.id, reviewed.id)
    }
  }
  @MainActor func testInvalidInvitationsDoNotHideAcceptedAlbumOrChangeTrust() async throws {
    try await withAlbum { services, server, model in
      let trusted = services.session.pinnedCards
      var invalid = server.definition; invalid.albumId = Wire.id()
      var signed = try CryptoAdapter().sign(invalid, kind: "album-v1", accountId: server.cards[0].accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
      signed.signature = Data(repeating: 0, count: 64).b64
      var unknownOwner = server.cards[0]; unknownOwner.accountId = Wire.id()
      invalid.albumId = Wire.id(); invalid.ownerAccountId = unknownOwner.accountId; invalid.members[0].card = unknownOwner
      var unknown = try CryptoAdapter().sign(invalid, kind: "album-v1", accountId: unknownOwner.accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
      unknown.signature = Data(repeating: 0, count: 64).b64
      var malformed = signed; malformed.body = Data("{}".utf8).b64
      server.extraInbox = [signed, unknown, malformed].map { AlbumOverviewV1(definition: $0, membership: "invited", endedAt: nil, photoCount: 0) }
      try await model.refresh()
      XCTAssertEqual(model.albums.map(\.id), [server.definition.albumId])
      XCTAssertEqual(services.session.pinnedCards, trusted)
      XCTAssertNotNil(model.inboxError)
      try await model.open(server.definition.albumId)
      XCTAssertEqual(model.items.count, 1)
      server.extraInbox = []; try await model.refresh()
      XCTAssertNil(model.inboxError); XCTAssertEqual(model.opened?.id, server.definition.albumId)
    }
  }
  @MainActor func testReviewedJoinRejectsDefinitionNotBoundToReviewedSignatureBeforePinning() async throws {
    try await withAlbum(invited: true) { services, server, model in
      services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
      try await model.refresh()
      let original = try XCTUnwrap(model.albums.first)
      var changed = original.definition
      changed.members[0].card.signingPublicKey = server.cards[1].signingPublicKey
      let reviewed = NativeAlbumSummary(overview: original.overview, definition: changed, title: nil, needsTrust: true)
      do {
        try await NativeAlbumReviewedJoin.join(reviewed, incoming: nil, services: services, model: model)
        XCTFail("Unbound reviewed definition joined")
      } catch {}
      XCTAssertNil(services.session.pinnedCards[server.cards[0].accountId])
      XCTAssertFalse(server.accepted); XCTAssertEqual(server.objectReads, 0)
    }
  }
  @MainActor func testReviewedJoinRejectsLinkMismatchBeforeTrustOrAcceptance() async throws {
    try await withAlbum(invited: true) { services, server, model in
      services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
      try await model.refresh()
      let reviewed = try XCTUnwrap(model.albums.first)
      do {
        try await NativeAlbumReviewedJoin.join(reviewed, incoming: FotoroAlbumInvitation(albumId: reviewed.id, ownerCard: server.cards[1]), services: services, model: model)
        XCTFail("Mismatched link joined")
      } catch {}
      XCTAssertNil(services.session.pinnedCards[server.cards[0].accountId])
      XCTAssertFalse(server.accepted)
      XCTAssertEqual(server.objectReads, 0)
    }
  }
  @MainActor func testReviewedJoinRejectsWithdrawnReviewBeforePinning() async throws {
    try await withAlbum(invited: true) { services, server, model in
      services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
      try await model.refresh()
      let reviewed = try XCTUnwrap(model.albums.first)
      model.clear()
      do {
        try await NativeAlbumReviewedJoin.join(reviewed, incoming: nil, services: services, model: model)
        XCTFail("Withdrawn review joined")
      } catch {}
      XCTAssertNil(services.session.pinnedCards[server.cards[0].accountId])
      XCTAssertFalse(server.accepted)
    }
  }
  @MainActor func testReviewedJoinRejectsChangedDefinitionAndCanRetryAfterReview() async throws {
    try await withAlbum(invited: true) { services, server, model in
      services.session.pinnedCards.removeValue(forKey: server.cards[0].accountId)
      try await model.refresh()
      let reviewed = try XCTUnwrap(model.albums.first)
      server.definition.createdAt = "2026-01-01T00:00:00.000Z"
      server.signed = try CryptoAdapter().sign(server.definition, kind: "album-v1", accountId: server.cards[0].accountId, secret: Data(b64: server.bundles[0].signingSecretKey))
      do {
        try await NativeAlbumReviewedJoin.join(reviewed, incoming: nil, services: services, model: model)
        XCTFail("Changed definition joined")
      } catch {}
      XCTAssertFalse(server.accepted)
      XCTAssertEqual(server.objectReads, 0)
      let fresh = try XCTUnwrap(model.albums.first)
      try await NativeAlbumReviewedJoin.join(fresh, incoming: nil, services: services, model: model)
      XCTAssertTrue(server.accepted)
      XCTAssertEqual(model.opened?.id, fresh.id)
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
  @MainActor func testFailedAppendMembershipKeepsPickerAndRevalidatesSameSelection() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false
      try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      let picker = NativeAlbumPhotoPickerStore()
      picker.open(services, initial: [server.source]); await picker.waitUntilSettled()
      let access = model.currentOpenedPhotoAccess
      server.accessStatus = 503
      do { try await model.append(picker.chosen(services)); XCTFail("Unavailable membership reported success") } catch {}
      XCTAssertEqual(model.opened?.id, server.definition.albumId)
      XCTAssertEqual(model.currentOpenedPhotoAccess, access)
      XCTAssertEqual(try picker.chosen(services).map(\.id), [server.source.id])
      XCTAssertTrue(server.appendBodies.isEmpty, "Failed membership cannot contribute a photo")
      server.accessStatus = nil
      let checks = server.accessReads
      try await model.append(picker.chosen(services))
      XCTAssertGreaterThan(server.accessReads, checks, "Retry must revalidate membership before contributing")
      XCTAssertEqual(model.items.map { $0.photo.id }, try picker.chosen(services).map(\.id))
      XCTAssertEqual(server.appendBodies.count, 1)
      server.accessStatus = 403
      do { try await model.append(picker.chosen(services)); XCTFail("Denied membership reported success") } catch {}
      XCTAssertNil(model.opened); XCTAssertNil(model.currentOpenedPhotoAccess)
      XCTAssertNotNil(try services.consumerSavedPhoto(server.source.id))
      picker.clear()
    }
  }
  @MainActor func testCancelledAppendMembershipKeepsTripForExplicitRetry() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false
      try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      let gate = AlbumFactsRequestGate(started: expectation(description: "Held append membership"))
      defer { gate.release.signal() }
      server.accessGate = gate
      let adding = Task { try await model.append([server.source]) }
      await fulfillment(of: [gate.started], timeout: 3)
      adding.cancel(); gate.release.signal()
      do { try await adding.value; XCTFail("Cancelled addition reported success") } catch is CancellationError {} catch { XCTFail("Unexpected error: \(error)") }
      XCTAssertEqual(model.opened?.id, server.definition.albumId)
      XCTAssertNotNil(model.currentOpenedPhotoAccess); XCTAssertTrue(server.appendBodies.isEmpty)
      try await model.append([server.source])
      XCTAssertEqual(model.items.map { $0.photo.id }, [server.source.id])
      XCTAssertEqual(server.appendBodies.count, 1)
    }
  }
  @MainActor func testTransientInboxRefreshKeepsVerifiedTripForNextChosenAction() async throws {
    try await withAlbum(owner: true) { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let items = model.items.map(\.id), access = model.currentOpenedPhotoAccess
      server.failInbox = true
      do { try await model.refresh(); XCTFail("Offline refresh reported success") } catch {}
      XCTAssertEqual(model.opened?.id, server.definition.albumId)
      XCTAssertEqual(model.items.map(\.id), items); XCTAssertEqual(model.currentOpenedPhotoAccess, access)
      server.failInbox = false; server.accessStatus = 403
      do { try await model.checkOpenedAccess(); XCTFail("Denied access reported success") } catch {}
      XCTAssertNil(model.opened); XCTAssertNil(model.currentOpenedPhotoAccess)
    }
  }
  @MainActor func testLostAppendResponseRetriesDurableExactBodyAndOriginalBrowserSignature() async throws {
    try await withAlbum(owner: true) { services, server, model in
      server.included = false; server.loseAppendResponse = true
      try services.store.put(server.source); try services.reload()
      try await model.refresh(); try await model.open(server.definition.albumId)
      let picker = NativeAlbumPhotoPickerStore()
      picker.open(services, initial: [server.source])
      await picker.waitUntilSettled()
      do { try await model.append(picker.chosen(services)); XCTFail("Lost response reported success") } catch {}
      XCTAssertEqual(try picker.chosen(services).map(\.id), [server.source.id], "A failed add must keep the picker’s current chosen sources for recovery")
      XCTAssertNotNil(try services.consumerSavedPhoto(server.source.id), "A failed contribution must keep its private Saved original")
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
      XCTAssertEqual(try picker.chosen(services).map(\.id), reopened.items.map { $0.photo.id }, "Retry must contribute the same retained picker selection")
      picker.clear(); reopened.clear()
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
  @MainActor func testDeniedInboxRefreshClearsOpenMediaAndKeys() async throws {
    try await withAlbum { _, server, model in
      try await model.refresh(); try await model.open(server.definition.albumId)
      let item = try XCTUnwrap(model.items.first), url = try await model.thumbnail(item)
      XCTAssertNotNil(url); let directory = try XCTUnwrap(model.directory)
      server.inboxStatus = 403
      do { try await model.refresh(); XCTFail("Denied refresh reported success") }
      catch let error as FotoroError { XCTAssertEqual(error.statusCode, 403) }
      XCTAssertTrue(model.items.isEmpty); XCTAssertNil(model.opened); XCTAssertNil(model.directory)
      XCTAssertNil(model.currentOpenedPhotoAccess)
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
  @MainActor func testAlbumSavedPickerPagesBeyondOneThousandAndKeepsOlderSelection() async throws {
    try await withAlbum(owner: true) { services, server, _ in
      var photos: [LocalPhoto] = []
      for number in 0..<1003 {
        var photo = server.source; photo.photoId = Wire.id(); photo.manifest.photoId = photo.id
        for index in photo.manifest.representations.indices { photo.manifest.representations[index].binding.photoId = photo.id }
        photo.manifest.metadataRepresentation.binding.photoId = photo.id
        photo.metadata.filename = "Saved-\(number).jpg"
        photo.metadata.sourceDate = Wire.date(Date(timeIntervalSince1970: Double(1_700_000_000 + number)))
        try services.store.put(photo); photos.append(photo)
      }
      var pending = server.source; pending.metadata.sourceDate = Wire.date(); pending.transferState = "pending"
      try services.store.put(pending)
      var foreign = server.source; foreign.photoId = Wire.id(); foreign.manifest.photoId = foreign.id
      foreign.manifest.ownerAccountId = server.cards[1].accountId; try services.store.put(foreign)
      let picker = NativeAlbumPhotoPickerStore()
      picker.open(services, initial: [photos[0]])
      await picker.waitUntilSettled()
      XCTAssertTrue(picker.hasMore)
      XCTAssertLessThanOrEqual(picker.photos.count, NativeAlbumPhotoPickerStore.pageSize)
      XCTAssertFalse(picker.photos.contains { $0.id == photos[0].id })
      XCTAssertEqual(try picker.chosen(services).map(\.id), [photos[0].id], "An initial older selection need not be in the first page")
      picker.toggle(try XCTUnwrap(picker.photos.first), services: services)
      var pageLoads = 1
      while picker.hasMore, pageLoads < 10 { picker.loadMore(services); await picker.waitUntilSettled(); pageLoads += 1 }
      XCTAssertFalse(picker.hasMore); XCTAssertNil(picker.feedback)
      XCTAssertEqual(pageLoads, 6)
      XCTAssertEqual(picker.photos.count, 1003)
      XCTAssertEqual(Set(picker.photos.map(\.id)), Set(photos.map(\.id)))
      XCTAssertEqual(picker.selection.count, 2)
      XCTAssertTrue(try picker.chosen(services).contains { $0.id == photos[0].id })
      picker.clear()
    }
  }
  @MainActor func testAlbumSavedPickerDeduplicatesPagesAndInitialSelection() async throws {
    try await withAlbum(owner: true) { services, server, _ in
      let first = server.source
      var second = first; second.photoId = Wire.id(); second.manifest.photoId = second.id
      try services.store.put(first); try services.store.put(second)
      let other = second
      let picker = NativeAlbumPhotoPickerStore(readPage: { _, after, limit in
        after == nil ? Array(repeating: first, count: limit) : [first, other]
      })
      picker.open(services, initial: [first, first])
      await picker.waitUntilSettled()
      XCTAssertEqual(picker.photos.map(\.id), [first.id]); XCTAssertEqual(picker.selection.count, 1)
      picker.loadMore(services); await picker.waitUntilSettled()
      XCTAssertEqual(picker.photos.map(\.id), [first.id, second.id])
      XCTAssertFalse(picker.hasMore); XCTAssertEqual(try picker.chosen(services).map(\.id), [first.id])
      picker.clear()
    }
  }
  @MainActor func testAlbumSavedPickerDiscardsLatePageAfterCancellationAccountLockOrOriginChange() async throws {
    for interruption in ["cancel", "account", "lock", "origin", "store"] {
      try await withAlbum(owner: true) { services, server, _ in
        try services.store.put(server.source)
        let gate = AlbumPickerReadGate()
        let picker = NativeAlbumPhotoPickerStore(readPage: { _, _, _ in await gate.read() })
        picker.open(services, initial: [server.source])
        let settled = Task { await picker.waitUntilSettled() }
        while !(await gate.started) { await Task.yield() }
        switch interruption {
        case "cancel": picker.clear()
        case "account": services.session.accountId = server.cards[1].accountId
        case "lock": services.vault.lock()
        case "origin": services.api.baseURL = URL(string: "http://localhost:8798")!
        default: try services.activateAccount()
        }
        await gate.finish([server.source]); await settled.value
        XCTAssertTrue(picker.photos.isEmpty, interruption)
        XCTAssertEqual(picker.selection.count, 0, interruption)
        XCTAssertFalse(picker.isCurrent(services), interruption)
        XCTAssertFalse(picker.busy, interruption)
        XCTAssertThrowsError(try picker.chosen(services), interruption)
      }
    }
  }
  @MainActor func testAlbumSavedPickerRejectsChangedSelectionAndRefreshesCurrentSource() async throws {
    try await withAlbum(owner: true) { services, server, _ in
      var photo = server.source; try services.store.put(photo)
      let picker = NativeAlbumPhotoPickerStore(); picker.open(services)
      await picker.waitUntilSettled(); picker.toggle(photo, services: services)
      photo.metadata.originalSha256 = Data("changed original".utf8).digest
      photo.metadata.filename = "changed.jpg"; try services.store.put(photo)
      XCTAssertThrowsError(try picker.chosen(services))
      picker.refresh(services); await picker.waitUntilSettled()
      XCTAssertEqual(picker.selection.count, 0)
      XCTAssertEqual(picker.photos.map { $0.metadata.filename }, ["changed.jpg"])
      picker.toggle(photo, services: services)
      XCTAssertEqual(try picker.chosen(services).map { $0.metadata.originalSha256 }, [photo.metadata.originalSha256])
      picker.clear()
    }
  }
  func testAlbumPhotoAccessibilityDistinguishesSameFilenameAndPreservesDateProvenance() throws {
    let server = try AlbumTestServer(); var first = server.source, second = server.source
    first.metadata.sourceDate = "2026-01-01T12:00:00.000Z"; first.metadata.dateSource = "photos"
    second.metadata.sourceDate = "2026-02-01T12:00:00.000Z"; second.metadata.dateSource = "import"
    let a = NativeAlbumPhotoAccessibility.label(first, member: "Member 1")
    let b = NativeAlbumPhotoAccessibility.label(second, member: "Member 1")
    XCTAssertNotEqual(a, b); XCTAssertTrue(a.contains(first.metadata.filename))
    XCTAssertTrue(a.contains("Photo date")); XCTAssertTrue(b.contains("Import date"))
    XCTAssertTrue(a.contains("Member 1")); XCTAssertFalse(a.contains(server.cards[0].accountId))
  }
  @MainActor func testTripDownloadReadsEveryPageDeduplicatesAndLeavesVisibleGalleryBounded() async throws {
    try await withAlbum { _, server, model in
      let extra = try server.extraOwnedPhotos(count: 108); try server.contribute(extra)
      try await model.refresh(); try await model.open(server.definition.albumId)
      let visibleIDs = model.items.map(\.id), cursor = model.nextCursor
      XCTAssertEqual(visibleIDs.count, 100)
      let result = try await model.downloadTrip()
      defer { result.remove() }
      XCTAssertEqual(result.originals, 2); XCTAssertEqual(result.omittedCopies, 107)
      XCTAssertEqual(server.originalReads, 2, "Read one original for each authenticated exact group")
      XCTAssertEqual(model.items.map(\.id), visibleIDs); XCTAssertEqual(model.nextCursor, cursor)
      let zip = try Data(contentsOf: result.archive)
      XCTAssertEqual(zip.prefix(4), Data([0x50, 0x4b, 0x03, 0x04]))
      XCTAssertNotNil(zip.range(of: Data(server.source.metadata.filename.utf8)))
      XCTAssertNotNil(zip.range(of: Data("public-batch.jpg".utf8)))
      XCTAssertFalse(FileManager.default.fileExists(atPath: result.directory.appendingPathComponent("Trip").path))
      XCTAssertTrue(FileManager.default.fileExists(atPath: result.archive.path), "The ZIP must outlive the coordinator accessor")
    }
  }
  @MainActor func testTripDownloadPreservesSameFilenameDifferentOriginals() async throws {
    try await withAlbum { _, server, model in
      let other = try server.extraOwnedPhotos(count: 1, filename: server.source.metadata.filename); try server.contribute(other)
      try await model.refresh(); try await model.open(server.definition.albumId)
      let result = try await model.downloadTrip(archive: { folder, destination in
        let directories = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        XCTAssertEqual(directories.count, 2)
        let files = try directories.map { try XCTUnwrap(FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil).first) }
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), [server.source.metadata.filename])
        XCTAssertNotEqual(try Data(contentsOf: files[0]), try Data(contentsOf: files[1]))
        try NativeTripArchive.create(folder: folder, destination: destination)
      })
      defer { result.remove() }
      XCTAssertEqual(result.originals, 2); XCTAssertEqual(result.omittedCopies, 0)
    }
  }
  @MainActor func testTripDownloadIncompleteOrCyclicPagesNeverExportPartialTrip() async throws {
    for invalid in ["missing", "cursor"] {
      try await withAlbum { _, server, model in
        let extra = try server.extraOwnedPhotos(count: 100); try server.contribute(extra)
        try await model.refresh(); try await model.open(server.definition.albumId)
        server.omitLastPageItem = invalid == "missing"; server.repeatPageCursor = invalid == "cursor"
        do { _ = try await model.downloadTrip(archive: { _, _ in XCTFail("Incomplete traversal cannot package") }); XCTFail("Invalid traversal completed") } catch {}
        XCTAssertEqual(server.originalReads, 0)
      }
    }
  }
  @MainActor func testTripDownloadCanUseAnotherVerifiedIdenticalCopyAfterOneOriginalFails() async throws {
    try await withAlbum { _, server, model in
      let bytes = try Data(contentsOf: Bundle.main.url(forResource: "singapore", withExtension: "jpg")!)
      let duplicate = try server.extraOwnedPhotos(count: 1, originalBytes: bytes); try server.contribute(duplicate)
      try await model.refresh(); try await model.open(server.definition.albumId)
      server.failObjectOnce = server.source.manifest.representations.first { $0.binding.kind == "original" }?.objectId
      let result = try await model.downloadTrip()
      defer { result.remove() }
      XCTAssertEqual(result.originals, 1); XCTAssertEqual(result.omittedCopies, 1); XCTAssertEqual(server.originalReads, 2)
    }
  }
  @MainActor func testTripDownloadOriginalFailureOrRevocationCleansAllStaging() async throws {
    for failure in ["object", "ended", "disk"] {
      try await withAlbum { _, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        if failure == "object" { server.failObjectOnce = server.source.manifest.representations.first { $0.binding.kind == "original" }?.objectId }
        if failure == "ended" { server.endOnOriginal = true }
        do {
          _ = try await model.downloadTrip(temporaryRoot: temporary, archive: { _, _ in
            guard failure == "disk" else { XCTFail("Unavailable original cannot package"); return }
            throw CocoaError(.fileWriteOutOfSpace)
          })
          XCTFail("Partial trip cannot complete")
        } catch {}
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: temporary.path).isEmpty, failure)
      }
    }
  }
  @MainActor func testTripDownloadLateArchiveCannotPublishAfterScopeChangeOrCancellation() async throws {
    for change in ["cancel", "vault", "account", "origin", "catalog", "definition", "end", "count"] {
      try await withAlbum { services, server, model in
        try await model.refresh(); try await model.open(server.definition.albumId)
        let gate = AlbumFactsRequestGate(started: expectation(description: "Trip ZIP " + change))
        defer { gate.release.signal() }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let download = Task { try await model.downloadTrip(temporaryRoot: temporary, archive: { _, destination in
          gate.started.fulfill(); _ = gate.release.wait(timeout: .now() + 5)
          try Data("controlled archive".utf8).write(to: destination)
        }) }
        await fulfillment(of: [gate.started], timeout: 3)
        switch change {
        case "cancel": download.cancel()
        case "vault": services.vault.lock()
        case "account": services.session.accountId = server.cards[0].accountId
        case "origin": services.api.baseURL = URL(string: "http://localhost:8798")!
        case "catalog": services.store = try LibraryStore(root: temporary.appendingPathComponent("catalog"))
        case "definition": server.signed = try NativeAlbumCrypto().make(title: "Changed trip", owner: server.cards[0], members: [server.cards[1]], bundle: server.bundles[0])
        case "end": server.ended = true
        default: try server.contribute(server.extraOwnedPhotos(count: 1))
        }
        gate.release.signal()
        do { let unexpected = try await download.value; unexpected.remove(); XCTFail("Late ZIP escaped \(change) fence") } catch {}
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: temporary.path).filter { $0.hasPrefix("fotoro-album-download-") }
        XCTAssertTrue(leftovers.isEmpty, change)
      }
    }
  }
  func testTripResourceFingerprintDeduplicatesRenamedCompleteLivePairsWithoutDroppingDistinctMotion() throws {
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live"))
    let bytes = try Data(contentsOf: url), pair = try CameraMedia.decodeLivePhoto(bytes)
    var still = pair.still, motion = pair.motion
    still.filename = "renamed." + URL(fileURLWithPath: still.filename).pathExtension
    motion.filename = "renamed." + URL(fileURLWithPath: motion.filename).pathExtension
    let renamed = try CameraMedia.encodeLivePhoto(still: still, motion: motion)
    var metadata = try AlbumTestServer().source.metadata; metadata.mediaType = CameraMedia.liveType
    XCTAssertNotEqual(bytes.digest, renamed.digest)
    XCTAssertEqual(try NativeTripArchive.fingerprint(bytes, metadata: metadata), try NativeTripArchive.fingerprint(renamed, metadata: metadata))
    motion.bytes.append(0)
    let changed = try CameraMedia.encodeLivePhoto(still: still, motion: motion)
    XCTAssertNotEqual(try NativeTripArchive.fingerprint(bytes, metadata: metadata), try NativeTripArchive.fingerprint(changed, metadata: metadata))
    var incomplete = bytes; incomplete.removeLast()
    XCTAssertThrowsError(try NativeTripArchive.fingerprint(incomplete, metadata: metadata))
  }
  @MainActor func testTripDownloadDeduplicatesRenamedLivePairsAndArchivesBothOriginalResources() async throws {
    try await withAlbum { _, server, model in
      let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live"))
      let bytes = try Data(contentsOf: url), pair = try CameraMedia.decodeLivePhoto(bytes)
      var still = pair.still, motion = pair.motion
      still.filename = "renamed." + URL(fileURLWithPath: still.filename).pathExtension
      motion.filename = "renamed." + URL(fileURLWithPath: motion.filename).pathExtension
      let renamed = try CameraMedia.encodeLivePhoto(still: still, motion: motion)
      server.included = false
      try server.contribute(server.extraOwnedPhotos(count: 1, originalBytes: bytes, filename: "live.fotoro-live", mediaType: CameraMedia.liveType))
      try server.contribute(server.extraOwnedPhotos(count: 1, originalBytes: renamed, filename: "renamed.fotoro-live", mediaType: CameraMedia.liveType))
      try await model.refresh(); try await model.open(server.definition.albumId)
      let result = try await model.downloadTrip(archive: { folder, destination in
        let directories = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        XCTAssertEqual(directories.count, 1)
        let directory = try XCTUnwrap(directories.first)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        XCTAssertEqual(Set(files.map(\.lastPathComponent)), [pair.still.filename, pair.motion.filename])
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(pair.still.filename)), pair.still.bytes)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent(pair.motion.filename)), pair.motion.bytes)
        try NativeTripArchive.create(folder: folder, destination: destination)
      })
      defer { result.remove() }
      XCTAssertEqual(result.originals, 1); XCTAssertEqual(result.omittedCopies, 1); XCTAssertEqual(server.originalReads, 2)
    }
  }
  @MainActor func testTripDownloadSanitizesCrossPlatformFilenamesWithoutChangingOriginalResources() async throws {
    for sourceName in ["..\\outside.jpg", "C:outside.jpg", "line\nname.jpg", "CON.jpg", "trailing.jpg.", "live"] {
      try await withAlbum { _, server, model in
        server.included = false
        let bytes: Data, type: String, filename: String, expected: [Data]
        if sourceName == "live" {
          let source = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live")))
          var pair = try CameraMedia.decodeLivePhoto(source)
          pair.motion.filename = "unsafe:" + pair.motion.filename
          bytes = try CameraMedia.encodeLivePhoto(still: pair.still, motion: pair.motion)
          type = CameraMedia.liveType; filename = "live.fotoro-live"; expected = [pair.still.bytes, pair.motion.bytes]
        } else { bytes = Data("controlled original".utf8); type = "image/jpeg"; filename = sourceName; expected = [bytes] }
        try server.contribute(server.extraOwnedPhotos(count: 1, originalBytes: bytes, filename: filename, mediaType: type))
        try await model.refresh(); try await model.open(server.definition.albumId)
        let result = try await model.downloadTrip(archive: { folder, destination in
          let directory = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).first)
          let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
          XCTAssertEqual(files.count, expected.count)
          for url in files {
            XCTAssertEqual(NativeTripArchive.safeFilename(url.lastPathComponent), url.lastPathComponent)
            XCTAssertTrue(expected.contains(try Data(contentsOf: url)))
          }
          try NativeTripArchive.create(folder: folder, destination: destination)
        })
        defer { result.remove() }
        XCTAssertEqual(result.originals, 1)
      }
    }
  }
  func testTripExportSanitizationPreservesCollidingResourcesAndRejectsLiveTraversal() throws {
    let directory = try NativeTripArchive.prepareDirectory(in: FileManager.default.temporaryDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }
    let a = directory.appendingPathComponent("same:name.jpg"), b = directory.appendingPathComponent("same?name.jpg")
    let first = Data("first original".utf8), second = Data("second original".utf8)
    try first.write(to: a); try second.write(to: b)
    let renamed = try NativeTripArchive.sanitizeExports([a, b], directory: directory)
    XCTAssertEqual(renamed.map(\.lastPathComponent), ["same_name.jpg", "same_name-2.jpg"])
    XCTAssertEqual(try Data(contentsOf: renamed[0]), first); XCTAssertEqual(try Data(contentsOf: renamed[1]), second)
    XCTAssertEqual(NativeTripArchive.safeFilename("CON .jpg"), "_CON .jpg")
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "camera-live", withExtension: "fotoro-live"))
    let pair = try CameraMedia.decodeLivePhoto(Data(contentsOf: url))
    var traversal = pair.motion; traversal.filename = "../outside.mov"
    XCTAssertThrowsError(try CameraMedia.encodeLivePhoto(still: pair.still, motion: traversal))
    traversal.filename = "..\\outside.mov"
    XCTAssertThrowsError(try CameraMedia.encodeLivePhoto(still: pair.still, motion: traversal))
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

private actor AlbumPickerReadGate {
  private(set) var started = false
  private var continuation: CheckedContinuation<[LocalPhoto], Never>?
  func read() async -> [LocalPhoto] {
    await withCheckedContinuation { continuation = $0; started = true }
  }
  func finish(_ photos: [LocalPhoto]) { continuation?.resume(returning: photos); continuation = nil }
}

private func factsAccess(_ server: AlbumTestServer) throws -> NativeAlbumAccess {
  let (_, key, _) = try NativeAlbumCrypto().open(server.signed, expectedID: server.definition.albumId,
    trustedOwner: server.cards[0], recipient: server.cards[0], bundle: server.bundles[0], trusted: [:])
  let context = NativeAlbumContext(photo: PhotoAccountAccess(account: server.cards[0].accountId, vault: UUID(), catalog: ObjectIdentifier(server)),
    origin: "http://127.0.0.1:8798", apiOrigin: "http://localhost:4310", cards: Dictionary(uniqueKeysWithValues: server.cards.map { ($0.accountId, $0) }),
    token: nil, fixture: true, epoch: UUID())
  return NativeAlbumAccess(context: context, albumID: server.definition.albumId, signedDefinition: server.signed, definition: server.definition, key: key)
}

private final class AlbumFactsRequestGate: @unchecked Sendable {
  let started: XCTestExpectation
  let release = DispatchSemaphore(value: 0)
  init(started: XCTestExpectation) { self.started = started }
}

private final class AlbumTestServer: @unchecked Sendable {
  let cards: [AccountCardV1]; let bundles: [AccountBundle]; var signed: SignedPayloadV1; var definition: AlbumDefinitionV1
  let source: LocalPhoto; let metadataKey: Data; let entry: SignedPayloadV1; let manifest: SignedPayloadV1
  private let objects: [String: Data]
  private var originalIDs = Set<String>()
  private(set) var originalReads = 0
  var omitLastPageItem = false
  var repeatPageCursor = false
  var endOnOriginal = false
  var accepted = true; var endOnObject = false; var ended = false
  var failObjectOnce: String?
  var included = true; var loseAppendResponse = false; var appendBodies: [Data] = []
  private var receipts: [String: (Data, AlbumAppendResultV1)] = [:]
  private var contributions: [(SignedPayloadV1, SignedPayloadV1)] = []
  private var extraObjects: [String: Data] = [:]
  private var owned: [String: SignedPayloadV1] = [:]
  var creationBodies: [Data] = []; var loseCreateResponse = false; var failInbox = false
  var inboxStatus: Int?
  var extraInbox: [AlbumOverviewV1] = []
  var hideInboxAlbum = false
  var accessStatus: Int?
  var accessGate: AlbumFactsRequestGate?
  var accountMismatchCount = 0; var authAccountHeader: String?
  var factsCapabilityStatus = 404
  var endOnFacts = false
  var factsPageReads = 0; var factsIndividualReads = 0
  var factsWriteBodies: [Data] = []
  var factsGate: AlbumFactsRequestGate?
  var loseFactsWriteResponse = false
  private var sharedDetails: [String: SignedPayloadV1] = [:]
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
    var initialOriginalIDs = Set<String>()
    for kind in ["original", "thumbnail", "preview"] {
      let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: kind), secret = crypto.randomKey()
      let container = try crypto.encrypt(bytes, key: secret, binding: binding), objectID = Wire.id()
      reps.append(RepresentationV1(binding: binding, objectId: objectID, header: container.prefix(24).b64, ciphertextBytes: container.count, ciphertextSha256: container.digest))
      keys[binding.representationId] = secret.b64; encrypted[objectID] = container
      if kind == "original" { initialOriginalIDs.insert(objectID) }
    }
    let metadata = PhotoMetadataV1(filename: "public-album-fixture.jpg", mediaType: "image/jpeg", sourceDate: Wire.date(), dateSource: "import", originalBytes: bytes.count, originalSha256: bytes.digest, representationKeys: keys)
    let binding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata"), container = try crypto.encrypt(Wire.encode(metadata), key: metaKey, binding: binding), id = Wire.id()
    let rep = RepresentationV1(binding: binding, objectId: id, header: container.prefix(24).b64, ciphertextBytes: container.count, ciphertextSha256: container.digest)
    encrypted[id] = container; objects = encrypted; originalIDs = initialOriginalIDs
    let value = PhotoManifestV1(photoId: photoID, ownerAccountId: cards[0].accountId, representations: reps, metadataRepresentation: rep, ownerWrappedMetadataKey: try crypto.wrap(metaKey, key: Data(b64: bundles[0].vaultKey)))
    source = LocalPhoto(photoId: photoID, manifest: value, metadata: metadata, transferState: "committed")
    entry = try c.append(source, definition: definition, albumKey: key, card: cards[0], bundle: bundles[0]).0
    func text<T: Encodable>(_ value: T) throws -> String { String(data: try Wire.encode(value), encoding: .utf8)! }
    let browserBody = try "{\"version\":1,\"photoId\":" + text(value.photoId) + ",\"ownerAccountId\":" + text(value.ownerAccountId) + ",\"representations\":" + text(value.representations) + ",\"metadataRepresentation\":" + text(value.metadataRepresentation) + ",\"ownerWrappedMetadataKey\":" + text(value.ownerWrappedMetadataKey) + "}"
    manifest = try crypto.signBytes(Data(browserBody.utf8), kind: "photo-manifest", accountId: cards[0].accountId, secret: Data(b64: bundles[0].signingSecretKey))
  }
  func extraOwnedPhotos(count: Int, originalBytes: Data? = nil, filename: String = "public-batch.jpg", mediaType: String = "image/jpeg", sourceDate: String? = nil, dateSource: String = "import") throws -> [LocalPhoto] {
    let crypto = CryptoAdapter(); var photos: [LocalPhoto] = []
    for _ in 0..<count {
      let photoID = Wire.id(), originalKey = crypto.randomKey(), key = crypto.randomKey()
      let bytes = originalBytes ?? Data("public batch fixture".utf8), originalBinding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "original")
      let original = try crypto.encrypt(bytes, key: originalKey, binding: originalBinding), originalID = Wire.id()
      let rep = RepresentationV1(binding: originalBinding, objectId: originalID, header: original.prefix(24).b64, ciphertextBytes: original.count, ciphertextSha256: original.digest)
      let metadata = PhotoMetadataV1(filename: filename, mediaType: mediaType, sourceDate: sourceDate ?? Wire.date(), dateSource: dateSource, originalBytes: bytes.count, originalSha256: bytes.digest, representationKeys: [originalBinding.representationId: originalKey.b64])
      let metaBinding = MediaBinding(photoId: photoID, representationId: Wire.id(), kind: "metadata"), meta = try crypto.encrypt(Wire.encode(metadata), key: key, binding: metaBinding), metaID = Wire.id()
      let metaRep = RepresentationV1(binding: metaBinding, objectId: metaID, header: meta.prefix(24).b64, ciphertextBytes: meta.count, ciphertextSha256: meta.digest)
      let value = PhotoManifestV1(photoId: photoID, ownerAccountId: cards[0].accountId, representations: [rep], metadataRepresentation: metaRep, ownerWrappedMetadataKey: try crypto.wrap(key, key: Data(b64: bundles[0].vaultKey)))
      let signed = try crypto.sign(value, kind: CameraMedia.manifestKind(for: mediaType), accountId: cards[0].accountId, secret: Data(b64: bundles[0].signingSecretKey))
      extraObjects[originalID] = original; extraObjects[metaID] = meta; owned[photoID] = signed
      originalIDs.insert(originalID)
      photos.append(LocalPhoto(photoId: photoID, manifest: value, metadata: metadata, transferState: "committed"))
    }
    return photos
  }
  func contribute(_ photos: [LocalPhoto]) throws {
    let access = try factsAccess(self)
    for photo in photos {
      let entry = try NativeAlbumCrypto().append(photo, definition: definition, albumKey: access.key, card: cards[0], bundle: bundles[0]).0
      contributions.append((entry, try XCTUnwrap(owned[photo.id])))
    }
  }
  func setFacts(_ photo: LocalPhoto, people: [String], wrongDigest: Bool = false) throws {
    let access = try factsAccess(self)
    let signedManifest = owned[photo.id] ?? manifest
    let entry = try NativeAlbumCrypto().append(photo, definition: definition, albumKey: access.key, card: cards[0], bundle: bundles[0]).0
    var source = photo
    if wrongDigest { source.metadata.originalSha256 = Data("wrong digest".utf8).digest }
    let item = NativeAlbumItem(entry: entry, signedManifest: signedManifest, photo: source)
    let prior = try sharedDetails[photo.id].map { try NativeAlbumWire.signedBody(AlbumPhotoFactsV1.self, $0, kind: NativeAlbumFacts.kind).revision } ?? 0
    sharedDetails[photo.id] = try NativeAlbumFacts.make(item: item, access: access, people: people, location: nil, revision: prior + 1, card: cards[0], bundle: bundles[0])
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
    if path == "/v1/album-photo-facts/capabilities" {
      return factsCapabilityStatus == 200 ? (200, try Wire.encode(AlbumFactsCapabilitiesV1(version: 1, albumFactsVersion: 1))) : (factsCapabilityStatus, Data())
    }
    if path.contains("/photo-facts") {
      if let gate = factsGate { factsGate = nil; lock.unlock(); gate.started.fulfill()
        _ = gate.release.wait(timeout: .now() + 5); lock.lock() }
      if endOnFacts { ended = true }
      guard accepted && !ended else { return (403, Data("{\"code\":\"ALBUM_INACTIVE\"}".utf8)) }
      if path.hasSuffix("/photo-facts") {
        factsPageReads += 1
        let cursor = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: true)?.queryItems?.first(where: { $0.name == "cursor" })?.value ?? "0") ?? 0
        let rows = try all.enumerated().compactMap { offset, pair -> (Int, SignedPayloadV1)? in
          let photo = try NativeAlbumWire.signedBody(PhotoManifestV1.self, pair.1, kind: pair.1.kind)
          guard offset + 1 > cursor, let value = sharedDetails[photo.photoId] else { return nil }
          return (offset + 1, value)
        }
        let page = Array(rows.prefix(100)), more = rows.count > 100
        return (200, try Wire.encode(AlbumPhotoFactsPageV1(version: 1, facts: page.map(\.1), nextCursor: more ? String(page.last!.0) : nil, hasMore: more)))
      }
      let id = request.url!.lastPathComponent
      if request.httpMethod == "PUT" {
        let bytes = body(), update = try NativeAlbumWire.decode(AlbumPhotoFactsRequestV1.self, bytes)
        factsWriteBodies.append(bytes)
        let next = try NativeAlbumWire.signedBody(AlbumPhotoFactsV1.self, update.facts, kind: NativeAlbumFacts.kind)
        let previous = try sharedDetails[id].map { try NativeAlbumWire.signedBody(AlbumPhotoFactsV1.self, $0, kind: NativeAlbumFacts.kind).revision } ?? 0
        if next.revision != previous + 1 { return (409, Data("{\"code\":\"VERSION_CONFLICT\"}".utf8)) }
        sharedDetails[id] = update.facts
        if loseFactsWriteResponse { loseFactsWriteResponse = false; throw URLError(.networkConnectionLost) }
      } else { factsIndividualReads += 1 }
      return (200, try Wire.encode(AlbumPhotoFactsReplyV1(version: 1, facts: sharedDetails[id])))
    }
    if path.hasSuffix("/capabilities") { return (200, try Wire.encode(AlbumCapabilitiesV1(version: 1, albumsVersion: 1, maxMembers: 12, maxPhotos: 1000, pageSize: 100))) }
    if path == "/v1/albums" {
      if let inboxStatus { return (inboxStatus, Data()) }
      if failInbox { throw URLError(.notConnectedToInternet) }
      return (200, try Wire.encode(AlbumInboxV1(version: 1, albums: extraInbox + (hideInboxAlbum ? [] : [overview]))))
    }
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
    if path.hasSuffix("/access") {
      accessCount += 1
      if let gate = accessGate { accessGate = nil; lock.unlock(); gate.started.fulfill()
        _ = gate.release.wait(timeout: .now() + 5); lock.lock() }
      if let accessStatus {
        if accessStatus == 0 { throw URLError(.timedOut) }
        if accessStatus == -999 { throw URLError(.cancelled) }
        return (accessStatus, Data())
      }
      return accepted && !ended ? (200, try Wire.encode(overview)) : (403, Data("{\"code\":\"ALBUM_INACTIVE\"}".utf8))
    }
    if path.hasPrefix("/v1/objects/") {
      objectCount += 1; if endOnObject { ended = true }
      if originalIDs.contains(request.url!.lastPathComponent) { originalReads += 1; if endOnOriginal { ended = true } }
      if request.url!.lastPathComponent == failObjectOnce {
        failObjectOnce = nil; throw URLError(.networkConnectionLost)
      }
      return (extraObjects[request.url!.lastPathComponent] ?? objects[request.url!.lastPathComponent]).map { (200, $0) } ?? (404, Data())
    }
    if path == "/v1/albums/" + definition.albumId {
      let cursor = Int(URLComponents(url: request.url!, resolvingAgainstBaseURL: true)?.queryItems?.first(where: { $0.name == "cursor" })?.value ?? "0") ?? 0
      var slice = accepted && !ended ? Array(all.dropFirst(cursor).prefix(100)) : []
      if omitLastPageItem, cursor + slice.count == all.count, !slice.isEmpty { slice.removeLast() }
      let next = repeatPageCursor ? "0" : (cursor + slice.count < all.count && !omitLastPageItem ? String(cursor + slice.count) : nil)
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
