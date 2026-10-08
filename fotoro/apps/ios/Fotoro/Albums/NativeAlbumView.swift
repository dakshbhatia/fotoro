import AVKit
import NukeUI
import Observation
import SwiftUI

struct NativeAlbumPresentation: Identifiable {
  let id = UUID()
  var selected: [LocalPhoto] = []
  var incoming: FotoroAlbumInvitation?
  static func opening(incoming: FotoroAlbumInvitation?, selection: () throws -> [LocalPhoto]) rethrows -> Self {
    Self(selected: incoming == nil ? try selection() : [], incoming: incoming)
  }
}

struct NativeAlbumView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  let incoming: FotoroAlbumInvitation?
  @State private var model: NativeAlbumService
  @State private var title = ""
  @State private var familyFilter = NativeAlbumSearchFilter()
  @State private var groupDuplicates = true
  @State private var showFamilyFilters = false
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
    model.items.filter { familyFilter.includes($0, facts: model.sharedFacts[$0.id]) }
  }
  private var photoGroups: [NativeAlbumDuplicateGroup] {
    groupDuplicates ? NativeAlbumSearch.groups(filteredItems) : filteredItems.map { NativeAlbumDuplicateGroup(copies: [$0]) }
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
        stop(); model.clear(); invitationPrepared = false; title = ""; memberIDs = []; feedback = nil; familyFilter = NativeAlbumSearchFilter()
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
      .onChange(of: model.opened?.id) { _, id in if id == nil { viewer = nil; link = nil; showFamilyFilters = false } }
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
      .sheet(isPresented: $showFamilyFilters) {
        NativeAlbumFamilyFilters(filter: $familyFilter,
          choices: NativeAlbumSearch.choices(items: model.items, facts: model.sharedFacts),
          memberName: { account in model.opened.map { memberName(account, in: $0.definition) } ?? "Member" })
      }
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
      TextField("Search shared details, filenames or dates", text: $familyFilter.query).textFieldStyle(.roundedBorder)
        .accessibilityIdentifier("albums.filter")
      HStack {
        Button("People, place and dates", systemImage: "line.3.horizontal.decrease") { showFamilyFilters = true }
          .accessibilityIdentifier("albums.family.filters")
        if familyFilter.hasFilters { Button("Clear filters") { familyFilter = NativeAlbumSearchFilter() } }
      }
      Toggle("Group identical originals", isOn: $groupDuplicates).font(.subheadline)
      Text("\(filteredItems.count) matching contributions in \(model.items.count) loaded photos").font(.subheadline).foregroundStyle(.secondary)
      if model.nextCursor != nil { Text("More album photos are available below. Filters apply to loaded photos.").font(.caption).foregroundStyle(.secondary) }
      if model.factsSupported == false {
        Text("Shared photo details are unavailable on this server. Photo dates and filenames still work.").font(.caption).foregroundStyle(.secondary)
      } else {
        Text("Shared details loaded for \(model.sharedFacts.count) photos. Names are contributor-reviewed labels, not linked identities.")
          .font(.caption).foregroundStyle(.secondary)
        if let error = model.factsError { Text(error).font(.caption).foregroundStyle(.secondary) }
        if model.factsNextCursor != nil || model.factsError != nil {
          Button(model.factsError == nil ? "Load more shared details" : "Retry shared details") { run { try await model.loadMoreSharedDetails() } }
            .disabled(busy).accessibilityIdentifier("albums.details.loadMore")
        }
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))], spacing: 4) {
        ForEach(photoGroups) { group in
          VStack {
            Button { viewer = group.representative } label: { NativeAlbumThumbnail(model: model, item: group.representative) }
              .buttonStyle(.plain).accessibilityLabel(NativeAlbumPhotoAccessibility.label(group.representative.photo, member: memberName(group.representative.photo.manifest.ownerAccountId, in: album.definition)))
            if group.copies.count > 1 {
              Menu("\(group.copies.count) copies") {
                ForEach(group.copies) { item in
                  Button(memberName(item.photo.manifest.ownerAccountId, in: album.definition) + " · " + item.photo.metadata.filename) { viewer = item }
                }
              }.font(.caption).accessibilityLabel("Open a contributing copy")
            }
          }
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
  private func stop() { operation?.cancel(); operation = nil; operationID = nil; viewer = nil; showPicker = false; link = nil; familyFilter = NativeAlbumSearchFilter(); showFamilyFilters = false; showCreation = false; showDetails = false; trustCandidate = nil }
  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    operation?.cancel(); let id = UUID(); operationID = id; feedback = nil
    operation = Task {
      defer { if operationID == id { operation = nil; operationID = nil } }
      do { try await services.withDiagnosticAction(.albums, action) }
      catch is CancellationError {} catch { if operationID == id { feedback = error.localizedDescription } }
    }
  }
}

struct NativeAlbumPickerContext: Equatable {
  let access: PhotoAccountAccess
  let origin: String
  @MainActor static func current(_ services: AppServices) -> Self? {
    guard let access = services.photoAccountAccess else { return nil }
    return Self(access: access, origin: services.api.baseURL.absoluteString)
  }
}

@MainActor @Observable final class NativeAlbumPhotoPickerStore {
  static let pageSize = 200
  private(set) var photos: [LocalPhoto] = []
  private(set) var busy = false
  private(set) var hasMore = false
  private(set) var feedback: String?
  private(set) var selection = SavedPhotoSelection()
  private var context: NativeAlbumPickerContext?
  private var after: String?
  private var seen = Set<String>()
  private var cursors = Set<String>()
  private var task: Task<Void, Never>?
  private var operation = UUID()
  private let readPage: @Sendable (LibraryStore, String?, Int) async throws -> [LocalPhoto]
  init(readPage: @escaping @Sendable (LibraryStore, String?, Int) async throws -> [LocalPhoto] = { catalog, after, limit in
    try Task.checkCancellation()
    let worker = Task.detached(priority: .userInitiated) {
      try Task.checkCancellation()
      return try catalog.photos(after: after, limit: limit)
    }
    return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
  }) { self.readPage = readPage }
  func isCurrent(_ services: AppServices) -> Bool {
    context != nil && context == NativeAlbumPickerContext.current(services)
  }
  func clear() {
    operation = UUID(); task?.cancel(); task = nil
    photos = []; selection.removeAll(); context = nil; after = nil; seen = []; cursors = []
    busy = false; hasMore = false; feedback = nil
  }
  func open(_ services: AppServices, initial: [LocalPhoto] = []) {
    clear()
    guard let context = NativeAlbumPickerContext.current(services) else { return }
    self.context = context
    for photo in initial where selection.count < 100 && !selection.contains(photo.id)
      && SavedPhotoSelection.isCurrent([photo], lookup: services.consumerSavedPhoto) {
      selection.toggle(photo)
    }
    hasMore = true
    loadMore(services)
  }
  func refresh(_ services: AppServices) {
    guard isCurrent(services) else { clear(); return }
    selection.removeWithdrawn(using: services.consumerSavedPhoto)
    let selected = (try? selection.resolve(using: services.consumerSavedPhoto)) ?? []
    open(services, initial: selected)
  }
  func toggle(_ photo: LocalPhoto, services: AppServices) {
    guard isCurrent(services) else { clear(); return }
    if selection.contains(photo.id) { selection.toggle(photo); return }
    guard SavedPhotoSelection.isCurrent([photo], lookup: services.consumerSavedPhoto) else {
      feedback = "This Saved photo changed. Refresh and choose it again."; return
    }
    guard selection.count < 100 else { feedback = "Choose up to 100 Saved photos."; return }
    selection.toggle(photo); feedback = nil
  }
  func chosen(_ services: AppServices) throws -> [LocalPhoto] {
    guard isCurrent(services) else { clear(); throw CancellationError() }
    return try selection.resolve(using: services.consumerSavedPhoto)
  }
  func loadMore(_ services: AppServices) {
    guard isCurrent(services) else { clear(); return }
    guard !busy, hasMore, let context else { return }
    let catalog = services.store, cursor = after, read = readPage, token = UUID()
    operation = token; busy = true; feedback = nil
    task = Task {
      defer { if operation == token { task = nil; busy = false } }
      do {
        let page = try await read(catalog, cursor, Self.pageSize)
        try Task.checkCancellation()
        guard operation == token, isCurrent(services) else { throw CancellationError() }
        guard page.count <= Self.pageSize else { throw FotoroError("Saved photo page is too large.") }
        let next = page.count == Self.pageSize ? page.last?.id : nil
        if let next, cursors.contains(next) { throw FotoroError("Saved photos changed. Refresh to continue.") }
        for photo in page where photo.manifest.ownerAccountId == context.access.account
          && photo.manifest.photoId == photo.id && ["saved", "committed"].contains(photo.transferState) {
          if seen.insert(photo.id).inserted { photos.append(photo) }
        }
        if let next { cursors.insert(next) }
        after = next; hasMore = next != nil
      } catch is CancellationError {
        if operation == token, !isCurrent(services) { clear() }
      } catch {
        if operation == token {
          if !isCurrent(services) { clear() }
          else if !Task.isCancelled { feedback = error.localizedDescription }
        }
      }
    }
  }
  func waitUntilSettled() async { await task?.value }
}

enum NativeAlbumPhotoAccessibility {
  static func label(_ photo: LocalPhoto, member: String? = nil) -> String {
    var parts = [photo.metadata.filename]
    if let date = Wire.parseDate(photo.metadata.sourceDate) {
      let prefix = ["photos", "exif"].contains(photo.metadata.dateSource) ? "Photo date" : "Import date"
      parts.append(prefix + " " + date.formatted(date: .abbreviated, time: .shortened))
    }
    if let member { parts.append("Photo from " + member) }
    return parts.joined(separator: ", ")
  }
}

private struct NativeAlbumPhotoPicker: View {
  @Bindable var services: AppServices
  let initial: [LocalPhoto]
  let add: ([LocalPhoto]) -> Void
  @State private var picker = NativeAlbumPhotoPickerStore()
  @State private var feedback: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var context: NativeAlbumPickerContext? {
    scenePhase == .active ? NativeAlbumPickerContext.current(services) : nil
  }
  var body: some View {
    NavigationStack {
      List {
        Text("Choose up to 100 of your Saved photos. Save device photos first.").font(.footnote).foregroundStyle(.secondary)
        if let message = feedback ?? picker.feedback { Text(message).foregroundStyle(.secondary) }
        ForEach(picker.isCurrent(services) ? picker.photos : []) { photo in
          Toggle(photo.metadata.filename, isOn: Binding(get: { picker.selection.contains(photo.id) }, set: { enabled in
            if enabled != picker.selection.contains(photo.id) { feedback = nil; picker.toggle(photo, services: services) }
          })).accessibilityLabel(NativeAlbumPhotoAccessibility.label(photo))
        }
        if picker.busy { ProgressView("Loading Saved photos…") }
        else if picker.isCurrent(services) {
          if picker.hasMore {
            Button("Load more Saved photos") { feedback = nil; picker.loadMore(services) }
              .accessibilityIdentifier("albums.picker.loadMore")
          }
          Button("Refresh Saved photos") { feedback = nil; picker.refresh(services) }
            .accessibilityIdentifier("albums.picker.refresh")
        }
      }.navigationTitle("Add Saved photos")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add \(picker.selection.count)") {
            do { add(try picker.chosen(services)) } catch is CancellationError {} catch { feedback = error.localizedDescription }
          }.disabled(!picker.isCurrent(services) || picker.selection.count == 0)
            .accessibilityIdentifier("albums.picker.add")
        }
      }
      .task(id: context) {
        feedback = nil
        if context == nil { picker.clear() } else { picker.open(services, initial: initial) }
      }
      .onDisappear { picker.clear() }
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
  @State private var showDetailsEditor = false
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
        if let facts = model.sharedFacts[item.id] {
          if !facts.people.isEmpty { Text(facts.people.joined(separator: ", ")).font(.caption) }
          if let location = facts.location { Text(location.displayName + " · " + location.provenance).font(.caption) }
        }
      }.navigationTitle(item.photo.metadata.filename).navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        if model.factsSupported == true, item.photo.manifest.ownerAccountId == model.services.session.accountId {
          ToolbarItem(placement: .topBarTrailing) { Button("Share details", systemImage: "tag") { showDetailsEditor = true }
            .accessibilityIdentifier("albums.details.edit") }
        }
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
      .sheet(isPresented: $showDetailsEditor) { NativeAlbumSharedDetailsEditor(model: model, item: item) }
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
