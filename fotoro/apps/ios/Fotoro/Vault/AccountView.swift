import SwiftUI
import UIKit

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
  @State private var password = ""
  @State private var apiURL = ""
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        AccountIdentityView(session: services.session, unlocked: services.vault.isUnlocked)
        if let code = services.auth.startPassword {
          Text("Your Fotoro password").font(.title2.bold())
          Text("Save this password. Use it to open your Fotoro on any device.").foregroundStyle(.secondary)
          Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            .privacySensitive()
          HStack {
            Button("Copy password", systemImage: "doc.on.doc") { UIPasteboard.general.string = code }
            ShareLink("Save password", item: code)
          }
          Button("Continue") {
            services.run(phase: .auth) {
              try await services.auth.completeStart(code: code)
              try await finishSignIn()
            }
          }.buttonStyle(.borderedProminent).disabled(services.busy)
          Button("Cancel") { services.auth.cancelStart(); services.error = nil }.disabled(services.busy)
        } else if services.session.isSignedIn && services.vault.canUnlockLocally {
          Button("Unlock photos") {
            services.run(phase: .auth) {
              try await services.vault.unlock(.localKeychain)
              try await finishSignIn()
            }
          }.buttonStyle(.borderedProminent).disabled(services.busy)
            .accessibilityIdentifier("account.unlock")
        } else {
          Text("Open your Fotoro").font(.title2.bold())
          SecureField("Fotoro password", text: $password)
            .textFieldStyle(.roundedBorder)
            .textContentType(.password).textInputAutocapitalization(.never)
            .autocorrectionDisabled().submitLabel(.go).onSubmit(signIn)
            .disabled(services.busy).accessibilityIdentifier("account.password")
          Button("Sign in", action: signIn).buttonStyle(.borderedProminent)
            .disabled(services.busy || password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("account.signIn")
          Button("New Fotoro") {
            services.run(phase: .auth) { try await services.auth.prepareStart() }
          }.disabled(services.busy)
            .accessibilityIdentifier("account.create")
        }
        if let error = services.error {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("account.error")
        }
        if services.busy {
          ProgressView("Opening your Fotoro…").accessibilityIdentifier("account.connecting")
        }
        if services.auth.startPassword == nil {
          DisclosureGroup("Other ways to sign in") {
            Button("Use a passkey") {
              services.run(phase: .auth) {
                _ = try await services.auth.login()
                try await finishSignIn()
              }
            }
            DisclosureGroup("Use a trusted device") {
              Button("Request approval") { services.run(phase: .auth) { try await services.deviceTrust.begin() } }
              if let request = services.deviceTrust.challengeJSON { ShareLink("Send request", item: request) }
              Button("Complete approved request") {
                services.run(phase: .auth) {
                  try await services.deviceTrust.complete()
                  try await finishSignIn()
                }
              }
            }
          }.disabled(services.busy)
        }
        if services.session.accountId != nil, let onSignOut {
          Button("Sign out", role: .destructive, action: onSignOut).disabled(services.busy)
        }
        #if DEBUG
          DisclosureGroup("Advanced · development") {
            TextField("API URL", text: $apiURL).textInputAutocapitalization(.never)
              .autocorrectionDisabled().keyboardType(.URL)
            Button("Use API") { services.run { try services.configureAPI(apiURL) } }
            Text(services.api.baseURL.absoluteString).font(.caption)
            Button("Public fixture · account 1") { services.run { try await services.fixtureUnlock(index: 0) } }
            Button("Public fixture · account 2") { services.run { try await services.fixtureUnlock(index: 1) } }
          }
        #endif
      }.padding()
    }
  }
  private func signIn() {
    guard !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    services.run(phase: .auth) {
      try await services.auth.loginWithCode(password)
      password = ""
      try await finishSignIn()
    }
  }
  func finishSignIn() async throws {
    guard services.vault.isUnlocked else { return }
    services.auth.fallbackMessage = nil
    try services.activateAccount()
    onSignedIn()
  }
}
