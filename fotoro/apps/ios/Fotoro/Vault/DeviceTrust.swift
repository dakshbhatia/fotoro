import Foundation
import Observation
import Sodium

struct DeviceEnrollmentRequest: Codable {
  var version = 1
  var deviceId: String
  var boxPublicKey: String
  var origin: String
}
struct DeviceApprovalRequest: Codable {
  var version = 1
  var signedPayload: SignedPayloadV1
  var sealedBundle: String
}
struct DeviceCompleteRequest: Codable {
  var version = 1
  var challenge: String
}
struct DeviceCompleteResponse: Codable {
  var version: Int
  var sealedBundle: String
  var signedPayload: SignedPayloadV1
  var challenge: DeviceChallengeV1
}
struct PendingDevice: Codable {
  var challenge: DeviceChallengeV1
  var secret: String
}
@MainActor @Observable final class DeviceTrust {
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  var pending: PendingDevice?
  var challengeJSON: String? {
    pending.flatMap { try? String(data: Wire.encode($0.challenge), encoding: .utf8) }
  }
  init(session: AccountSession, api: APIClient, vault: VaultStore) {
    self.session = session
    self.api = api
    self.vault = vault
  }
  func begin() async throws {
    guard let id = session.accountId, let device = session.deviceId,
      let pair = Sodium().box.keyPair()
    else { throw FotoroError("Sign in on the new device before requesting approval") }
    let pk = Data(pair.publicKey).b64
    let challenge: DeviceChallengeV1 = try await api.post(
      "/v1/devices/enroll",
      DeviceEnrollmentRequest(deviceId: device, boxPublicKey: pk, origin: api.origin))
    guard challenge.accountId == id, challenge.deviceId == device, challenge.boxPublicKey == pk,
      challenge.origin == api.origin, challenge.state == "pending", challenge.version == 1
    else { throw FotoroError("Device challenge binding mismatch") }
    let value = PendingDevice(challenge: challenge, secret: Data(pair.secretKey).b64)
    try Keychain.write(Wire.encode(value), id: "device-request-" + id)
    pending = value
  }
  func approve(_ json: String) async throws {
    let challenge = try Wire.decode(DeviceChallengeV1.self, Data(json.utf8))
    guard challenge.version == 1, challenge.accountId == session.accountId,
      challenge.origin == api.origin, challenge.state == "pending",
      let expiry = Wire.parseDate(challenge.expiresAt), expiry > Date(),
      try Data(b64: challenge.challenge).count == 32,
      let sealed = Sodium().box.seal(
        message: Array(try Wire.encode(vault.requireBundle())),
        recipientPublicKey: Array(try Data(b64: challenge.boxPublicKey)))
    else { throw FotoroError("Device request is expired or belongs to another account/origin") }
    let body = DeviceApprovalBody(challenge: challenge, sealedBundle: Data(sealed).b64)
    let signed = try CryptoAdapter().sign(
      body, kind: "device-approval", accountId: challenge.accountId,
      secret: Data(b64: vault.requireBundle().signingSecretKey))
    let _: DeviceChallengeV1 = try await api.post(
      "/v1/devices/enroll/\(challenge.enrollmentId)/approve",
      DeviceApprovalRequest(signedPayload: signed, sealedBundle: body.sealedBundle))
  }
  func complete() async throws {
    guard let id = session.accountId else { throw FotoroError("Sign in first") }
    let pending =
      try pending ?? Wire.decode(PendingDevice.self, Keychain.read("device-request-" + id))
    let result: DeviceCompleteResponse = try await api.post(
      "/v1/devices/enroll/\(pending.challenge.enrollmentId)/complete",
      DeviceCompleteRequest(challenge: pending.challenge.challenge))
    var expected = pending.challenge
    expected.state = "completed"
    guard result.version == 1, result.challenge == expected else {
      throw FotoroError("Completed device challenge mismatch")
    }
    try await vault.unlock(
      .trustedDevice(
        challenge: pending.challenge, expected: pending.challenge,
        sealedBundle: result.sealedBundle, signedPayload: result.signedPayload,
        deviceSecret: Data(b64: pending.secret)))
    Keychain.remove("device-request-" + id)
    self.pending = nil
  }
}
