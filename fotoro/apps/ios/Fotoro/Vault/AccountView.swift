import SwiftUI
import UIKit

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
  var onAuthenticationTask: (Task<Void, Never>?) -> Void = { _ in }
  @State private var password = ""
  @State private var apiURL = ""
  @FocusState private var passwordFocused: Bool
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let code = services.auth.startPassword {
          Text("Your Fotoro password").font(.title2.bold())
          Text("Save this password. Use it to open your Fotoro on any device.").foregroundStyle(.secondary)
          Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
            .privacySensitive().fixedSize(horizontal: false, vertical: true)
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { passwordActions(code) }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 12) { passwordActions(code) }
          }
          Button("Open Fotoro") {
            authenticate {
              try await services.auth.completeStart(code: code)
              try await finishSignIn()
            }
          }.buttonStyle(.borderedProminent).disabled(services.busy)
          Button("Cancel") { services.auth.cancelStart(); services.error = nil }.disabled(services.busy)
        } else if services.session.isSignedIn && services.vault.canUnlockLocally {
          Button("Open Fotoro") {
            authenticate {
              try await services.vault.unlock(.localKeychain)
              try await finishSignIn()
            }
          }.buttonStyle(.borderedProminent).disabled(services.busy)
            .accessibilityIdentifier("account.unlock")
        } else {
          Text("Open your Fotoro").font(.title2.bold())
          SecureField("Fotoro password", text: $password)
            .focused($passwordFocused)
            .textFieldStyle(.roundedBorder)
            .textContentType(.password).textInputAutocapitalization(.never)
            .autocorrectionDisabled().submitLabel(.go).onSubmit(signIn)
            .disabled(services.busy).accessibilityIdentifier("account.password")
          Button("Open Fotoro", action: signIn).buttonStyle(.borderedProminent)
            .disabled(services.busy || password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("account.signIn")
          Button("New Fotoro") {
            authenticate { try await services.auth.prepareStart() }
          }.disabled(services.busy)
            .accessibilityIdentifier("account.create")
        }
        if let error = services.error {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("account.error")
        }
        if services.busy {
          ProgressView("Opening your Fotoro…").accessibilityIdentifier("account.connecting")
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
    }.scrollDismissesKeyboard(.interactively)
  }
  @ViewBuilder private func passwordActions(_ code: String) -> some View {
    Button("Copy password", systemImage: "doc.on.doc") { UIPasteboard.general.string = code }
    ShareLink("Save password", item: code)
  }
  private func authenticate(_ action: @escaping @MainActor () async throws -> Void) {
    passwordFocused = false
    if let task = services.run(phase: .auth, {
      defer { onAuthenticationTask(nil) }
      try await action()
    }) { onAuthenticationTask(task) }
  }
  private func signIn() {
    guard !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    authenticate {
      try await services.auth.loginWithCode(password)
      password = ""
      try await finishSignIn()
    }
  }
  func finishSignIn() async throws {
    try Task.checkCancellation()
    guard services.vault.isUnlocked else { return }
    services.auth.fallbackMessage = nil
    try services.activateAccount()
    onSignedIn()
  }
}

struct FotoroPassword: Identifiable {
  let id = UUID()
  let value: String
}

struct FotoroPasswordView: View {
  let password: FotoroPassword
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text("Use this password to open your Fotoro on any device.").foregroundStyle(.secondary)
          Text(password.value).font(.system(.callout, design: .monospaced))
            .textSelection(.enabled).privacySensitive().fixedSize(horizontal: false, vertical: true)
          Button("Copy password", systemImage: "doc.on.doc") { UIPasteboard.general.string = password.value }
          ShareLink("Save password", item: password.value)
        }.frame(maxWidth: .infinity, alignment: .leading).padding()
      }.navigationTitle("Fotoro password").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
