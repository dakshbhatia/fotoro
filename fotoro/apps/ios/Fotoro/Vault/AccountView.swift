import SwiftUI

struct RecoveryCodeAcknowledgement {
  private var savedCode: String?
  func isSaved(_ code: String?) -> Bool { code != nil && savedCode == code }
  mutating func setSaved(_ saved: Bool, code: String?) { savedCode = saved ? code : nil }
}

struct AccountIdentityView: View {
  let session: AccountSession
  let unlocked: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(session.fixture ? "Public demo account" : session.isSignedIn ? "Signed in" : "Not signed in",
        systemImage: session.isSignedIn || session.fixture ? "person.crop.circle.fill" : "person.crop.circle")
        .font(.headline).accessibilityIdentifier("account.status")
      if let reference = session.accountReference {
        Text("Account \(reference)").font(.subheadline.monospaced()).foregroundStyle(.secondary)
          .textSelection(.enabled).accessibilityIdentifier("account.identity")
      }
      if session.isSignedIn && !unlocked {
        Text("Saved photos are locked on this iPhone.").font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}

struct AccountView: View {
  @Bindable var services: AppServices
  var onSignedIn: () -> Void = {}
  var onSignOut: (() -> Void)?
  @State private var recovery = ""
  @State private var recoveryAcknowledgement = RecoveryCodeAcknowledgement()
  @State private var apiURL = ""
  private var needsRecovery: Bool { services.auth.needsRecovery }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        AccountIdentityView(session: services.session, unlocked: services.vault.isUnlocked)
        Text(services.auth.pending != nil ? "Create your account" : needsRecovery ? "Unlock your saved photos" : services.session.isSignedIn ? "Welcome back" : "Sign in to Fotoro")
          .font(.title2.bold())
        Text(needsRecovery
          ? "Use your recovery code or a trusted device to open your saved photos."
          : "Save photos when you choose. Automatic sync is off.").foregroundStyle(.secondary)
        if let error = services.error {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("account.error")
        }
        if services.busy {
          ProgressView("Connecting your account…").accessibilityIdentifier("account.connecting")
        }
        if !needsRecovery && services.auth.pending == nil {
          Button(services.session.isSignedIn ? "Unlock photos" : "Sign in") {
            services.run(phase: .auth) {
              if services.session.isSignedIn {
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
          if !services.session.isSignedIn {
            Text("Use your Fotoro passkey.").font(.footnote).foregroundStyle(.secondary)
            Button("Create account") { services.run(phase: .auth) { try await services.auth.prepareEnrollment() } }
              .disabled(services.busy)
          }
        }
        if needsRecovery { recoveryForm }
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
          Button("Cancel") {
            services.auth.pending = nil
            recoveryAcknowledgement.setSaved(false, code: nil)
            services.error = nil
          }.disabled(services.busy)
        }
        if services.auth.pending == nil {
          if needsRecovery {
            DisclosureGroup("Use a trusted device") { trustedDeviceForm }.disabled(services.busy)
          } else {
            DisclosureGroup("Other ways to sign in") {
              recoveryForm
              DisclosureGroup("Use a trusted device") { trustedDeviceForm }
            }.disabled(services.busy)
          }
        }
        if services.session.accountId != nil, let onSignOut {
          Button("Sign out", role: .destructive, action: onSignOut).disabled(services.busy)
        }
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
  private var trustedDeviceForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button("Request approval") { services.run(phase: .auth) { try await services.deviceTrust.begin() } }
      if let request = services.deviceTrust.challengeJSON { ShareLink("Send request", item: request) }
      Button("Complete approved request") {
        services.run(phase: .auth) {
          try await services.deviceTrust.complete()
          try await finishSignIn()
        }
      }
    }
  }
  private var recoveryForm: some View {
    VStack(alignment: .leading, spacing: 12) {
      SecureField("Recovery code", text: $recovery).textInputAutocapitalization(.never)
        .autocorrectionDisabled().disabled(services.busy)
      Button("Unlock with recovery code") {
        services.run(phase: .auth) {
          try await services.auth.recover(recovery)
          recovery = ""
          try await finishSignIn()
        }
      }.disabled(services.busy || recovery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }
  func finishSignIn() async throws {
    guard services.vault.isUnlocked else { return }
    services.auth.fallbackMessage = nil
    try services.activateAccount()
    onSignedIn()
  }
}
