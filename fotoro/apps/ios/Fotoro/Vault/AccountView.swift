import SwiftUI

struct RecoveryCodeAcknowledgement {
  private var savedCode: String?
  func isSaved(_ code: String?) -> Bool { code != nil && savedCode == code }
  mutating func setSaved(_ saved: Bool, code: String?) { savedCode = saved ? code : nil }
}

struct AccountView: View {
  @Bindable var services: AppServices
  var onSignedIn: () -> Void = {}
  @State private var recovery = ""
  @State private var recovering = false
  @State private var recoveryAcknowledgement = RecoveryCodeAcknowledgement()
  @State private var apiURL = ""
  private var needsRecovery: Bool {
    services.session.bearerToken != nil && services.auth.fallbackMessage != nil && !services.vault.isUnlocked
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text(needsRecovery ? "Unlock your saved photos" : "Your photos, everywhere").font(.title2.bold())
        Text(needsRecovery
          ? "You're signed in. Use your recovery code or a trusted device to open your encrypted photos on this iPhone."
          : "Create an account or sign in to find your saved photos on any device.").foregroundStyle(.secondary)
        if let error = services.error {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("account.error")
        }
        if services.busy {
          ProgressView("Connecting your account…").accessibilityIdentifier("account.connecting")
        }
        if !needsRecovery {
          Button(services.session.accountId == nil ? "Sign in" : "Unlock account") {
            services.run(phase: .auth) {
              if services.session.accountId != nil {
                do { try await services.vault.unlock(.localKeychain) } catch {
                  _ = try await services.auth.login()
                }
              } else {
                _ = try await services.auth.login()
              }
              try await finishSignIn()
            }
          }.buttonStyle(.borderedProminent).disabled(services.busy)
            .accessibilityIdentifier("account.signIn")
          Button("Create account") { services.run(phase: .auth) { try await services.auth.prepareEnrollment() } }
            .disabled(services.busy)
        }
        Button("Use a recovery code") { recovering.toggle() }.disabled(services.busy)
        if recovering || needsRecovery {
          SecureField("Recovery code", text: $recovery).textInputAutocapitalization(.never)
            .autocorrectionDisabled().disabled(services.busy)
          Button("Recover") {
            services.run(phase: .auth) {
              try await services.auth.recover(recovery)
              recovery = ""
              try await finishSignIn()
            }
          }.disabled(services.busy || recovery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        if let code = services.auth.recoveryCode {
          Text("Save your recovery code").font(.headline)
          Text(code).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          ShareLink("Save recovery code", item: code)
          Toggle("I saved this recovery code", isOn: Binding(
            get: { recoveryAcknowledgement.isSaved(code) },
            set: { recoveryAcknowledgement.setSaved($0, code: code) })).disabled(services.busy)
          Button("Continue") {
            services.run(phase: .auth) {
              try await services.auth.completeEnrollment(recoverySaved: recoveryAcknowledgement.isSaved(services.auth.recoveryCode))
              try await finishSignIn()
            }
          }.disabled(services.busy || !recoveryAcknowledgement.isSaved(code))
        }
        if let fallback = services.auth.fallbackMessage { Text(fallback).font(.caption) }
        DisclosureGroup("More options") {
          DisclosureGroup("Use a trusted device") {
            Button("Request approval") { services.run(phase: .auth) { try await services.deviceTrust.begin() } }
            if let request = services.deviceTrust.challengeJSON {
              ShareLink("Send request", item: request)
            }
            Button("Complete approved request") {
              services.run(phase: .auth) {
                try await services.deviceTrust.complete()
                try await finishSignIn()
              }
            }
          }
        }.disabled(services.busy)
        #if DEBUG
          DisclosureGroup("Advanced · development") {
            Button("Unlock with PRF passkey") {
              services.run {
                try await services.auth.unlockWithPRF()
                try await finishSignIn()
              }
            }
            TextField("API URL", text: $apiURL).textInputAutocapitalization(.never)
              .autocorrectionDisabled().keyboardType(.URL)
            Button("Use API") { services.run { try services.configureAPI(apiURL) } }
            Text(services.api.baseURL.absoluteString).font(.caption)
            Button("Public fixture · account 1") {
              services.run { try await services.fixtureUnlock(index: 0) }
            }
            Button("Public fixture · account 2") {
              services.run { try await services.fixtureUnlock(index: 1) }
            }
          }
        #endif
      }.padding()
    }
  }
  func finishSignIn() async throws {
    guard services.vault.isUnlocked else { return }
    services.auth.fallbackMessage = nil
    try services.activateAccount()
    try await services.sync()
    onSignedIn()
  }
}
