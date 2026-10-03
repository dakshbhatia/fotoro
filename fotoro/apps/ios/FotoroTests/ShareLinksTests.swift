import XCTest

@testable import Fotoro

private struct ShareLinkVectors: Decodable {
  struct Invalid: Decodable { var name: String; var url: String }
  var version: Int
  var card: AccountCardV1
  var grantId: String
  var contactLink: String
  var momentLink: String
  var invalidLinks: [Invalid]
}

final class ShareLinksTests: XCTestCase {
  func testCanonicalPublicLinksMatchTypeScript() throws {
    let vector = try fixture(ShareLinkVectors.self, "share-links-v1")
    XCTAssertEqual(try FotoroShareLinks.contactURL(vector.card).absoluteString, vector.contactLink)
    XCTAssertEqual(try FotoroShareLinks.momentURL(grantId: vector.grantId, senderCard: vector.card).absoluteString, vector.momentLink)
    XCTAssertEqual(try FotoroShareLinks.parse(vector.contactLink), .contact(vector.card))
    XCTAssertEqual(try FotoroShareLinks.parse(URL(string: vector.momentLink)!), .moment(FotoroMomentInvitation(grantId: vector.grantId, senderCard: vector.card)))
  }
  func testMalformedForeignAndHiddenFieldsAreRejected() throws {
    let vector = try fixture(ShareLinkVectors.self, "share-links-v1")
    for invalid in vector.invalidLinks {
      XCTAssertThrowsError(try FotoroShareLinks.parse(invalid.url), invalid.name)
      if let url = URL(string: invalid.url) { XCTAssertThrowsError(try FotoroShareLinks.parse(url), invalid.name) }
    }
  }
  func testExplicitOriginsKeepStrictServiceBoundaries() throws {
    let vector = try fixture(ShareLinkVectors.self, "share-links-v1")
    for origin in ["http://localhost:4310", "http://127.0.0.1:4310", "http://[::1]:4310", "https://photos.example.com"] {
      let url = try FotoroShareLinks.contactURL(vector.card, origin: origin)
      XCTAssertEqual(try FotoroShareLinks.parse(url, expectedOrigin: origin), .contact(vector.card))
      XCTAssertThrowsError(try FotoroShareLinks.parse(url))
    }
    for origin in ["http://evil.invalid", "https://fotoro.cloud/", "https://FOTORO.cloud", "https://fotoro.cloud:443", "https://user@fotoro.cloud", "https://fotoro.cloud?x=1", "https://fotoro.cloud.", "http://localhost:04310", "http://localhost:65536", "https://127.1", "https://bad_host.invalid", "https://-bad.invalid"] {
      XCTAssertThrowsError(try FotoroShareLinks.contactURL(vector.card, origin: origin), origin)
    }
  }
  func testCreationRejectsInvalidKeysAndIdsWithoutTrustSideEffects() throws {
    let vector = try fixture(ShareLinkVectors.self, "share-links-v1")
    var card = vector.card
    card.boxPublicKey = String(card.boxPublicKey.dropLast()) + "d"
    XCTAssertThrowsError(try FotoroShareLinks.contactURL(card))
    XCTAssertThrowsError(try FotoroShareLinks.momentURL(grantId: "../vault", senderCard: vector.card))
    card = vector.card
    card.version = 2
    XCTAssertThrowsError(try FotoroShareLinks.contactURL(card))
    card = vector.card
    card.signingPublicKey = String(repeating: "A", count: 43)
    XCTAssertEqual(try FotoroShareLinks.parse(FotoroShareLinks.contactURL(card)), .contact(card))
  }
}
