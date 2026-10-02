import CryptoKit
import Foundation
import Sodium

enum Wire {
  static func encode<T: Encodable>(_ value: T) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try e.encode(value)
  }
  static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    try JSONDecoder().decode(type, from: data)
  }
  static func tuple(_ values: [String]) throws -> [UInt8] {
    Array(try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes]))
  }
  static func id() -> String { UUID().uuidString.lowercased() }
  static func parseDate(_ value: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
  static func date(_ value: Date = Date()) -> String { ISO8601DateFormatter().string(from: value) }
}
extension Data {
  var b64: String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
  init(b64: String) throws {
    guard !b64.contains("="), b64.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil,
      let d = Data(
        base64Encoded: b64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
          of: "_", with: "/") + String(repeating: "=", count: (4 - b64.count % 4) % 4)),
      d.b64 == b64
    else { throw FotoroError("Invalid base64url") }
    self = d
  }
  var digest: String { Data(SHA256.hash(data: self)).b64 }
}
struct CryptoAdapter: Sendable {
  private var sodium: Sodium { Sodium() }
  func randomKey() -> Data { Data(sodium.secretBox.key()) }
  func mediaAAD(_ binding: MediaBinding) throws -> [UInt8] {
    guard binding.version == 1,
      ["original", "preview", "thumbnail", "metadata"].contains(binding.kind)
    else { throw FotoroError("Unsupported media version/kind") }
    return try Wire.tuple([
      "fotoro-media-v1", binding.photoId, binding.representationId, binding.kind,
    ])
  }
  func encrypt(_ bytes: Data, key: Data, binding: MediaBinding) throws -> Data {
    guard key.count == 32,
      let stream = sodium.secretStream.xchacha20poly1305.initPush(secretKey: Array(key))
    else { throw FotoroError("Invalid encryption key") }
    let aad = try mediaAAD(binding)
    var output = Data(stream.header())
    var offset = 0
    repeat {
      let end = min(offset + 4_194_304, bytes.count)
      let final = end == bytes.count
      guard
        let record = stream.push(
          message: Array(bytes[offset..<end]), tag: final ? .FINAL : .MESSAGE, ad: aad)
      else { throw FotoroError("Encryption failed") }
      var length = UInt32(record.count).bigEndian
      withUnsafeBytes(of: &length) { output.append(contentsOf: $0) }
      output.append(contentsOf: record)
      offset = end
    } while offset < bytes.count
    return output
  }
  func decrypt(_ container: Data, key: Data, binding: MediaBinding) throws -> Data {
    guard key.count == 32, container.count >= 45,
      let stream = sodium.secretStream.xchacha20poly1305.initPull(
        secretKey: Array(key), header: Array(container.prefix(24)))
    else { throw FotoroError("Invalid media header/key") }
    let aad = try mediaAAD(binding)
    var offset = 24
    var plain = Data()
    var final = false
    while offset < container.count {
      guard !final, offset + 4 <= container.count else {
        throw FotoroError("Trailing or truncated media")
      }
      let length = container[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4
      guard length >= 17, length <= 4_194_304 + 17, length <= container.count - offset,
        let (bytes, tag) = stream.pull(
          cipherText: Array(container[offset..<offset + length]), ad: aad),
        tag == .MESSAGE || tag == .FINAL
      else { throw FotoroError("Media authentication failed") }
      plain.append(contentsOf: bytes)
      offset += length
      final = tag == .FINAL
    }
    guard final else { throw FotoroError("Media missing final record") }
    return plain
  }
  func decrypt(_ container: Data, key: Data, representation: RepresentationV1) throws -> Data {
    guard container.count == representation.ciphertextBytes,
      container.digest == representation.ciphertextSha256,
      container.prefix(24).b64 == representation.header
    else { throw FotoroError("Ciphertext manifest mismatch") }
    return try decrypt(container, key: key, binding: representation.binding)
  }
  func wrap(_ bytes: Data, key: Data) throws -> WrappedKeyV1 {
    guard key.count == 32,
      let (cipher, nonce): ([UInt8], [UInt8]) = sodium.secretBox.seal(
        message: Array(bytes), secretKey: Array(key))
    else { throw FotoroError("Wrapping failed") }
    return WrappedKeyV1(nonce: Data(nonce).b64, ciphertext: Data(cipher).b64)
  }
  func unwrap(_ wrapped: WrappedKeyV1, key: Data) throws -> Data {
    let nonce = try Data(b64: wrapped.nonce)
    let cipher = try Data(b64: wrapped.ciphertext)
    guard wrapped.version == 1, key.count == 32, nonce.count == 24, cipher.count >= 16,
      let plain = sodium.secretBox.open(
        authenticatedCipherText: Array(cipher), secretKey: Array(key), nonce: Array(nonce))
    else { throw FotoroError("Recovery or wrapper authentication failed") }
    return Data(plain)
  }
  func sign<T: Encodable>(_ value: T, kind: String, accountId: String, secret: Data) throws
    -> SignedPayloadV1
  { try signBytes(Wire.encode(value), kind: kind, accountId: accountId, secret: secret) }
  func signBytes(_ body: Data, kind: String, accountId: String, secret: Data) throws
    -> SignedPayloadV1
  {
    guard secret.count == 64,
      let signature = sodium.sign.signature(
        message: try Wire.tuple(["fotoro-signed-v1", kind, accountId, body.b64]),
        secretKey: Array(secret))
    else { throw FotoroError("Signing failed") }
    return SignedPayloadV1(
      kind: kind, accountId: accountId, body: body.b64, signature: Data(signature).b64)
  }
  func verify(_ payload: SignedPayloadV1, card: AccountCardV1, kind: String) throws -> Data {
    let signature = try Data(b64: payload.signature)
    let pk = try Data(b64: card.signingPublicKey)
    guard payload.version == 1, card.version == 1, payload.kind == kind,
      payload.accountId == card.accountId, pk.count == 32, signature.count == 64,
      sodium.sign.verify(
        message: try Wire.tuple(["fotoro-signed-v1", kind, payload.accountId, payload.body]),
        publicKey: Array(pk), signature: Array(signature))
    else { throw FotoroError("Pinned sender signature failed") }
    return try Data(b64: payload.body)
  }
  private func shareTuple(_ e: ShareKeyEnvelopeV1) throws -> [UInt8] {
    try Wire.tuple([
      "fotoro-share-v1", e.grantId, e.photoId, e.senderAccountId, e.recipientAccountId,
      e.sealedMetadataKey,
    ])
  }
  func share(
    _ key: Data, grantId: String, photoId: String, sender: String, recipient: AccountCardV1,
    signingKey: Data
  ) throws -> ShareKeyEnvelopeV1 {
    let pk = try Data(b64: recipient.boxPublicKey)
    guard key.count == 32, pk.count == 32, signingKey.count == 64,
      let sealed = sodium.box.seal(message: Array(key), recipientPublicKey: Array(pk))
    else { throw FotoroError("Recipient encryption failed") }
    var e = ShareKeyEnvelopeV1(
      grantId: grantId, photoId: photoId, senderAccountId: sender,
      recipientAccountId: recipient.accountId, sealedMetadataKey: Data(sealed).b64,
      senderSignature: "")
    guard let sig = sodium.sign.signature(message: try shareTuple(e), secretKey: Array(signingKey))
    else { throw FotoroError("Share signature failed") }
    e.senderSignature = Data(sig).b64
    return e
  }
  func openShare(
    _ e: ShareKeyEnvelopeV1, grantId: String, photoId: String, sender: AccountCardV1,
    recipient: AccountCardV1, boxSecret: Data
  ) throws -> Data {
    let signature = try Data(b64: e.senderSignature)
    let signing = try Data(b64: sender.signingPublicKey)
    let sealed = try Data(b64: e.sealedMetadataKey)
    let box = try Data(b64: recipient.boxPublicKey)
    guard e.version == 1, e.grantId == grantId, e.photoId == photoId,
      e.senderAccountId == sender.accountId, e.recipientAccountId == recipient.accountId,
      signature.count == 64, signing.count == 32, sealed.count == 80, box.count == 32,
      boxSecret.count == 32,
      sodium.sign.verify(
        message: try shareTuple(e), publicKey: Array(signing), signature: Array(signature)),
      let key = sodium.box.open(
        anonymousCipherText: Array(sealed), recipientPublicKey: Array(box),
        recipientSecretKey: Array(boxSecret)), key.count == 32
    else { throw FotoroError("Share binding or pinned identity failed") }
    return Data(key)
  }
}
