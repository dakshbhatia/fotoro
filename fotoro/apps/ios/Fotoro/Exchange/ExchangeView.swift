import NukeUI
import SwiftUI

struct SharedPhotosPresentation: Identifiable {
  let id = UUID()
  var photos: [LocalPhoto] = []
  var incoming: FotoroShareLink? = nil
}

struct ExchangeView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  var incoming: FotoroShareLink? = nil
  @State private var temporary = false
  @State private var link = ""
  @State private var candidate: FotoroShareLink?
  @State private var name = ""
  @State private var invitationURL: URL?
  @State private var feedback: String?
  @State private var operation: Task<Void, Never>?
  @State private var openedPhoto: LocalPhoto?
  @State private var shareCode: ShareCodePresentation?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss

  private var account: String? { services.session.accountId }
  private var contacts: [AccountCardV1] {
    services.session.pinnedCards.values.filter { $0.accountId != account }
      .sorted { services.contactName($0.accountId).localizedStandardCompare(services.contactName($1.accountId)) == .orderedAscending }
  }
  private var candidateCard: AccountCardV1? {
    switch candidate {
    case .contact(let card): return card
    case .moment(let moment): return moment.senderCard
    case nil: return nil
    }
  }
  private var changedContact: Bool {
    guard let card = candidateCard, let previous = services.session.pinnedCards[card.accountId] else { return false }
    return previous != card
  }
  private var receivedGrants: [GrantV1] { services.grants.filter { $0.recipientAccountId == account } }
  private var sentGrants: [GrantV1] { services.grants.filter { $0.ownerAccountId == account } }

  var body: some View {
    NavigationStack {
      List {
        if services.busy { ProgressView("Working…") }
        if let feedback { Text(feedback).foregroundStyle(.secondary) }
        if let candidateCard {
          Section(candidateIsMoment ? "Photo invitation" : "Add a contact") {
            TextField("Their name (optional)", text: $name).textContentType(.name)
            Text("Confirm this link came from the person you want to share with.")
              .font(.footnote).foregroundStyle(.secondary)
            if changedContact {
              Text("This person's Fotoro keys have changed. Accept this link only if they sent it to you.")
                .font(.footnote)
            }
            Button(candidateIsMoment ? "Accept and open photos" : changedContact ? "Accept new contact link" : "Add contact") {
              perform {
                let openingPhotos = candidateIsMoment
                try services.acceptContact(candidateCard, name: name)
                if case .moment(let moment) = candidate { try await services.openMoment(moment) }
                candidate = nil; link = ""; name = ""
                feedback = openingPhotos ? "Photos opened." : "Contact added."
              }
            }.disabled(services.busy || name.count > 80)
            Button("Cancel", role: .cancel) { candidate = nil; link = ""; name = "" }
          }
        }
        if !selected.isEmpty {
          Section("Share \(selected.count) \(selected.count == 1 ? "photo" : "photos")") {
            Toggle("Access for 15 minutes", isOn: $temporary)
            if contacts.isEmpty { Text("Add a contact below to share these photos.").foregroundStyle(.secondary) }
            ForEach(contacts, id: \.accountId) { card in
              Button("Share with \(services.contactName(card.accountId))", systemImage: "person.crop.circle") {
                perform {
                  let grant = try await services.share(selected, recipient: card, temporary: temporary)
                  invitationURL = try FotoroShareLinks.momentURL(grantId: grant.grantId,
                    senderCard: services.session.requireCard(grant.ownerAccountId), origin: services.api.origin)
                  try await services.refreshSharedMoments()
                  feedback = "Photos shared. Send the invitation to \(services.contactName(card.accountId))."
                }
              }.disabled(services.busy)
            }
            if let invitationURL {
              ShareLink("Send invitation", item: invitationURL).accessibilityIdentifier("sharing.invitation")
              Button("Show invitation code") { shareCode = ShareCodePresentation(url: invitationURL, title: "Photo invitation") }
            }
          }
        }
        if services.selectedGrant != nil {
          Section("Opened photos") {
            ForEach(services.received) { photo in
              VStack(alignment: .leading, spacing: 12) {
                Button { openedPhoto = photo } label: {
                  LazyImage(url: photo.thumbnailURL) { state in
                    if let image = state.image { image.resizable().scaledToFit() }
                    else { Rectangle().fill(.quaternary).overlay { ProgressView() } }
                  }.frame(height: 180).frame(maxWidth: .infinity)
                }.buttonStyle(.plain).accessibilityLabel("Open \(photo.metadata.filename)")
                Button("Save to my photos", systemImage: "icloud.and.arrow.up") {
                  perform { try await services.save(photo); feedback = "Saved in your Fotoro." }
                }.disabled(services.busy)
              }.padding(.vertical, 4)
            }
            if !selected.isEmpty, services.selectedGrant?.role == "contributor" {
              Button("Add selected photos", systemImage: "plus") {
                perform { try await services.contribute(selected); feedback = "Photos added." }
              }.disabled(services.busy)
            }
          }
        }
        Section("Shared with you") {
          if receivedGrants.isEmpty { Text("Photo invitations will appear here.").foregroundStyle(.secondary) }
          ForEach(receivedGrants, id: \.grantId) { grant in
            VStack(alignment: .leading, spacing: 8) {
              Text("Photos from \(services.contactName(grant.ownerAccountId))")
              Text(state(grant)).font(.footnote).foregroundStyle(.secondary)
              Button("Open photos") { perform { try await services.receive(grant) } }
                .disabled(services.busy || !available(grant))
            }
          }
          Button("Refresh", systemImage: "arrow.clockwise") { perform { try await services.refreshSharedMoments() } }
            .disabled(services.busy)
        }
        if !sentGrants.isEmpty {
          Section("Sent photos") {
            ForEach(sentGrants, id: \.grantId) { grant in
              VStack(alignment: .leading, spacing: 8) {
                Text("Shared with \(services.contactName(grant.recipientAccountId))")
                Text(state(grant)).font(.footnote).foregroundStyle(.secondary)
                if available(grant), let card = try? services.session.requireCard(grant.ownerAccountId),
                  let url = try? FotoroShareLinks.momentURL(grantId: grant.grantId, senderCard: card, origin: services.api.origin) {
                  ShareLink("Send invitation", item: url)
                }
                if grant.revokedAt == nil {
                  Button("End access", role: .destructive) {
                    perform { try await services.endSharedAccess(grant); feedback = "Access ended. Copies already saved stay in their photos." }
                  }.disabled(services.busy)
                }
              }
            }
          }
        }
        Section("Contacts") {
          if let account, let card = try? services.session.requireCard(account),
            let url = try? FotoroShareLinks.contactURL(card, origin: services.api.origin) {
            ShareLink("Share my contact link", item: url).accessibilityIdentifier("sharing.contact")
            Button("Show my contact code") { shareCode = ShareCodePresentation(url: url, title: "My contact link") }
          }
          TextField("Paste a Fotoro contact or photo link", text: $link)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          Button("Open link") {
            do {
              candidate = try FotoroShareLinks.parse(link.trimmingCharacters(in: .whitespacesAndNewlines), expectedOrigin: services.api.origin)
              if let card = candidateCard { name = contacts.contains(where: { $0.accountId == card.accountId }) ? services.contactName(card.accountId) : "" }
            } catch { services.error = error.localizedDescription }
          }.disabled(link.isEmpty || services.busy)
          ForEach(contacts, id: \.accountId) { card in Text(services.contactName(card.accountId)) }
        }
      }.navigationTitle(selected.isEmpty ? "Shared photos" : "Share photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .task {
          candidate = incoming
          if let card = candidateCard, contacts.contains(where: { $0.accountId == card.accountId }) { name = services.contactName(card.accountId) }
          perform { try await services.refreshSharedMoments() }
        }
        .sheet(item: $openedPhoto) { photo in
          NavigationStack {
            LazyImage(url: photo.previewURL ?? photo.thumbnailURL) { state in
              if let image = state.image { image.resizable().scaledToFit() }
              else { ProgressView() }
            }.background(.black).navigationTitle("Shared photo").navigationBarTitleDisplayMode(.inline)
              .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { openedPhoto = nil } }
                ToolbarItem(placement: .bottomBar) {
                  Button("Save to my photos", systemImage: "icloud.and.arrow.up") {
                    perform { try await services.save(photo); feedback = "Saved in your Fotoro."; openedPhoto = nil }
                  }.disabled(services.busy)
                }
              }
          }.preferredColorScheme(.dark)
        }
        .sheet(item: $shareCode) { ShareCodeView(presentation: $0) }
        .onChange(of: scenePhase) { if scenePhase == .background { operation?.cancel() } }
        .onChange(of: services.photoAccountAccess) { operation?.cancel(); dismiss() }
        .onDisappear { operation?.cancel() }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }
  }
  private var candidateIsMoment: Bool { if case .moment = candidate { return true }; return false }
  private func available(_ grant: GrantV1) -> Bool {
    grant.revokedAt == nil && (grant.expiresAt.map { (Wire.parseDate($0) ?? .distantPast) > Date() } ?? true)
  }
  private func state(_ grant: GrantV1) -> String {
    if grant.revokedAt != nil { return "Access ended" }
    if !available(grant) { return "Invitation expired" }
    if let expiry = grant.expiresAt.flatMap(Wire.parseDate) { return "Available until " + expiry.formatted(date: .omitted, time: .shortened) }
    return "Available"
  }
  private func perform(_ action: @escaping @MainActor () async throws -> Void) {
    guard operation == nil, scenePhase == .active else { return }
    if let task = services.run(phase: .share, { defer { operation = nil }; try await action() }) { operation = task }
  }
}
