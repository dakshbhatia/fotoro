import NukeUI
import SwiftUI

struct ExchangeView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  @State private var temporary = false
  @State private var accountCard = ""
  @State private var approvalJSON = ""
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        if services.busy { ProgressView("Working…") }
        if !selected.isEmpty {
          Section("Share \(selected.count) photos") {
            ForEach(selected) { Text($0.metadata.filename) }
            Toggle("15-minute access", isOn: $temporary)
            ForEach(
              Array(services.session.pinnedCards.values).filter {
                $0.accountId != services.session.accountId
              },
              id: \.accountId
            ) { card in
              Button("Share with pinned account \(card.accountId.prefix(8))") {
                services.run {
                  _ = try await services.share(selected, recipient: card, temporary: temporary)
                  try await services.sync()
                }
              }
            }
          }
        }
        Section("Trust account card") {
          TextField("Account card JSON", text: $accountCard).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Trust this account card") {
            services.run {
              let card = try Wire.decode(AccountCardV1.self, Data(accountCard.utf8))
              try services.session.pin(card)
              accountCard = ""
            }
          }
          Text(
            "Verify both public keys through the person’s authentic card or QR before trusting. A replacement card renews trust."
          ).font(.caption)
        }
        Section("Approve your new device") {
          TextField("Device request JSON", text: $approvalJSON).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Approve this account and device request") {
            services.run {
              try await services.deviceTrust.approve(approvalJSON)
              approvalJSON = ""
            }
          }
          Text(
            "Check the requested account, device public key, challenge, and origin on your new device before approving."
          ).font(.caption)
        }
        Section("Transfers") {
          Button("Retry pending saves") { services.run { try await services.resumeSaves() } }
          Button("Retry pending uploads") {
            services.run {
              try await services.resumeTransfers()
              try services.reload()
              if let error = services.journal.errors.values.first { throw FotoroError(error) }
            }
          }
        }
        Section("Shared moments") {
          Button("Refresh") { services.run { try await services.sync() } }
          ForEach(services.grants, id: \.grantId) { grant in
            Button(
              "\(grant.role) · \(grant.expiresAt == nil ? "ongoing":"15-minute") · \(grant.grantId.prefix(8))"
            ) { services.run { try await services.receive(grant) } }
          }
        }
        if services.selectedGrant != nil {
          Section("Received") {
            ForEach(services.received) { photo in
              VStack(alignment: .leading) {
                Text(photo.metadata.filename)
                LazyImage(url: photo.thumbnailURL).frame(height: 140)
                Text("Preview authenticated; original is verified on save").font(.caption)
                Button("Save independent copy") { services.run { try await services.save(photo) } }
              }
            }
            if !selected.isEmpty {
              Button("Contribute selected photos") {
                services.run { try await services.contribute(selected) }
              }
            }
          }
        }
      }.disabled(services.busy).navigationTitle("Encrypted sharing")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }
  }
}
