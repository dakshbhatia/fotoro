import AVKit
import NukeUI
import SwiftUI

struct NativeAlbumPresentation: Identifiable {
  let id = UUID()
  var selected: [LocalPhoto] = []
  var incoming: FotoroAlbumInvitation?
}

struct NativeAlbumView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  let incoming: FotoroAlbumInvitation?
  @State private var model: NativeAlbumService
  @State private var title = ""
  @State private var albumQuery = ""
  @State private var memberIDs = Set<String>()
  @State private var operation: Task<Void, Never>?
  @State private var operationID: UUID?
  @State private var authenticationTask: Task<Void, Never>?
  @State private var feedback: String?
  @State private var viewer: NativeAlbumItem?
  @State private var showPicker = false
  @State private var showCreation = false
  @State private var showDetails = false
  @State private var trustCandidate: NativeAlbumSummary?
  @State private var ending = false
  @State private var link: URL?
  @State private var invitationPrepared = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(services: AppServices, selected: [LocalPhoto] = [], incoming: FotoroAlbumInvitation? = nil) {
    self.services = services; self.selected = selected; self.incoming = incoming
    _model = State(initialValue: NativeAlbumService(services: services))
  }
  private var busy: Bool { operationID != nil }
  private var binding: String {
    let access = services.photoAccountAccess
    return (access?.account ?? "") + (access?.vault.uuidString ?? "") + services.api.baseURL.absoluteString
      + ((try? Wire.encode(services.session.pinnedCards).digest) ?? "") + String(describing: scenePhase)
  }
  private var filteredItems: [NativeAlbumItem] {
    let query = albumQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return model.items }
    return model.items.filter { $0.photo.metadata.filename.localizedStandardContains(query) || $0.photo.metadata.sourceDate.localizedStandardContains(query) }
  }
  private var contacts: [AccountCardV1] {
    services.session.pinnedCards.values.filter { $0.accountId != services.session.accountId }
      .sorted { services.contactName($0.accountId).localizedStandardCompare(services.contactName($1.accountId)) == .orderedAscending }
  }
  var body: some View {
    NavigationStack {
      Group {
        if services.photoAccountAccess == nil {
          VStack(alignment: .leading) {
            if incoming != nil { Text("Open the Fotoro this album was invited to.").font(.headline).padding() }
            AccountView(services: services, onAuthenticationTask: { authenticationTask = $0 })
          }
        } else {
          albumContent
        }
      }
      .navigationTitle(model.opened?.title ?? "Albums")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(model.opened == nil ? "Done" : "Albums") {
            if model.opened != nil { stop(); model.clear(); run { try await model.refresh() } }
            else { dismiss() }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Menu("More", systemImage: "ellipsis") {
            if model.opened != nil {
              Button("Details", systemImage: "info.circle") { showDetails = true }
              Button("Share link", systemImage: "link") {
                do { if let id = model.opened?.id { link = try model.invitation(id) } }
                catch { feedback = error.localizedDescription }
              }
              if model.opened?.definition.ownerAccountId == services.session.accountId {
                Button("End access", role: .destructive) { ending = true }
              }
            }
            Button("Refresh", systemImage: "arrow.clockwise") {
              let id = model.opened?.id
              run { try await model.refresh(); if let id { try await model.open(id) } }
            }
          }.disabled(busy || services.photoAccountAccess == nil)
        }
      }
      .task(id: binding) {
        stop(); model.clear(); invitationPrepared = false; title = ""; memberIDs = []; feedback = nil
        guard services.photoAccountAccess != nil, scenePhase == .active else { return }
        do { try await model.refresh(); try prepareInvitation() }
        catch is CancellationError { return }
        catch { feedback = error.localizedDescription }
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(15)) } catch { return }
          guard scenePhase == .active, !busy else { continue }
          let openedID = model.opened?.id, count = model.opened?.overview.photoCount
          do {
            try await model.refresh()
            if let openedID, model.opened != nil,
              let fresh = model.albums.first(where: { $0.id == openedID }), fresh.overview.photoCount != count {
              try await model.open(openedID)
            }
          } catch is CancellationError { return }
          catch { feedback = error.localizedDescription }
        }
      }
      .onChange(of: scenePhase) { _, phase in
        if phase != .active { stop(); authenticationTask?.cancel(); authenticationTask = nil; model.clear() }
      }
      .onChange(of: model.opened?.id) { _, id in if id == nil { viewer = nil; link = nil } }
      .onDisappear { stop(); authenticationTask?.cancel(); authenticationTask = nil; model.clear() }
      .sheet(isPresented: $showCreation) {
        NavigationStack {
          ScrollView { create.padding() }.navigationTitle("New album").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showCreation = false }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
        }
      }
      .sheet(isPresented: $showDetails) {
        NavigationStack {
          ScrollView { if let album = model.opened { albumDetails(album).padding() } }
            .navigationTitle("Album details").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showDetails = false } } }
        }
      }
      .sheet(item: $trustCandidate) { album in
        NavigationStack {
          ScrollView { trustOwner(album).padding() }.navigationTitle("Verify sender").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { trustCandidate = nil } } }
        }
      }
      .sheet(isPresented: Binding(get: { link != nil }, set: { if !$0 { link = nil } })) {
        if let link { OriginalShareSheet(urls: [link]) { _ in self.link = nil } }
      }
      .sheet(isPresented: $showPicker) { NativeAlbumPhotoPicker(services: services, initial: selected) { photos in
        showPicker = false; run { try await model.append(photos); feedback = "Photos added." }
      } }
      .sheet(item: $viewer) { item in NativeAlbumPhotoView(model: model, item: item).presentationDetents([.large]) }
      .confirmationDialog("End album access for everyone?", isPresented: $ending, titleVisibility: .visible) {
        Button("End access", role: .destructive) { if let id = model.opened?.id { run { try await model.end(id) } } }
      } message: { Text("Previously downloaded originals cannot be recalled.") }
    }
  }
  private var albumContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if busy { ProgressView("Working…") }
        if let feedback { Text(feedback).foregroundStyle(.secondary).accessibilityIdentifier("albums.feedback") }
        if let opened = model.opened { detail(opened) }
        else { inbox }
      }.padding()
    }.accessibilityIdentifier("albums.home")
  }
  private var inbox: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Your albums").font(.headline)
        Spacer()
        Button("New album", systemImage: "plus") { showCreation = true }.buttonStyle(.borderedProminent).disabled(busy)
      }
      if model.albums.isEmpty { Text("No albums yet.").foregroundStyle(.secondary) }
      ForEach(model.albums) { album in
        VStack(alignment: .leading, spacing: 8) {
          Text(album.title ?? "Album invitation").font(.headline)
          Text("\(album.definition.members.count) members · \(album.overview.photoCount) photos").font(.subheadline).foregroundStyle(.secondary)
          Text("Owner: " + memberName(album.definition.ownerAccountId, in: album.definition)).font(.caption)
          if album.overview.endedAt != nil { Text("Access ended").foregroundStyle(.secondary) }
          else if album.needsTrust { Button("Verify sender", systemImage: "checkmark.shield") { trustCandidate = album }.buttonStyle(.bordered).disabled(busy) }
          else if album.overview.membership == "invited" {
            Button("Accept invitation") { run {
              try await model.accept(album.id, expectedOwner: incoming?.albumId == album.id ? incoming?.ownerCard : nil)
              try await model.open(album.id)
            } }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("albums.accept")
          } else {
            Button("Open album") { run { try await model.open(album.id) } }.buttonStyle(.bordered).disabled(busy)
          }
        }.padding().background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
      }
    }
  }
  private func trustOwner(_ album: NativeAlbumSummary) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Confirm this album invitation came from its owner before accepting their contact.").font(.footnote)
      Text(album.definition.ownerAccountId).font(.caption.monospaced()).textSelection(.enabled)
      if let card = album.definition.members.first(where: { $0.card.accountId == album.definition.ownerAccountId })?.card {
        Text("Signing fingerprint").font(.caption)
        Text(card.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
        Text("Encryption fingerprint").font(.caption)
        Text(card.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
      }
      Button("Confirm sender") { run {
        guard let card = album.definition.members.first(where: { $0.card.accountId == album.definition.ownerAccountId })?.card,
          incoming?.albumId != album.id || incoming?.ownerCard == card else { throw FotoroError("Album link identity does not match its owner.") }
        try services.acceptContact(card, name: ""); trustCandidate = nil; try await model.refresh(); try prepareInvitation()
      } }.buttonStyle(.bordered).disabled(busy)
    }
  }
  private var create: some View {
    VStack(alignment: .leading, spacing: 12) {
      if model.hasPendingCreation { Button("Retry pending creation") { run { let id = try await model.retryCreation(); try await model.open(id) } }.disabled(busy) }
      TextField("Album name", text: $title).textFieldStyle(.roundedBorder).accessibilityIdentifier("albums.name")
      Text("Choose 1–11 confirmed contacts. Each person accepts before viewing or adding photos.").font(.footnote).foregroundStyle(.secondary)
      if contacts.isEmpty { Text("Add a contact in Shared photos first.").foregroundStyle(.secondary) }
      ForEach(contacts, id: \.accountId) { card in
        Toggle(services.contactName(card.accountId), isOn: Binding(get: { memberIDs.contains(card.accountId) }, set: { enabled in
          if enabled { memberIDs.insert(card.accountId) } else { memberIDs.remove(card.accountId) }
        }))
      }
      Button("Create album") { run {
        let members = contacts.filter { memberIDs.contains($0.accountId) }
        let id = try await model.create(title: title, members: members)
        title = ""; memberIDs = []; try await model.open(id); showCreation = false
      } }.buttonStyle(.borderedProminent).disabled(busy || memberIDs.isEmpty || memberIDs.count > 11 || (try? NativeAlbumWire.title(title)) == nil)
        .accessibilityIdentifier("albums.create")
    }
  }
  private func detail(_ album: NativeAlbumSummary) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("\(album.overview.photoCount) photos · \(album.definition.members.count) members").font(.subheadline).foregroundStyle(.secondary)
        Spacer()
        Button(selected.isEmpty ? "Add photos" : "Add \(selected.count)", systemImage: "plus") {
          if selected.isEmpty { showPicker = true }
          else { run { try await model.append(selected); feedback = "Photos added." } }
        }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("albums.add")
      }
      ScrollView(.horizontal) {
        HStack {
          ForEach(album.definition.members, id: \.card.accountId) { member in
            Label(memberName(member.card.accountId, in: album.definition), systemImage: "person.fill")
              .font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
              .background(.secondary.opacity(0.08), in: Capsule())
          }
        }
      }.scrollIndicators(.hidden)
      if model.hasPendingAddition { Button("Retry pending addition") { run { try await model.retryAddition(); feedback = "Photos added." } }.disabled(busy) }
      TextField("Filter filenames or YYYY-MM-DD", text: $albumQuery).textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("albums.filter")
      if !albumQuery.isEmpty { Button("Clear filter") { albumQuery = "" } }
      Text("\(filteredItems.count) of \(model.items.count) loaded photos").font(.subheadline).foregroundStyle(.secondary)
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))], spacing: 4) {
        ForEach(filteredItems) { item in
          Button { viewer = item } label: { NativeAlbumThumbnail(model: model, item: item) }
            .buttonStyle(.plain).accessibilityLabel("Photo from " + memberName(item.photo.manifest.ownerAccountId, in: album.definition))
        }
      }
      if model.nextCursor != nil { Button("Load more photos") { run { try await model.loadMore() } }.disabled(busy) }
    }
  }
  private func memberName(_ account: String, in definition: AlbumDefinitionV1) -> String {
    if account == services.session.accountId { return "You" }
    let name = services.contactName(account)
    if name != "Contact " + account.suffix(8) { return name }
    return "Member " + String((definition.members.firstIndex(where: { $0.card.accountId == account }) ?? 0) + 1)
  }
  private func albumDetails(_ album: NativeAlbumSummary) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Each accepted member can add chosen Saved photos. People names and photo annotations stay private.").font(.footnote).foregroundStyle(.secondary)
      ForEach(album.definition.members, id: \.card.accountId) { member in
        VStack(alignment: .leading, spacing: 6) {
          Text(memberName(member.card.accountId, in: album.definition)).font(.headline)
          Text(member.card.accountId).font(.caption.monospaced()).textSelection(.enabled)
          Text(member.card.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
          Text(member.card.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
        }
      }
    }
  }
  private func prepareInvitation() throws {
    guard let incoming, !invitationPrepared else { return }
    guard let album = model.albums.first(where: { $0.id == incoming.albumId }),
      album.definition.ownerAccountId == incoming.ownerCard.accountId,
      album.definition.members.first(where: { $0.card.accountId == incoming.ownerCard.accountId })?.card == incoming.ownerCard else {
      throw FotoroError("This album invitation is unavailable for this account.")
    }
    invitationPrepared = true
    if album.overview.endedAt != nil { feedback = "Album access has ended." }
    else { feedback = album.overview.membership == "invited" ? "Accept the album invitation below." : "Open the album below." }
  }
  private func stop() { operation?.cancel(); operation = nil; operationID = nil; viewer = nil; showPicker = false; link = nil; albumQuery = ""; showCreation = false; showDetails = false; trustCandidate = nil }
  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    operation?.cancel(); let id = UUID(); operationID = id; feedback = nil
    operation = Task {
      defer { if operationID == id { operation = nil; operationID = nil } }
      do { try await action() }
      catch is CancellationError {} catch { if operationID == id { feedback = error.localizedDescription } }
    }
  }
}

private struct NativeAlbumPhotoPicker: View {
  @Bindable var services: AppServices
  let initial: [LocalPhoto]
  let add: ([LocalPhoto]) -> Void
  @State private var photos: [LocalPhoto] = []
  @State private var ids = Set<String>()
  @State private var feedback: String?
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        Text("Choose up to 100 of your Saved photos. Save device photos first.").font(.footnote).foregroundStyle(.secondary)
        if let feedback { Text(feedback) }
        ForEach(photos) { photo in
          Toggle(photo.metadata.filename, isOn: Binding(get: { ids.contains(photo.id) }, set: { enabled in
            if enabled { ids.insert(photo.id) } else { ids.remove(photo.id) }
          }))
        }
      }.navigationTitle("Add Saved photos")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) { Button("Add \(ids.count)") { add(photos.filter { ids.contains($0.id) }) }.disabled(ids.isEmpty || ids.count > 100) }
      }
      .task {
        do {
          guard let account = services.photoAccountAccess?.account else { return }
          photos = try services.store.photos(limit: 1000).filter { $0.manifest.ownerAccountId == account && ["saved", "committed"].contains($0.transferState) }
          let eligible = Set(photos.map(\.id)); ids = Set(initial.map(\.id)).intersection(eligible)
        } catch { feedback = error.localizedDescription }
      }
    }
  }
}

private struct NativeAlbumThumbnail: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  @State private var url: URL?
  var body: some View {
    LazyImage(url: url) { state in
      if let image = state.image { image.resizable().scaledToFill() }
      else { Rectangle().fill(.secondary.opacity(0.2)).overlay { Image(systemName: "photo") } }
    }.frame(height: 110).clipped()
      .task(id: item.id) { do { url = try await model.thumbnail(item) } catch { url = nil } }
  }
}

private struct NativeAlbumPhotoView: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  @State private var preview: URL?
  @State private var player: AVPlayer?
  @State private var motionExports: [URL] = []
  @State private var exports: [URL] = []
  @State private var showShare = false
  @State private var feedback: String?
  @State private var operation: Task<Void, Never>?
  @State private var loading = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      VStack {
        if let feedback { Text(feedback).foregroundStyle(.secondary) }
        if let player { VideoPlayer(player: player) }
        else {
          LazyImage(url: preview) { state in
            if let image = state.image { image.resizable().scaledToFit() }
            else { ProgressView() }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        Text(item.photo.metadata.sourceDate).font(.caption).foregroundStyle(.secondary)
      }.navigationTitle(item.photo.metadata.filename).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        if CameraMedia.isMotion(item.photo.metadata.mediaType) {
          ToolbarItem(placement: .bottomBar) { Button(item.photo.metadata.mediaType == CameraMedia.liveType ? "Play Live Photo" : "Play video", systemImage: "play.fill") {
            operation?.cancel(); loading = true
            operation = Task {
              defer { loading = false; operation = nil }
              do {
                let urls = try await model.export(item); try Task.checkCancellation()
                motionExports = urls
                let movie = item.photo.metadata.mediaType == CameraMedia.liveType ? urls[1] : urls[0]
                player = AVPlayer(url: movie); player?.play()
              } catch is CancellationError {} catch { feedback = error.localizedDescription }
            }
          }.disabled(loading) }
        }
        ToolbarItem(placement: .bottomBar) { Button("Share original", systemImage: "square.and.arrow.up") {
          operation?.cancel(); loading = true
          operation = Task {
            defer { loading = false; operation = nil }
            do { exports = try await model.export(item); try Task.checkCancellation(); showShare = true }
            catch is CancellationError {} catch { feedback = error.localizedDescription }
          }
        }.disabled(loading) }
      }
      .task(id: item.id) { do { preview = try await model.preview(item) } catch is CancellationError {} catch { feedback = error.localizedDescription } }
      .sheet(isPresented: $showShare, onDismiss: cleanup) { OriginalShareSheet(urls: exports) { _ in cleanup() } }
      .onChange(of: scenePhase) { _, phase in if phase != .active { operation?.cancel(); cleanup(); cleanupMotion(); preview = nil; dismiss() } }
      .onDisappear { operation?.cancel(); cleanup(); cleanupMotion(); preview = nil }
    }
  }
  private func cleanupMotion() {
    player?.pause(); player = nil
    for url in motionExports { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    motionExports = []
  }
  private func cleanup() {
    for url in exports { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    exports = []; showShare = false
  }
}
