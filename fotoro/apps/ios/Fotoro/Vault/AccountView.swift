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

enum AccountEntryPage: Equatable { case welcome, remembered, password }

enum AccountEntryPolicy {
  static func initialPage(accountId: String?, fixture: Bool, hasRememberedPassword: Bool,
    isSignedIn: Bool, canUnlockLocally: Bool, enterPassword: Bool, reauthenticate: Bool) -> AccountEntryPage {
    if enterPassword && !fixture { return .password }
    guard NativeBackupPolicy.allowsPrivatePhotos(accountId: accountId, fixture: fixture) else { return .welcome }
    return hasRememberedPassword || (isSignedIn && canUnlockLocally && !reauthenticate) ? .remembered : .welcome
  }
  @MainActor static func preparePrivateAuthentication(_ services: AppServices) throws {
    guard services.session.fixture else { return }
    try services.configureAPI(APIURLPolicy.canonical.absoluteString)
    UserDefaults.standard.removeObject(forKey: "fotoro.fixtureAccount")
  }
}

struct AccountView: View {
  @Bindable var services: AppServices
  let reauthenticate: Bool
  let diagnosticDetail: String?
  var onSignedIn: () -> Void = {}
  var onAuthenticationTask: (Task<Void, Never>?) -> Void = { _ in }
  @State private var password = ""
  @State private var page: AccountEntryPage
  @State private var passwordExpanded = false
  @State private var apiURL = ""
  @FocusState private var passwordFocused: Bool
  init(services: AppServices, enterPassword: Bool = false, reauthenticate: Bool = false,
    diagnosticDetail: String? = nil, onSignedIn: @escaping () -> Void = {},
    onAuthenticationTask: @escaping (Task<Void, Never>?) -> Void = { _ in }) {
    self.services = services
    self.reauthenticate = reauthenticate
    self.diagnosticDetail = diagnosticDetail
    self.onSignedIn = onSignedIn
    self.onAuthenticationTask = onAuthenticationTask
    _page = State(initialValue: AccountEntryPolicy.initialPage(accountId: services.session.accountId,
      fixture: services.session.fixture, hasRememberedPassword: services.auth.hasRememberedPassword,
      isSignedIn: services.session.isSignedIn, canUnlockLocally: services.vault.canUnlockLocally,
      enterPassword: enterPassword, reauthenticate: reauthenticate))
  }
  private var defaultPage: AccountEntryPage {
    AccountEntryPolicy.initialPage(accountId: services.session.accountId, fixture: services.session.fixture,
      hasRememberedPassword: services.auth.hasRememberedPassword, isSignedIn: services.session.isSignedIn,
      canUnlockLocally: services.vault.canUnlockLocally, enterPassword: false, reauthenticate: reauthenticate)
  }
  private var authenticationInProgress: Bool { services.busy || services.auth.isOpeningRememberedAccount }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let code = services.auth.startPassword {
          Text("New Fotoro").font(.largeTitle.weight(.semibold))
          primaryAction("Continue", identifier: "account.completeStart") {
            authenticate {
              try await services.auth.completeStart(code: code)
              try await finishSignIn()
            }
          }
          DisclosureGroup("Password", isExpanded: $passwordExpanded) {
            VStack(alignment: .leading, spacing: 16) {
              Text("Use this password to open your Fotoro on another device.").foregroundStyle(.secondary)
              Text(code).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                .privacySensitive().fixedSize(horizontal: false, vertical: true)
              passwordActions(code)
            }.padding(.top, 12)
          }.font(.body)
          backButton { services.auth.cancelStart(); services.error = nil; page = defaultPage }
        } else if page == .remembered && defaultPage == .remembered {
          Text("Welcome back").font(.largeTitle.weight(.semibold))
          primaryAction("Open Fotoro", identifier: "account.unlock") {
            authenticate {
              let generation = try await services.auth.openRememberedAccount(forceReauthentication: reauthenticate)
              guard services.vault.generation == generation else { throw CancellationError() }
              try await finishSignIn()
            }
          }
          secondaryAction("Use another account", identifier: "account.useAnotherPassword") {
            page = .welcome; services.error = nil
          }
        } else if page == .password {
          backButton { password = ""; passwordFocused = false; page = defaultPage; services.error = nil }
          Text("Open your Fotoro").font(.largeTitle.weight(.semibold))
          SecureField("Fotoro password", text: $password)
            .focused($passwordFocused)
            .onAppear { passwordFocused = !authenticationInProgress }
            .font(.body).padding(.horizontal, 16).frame(maxWidth: .infinity, minHeight: 52)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
            .textContentType(.password).textInputAutocapitalization(.never)
            .autocorrectionDisabled().submitLabel(.go).onSubmit(signIn)
            .disabled(authenticationInProgress).accessibilityIdentifier("account.password")
          primaryAction("Open Fotoro", identifier: "account.signIn", action: signIn)
            .disabled(password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } else {
          Text("Your Fotoro").font(.largeTitle.weight(.semibold))
          primaryAction("Get started", identifier: "account.create") {
            authenticate {
              try AccountEntryPolicy.preparePrivateAuthentication(services)
              try await services.auth.prepareStart()
              passwordExpanded = false
            }
          }
          secondaryAction("Sign in to your Fotoro", identifier: "account.choosePassword", action: choosePassword)
        }
        if let error = services.error {
          Text(error).font(.body).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("account.error")
        }
        if authenticationInProgress {
          ProgressView("Opening your Fotoro…").accessibilityIdentifier("account.connecting")
        }
        if let diagnosticDetail {
          DisclosureGroup("Details") { Text(diagnosticDetail).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            .font(.body).foregroundStyle(.secondary)
        }
        #if DEBUG
          if ProcessInfo.processInfo.arguments.contains("-fotoro-developer") {
            DisclosureGroup("Development") {
              TextField("API URL", text: $apiURL).textInputAutocapitalization(.never)
                .autocorrectionDisabled().keyboardType(.URL)
              Button("Use API") { services.run { try services.configureAPI(apiURL) } }
              Text(services.api.baseURL.absoluteString).font(.caption)
              Button("Public fixture · account 1") { services.run { try await services.fixtureUnlock(index: 0) } }
              Button("Public fixture · account 2") { services.run { try await services.fixtureUnlock(index: 1) } }
            }
          }
        #endif
      }.frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity)
        .padding(24)
    }.scrollDismissesKeyboard(.interactively)
      .onChange(of: services.error) {
        if services.error != nil, services.auth.startPassword != nil { passwordExpanded = true }
      }
  }
  private func primaryAction(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { Text(title).font(.headline).frame(maxWidth: .infinity, minHeight: 52) }
      .buttonStyle(.glassProminent).buttonBorderShape(.roundedRectangle(radius: 16))
      .disabled(authenticationInProgress).accessibilityIdentifier(identifier)
  }
  private func secondaryAction(_ title: String, identifier: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { Text(title).font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 48) }
      .buttonStyle(.glass).buttonBorderShape(.roundedRectangle(radius: 16))
      .disabled(authenticationInProgress).accessibilityIdentifier(identifier)
  }
  private func backButton(action: @escaping () -> Void) -> some View {
    Button("Back", systemImage: "chevron.backward", action: action).font(.body)
      .frame(minHeight: 44).disabled(authenticationInProgress)
  }
  @ViewBuilder private func passwordActions(_ code: String) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) { passwordTools(code) }
      VStack(spacing: 12) { passwordTools(code) }
    }
  }
  @ViewBuilder private func passwordTools(_ code: String) -> some View {
    Button { UIPasteboard.general.string = code } label: {
      Label("Copy", systemImage: "doc.on.doc").frame(maxWidth: .infinity, minHeight: 48)
    }.buttonStyle(.glass).accessibilityLabel("Copy password")
    ShareLink(item: code) {
      Label("Save", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity, minHeight: 48)
    }.buttonStyle(.glass).accessibilityLabel("Save password")
  }
  private func choosePassword() {
    guard !authenticationInProgress else { return }
    do {
      try AccountEntryPolicy.preparePrivateAuthentication(services)
      services.error = nil
      page = .password
    } catch { services.error = error.localizedDescription }
  }
  private func authenticate(_ action: @escaping @MainActor () async throws -> Void) {
    guard !authenticationInProgress else { return }
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
  @State private var copied = false
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          Text("Use this password to open your Fotoro on another device.").font(.body).foregroundStyle(.secondary)
          Text("Your Fotoro password").font(.headline)
          Text(password.value).font(.system(.body, design: .monospaced))
            .textSelection(.enabled).privacySensitive().fixedSize(horizontal: false, vertical: true)
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
          Button {
            UIPasteboard.general.string = password.value
            copied = true
          } label: {
            Label(copied ? "Copied" : "Copy password", systemImage: copied ? "checkmark" : "doc.on.doc")
              .font(.headline).frame(maxWidth: .infinity, minHeight: 52)
          }.buttonStyle(.glassProminent).buttonBorderShape(.roundedRectangle(radius: 16))
            .accessibilityLabel(copied ? "Password copied" : "Copy password")
          ShareLink(item: password.value) {
            Label("Save password", systemImage: "square.and.arrow.up").font(.headline).frame(maxWidth: .infinity, minHeight: 52)
          }.buttonStyle(.glass).buttonBorderShape(.roundedRectangle(radius: 16))
          Link(destination: URL(string: "https://fotoro.cloud/saved")!) {
            Text("Open fotoro.cloud").font(.body).frame(maxWidth: .infinity, minHeight: 48)
          }.buttonStyle(.glass).buttonBorderShape(.roundedRectangle(radius: 16))
            .accessibilityIdentifier("account.otherDeviceWebsite")
        }.frame(maxWidth: 520, alignment: .leading).frame(maxWidth: .infinity).padding(24)
      }.navigationTitle("Open on another device").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .onChange(of: password.id) { copied = false }
    }
  }
}
