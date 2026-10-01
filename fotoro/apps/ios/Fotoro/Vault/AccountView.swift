import SwiftUI

struct AccountView: View {
  @Bindable var services: AppServices
  @State private var recovery = ""
  @State private var recoverySaved = false
  @State private var apiURL = ""
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Image(systemName: "lock.shield").font(.system(size: 48))
        Text("Unlock to view your photos").font(.title2)
        Button("Unlock enrolled device") {
          services.run {
            try await services.vault.unlock(.localKeychain)
            try services.activateAccount()
          }
        }
        Button("Sign in with passkey") {
          services.run {
            try await services.auth.login()
            try services.activateAccount()
          }
        }
        Button("Unlock with PRF passkey") {
          services.run {
            try await services.auth.unlockWithPRF()
            try services.activateAccount()
          }
        }
        Button("Create account") { services.run { try await services.auth.prepareEnrollment() } }
        if let code = services.auth.recoveryCode {
          Text("Save your recovery code").font(.headline)
          Text(code).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          Text(
            "This code unlocks your account if every passkey is lost. Fotoro does not send the secret to the service."
          ).font(.caption)
          ShareLink("Save recovery code", item: code)
          Toggle("I saved this recovery code", isOn: $recoverySaved)
          Button("Enroll passkey") {
            services.run {
              try await services.auth.completeEnrollment(recoverySaved: recoverySaved)
              try services.activateAccount()
            }
          }.disabled(!recoverySaved)
        }
        SecureField("fotoro1.… recovery code", text: $recovery).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Recover account") {
          services.run {
            try await services.auth.recover(recovery)
            recovery = ""
            try services.activateAccount()
            try await services.sync()
          }
        }
        if let fallback = services.auth.fallbackMessage { Text(fallback).font(.caption) }
        DisclosureGroup("Trusted device approval") {
          Button("Request approval") { services.run { try await services.deviceTrust.begin() } }
          if let request = services.deviceTrust.challengeJSON {
            Text(request).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            ShareLink("Send request to your trusted device", item: request)
          }
          Button("Complete approved request") {
            services.run {
              try await services.deviceTrust.complete()
              try services.activateAccount()
            }
          }
        }
        DisclosureGroup("API connection") {
          TextField("https://fotoro.cloud", text: $apiURL).textInputAutocapitalization(.never)
            .autocorrectionDisabled().keyboardType(.URL)
          Button("Use API") { services.run { try services.configureAPI(apiURL) } }
          Text(services.api.baseURL.absoluteString).font(.caption)
        }
        #if DEBUG
          Divider()
          Text("Public loopback fixtures").font(.headline)
          Button("Public fixture · account 1") {
            services.run { try await services.fixtureUnlock(index: 0) }
          }
          Button("Public fixture · account 2") {
            services.run { try await services.fixtureUnlock(index: 1) }
          }
          Text(
            "Fixture auth returns REAL_AUTH_REQUIRED for passkey ceremonies. Physical passkeys require associated domains and signing."
          ).font(.caption)
        #endif
      }.padding()
    }
  }
}
