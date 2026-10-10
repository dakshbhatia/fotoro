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
// A request is bound to this authenticated session, vault lifetime and exact API endpoint.
struct DeviceTrustAccess: Equatable {
  let account: String
  let device: String
  let token: String
  let expires: Date?
  let vault: UUID
  let unlocked: Bool
  let origin: String
  let server: URL
}
@MainActor @Observable final class DeviceTrust {
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  private(set) var pending: PendingDevice?
  private(set) var inProgress = false
  private var binding: DeviceTrustAccess?
  private var operation = UUID()
  private var expiryTask: Task<Void, Never>?
  private let now: () -> Date
  private let enroll: (DeviceEnrollmentRequest) async throws -> DeviceChallengeV1
  private let approveRequest: (String, DeviceApprovalRequest) async throws -> DeviceChallengeV1
  private let completeRequest: (String, DeviceCompleteRequest) async throws -> DeviceCompleteResponse
  var challengeJSON: String? {
    guard let pending, let binding, (try? require(binding)) != nil,
      (try? validate(pending.challenge, account: binding.account)) != nil else { return nil }
    return try? String(data: Wire.encode(pending.challenge), encoding: .utf8)
  }
  init(session: AccountSession, api: APIClient, vault: VaultStore,
    now: @escaping () -> Date = Date.init,
    enroll: ((DeviceEnrollmentRequest) async throws -> DeviceChallengeV1)? = nil,
    approve: ((String, DeviceApprovalRequest) async throws -> DeviceChallengeV1)? = nil,
    complete: ((String, DeviceCompleteRequest) async throws -> DeviceCompleteResponse)? = nil) {
    self.session = session; self.api = api; self.vault = vault; self.now = now
    self.enroll = enroll ?? { try await api.post("/v1/devices/enroll", $0) }
    self.approveRequest = approve ?? { try await api.post("/v1/devices/enroll/\($0)/approve", $1) }
    self.completeRequest = complete ?? { try await api.post("/v1/devices/enroll/\($0)/complete", $1) }
    // Older versions persisted ephemeral secrets. Never restore them into a new session.
    if let id = session.accountId { Keychain.remove("device-request-" + id) }
  }
  private func access(unlocked: Bool) throws -> DeviceTrustAccess {
    try Task.checkCancellation()
    guard session.isSignedIn, !session.fixture, vault.isUnlocked == unlocked,
      let account = session.accountId, let device = session.deviceId,
      UUID(uuidString: account) != nil, UUID(uuidString: device) != nil,
      let token = session.bearerToken, !token.isEmpty else {
      throw FotoroError(unlocked ? "Open your Fotoro before approving another device." : "Sign in on this device before requesting approval.")
    }
    _ = try session.requireCard(account)
    return DeviceTrustAccess(account: account, device: device, token: token,
      expires: session.expiresAt, vault: vault.generation, unlocked: unlocked,
      origin: api.origin, server: api.baseURL)
  }
  private func require(_ expected: DeviceTrustAccess, unlocked: Bool? = nil, generation: UUID? = nil) throws {
    try Task.checkCancellation()
    guard session.isSignedIn, !session.fixture, session.accountId == expected.account,
      session.deviceId == expected.device, session.bearerToken == expected.token,
      session.expiresAt == expected.expires, vault.generation == (generation ?? expected.vault),
      vault.isUnlocked == (unlocked ?? expected.unlocked), api.origin == expected.origin,
      api.baseURL == expected.server else { throw CancellationError() }
  }
  private func require(_ expected: DeviceTrustAccess, operation: UUID) throws {
    try require(expected)
    guard self.operation == operation else { throw CancellationError() }
  }
  func validate(_ challenge: DeviceChallengeV1, account: String) throws {
    guard challenge.version == 1, challenge.accountId == account, challenge.origin == api.origin,
      challenge.state == "pending", UUID(uuidString: challenge.enrollmentId) != nil,
      UUID(uuidString: challenge.deviceId) != nil,
      let expiry = Wire.parseDate(challenge.expiresAt), expiry > now(),
      expiry.timeIntervalSince(now()) <= 305,
      try Data(b64: challenge.challenge).count == 32,
      try Data(b64: challenge.boxPublicKey).count == 32 else {
      throw FotoroError("This approval request is expired or does not match your Fotoro.")
    }
  }
  func review(_ json: String) throws -> DeviceChallengeV1 {
    let current = try access(unlocked: true)
    guard json.utf8.count <= 4096 else { throw FotoroError("Invalid approval request.") }
    let challenge = try Wire.decode(DeviceChallengeV1.self, Data(json.utf8))
    try validate(challenge, account: current.account)
    guard challenge.deviceId != current.device else { throw FotoroError("Choose the request from your other device.") }
    return challenge
  }
  func cancel() {
    operation = UUID()
    expiryTask?.cancel(); expiryTask = nil
    if let id = pending?.challenge.accountId { Keychain.remove("device-request-" + id) }
    pending = nil; binding = nil; inProgress = false
  }
  func discardInvalidRequest() {
    guard let pending, let binding else { return }
    if (try? require(binding)) == nil || (try? validate(pending.challenge, account: binding.account)) == nil { cancel() }
  }
  private func startOperation() throws -> UUID {
    guard !inProgress else { throw FotoroError("An approval action is already in progress.") }
    inProgress = true
    operation = UUID()
    return operation
  }
  func begin() async throws {
    let current = try access(unlocked: false)
    guard !inProgress else { throw FotoroError("An approval action is already in progress.") }
    cancel()
    let op = try startOperation()
    defer { if operation == op { inProgress = false } }
    do {
      guard let pair = Sodium().box.keyPair() else { throw FotoroError("Cannot create approval request.") }
      let pk = Data(pair.publicKey).b64
      let challenge = try await enroll(DeviceEnrollmentRequest(deviceId: current.device, boxPublicKey: pk, origin: current.origin))
      try require(current, operation: op)
      try validate(challenge, account: current.account)
      guard challenge.deviceId == current.device, challenge.boxPublicKey == pk else { throw FotoroError("Device challenge binding mismatch") }
      pending = PendingDevice(challenge: challenge, secret: Data(pair.secretKey).b64)
      binding = current
      let expiry = min(Wire.parseDate(challenge.expiresAt)!, current.expires ?? .distantFuture)
      let remaining = max(0, expiry.timeIntervalSince(now()))
      expiryTask = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(remaining)) } catch { return }
        guard let self, self.pending?.challenge.enrollmentId == challenge.enrollmentId else { return }
        self.cancel()
      }
    } catch {
      if operation == op { cancel() }
      throw error
    }
  }
  func approve(_ json: String) async throws {
    let current = try access(unlocked: true), challenge = try review(json)
    let op = try startOperation()
    defer { if operation == op { inProgress = false } }
    let bundle = try vault.requireBundle()
    guard let sealed = Sodium().box.seal(message: Array(try Wire.encode(bundle)),
      recipientPublicKey: Array(try Data(b64: challenge.boxPublicKey))) else { throw FotoroError("Cannot prepare device approval.") }
    let body = DeviceApprovalBody(challenge: challenge, sealedBundle: Data(sealed).b64)
    let signed = try CryptoAdapter().sign(body, kind: "device-approval", accountId: current.account,
      secret: Data(b64: bundle.signingSecretKey))
    try require(current, operation: op)
    let response = try await approveRequest(challenge.enrollmentId,
      DeviceApprovalRequest(signedPayload: signed, sealedBundle: body.sealedBundle))
    try require(current, operation: op)
    try validate(challenge, account: current.account)
    var expected = challenge; expected.state = "approved"
    guard response == expected else { throw FotoroError("Approved device challenge mismatch") }
  }
  func complete() async throws {
    discardInvalidRequest()
    guard let pending, let current = binding else { throw FotoroError("Request approval again on this device.") }
    try require(current)
    try validate(pending.challenge, account: current.account)
    let op = try startOperation()
    defer { if operation == op { inProgress = false } }
    var received = false
    do {
      let result = try await completeRequest(pending.challenge.enrollmentId,
        DeviceCompleteRequest(challenge: pending.challenge.challenge))
      received = true
      try require(current, operation: op)
      try validate(pending.challenge, account: current.account)
      var expected = pending.challenge; expected.state = "completed"
      guard result.version == 1, result.challenge == expected, result.signedPayload.accountId == current.account else {
        throw FotoroError("Completed device challenge mismatch")
      }
      try await vault.unlock(.trustedDevice(challenge: pending.challenge, expected: pending.challenge,
        sealedBundle: result.sealedBundle, signedPayload: result.signedPayload,
        deviceSecret: Data(b64: pending.secret)), validation: {
          try self.require(current, operation: op)
          try self.validate(pending.challenge, account: current.account)
        })
      try require(current, unlocked: true, generation: vault.generation)
      guard operation == op else { throw CancellationError() }
      cancel()
    } catch {
      if operation == op {
        if received || error is CancellationError || (error as? URLError)?.code == .cancelled { cancel() }
        else { discardInvalidRequest() }
      }
      throw error
    }
  }
}
