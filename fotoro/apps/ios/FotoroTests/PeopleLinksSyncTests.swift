import GRDB
import XCTest
@testable import Fotoro

final class PeopleLinksSyncTests: XCTestCase {
  private func setup() throws -> (PeopleLinksLedger, FixtureAccounts, URL) {
    let accounts = try fixture(FixtureAccounts.self, "accounts"), secret = accounts.testSecrets[0]
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
    let ledger = PeopleLinksLedger(store: try LibraryStore(root: root), owner: accounts.accounts[0].accountId,
      origin: "https://people.invalid:443", bundle: AccountBundle(vaultKey: secret.vaultKey, boxSecretKey: secret.boxSecretKey, signingSecretKey: secret.signingSecretKey), card: accounts.accounts[0])
    try ledger.bootstrap(); return (ledger, accounts, root)
  }
  private func link(_ cards: [AccountCardV1], name: String = "Mom") -> TripPersonLinkV1 {
    TripPersonLinkV1(id: Wire.id(), origin: "https://people.invalid", albumId: "11111111-1111-4111-8111-111111111111",
      ownerCard: cards[0], name: name, aliases: [TripPersonAliasV1(card: cards[0], name: "Mom"), TripPersonAliasV1(card: cards[1], name: "Mother")], deleted: false)
  }
  func testEncryptedExactRetryReopenAcknowledgementAndTombstone() throws {
    let (ledger, accounts, root) = try setup(); defer { try? FileManager.default.removeItem(at: root) }
    var linked = link(accounts.accounts); try ledger.edit(linked)
    let first = try XCTUnwrap(ledger.prepare()), signed = try Wire.decode(SignedPayloadV1.self, first)
    let reopened = PeopleLinksLedger(store: ledger.store, owner: ledger.owner, origin: ledger.origin, bundle: ledger.bundle, card: ledger.card)
    XCTAssertEqual(try reopened.prepare(), first, "Lost response must replay the exact signed request")
    let opened = try PeopleLinksCrypto.open(signed, card: ledger.card, bundle: ledger.bundle)
    XCTAssertEqual(opened.book.links, [linked.canonical]); XCTAssertEqual(opened.revision, 1)
    let stored = try ledger.store.database.read { try Data.fetchOne($0, sql: "SELECT value FROM operations WHERE id=?", arguments: [ledger.key]) }
    XCTAssertFalse(String(decoding: try XCTUnwrap(stored), as: UTF8.self).contains("Mother"))
    linked.deleted = true; try reopened.edit(linked)
    try reopened.receive(signed)
    XCTAssertTrue(try reopened.state().draft.links[0].deleted, "Acknowledgement cannot discard a later explicit deletion")
    let tombstone = try Wire.decode(SignedPayloadV1.self, XCTUnwrap(reopened.prepare()))
    XCTAssertEqual(try PeopleLinksCrypto.open(tombstone, card: ledger.card, bundle: ledger.bundle).revision, 2)
    try reopened.receive(tombstone); XCTAssertNil(try reopened.prepare())
    XCTAssertThrowsError(try reopened.receive(signed), "A rollback cannot revive a deleted identity")
    let other = PeopleLinksLedger(store: ledger.store, owner: ledger.owner, origin: "https://other.invalid:443", bundle: ledger.bundle, card: ledger.card)
    try other.bootstrap(); XCTAssertTrue(try other.state().draft.links.isEmpty)
    var wrong = ledger.card; wrong.accountId = Wire.id()
    XCTAssertThrowsError(try PeopleLinksCrypto.open(signed, card: wrong, bundle: ledger.bundle))
  }
  func testWholeBookConflictsRemainStickyUntilConvergedOrExplicitlyReviewed() throws {
    let (ledger, accounts, root) = try setup(); defer { try? FileManager.default.removeItem(at: root) }
    let empty = AccountPeopleLinksV1(ownerAccountId: ledger.owner)
    let mine = AccountPeopleLinksV1(ownerAccountId: ledger.owner, links: [link(accounts.accounts)])
    let theirs = AccountPeopleLinksV1(ownerAccountId: ledger.owner, links: [link(accounts.accounts, name: "Grandma")])
    XCTAssertEqual(try PeopleLinksMerge.merge(base: empty, local: empty, remote: theirs).value, theirs.canonical)
    XCTAssertFalse(try PeopleLinksMerge.merge(base: empty, local: mine, remote: empty).conflict)
    XCTAssertTrue(try PeopleLinksMerge.merge(base: empty, local: mine, remote: theirs).conflict)
    XCTAssertTrue(try PeopleLinksMerge.merge(base: theirs, local: mine, remote: theirs, unresolved: true).conflict)
    XCTAssertFalse(try PeopleLinksMerge.merge(base: empty, local: mine, remote: mine, unresolved: true).conflict)
    try ledger.edit(mine.links[0])
    let synced = try PeopleLinksCrypto.seal(theirs, revision: 1, bundle: ledger.bundle)
    try ledger.receive(synced); XCTAssertNil(try ledger.prepare())
    let state = try ledger.state(), review = PeopleLinksReview(owner: ledger.owner, origin: ledger.origin, epoch: UUID(), local: state.draft, synced: state.base)
    try ledger.resolve(review, keepLocal: false)
    XCTAssertEqual(try ledger.state().draft, theirs.canonical); XCTAssertNil(try ledger.prepare())
    XCTAssertThrowsError(try ledger.resolve(review, keepLocal: true), "A stale review cannot change an already resolved book")
  }
  func testRemovalRequiresExactReviewedOriginalAndPreservesEveryAliasInTombstone() throws {
    let (ledger, accounts, root) = try setup(); defer { try? FileManager.default.removeItem(at: root) }
    let original = link(accounts.accounts); try ledger.edit(original)
    var changed = original; changed.name = "Family Mom"; try ledger.edit(changed)
    XCTAssertThrowsError(try ledger.remove(original), "A concurrent edit requires a new review before removal")
    XCTAssertFalse(try ledger.state().draft.links[0].deleted)
    try ledger.remove(changed)
    let removed = try XCTUnwrap(ledger.state().draft.links.first)
    XCTAssertTrue(removed.deleted); XCTAssertEqual(removed.aliases, changed.canonical.aliases)
    XCTAssertThrowsError(try ledger.remove(changed), "A queued second removal cannot revive or rewrite a tombstone")
  }
  func testValidationExactNamesScopeOverlapAndCanonicalOrigins() throws {
    let (ledger, accounts, root) = try setup(); defer { try? FileManager.default.removeItem(at: root) }
    var value = link(accounts.accounts), book = AccountPeopleLinksV1(ownerAccountId: ledger.owner, links: [value])
    try PeopleLinksCrypto.validate(book, owner: ledger.owner)
    value.id = Wire.id(); book.links.append(value)
    XCTAssertThrowsError(try PeopleLinksCrypto.validate(book, owner: ledger.owner))
    book.links[1].deleted = true; try PeopleLinksCrypto.validate(book, owner: ledger.owner)
    book.links[0].name = String(repeating: "😀", count: 41)
    XCTAssertThrowsError(try PeopleLinksCrypto.validate(book, owner: ledger.owner))
    book.links = [link(accounts.accounts)]; book.links[0].origin += ":443"
    XCTAssertThrowsError(try PeopleLinksCrypto.validate(book, owner: ledger.owner))
    XCTAssertEqual(PeopleLinksCrypto.origin(URL(string: "https://people.invalid:443/api")!), "https://people.invalid")
    XCTAssertEqual(PeopleLinksCrypto.origin(URL(string: "https://fotoro.cloud")!), "https://fotoro.cloud")
    XCTAssertEqual(PeopleLinksCrypto.origin(URL(string: "https://fotoro.cloud:443")!), "https://fotoro.cloud")
    XCTAssertNotEqual(TripPersonAliasV1(card: accounts.accounts[0], name: "é"), TripPersonAliasV1(card: accounts.accounts[0], name: "e\u{301}"))
  }
  func testTripScopeWithdrawsDeletedLinksAndChangedContributorIdentities() throws {
    let accounts = try fixture(FixtureAccounts.self, "accounts"), linked = link(accounts.accounts)
    func active(_ value: TripPersonLinkV1, origin: String = "https://people.invalid", album: String? = nil, cards: [AccountCardV1]? = nil) -> [TripPersonLinkV1] {
      TripPersonLinkScope.active([value], origin: origin, albumID: album ?? linked.albumId, owner: accounts.accounts[0], contributors: cards ?? accounts.accounts)
    }
    XCTAssertEqual(active(linked), [linked])
    XCTAssertTrue(active(linked, origin: "https://another.invalid").isEmpty)
    XCTAssertTrue(active(linked, album: Wire.id()).isEmpty)
    var changed = accounts.accounts; changed[1].signingPublicKey = accounts.accounts[0].signingPublicKey
    XCTAssertEqual(active(linked, cards: changed).first?.aliases, [linked.aliases[0]], "A rotated alias withdraws only that contributor; the remaining confirmed alias stays valid")
    XCTAssertEqual(linked.aliases.count, 2, "Projection must not rewrite the durable reviewed link")
    var removed = linked; removed.deleted = true; XCTAssertTrue(active(removed).isEmpty)
    var anotherOwner = linked; anotherOwner.ownerCard = accounts.accounts[1]; XCTAssertTrue(active(anotherOwner).isEmpty)
  }
  #if !FOTORO_LOCAL_PREVIEW
  func testLinkedPeopleRequireEachDistinctPersonOnSameAuthenticatedPhoto() throws {
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let mom = link(accounts.accounts)
    var dad = link(accounts.accounts, name: "Dad")
    dad.aliases = [TripPersonAliasV1(card: accounts.accounts[0], name: "Dad"), TripPersonAliasV1(card: accounts.accounts[1], name: "Father")]
    func item(_ card: AccountCardV1) -> NativeAlbumItem {
      let id = Wire.id(), rep = RepresentationV1(binding: MediaBinding(photoId: id, representationId: Wire.id(), kind: "metadata"), objectId: "object", header: "", ciphertextBytes: 1, ciphertextSha256: "cipher")
      let photo = LocalPhoto(photoId: id, manifest: PhotoManifestV1(photoId: id, ownerAccountId: card.accountId, representations: [], metadataRepresentation: rep, ownerWrappedMetadataKey: WrappedKeyV1(nonce: "", ciphertext: "")), metadata: PhotoMetadataV1(filename: "photo.jpg", mediaType: "image/jpeg", sourceDate: "2026-10-02T00:00:00Z", dateSource: "photos", originalBytes: 1, originalSha256: "same", representationKeys: [:]), transferState: "committed")
      let signed = SignedPayloadV1(kind: "test", accountId: card.accountId, body: "", signature: "")
      return NativeAlbumItem(entry: signed, signedManifest: signed, photo: photo)
    }
    let first = item(accounts.accounts[0]), second = item(accounts.accounts[1])
    func facts(_ item: NativeAlbumItem, _ names: [String]) -> AlbumPhotoFactsContentV1 {
      AlbumPhotoFactsContentV1(albumId: mom.albumId, photoId: item.id, ownerAccountId: item.photo.manifest.ownerAccountId, definitionSignature: "definition", revision: 1, originalSha256: "same", people: names)
    }
    var supplied = [first.id: facts(first, ["Mom"]), second.id: facts(second, ["Father"])]
    let everyone = NativeAlbumSearchFilter(people: ["linked:" + mom.id, "linked:" + dad.id], match: .everyone)
    XCTAssertTrue(NativeAlbumSearch.snapshot(items: [first, second], facts: supplied, filter: everyone, groupDuplicates: true, links: [mom, dad]).items.isEmpty, "Copies and contributors must never stitch names into one photo")
    supplied[second.id] = facts(second, ["Mother", "Father"])
    XCTAssertEqual(NativeAlbumSearch.unlinkedChoices(items: [first, second], facts: supplied, links: [mom]).map(\.name), ["Father"], "Already linked aliases cannot be offered for an overlapping confirmation")
    XCTAssertEqual(NativeAlbumSearch.snapshot(items: [first, second], facts: supplied, filter: everyone, groupDuplicates: true, links: [mom, dad]).items.map(\.id), [second.id])
    XCTAssertEqual(NativeAlbumSearch.snapshot(items: [first, second], facts: supplied, filter: NativeAlbumSearchFilter(query: "Mom"), groupDuplicates: false, links: [mom]).items.count, 2, "Confirmed canonical labels can match either contributor's own alias")
    var wrong = supplied[second.id]!; wrong.originalSha256 = "changed"
    XCTAssertTrue(NativeAlbumSearch.choices(items: [second], facts: [second.id: wrong]).isEmpty, "Stale facts cannot offer a name for linking")
    XCTAssertTrue(NativeAlbumSearch.snapshot(items: [second], facts: [second.id: wrong], filter: everyone, groupDuplicates: false, links: [mom, dad]).items.isEmpty, "Stale facts cannot supply a linked identity")
    XCTAssertTrue(NativeAlbumSearch.snapshot(items: [first, second], facts: [:], filter: everyone, groupDuplicates: false, links: [mom, dad]).items.isEmpty)
  }
  #endif
}
