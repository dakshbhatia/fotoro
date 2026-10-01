import SwiftUI

struct AccountView: View {
  @Bindable var services: AppServices
  @State private var recovery = ""
  @State private var recovering = false
  @State private var recoverySaved = false
  @State private var apiURL = ""
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("Backup & sharing").font(.title2)
        Button("Continue") {
          services.run {
            if services.session.accountId != nil {
              do { try await services.vault.unlock(.localKeychain) } catch {
                try await services.auth.login()
              }
            } else {
              try await services.auth.login()
            }
            try services.activateAccount()
          }
        }.buttonStyle(.borderedProminent)
        Button("Recover account") { recovering.toggle() }
        if recovering {
          SecureField("Recovery code", text: $recovery).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Recover") {
            services.run {
              try await services.auth.recover(recovery)
              recovery = ""
              try services.activateAccount()
              try await services.sync()
            }
          }
        }
        if let code = services.auth.recoveryCode {
          Text("Save your recovery code").font(.headline)
          Text(code).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          ShareLink("Save recovery code", item: code)
          Toggle("I saved this recovery code", isOn: $recoverySaved)
          Button("Continue") {
            services.run {
              try await services.auth.completeEnrollment(recoverySaved: recoverySaved)
              try services.activateAccount()
            }
          }.disabled(!recoverySaved)
        }
        if let fallback = services.auth.fallbackMessage { Text(fallback).font(.caption) }
        DisclosureGroup("More options") {
          Button("Create account") { services.run { try await services.auth.prepareEnrollment() } }
          DisclosureGroup("Use a trusted device") {
            Button("Request approval") { services.run { try await services.deviceTrust.begin() } }
            if let request = services.deviceTrust.challengeJSON {
              ShareLink("Send request", item: request)
            }
            Button("Complete approved request") {
              services.run {
                try await services.deviceTrust.complete()
                try services.activateAccount()
              }
            }
          }
        }
        #if DEBUG
          DisclosureGroup("Advanced · development") {
            Button("Unlock with PRF passkey") {
              services.run {
                try await services.auth.unlockWithPRF()
                try services.activateAccount()
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
}
