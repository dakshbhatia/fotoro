import XCTest

@testable import Fotoro

struct Vectors: Decodable {
  struct Media: Decodable {
    var binding: MediaBinding
    var key: String
    var plaintext: String
    var plaintextSha256: String
    var container: String
  }
  struct Negative: Decodable {
    var wrongKey: String
    var wrongBinding: MediaBinding
    var truncated: String
    var reordered: String
    var trailing: String
  }
  struct Share: Decodable { var envelope: ShareKeyEnvelopeV1 }
  var media: Media
  var negative: Negative
  var wrappedKey: WrappedKeyV1
  var share: Share
  var signed: SignedPayloadV1
}
func fixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
  try Wire.decode(
    type,
    Data(
      contentsOf: Bundle(for: CryptoVectorTests.self).url(forResource: name, withExtension: "json")!
    ))
}
final class CryptoVectorTests: XCTestCase {
  func testGoldenMediaAndRejections() throws {
    let v = try fixture(Vectors.self, "crypto-v1")
    let crypto = CryptoAdapter()
    let key = try Data(b64: v.media.key)
    let container = try Data(b64: v.media.container)
    let bytes = try crypto.decrypt(container, key: key, binding: v.media.binding)
    XCTAssertEqual(bytes.b64, v.media.plaintext)
    XCTAssertEqual(bytes.digest, v.media.plaintextSha256)
    XCTAssertThrowsError(
      try crypto.decrypt(container, key: Data(b64: v.negative.wrongKey), binding: v.media.binding))
    XCTAssertThrowsError(try crypto.decrypt(container, key: key, binding: v.negative.wrongBinding))
    for encoded in [v.negative.truncated, v.negative.reordered, v.negative.trailing] {
      XCTAssertThrowsError(
        try crypto.decrypt(Data(b64: encoded), key: key, binding: v.media.binding))
    }
    var unknown = v.media.binding
    unknown.version = 2
    XCTAssertThrowsError(try crypto.decrypt(container, key: key, binding: unknown))
    XCTAssertEqual(
      try crypto.decrypt(
        crypto.encrypt(bytes, key: key, binding: v.media.binding), key: key,
        binding: v.media.binding), bytes)
  }
  func testGoldenSignatureShareAndRecovery() throws {
    let v = try fixture(Vectors.self, "crypto-v1")
    let accounts = try fixture(FixtureAccounts.self, "accounts")
    let crypto = CryptoAdapter()
    XCTAssertEqual(
      try crypto.verify(v.signed, card: accounts.accounts[0], kind: "vector").b64, v.media.plaintext
    )
    XCTAssertThrowsError(try crypto.verify(v.signed, card: accounts.accounts[1], kind: "vector"))
    var bad = v.signed
    bad.body = ""
    XCTAssertThrowsError(try crypto.verify(bad, card: accounts.accounts[0], kind: "vector"))
    XCTAssertEqual(
      try crypto.signBytes(
        Data(b64: v.media.plaintext), kind: "vector", accountId: accounts.accounts[0].accountId,
        secret: Data(b64: accounts.testSecrets[0].signingSecretKey)), v.signed)
    let native = try crypto.encrypt(
      Data(b64: v.media.plaintext), key: Data(b64: v.media.key), binding: v.media.binding)
    let output: [String: Any] = [
      "version": 1, "binding": try JSONSerialization.jsonObject(with: Wire.encode(v.media.binding)),
      "container": native.b64, "key": v.media.key, "plaintext": v.media.plaintext,
    ]
    let outputURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("native-interop.json")
    try JSONSerialization.data(withJSONObject: output).write(to: outputURL)
    let e = v.share.envelope
    XCTAssertEqual(
      try crypto.openShare(
        e, grantId: e.grantId, photoId: e.photoId, sender: accounts.accounts[0],
        recipient: accounts.accounts[1], boxSecret: Data(b64: accounts.testSecrets[1].boxSecretKey)
      ).count, 32)
    XCTAssertThrowsError(
      try crypto.openShare(
        e, grantId: Wire.id(), photoId: e.photoId, sender: accounts.accounts[0],
        recipient: accounts.accounts[1], boxSecret: Data(b64: accounts.testSecrets[1].boxSecretKey))
    )
    let recovered = try Wire.decode(
      AccountBundle.self,
      crypto.unwrap(
        accounts.testSecrets[0].encryptedBundle,
        key: Data(b64: accounts.testSecrets[0].recoverySecret)))
    XCTAssertEqual(recovered.vaultKey, accounts.testSecrets[0].vaultKey)
    XCTAssertThrowsError(
      try crypto.unwrap(accounts.testSecrets[0].encryptedBundle, key: Data(repeating: 0, count: 32))
    )
  }
}
