import AuthenticationServices
import CryptoKit
import Foundation
import Observation
import Sodium
import UIKit

struct RecoveryCode {
  let accountId: String
  let secret: Data
  init(_ code: String) throws {
    let parts = code.trimmingCharacters(in: .whitespacesAndNewlines).split(
      separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0] == "fotoro1", UUID(uuidString: String(parts[1])) != nil else {
      throw FotoroError("Invalid recovery code")
    }
    accountId = String(parts[1])
    secret = try Data(b64: String(parts[2]))
    guard secret.count == 32 else { throw FotoroError("Invalid recovery secret") }
  }
}
struct AuthOptionsRequest: Codable {
  var version = 1
  var client = "native"
  var accountId: String?
}
struct RecoveryOptionsResponse: Codable {
  var version: Int
  var challengeId: String
  var challenge: String
  var expiresAt: String
  var vault: VaultV1
}
struct RecoveryProof: Codable {
  var version = 1
  var challengeId: String
  var challenge: String
  var accountId: String
  var client = "native"
  var origin: String
}
struct RecoveryVerify: Codable {
  var version = 1
  var challengeId: String
  var signedPayload: SignedPayloadV1
  var client = "native"
}
struct EnrollmentProof: Codable {
  var accountCard: AccountCardV1
  var recoveryWrapper: VaultWrapperV1
}
struct Enrollment: Codable {
  var version = 1
  var accountCard: AccountCardV1
  var recoveryWrapper: VaultWrapperV1
  var proof: SignedPayloadV1
}
struct PendingEnrollment {
  var challengeId: String
  var challenge: Data
  var userID: Data
  var card: AccountCardV1
  var bundle: AccountBundle
  var recovery: Data
  var wrapper: VaultWrapperV1
  var salt: Data
}
struct CredentialResult {
  var response: Data
  var credentialId: String
  var prf: Data?
}

@MainActor
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
  ASAuthorizationControllerPresentationContextProviding
{
  private var continuation: CheckedContinuation<CredentialResult, Error>?
  private var controller: ASAuthorizationController?
  func perform(_ request: ASAuthorizationRequest) async throws -> CredentialResult {
    guard continuation == nil else { throw FotoroError("A passkey request is already active") }
    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let controller = ASAuthorizationController(authorizationRequests: [request])
      self.controller = controller
      controller.delegate = self
      controller.presentationContextProvider = self
      controller.performRequests()
    }
  }
  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
      .first(where: { $0.isKeyWindow }) ?? UIWindow()
  }
  func authorizationController(
    controller: ASAuthorizationController,
    didCompleteWithAuthorization authorization: ASAuthorization
  ) {
    do {
      let response: [String: Any]
      let credentialId: String
      let prf: Data?
      if let registration = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialRegistration
      {
        guard let attestation = registration.rawAttestationObject else {
          throw FotoroError("Passkey attestation unavailable")
        }
        credentialId = registration.credentialID.b64
        prf = registration.prf?.first.map { $0.withUnsafeBytes { Data($0) } }
        response = [
          "id": credentialId, "rawId": credentialId, "type": "public-key",
          "authenticatorAttachment": "platform", "clientExtensionResults": [:],
          "response": [
            "clientDataJSON": registration.rawClientDataJSON.b64,
            "attestationObject": attestation.b64, "transports": ["internal"],
          ],
        ]
      } else if let assertion = authorization.credential
        as? ASAuthorizationPlatformPublicKeyCredentialAssertion
      {
        credentialId = assertion.credentialID.b64
        prf = assertion.prf?.first.withUnsafeBytes { Data($0) }
        response = [
          "id": credentialId, "rawId": credentialId, "type": "public-key",
          "authenticatorAttachment": "platform", "clientExtensionResults": [:],
          "response": [
            "clientDataJSON": assertion.rawClientDataJSON.b64,
            "authenticatorData": assertion.rawAuthenticatorData.b64,
            "signature": assertion.signature.b64, "userHandle": assertion.userID.b64,
          ],
        ]
      } else {
        throw FotoroError("Unexpected passkey credential")
      }
      continuation?.resume(
        returning: CredentialResult(
          response: try JSONSerialization.data(withJSONObject: response),
          credentialId: credentialId, prf: prf))
    } catch { continuation?.resume(throwing: error) }
    continuation = nil
    self.controller = nil
  }
  func authorizationController(
    controller: ASAuthorizationController, didCompleteWithError error: Error
  ) {
    continuation?.resume(throwing: error)
    continuation = nil
    self.controller = nil
  }
}

@MainActor @Observable final class NativeAuth {
  let session: AccountSession
  let api: APIClient
  let vault: VaultStore
  private let crypto = CryptoAdapter()
  private let ceremony = PasskeyCeremony()
  var pending: PendingEnrollment?
  var recoveryCode: String? { pending.map { "fotoro1.\($0.card.accountId).\($0.recovery.b64)" } }
  var fallbackMessage: String?
  init(session: AccountSession, api: APIClient, vault: VaultStore) {
    self.session = session
    self.api = api
    self.vault = vault
  }
  private func options(_ path: String, accountId: String? = nil) async throws -> [String: Any] {
    let bytes = try await api.request(
      path, method: "POST", body: Wire.encode(AuthOptionsRequest(accountId: accountId)))
    guard let json = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      json["version"] as? Int == 1
    else { throw FotoroError("Invalid authentication options") }
    return json
  }
  private func accept(_ result: SessionV1) throws {
    guard result.version == 1, let token = result.token, !token.isEmpty else {
      throw FotoroError("Native bearer session missing")
    }
    session.accountId = result.accountId
    session.bearerToken = token
    session.deviceId = result.deviceId
    session.fixture = false
    try Keychain.write(try Wire.encode(result), id: "session")
    UserDefaults.standard.set(result.accountId, forKey: "fotoro.account")
  }
  func prepareEnrollment() async throws {
    guard !session.fixture else {
      throw FotoroError("Fixture authentication is unavailable; choose a real API")
    }
    let response = try await options("/v1/auth/register/options")
    guard let id = response["accountId"] as? String,
      let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String, let user = options["user"] as? [String: Any],
      let userID = user["id"] as? String, let box = Sodium().box.keyPair(),
      let sign = Sodium().sign.keyPair()
    else { throw FotoroError("Invalid registration options") }
    let bundle = AccountBundle(
      vaultKey: crypto.randomKey().b64, boxSecretKey: Data(box.secretKey).b64,
      signingSecretKey: Data(sign.secretKey).b64)
    let card = AccountCardV1(
      accountId: id, boxPublicKey: Data(box.publicKey).b64,
      signingPublicKey: Data(sign.publicKey).b64)
    let recovery = crypto.randomKey()
    let wrapper = VaultWrapperV1(
      version: 1, wrapperId: Wire.id(), kind: "recovery", credentialId: nil, prfSalt: nil,
      wrappedBundle: try crypto.wrap(Wire.encode(bundle), key: recovery), verified: true)
    _ = try crypto.unwrap(wrapper.wrappedBundle, key: recovery)
    pending = PendingEnrollment(
      challengeId: challengeId, challenge: try Data(b64: challenge), userID: try Data(b64: userID),
      card: card, bundle: bundle, recovery: recovery, wrapper: wrapper, salt: crypto.randomKey())
  }
  func completeEnrollment(recoverySaved: Bool) async throws {
    guard recoverySaved, let pending else {
      throw FotoroError("Save the recovery code before enrolling")
    }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId)
    let request = provider.createCredentialRegistrationRequest(
      challenge: pending.challenge, name: "Fotoro", userID: pending.userID)
    request.prf = .inputValues(.saltInput1(pending.salt))
    request.userVerificationPreference = .required
    let credential = try await ceremony.perform(request)
    let proof = try crypto.sign(
      EnrollmentProof(accountCard: pending.card, recoveryWrapper: pending.wrapper),
      kind: "account-enrollment", accountId: pending.card.accountId,
      secret: Data(b64: pending.bundle.signingSecretKey))
    let enrollment = Enrollment(
      accountCard: pending.card, recoveryWrapper: pending.wrapper, proof: proof)
    let body: [String: Any] = [
      "version": 1, "challengeId": pending.challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response),
      "enrollment": try JSONSerialization.jsonObject(with: Wire.encode(enrollment)),
      "client": "native",
    ]
    let result: SessionV1 = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/register/verify", method: "POST",
        body: JSONSerialization.data(withJSONObject: body)))
    guard result.accountId == pending.card.accountId else {
      throw FotoroError("Enrollment account mismatch")
    }
    try accept(result)
    try session.pin(pending.card)
    try await vault.unlock(
      .recoveryEnvelope(secret: pending.recovery, wrapper: pending.wrapper.wrappedBundle))
    if let output = credential.prf, output.count == 32 {
      let wrapper = VaultWrapperV1(
        version: 1, wrapperId: Wire.id(), kind: "prf", credentialId: credential.credentialId,
        prfSalt: pending.salt.b64,
        wrappedBundle: try crypto.wrap(Wire.encode(pending.bundle), key: output), verified: false)
      let _: VaultWrapperV1 = try Wire.decode(
        VaultWrapperV1.self,
        await api.request(
          "/v1/vault/wrappers/\(wrapper.wrapperId)", method: "PUT", body: Wire.encode(wrapper)))
    } else {
      fallbackMessage =
        "This passkey has no PRF output. This enrolled iPhone uses Keychain; another device needs the saved recovery code or trusted-device approval."
    }
    self.pending = nil
  }
  func login() async throws {
    guard !session.fixture else {
      throw FotoroError("Fixture authentication cannot create passkeys")
    }
    let response = try await options("/v1/auth/login/options", accountId: session.accountId)
    guard let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String
    else { throw FotoroError("Invalid sign-in options") }
    let request = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId
    ).createCredentialAssertionRequest(challenge: try Data(b64: challenge))
    request.userVerificationPreference = .required
    var wrappers: [VaultWrapperV1] = []
    if session.accountId != nil, let v: VaultV1 = try? await api.get("/v1/vault") {
      wrappers = v.wrappers
      let values = try wrappers.filter { $0.kind == "prf" }.reduce(
        into: [Data: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues]()
      ) { dict, w in
        if let id = w.credentialId, let salt = w.prfSalt {
          dict[try Data(b64: id)] = .saltInput1(try Data(b64: salt))
        }
      }
      if !values.isEmpty { request.prf = .perCredentialInputValues(values) }
    }
    let credential = try await ceremony.perform(request)
    let body: [String: Any] = [
      "version": 1, "challengeId": challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response), "client": "native",
    ]
    let result = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/login/verify", method: "POST", body: JSONSerialization.data(withJSONObject: body))
    )
    try accept(result)
    if let output = credential.prf,
      let wrapper = wrappers.first(where: { $0.credentialId == credential.credentialId })
    {
      try await vault.unlock(.prf(output: output, wrapper: wrapper.wrappedBundle))
    } else {
      do { try await vault.unlock(.localKeychain) } catch {
        fallbackMessage =
          "Authenticated. Recover the vault with your saved code or a trusted device."
      }
    }
  }
  func unlockWithPRF() async throws {
    let v: VaultV1 = try await api.get("/v1/vault")
    guard v.accountCard.accountId == session.accountId else {
      throw FotoroError("Vault account mismatch")
    }
    let response = try await options("/v1/auth/login/options", accountId: session.accountId)
    guard let challengeId = response["challengeId"] as? String,
      let options = response["options"] as? [String: Any],
      let challenge = options["challenge"] as? String
    else { throw FotoroError("Invalid PRF challenge") }
    let values = try v.wrappers.filter { $0.kind == "prf" }.reduce(
      into: [Data: ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues]()
    ) { dict, w in
      if let id = w.credentialId, let salt = w.prfSalt {
        dict[try Data(b64: id)] = .saltInput1(try Data(b64: salt))
      }
    }
    guard !values.isEmpty else {
      throw FotoroError("No PRF credential wrapper. Use recovery or trusted-device approval.")
    }
    let request = ASAuthorizationPlatformPublicKeyCredentialProvider(
      relyingPartyIdentifier: api.rpId
    ).createCredentialAssertionRequest(challenge: try Data(b64: challenge))
    request.prf = .perCredentialInputValues(values)
    request.userVerificationPreference = .required
    let credential = try await ceremony.perform(request)
    guard let output = credential.prf, output.count == 32,
      let wrapper = v.wrappers.first(where: {
        $0.credentialId == credential.credentialId && $0.kind == "prf"
      })
    else {
      throw FotoroError(
        "This passkey returned no PRF output. Use recovery or trusted-device approval.")
    }
    let bundle = try Wire.decode(
      AccountBundle.self, crypto.unwrap(wrapper.wrappedBundle, key: output))
    let test = try crypto.signBytes(
      Data("fotoro-prf-identity".utf8), kind: "unlock", accountId: v.accountCard.accountId,
      secret: Data(b64: bundle.signingSecretKey))
    _ = try crypto.verify(test, card: v.accountCard, kind: "unlock")
    guard
      try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: bundle.boxSecretKey))
        .publicKey.rawRepresentation.b64 == v.accountCard.boxPublicKey
    else { throw FotoroError("PRF identity mismatch") }
    let body: [String: Any] = [
      "version": 1, "challengeId": challengeId,
      "response": try JSONSerialization.jsonObject(with: credential.response), "client": "native",
    ]
    let result = try Wire.decode(
      SessionV1.self,
      await api.request(
        "/v1/auth/login/verify", method: "POST", body: JSONSerialization.data(withJSONObject: body))
    )
    guard result.accountId == v.accountCard.accountId else {
      throw FotoroError("PRF authenticated account mismatch")
    }
    try accept(result)
    try session.pin(v.accountCard)
    try await vault.unlock(.prf(output: output, wrapper: wrapper.wrappedBundle))
  }
  func recover(_ code: String) async throws {
    let recovery = try RecoveryCode(code)
    let bytes = try await api.request(
      "/v1/auth/recovery/options", method: "POST",
      body: Wire.encode(AuthOptionsRequest(accountId: recovery.accountId)))
    let options = try Wire.decode(RecoveryOptionsResponse.self, bytes)
    guard options.version == 1, options.vault.accountCard.accountId == recovery.accountId,
      let wrapper = options.vault.wrappers.first(where: { $0.kind == "recovery" && $0.verified })
    else { throw FotoroError("Recovery account mismatch") }
    let bundle = try Wire.decode(
      AccountBundle.self, crypto.unwrap(wrapper.wrappedBundle, key: recovery.secret))
    let proof = RecoveryProof(
      challengeId: options.challengeId, challenge: options.challenge, accountId: recovery.accountId,
      origin: api.origin)
    let signed = try crypto.sign(
      proof, kind: "recovery-session", accountId: recovery.accountId,
      secret: Data(b64: bundle.signingSecretKey))
    _ = try crypto.verify(signed, card: options.vault.accountCard, kind: "recovery-session")
    guard
      try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(b64: bundle.boxSecretKey))
        .publicKey.rawRepresentation.b64 == options.vault.accountCard.boxPublicKey
    else { throw FotoroError("Recovery identity mismatch") }
    let result: SessionV1 = try await api.post(
      "/v1/auth/recovery/verify",
      RecoveryVerify(challengeId: options.challengeId, signedPayload: signed))
    guard result.accountId == recovery.accountId else {
      throw FotoroError("Recovery session account mismatch")
    }
    try accept(result)
    try session.pin(options.vault.accountCard)
    try await vault.unlock(
      .recoveryEnvelope(secret: recovery.secret, wrapper: wrapper.wrappedBundle))
  }
}
