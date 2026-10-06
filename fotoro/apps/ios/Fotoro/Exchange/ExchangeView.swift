import NukeUI
import SwiftUI

struct SharedPhotosPresentation: Identifiable {
  let id = UUID()
  var photos: [LocalPhoto] = []
  var incoming: FotoroShareLink? = nil
}

private struct ReceivedViewerPresentation: Identifiable {
  let photo: LocalPhoto
  let photos: [LocalPhoto]
  let grant: GrantV1
  var id: String { photo.id }
}

struct ExchangeView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  var incoming: FotoroShareLink? = nil
  var onRetryPassword: ((FotoroShareLink) -> Void)? = nil
  @State private var temporary = false
  @State private var link = ""
  @State private var candidate: FotoroShareLink?
  @State private var name = ""
  @State private var invitationURL: URL?
  @State private var feedback: String?
  @State private var operation: Task<Void, Never>?
  @State private var openedPhoto: ReceivedViewerPresentation?
  @State private var recipient: AccountCardV1?
  @State private var shareCode: ShareCodePresentation?
  @State private var preparedIncoming = false
  private enum FocusField: Hashable { case link, name }
  @FocusState private var focusedField: FocusField?
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
              .focused($focusedField, equals: .name).disabled(services.busy)
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
            if candidateIsMoment, let candidate, let onRetryPassword {
              Button("Use another Fotoro password") {
                focusedField = nil
                onRetryPassword(candidate)
              }.disabled(services.busy || operation != nil)
            }
            Button("Cancel", role: .cancel) { focusedField = nil; candidate = nil; link = ""; name = "" }
          }
        }
        if !selected.isEmpty {
          Section("\(selected.count) \(selected.count == 1 ? "photo" : "photos")") {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 3) {
                ForEach(selected.prefix(12)) { photo in
                  LazyImage(url: photo.thumbnailURL ?? photo.previewURL) { state in
                    if let image = state.image { image.resizable().scaledToFill() }
                    else { Rectangle().fill(.quaternary) }
                  }.frame(width: 88, height: 88).clipped().accessibilityLabel(photo.metadata.filename)
                }
              }
            }
            if contacts.isEmpty { Text("Add a person below to share these photos.").foregroundStyle(.secondary) }
            ForEach(contacts, id: \.accountId) { card in
              Button { recipient = card; invitationURL = nil } label: {
                HStack {
                  Label(services.contactName(card.accountId), systemImage: "person.crop.circle")
                  Spacer()
                  if recipient == card { Image(systemName: "checkmark.circle.fill") }
                }
              }.disabled(services.busy).accessibilityValue(recipient == card ? "Selected" : "")
            }
            if recipient != nil, invitationURL == nil {
              DisclosureGroup("Options") { Toggle("Access for 15 minutes", isOn: $temporary).disabled(services.busy) }
            }
            if let recipient, invitationURL == nil {
              Button("Share with \(services.contactName(recipient.accountId))", systemImage: "square.and.arrow.up") {
                perform {
                  let grant = try await services.share(selected, recipient: recipient, temporary: temporary)
                  invitationURL = try FotoroShareLinks.momentURL(grantId: grant.grantId,
                    senderCard: services.session.requireCard(grant.ownerAccountId), origin: services.api.origin)
                  try await services.refreshSharedMoments()
                  feedback = "Ready to send to \(services.contactName(recipient.accountId))."
                }
              }.disabled(services.busy)
            }
            if let invitationURL {
              ShareLink("Send photos", item: invitationURL).accessibilityIdentifier("sharing.invitation")
              DisclosureGroup("More") {
                Button("Show invitation code") { shareCode = ShareCodePresentation(url: invitationURL, title: "Photo invitation") }
              }
            }
          }
          if let grant = services.selectedGrant, grant.role == "contributor", available(grant) {
            Section("Add to a shared moment") {
              Text("Photos from \(services.contactName(grant.ownerAccountId))").foregroundStyle(.secondary)
              Button("Add selected photos", systemImage: "plus") {
                perform { try await services.contribute(selected); feedback = "Photos added." }
              }.disabled(services.busy)
            }
          }
        }
        if selected.isEmpty {
        if let grant = services.selectedGrant {
          Section("Photos from \(services.contactName(grant.ownerAccountId))") {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
              ForEach(services.received) { photo in
                GeometryReader { geometry in
                  Button("Open \(photo.metadata.filename)") {
                    guard services.isReceivedGrantCurrent(grant) else { services.withdrawExpiredReceivedMoment(); return }
                    focusedField = nil
                    openedPhoto = ReceivedViewerPresentation(photo: photo, photos: services.received, grant: grant)
                  }.buttonStyle(.plain).disabled(services.busy)
                    .frame(width: geometry.size.width, height: geometry.size.width)
                    .overlay {
                      LazyImage(url: photo.thumbnailURL) { state in
                        if let image = state.image { image.resizable().scaledToFill() }
                        else { Rectangle().fill(.quaternary).overlay { ProgressView() } }
                      }.frame(width: geometry.size.width, height: geometry.size.width).clipped()
                        .allowsHitTesting(false).accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }.aspectRatio(1, contentMode: .fit)
              }
            }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
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
        }
        Section(selected.isEmpty ? "People" : "Add a person") {
          if selected.isEmpty, let account, let card = try? services.session.requireCard(account),
            let url = try? FotoroShareLinks.contactURL(card, origin: services.api.origin) {
            ShareLink("Share my contact link", item: url).accessibilityIdentifier("sharing.contact")
            Button("Show my contact code") { shareCode = ShareCodePresentation(url: url, title: "My contact link") }
          }
          if !selected.isEmpty, !contacts.isEmpty {
            DisclosureGroup("Add a person") { contactEntry }
          } else {
            contactEntry
          }
          if selected.isEmpty {
            ForEach(contacts, id: \.accountId) { card in Text(services.contactName(card.accountId)) }
          }
        }
      }.scrollDismissesKeyboard(.interactively)
        .navigationTitle(selected.isEmpty ? "Shared photos" : "Share photos")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .task {
          guard !preparedIncoming else { return }
          preparedIncoming = true
          candidate = incoming
          if let card = candidateCard, contacts.contains(where: { $0.accountId == card.accountId }) { name = services.contactName(card.accountId) }
        }
        .task(id: scenePhase) { await refreshMoments() }
        .task(id: services.selectedGrant?.expiresAt) { await waitForExpiry() }
        .fullScreenCover(item: $openedPhoto) { presentation in
          PhotoViewer(services: services, initialID: presentation.photo.id,
            displayedPhotos: presentation.photos, receivedGrant: presentation.grant)
            .task(id: scenePhase) { await refreshMoments() }
            .task(id: services.selectedGrant?.expiresAt) { await waitForExpiry() }
        }
        .sheet(item: $shareCode) { ShareCodeView(presentation: $0) }
        .onChange(of: scenePhase) { if scenePhase == .background { operation?.cancel() } }
        .onChange(of: services.photoAccountAccess) { operation?.cancel(); dismiss() }
        .onChange(of: services.selectedGrant) { previous, current in
          if previous != nil && current == nil { feedback = "These shared photos are no longer available. Copies you saved stay in your Fotoro." }
        }
        .onDisappear {
          operation?.cancel()
          if openedPhoto == nil { services.cancelSharedMomentRefresh() }
        }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }
  }
  private func refreshMoments() async {
    guard scenePhase == .active else { services.cancelSharedMomentRefresh(); return }
    do { try await services.refreshSharedMoments() }
    catch is CancellationError {} catch {
      guard !Task.isCancelled, scenePhase == .active else { return }
      services.error = error.localizedDescription
    }
  }
  private func waitForExpiry() async {
    guard let expiry = services.selectedGrant?.expiresAt.flatMap(Wire.parseDate) else { return }
    let remaining = expiry.timeIntervalSinceNow
    if remaining > 0 { try? await Task.sleep(for: .seconds(remaining)) }
    guard !Task.isCancelled else { return }
    services.withdrawExpiredReceivedMoment()
  }
  private var contactEntry: some View {
    Group {
      TextField("Paste a Fotoro link", text: $link)
        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
        .focused($focusedField, equals: .link).submitLabel(.go).onSubmit(openLink)
        .disabled(services.busy)
      Button("Open link", action: openLink)
        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || services.busy)
    }
  }
  private var candidateIsMoment: Bool { if case .moment = candidate { return true }; return false }
  private func openLink() {
    let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !services.busy else { return }
    do {
      candidate = try FotoroShareLinks.parse(text, expectedOrigin: services.api.origin)
      if let card = candidateCard { name = contacts.contains(where: { $0.accountId == card.accountId }) ? services.contactName(card.accountId) : "" }
      focusedField = nil
    } catch { services.error = error.localizedDescription }
  }
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
    focusedField = nil
    if let task = services.run(phase: .share, { defer { operation = nil }; try await action() }) { operation = task }
  }
}
