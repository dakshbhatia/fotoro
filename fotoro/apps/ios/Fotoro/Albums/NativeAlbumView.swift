import AVKit
import NukeUI
import Observation
import Photos
import PhotosUI
import SwiftUI

struct NativeAlbumPresentation: Identifiable {
  let id = UUID()
  var selected: [LocalPhoto] = []
  var incoming: FotoroAlbumInvitation?
  static func opening(incoming: FotoroAlbumInvitation?, selection: () throws -> [LocalPhoto]) rethrows -> Self {
    Self(selected: incoming == nil ? try selection() : [], incoming: incoming)
  }
}

// Keep navigation intent, never decrypted media or album keys, across inactivity.
struct NativeAlbumReturnIntent {
  let id = UUID()
  let context: NativeAlbumPickerContext
  let albumID: String
  let definition: SignedPayloadV1
  let filter: NativeAlbumSearchFilter
  @MainActor static func capture(from model: NativeAlbumService, filter: NativeAlbumSearchFilter) -> Self? {
    guard let access = model.currentOpenedPhotoAccess else { return nil }
    return Self(album: model.opened,
      context: NativeAlbumPickerContext(access: access, origin: model.services.api.baseURL.absoluteString), filter: filter)
  }
  init?(album: NativeAlbumSummary?, context: NativeAlbumPickerContext?, filter: NativeAlbumSearchFilter) {
    guard let album, let context, !album.needsTrust,
      album.overview.membership == "accepted", album.overview.endedAt == nil else { return nil }
    self.context = context; albumID = album.id; definition = album.overview.definition; self.filter = filter
  }
  func destination(in albums: [NativeAlbumSummary], context: NativeAlbumPickerContext?) -> String? {
    guard self.context == context,
      albums.contains(where: { $0.id == albumID && $0.overview.definition == definition
        && $0.overview.membership == "accepted" && $0.overview.endedAt == nil && !$0.needsTrust }) else { return nil }
    return albumID
  }
  @MainActor func reopen(in model: NativeAlbumService, services: AppServices) async throws -> NativeAlbumSearchFilter? {
    try Task.checkCancellation()
    guard let id = destination(in: model.albums, context: NativeAlbumPickerContext.current(services)) else { return nil }
    try await model.open(id)
    try Task.checkCancellation()
    guard let opened = model.opened,
      destination(in: [opened], context: NativeAlbumPickerContext.current(services)) == id else { throw CancellationError() }
    return filter
  }
}

struct NativeAlbumResumeState {
  var intent: NativeAlbumReturnIntent?
  @MainActor mutating func deliberateNavigation(in model: NativeAlbumService) {
    intent = nil; model.discardOpenedAlbum()
  }
  @MainActor mutating func useAnotherAccount(services: AppServices, model: NativeAlbumService) {
    intent = nil; model.clear(); services.lockAccount()
  }
  @MainActor func reopen(in model: NativeAlbumService, services: AppServices) async throws -> NativeAlbumSearchFilter? {
    guard let intent else { return nil }
    return try await intent.reopen(in: model, services: services)
  }
}

// Called only after the owner identity shown in the review sheet was confirmed.
@MainActor enum NativeAlbumReviewedJoin {
  static func join(_ reviewed: NativeAlbumSummary, incoming: FotoroAlbumInvitation?, services: AppServices, model: NativeAlbumService) async throws {
    try Task.checkCancellation()
    guard let access = services.photoAccountAccess,
      let owner = reviewed.definition.members.first(where: { $0.card.accountId == reviewed.definition.ownerAccountId })?.card,
      reviewed.overview.endedAt == nil,
      incoming?.albumId != reviewed.id || incoming?.ownerCard == owner else {
      throw FotoroError("Album link identity does not match its owner.")
    }
    guard try NativeAlbumWire.overview(reviewed.overview) == reviewed.definition,
      reviewed.definition.members.contains(where: { $0.card.accountId == access.account && $0.card == services.session.pinnedCards[access.account] }),
      model.albums.contains(where: { $0.id == reviewed.id && $0.overview.definition == reviewed.overview.definition }) else {
      throw FotoroError("Album invitation is unavailable for this account.")
    }
    _ = try CryptoAdapter().verify(reviewed.overview.definition, card: owner, kind: "album-v1")
    let origin = services.api.baseURL.absoluteString
    if services.session.pinnedCards[owner.accountId] != owner { try services.acceptContact(owner, name: nil) }
    try await model.refresh()
    try Task.checkCancellation()
    guard services.photoAccountAccess == access, services.api.baseURL.absoluteString == origin else { throw CancellationError() }
    guard let fresh = model.albums.first(where: { $0.id == reviewed.id }),
      fresh.overview.definition == reviewed.overview.definition, !fresh.needsTrust,
      fresh.overview.endedAt == nil else { throw FotoroError("Album invitation changed. Review it again before joining.") }
    if fresh.overview.membership == "invited" { try await model.accept(fresh.id, expectedOwner: owner) }
    else if fresh.overview.membership != "accepted" { throw FotoroError("Album invitation is unavailable.") }
    try Task.checkCancellation()
    guard services.photoAccountAccess == access, services.api.baseURL.absoluteString == origin else { throw CancellationError() }
    try await model.open(fresh.id)
  }
}

struct NativeAlbumView: View {
  @Bindable var services: AppServices
  let selected: [LocalPhoto]
  let incoming: FotoroAlbumInvitation?
  @State private var model: NativeAlbumService
  @State private var title = ""
  @State private var familyFilter = NativeAlbumSearchFilter()
  @State private var searchTask: Task<Void, Never>?
  @State private var searchTaskID: UUID?
  @State private var searchError: String?

  @State private var groupDuplicates = true
  @State private var showTripPicks = false
  @State private var showFamilyFilters = false
  @State private var memberIDs = Set<String>()
  @State private var operation: Task<Void, Never>?
  @State private var operationID: UUID?
  @State private var authenticationTask: Task<Void, Never>?
  @State private var feedback: String?
  @State private var viewer: NativeAlbumItem?
  @State private var showPicker = false
  @State private var savingDevicePhotos = false
  @State private var showCreation = false
  @State private var showCreationContacts = false
  @State private var showDetails = false
  @State private var trustCandidate: NativeAlbumSummary?
  @State private var ending = false
  @State private var link: URL?
  @State private var invitationPrepared = false
  @State private var invitationUnavailable = false
  @State private var enterAnotherAccount = false
  @State private var resumeState = NativeAlbumResumeState()
  @State private var downloadToken = UUID()
  @State private var downloadProgress: NativeTripDownloadProgress?
  @State private var downloadedTrip: NativeTripDownloadResult?
  @State private var showTripShare = false
  @State private var downloadError: String?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.dismiss) private var dismiss
  init(services: AppServices, selected: [LocalPhoto] = [], incoming: FotoroAlbumInvitation? = nil) {
    self.services = services; self.selected = selected; self.incoming = incoming
    _model = State(initialValue: NativeAlbumService(services: services))
  }
  private var busy: Bool { operationID != nil }
  private var binding: String {
    let access = services.photoAccountAccess
    return (access?.account ?? "") + (access?.vault.uuidString ?? "") + services.api.baseURL.absoluteString
      + String(scenePhase == .background)
  }
  private var wantsWholeTripSearch: Bool { familyFilter.hasFilters || showFamilyFilters }
  private var browseSnapshot: NativeAlbumSearchSnapshot {
    model.browse(filter: familyFilter, groupDuplicates: groupDuplicates)
  }
  private var filteredItems: [NativeAlbumItem] {
    browseSnapshot.items
  }
  private var photoGroups: [NativeAlbumDuplicateGroup] {
    browseSnapshot.groups
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
            if incoming != nil { Text("Open the Fotoro invited to this trip.").font(.headline).padding() }
            AccountView(services: services, enterPassword: enterAnotherAccount, onAuthenticationTask: { authenticationTask = $0 })
          }
        } else {
          albumContent
        }
      }
      .navigationTitle(model.opened?.title ?? "Trips")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(model.opened == nil ? "Done" : "Trips") {
            if model.opened != nil { resumeState.deliberateNavigation(in: model); stop(); model.clear(); run { try await model.refresh() } }
            else { dismiss() }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Menu("More", systemImage: "ellipsis") {
            if model.opened != nil {
              Button("Details", systemImage: "info.circle") { showDetails = true }
              Toggle("Best shots", isOn: $showTripPicks).disabled(filteredItems.isEmpty)
                .accessibilityIdentifier("albums.picks")
              if !wantsWholeTripSearch, model.factsNextCursor != nil, model.factsError == nil {
                Button("Load shared details") { run { try await model.loadMoreSharedDetails() } }
                  .accessibilityIdentifier("albums.details.loadMore")
              }
              Button("Share link", systemImage: "link") {
                do { if let id = model.opened?.id { link = try model.invitation(id) } }
                catch { feedback = error.localizedDescription }
              }
              if model.opened?.definition.ownerAccountId == services.session.accountId {
                Button("End access", role: .destructive) { ending = true }
              }
            }
            Button("Refresh", systemImage: "arrow.clockwise") {
              run { try await refreshAlbums(reopenCurrent: true) }
            }
          }.disabled(busy || services.photoAccountAccess == nil)
        }
      }
      .task(id: binding) {
        guard scenePhase != .background else { suspendAlbum(); return }
        stop(); model.clear(); invitationPrepared = false; invitationUnavailable = false; title = ""; memberIDs = []; feedback = nil; familyFilter = NativeAlbumSearchFilter()
        guard services.photoAccountAccess != nil else { resumeState.intent = nil; return }
        enterAnotherAccount = false
        do {
          try await refreshAlbums()
        }
        catch is CancellationError { if Task.isCancelled { return } }
        catch { feedback = error.localizedDescription }
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(15)) } catch { return }
          guard scenePhase == .active, !busy, searchTask == nil, !showPicker else { continue }
          let openedID = model.opened?.id, count = model.opened?.overview.photoCount
          run {
            try await refreshAlbums()
            if let openedID, model.opened?.id == openedID,
              let fresh = model.albums.first(where: { $0.id == openedID }), fresh.overview.photoCount != count {
              try await model.refreshOpened()
            }
          }
        }
      }
      .onChange(of: familyFilter) { _, _ in startTripSearch() }
      .onChange(of: showFamilyFilters) { _, _ in startTripSearch() }
      .onChange(of: operationID) { _, id in if id == nil { startTripSearch() } }
      .onChange(of: model.searchCoverageID) { _, _ in searchError = nil; startTripSearch() }
      .onChange(of: scenePhase) { _, phase in
        if phase == .background { suspendAlbum() }
      }
      .onChange(of: model.opened?.id) { _, id in
        if id == nil { cleanupTripDownload(); viewer = nil; link = nil; showFamilyFilters = false; showPicker = false }
      }
      .onDisappear { resumeState.intent = nil; stop(); authenticationTask?.cancel(); authenticationTask = nil; model.clear() }
      .sheet(isPresented: $showCreation) {
        NavigationStack {
          ScrollView { create.padding() }.navigationTitle("New trip").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showCreation = false }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
        }
        .sheet(isPresented: $showCreationContacts) {
          ExchangeView(services: services, selected: [], contactsOnly: true)
        }
      }
      .sheet(isPresented: $showDetails) {
        NavigationStack {
          ScrollView { if let album = model.opened { albumDetails(album).padding() } }
            .navigationTitle("Trip details").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showDetails = false } } }
        }
      }
      .sheet(item: $trustCandidate) { album in
        NavigationStack {
          ScrollView { trustOwner(album).padding() }.navigationTitle("Verify sender").navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(busy)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { trustCandidate = nil }.disabled(busy) } }
        }
      }
      .sheet(isPresented: Binding(get: { link != nil }, set: { if !$0 { link = nil } })) {
        if let link { OriginalShareSheet(urls: [link]) { _ in self.link = nil } }
      }
      .sheet(isPresented: $showPicker) {
        NativeAlbumPhotoPicker(services: services, initial: selected, adding: busy,
          additionFeedback: feedback, pendingAddition: model.hasPendingAddition,
          cancelAddition: { operation?.cancel(); feedback = "Adding cancelled." },
          retryAddition: { run { try await finishPickerAddition { try await model.retryAddition() } } },
          addDevice: { sources in
            run { try await finishPickerAddition { try await addDevicePhotos(sources) } }
          }, add: { photos in
            run { try await finishPickerAddition { try await model.append(photos) } }
          })
      }
      .sheet(isPresented: $showTripShare, onDismiss: cleanupTripDownload) {
        if let downloadedTrip {
          OriginalShareSheet(urls: [downloadedTrip.archive]) { _ in cleanupTripDownload() }
        }
      }
      .sheet(item: $viewer) { item in NativeAlbumPhotoView(model: model, item: item).presentationDetents([.large]) }
      .sheet(isPresented: $showFamilyFilters) {
        NativeAlbumFamilyFilters(filter: $familyFilter, groupDuplicates: $groupDuplicates,
          choices: NativeAlbumSearch.choices(items: model.items, facts: model.sharedFacts),
          loadingChoices: wantsWholeTripSearch && !model.searchMetadataComplete,
          searchError: searchError,
          retrySearch: { searchError = nil; startTripSearch() },
          memberName: { account in model.opened.map { memberName(account, in: $0.definition) } ?? "Member" })
      }
      .confirmationDialog("End trip access for everyone?", isPresented: $ending, titleVisibility: .visible) {
        Button("End access", role: .destructive) { if let id = model.opened?.id { run { try await model.end(id) } } }
      } message: { Text("Previously downloaded originals cannot be recalled.") }
    }
  }
  private var albumContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if busy && downloadProgress == nil {
          ProgressView(savingDevicePhotos ? "Saving photos…" : "Working…")
          if savingDevicePhotos {
            Button("Cancel adding photos", role: .cancel) { operation?.cancel() }
              .accessibilityIdentifier("albums.device.cancel")
          }
        }
        if let feedback { Text(feedback).foregroundStyle(.secondary).accessibilityIdentifier("albums.feedback") }
        if invitationUnavailable {
          Button("Use another account") {
            stop(); authenticationTask?.cancel(); authenticationTask = nil
            enterAnotherAccount = true
            resumeState.useAnotherAccount(services: services, model: model)
          }.buttonStyle(.bordered).disabled(busy || services.busy)
            .accessibilityIdentifier("albums.useAnotherAccount")
        }
        if let opened = model.opened { detail(opened) }
        else { inbox }
      }.padding()
    }.accessibilityIdentifier("albums.home")
  }
  private var inbox: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Your trips").font(.headline)
        Spacer()
        Button("New trip", systemImage: "plus") { resumeState.deliberateNavigation(in: model); showCreation = true }.buttonStyle(.borderedProminent).disabled(busy)
      }
      if let error = model.inboxError {
        Text(error).foregroundStyle(.secondary)
        Button("Refresh trips") { run { try await model.refresh() } }.disabled(busy)
      } else if model.albums.isEmpty { Text("No trips yet.").foregroundStyle(.secondary) }
      ForEach(model.albums.sorted { ($0.id == incoming?.albumId ? 0 : 1) < ($1.id == incoming?.albumId ? 0 : 1) }) { album in
        if album.overview.endedAt == nil, !album.needsTrust, album.overview.membership == "accepted" {
          Button { run(navigating: true) { try await model.open(album.id) } } label: {
            HStack {
              tripSummary(album)
              Spacer()
              Image(systemName: "chevron.right").foregroundStyle(.secondary).accessibilityHidden(true)
            }.padding().frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
              .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
          }.buttonStyle(.plain).disabled(busy)
            .accessibilityHint("Open trip")
        } else {
          VStack(alignment: .leading, spacing: 8) {
            tripSummary(album)
            Text("From " + memberName(album.definition.ownerAccountId, in: album.definition)).font(.caption)
            if album.overview.endedAt != nil { Text("Access ended").foregroundStyle(.secondary) }
            else if album.needsTrust { Button("Verify sender", systemImage: "checkmark.shield") { resumeState.deliberateNavigation(in: model); trustCandidate = album }.buttonStyle(.bordered).disabled(busy) }
            else if album.overview.membership == "invited" {
              Button("Join trip") { run(navigating: true) {
                try await model.accept(album.id, expectedOwner: incoming?.albumId == album.id ? incoming?.ownerCard : nil)
                try await model.open(album.id)
              } }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("albums.accept")
            }
          }.padding().background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
        }
      }
    }
  }
  private func tripSummary(_ album: NativeAlbumSummary) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(album.title ?? "Trip invitation").font(.headline)
      Text("\(album.overview.photoCount) photos").font(.subheadline).foregroundStyle(.secondary)
    }
  }
  private func trustOwner(_ album: NativeAlbumSummary) -> some View {
    let owner = album.definition.members.first(where: { $0.card.accountId == album.definition.ownerAccountId })?.card
    let changed = services.session.pinnedCards[album.definition.ownerAccountId].map { $0 != owner } ?? false
    return VStack(alignment: .leading, spacing: 8) {
      Text(changed ? "Their Fotoro keys changed. Confirm this trip link with them before joining." : "Confirm this trip invitation came from its owner.").font(.footnote)
      if let feedback { Text(feedback).foregroundStyle(.secondary) }
      Text(memberName(album.definition.ownerAccountId, in: album.definition)).font(.headline)
      DisclosureGroup("Identity details") {
        Text(album.definition.ownerAccountId).font(.caption.monospaced()).textSelection(.enabled)
        if let card = owner {
          Text("Signing fingerprint").font(.caption)
          Text(card.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
          Text("Encryption fingerprint").font(.caption)
          Text(card.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
        }
      }
      Button(changed ? "Join trip with new identity" : "Join trip") { run(navigating: true) {
        try await NativeAlbumReviewedJoin.join(album, incoming: incoming, services: services, model: model)
        trustCandidate = nil
      } }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("albums.joinReviewed")
    }
  }
  private var create: some View {
    VStack(alignment: .leading, spacing: 12) {
      if model.hasPendingCreation {
        Button("Retry pending creation") { run(navigating: true) {
          let id = try await model.retryCreation(); try await model.open(id)
          try Task.checkCancellation()
          title = ""; memberIDs = []; showCreation = false
        } }.disabled(busy)
      }
      TextField("Trip name", text: $title).textFieldStyle(.roundedBorder).accessibilityIdentifier("albums.name")
      Text("Invite up to 11 contacts. Each person must join to see or add photos.").font(.footnote).foregroundStyle(.secondary)
      Button("Add contact", systemImage: "person.badge.plus") { showCreationContacts = true }
        .disabled(busy || services.busy).accessibilityIdentifier("albums.addContact")
      ForEach(contacts, id: \.accountId) { card in
        Toggle(services.contactName(card.accountId), isOn: Binding(get: { memberIDs.contains(card.accountId) }, set: { enabled in
          if enabled { memberIDs.insert(card.accountId) } else { memberIDs.remove(card.accountId) }
        }))
      }
      Button("Create trip") { run(navigating: true) {
        let members = contacts.filter { memberIDs.contains($0.accountId) }
        let id = try await model.create(title: title, members: members)
        title = ""; memberIDs = []; try await model.open(id); showCreation = false
      } }.buttonStyle(.borderedProminent).disabled(busy || memberIDs.isEmpty || memberIDs.count > 11 || (try? NativeAlbumWire.title(title)) == nil)
        .accessibilityIdentifier("albums.create")
    }
  }
  private func detail(_ album: NativeAlbumSummary) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      tripActions
      tripDownloadControls
      if model.hasPendingAddition { Button("Retry adding photos") { run { try await model.retryAddition(); feedback = "Photos added." } }.disabled(busy) }
      if dynamicTypeSize.isAccessibilitySize {
        VStack(alignment: .leading, spacing: 8) { tripSearchField; tripFiltersButton }
      } else {
        HStack { tripSearchField; tripFiltersButton }
      }
      tripSearchStatus
      NativeTripPicks(model: model, items: filteredItems, hasMore: model.nextCursor != nil, reviewing: $showTripPicks) { viewer = $0 }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 96))], spacing: 4) {
        ForEach(photoGroups) { group in
          VStack {
            NativeAlbumThumbnail(model: model, item: group.representative) { viewer = group.representative }
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
      if familyFilter.hasFilters && filteredItems.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text(model.searchMetadataComplete ? "No matches." : "No matches in the photos checked so far.")
            .foregroundStyle(.secondary).accessibilityIdentifier("albums.search.empty")
          Button("Clear filters") { familyFilter = NativeAlbumSearchFilter(); groupDuplicates = true }
            .frame(minHeight: 44).accessibilityIdentifier("albums.filter.clear")
        }
      }
      if !wantsWholeTripSearch && model.nextCursor != nil { Button("Load more photos") { run { try await model.loadMore() } }.disabled(busy) }
    }
  }
  private var tripAddButton: some View {
    Button(selected.isEmpty ? "Add photos" : "Add \(selected.count)", systemImage: "plus") {
      if selected.isEmpty { feedback = nil; showPicker = true }
      else { run { try await model.append(selected); feedback = "Photos added." } }
    }.buttonStyle(.borderedProminent).disabled(busy).frame(minHeight: 44).accessibilityIdentifier("albums.add")
  }
  private var tripDownloadButton: some View {
    Button("Download trip", systemImage: "arrow.down.circle") { downloadTrip() }
      .disabled(busy || model.opened?.overview.photoCount == 0).frame(minHeight: 44)
      .accessibilityHint("Download all trip originals as a ZIP, including photos outside current filters.")
      .accessibilityIdentifier("albums.download")
  }
  @ViewBuilder private var tripActions: some View {
    if dynamicTypeSize.isAccessibilitySize {
      VStack(alignment: .leading, spacing: 8) {
        tripAddButton
        if downloadProgress == nil { tripDownloadButton }
      }
    } else {
      ViewThatFits(in: .horizontal) {
        HStack {
          tripAddButton.fixedSize()
          Spacer(minLength: 8)
          if downloadProgress == nil { tripDownloadButton.fixedSize() }
        }
        VStack(alignment: .leading, spacing: 8) {
          tripAddButton
          if downloadProgress == nil { tripDownloadButton }
        }
      }
    }
  }
  private var tripSearchField: some View {
    TextField("Search trip", text: $familyFilter.query).textFieldStyle(.roundedBorder)
      .accessibilityLabel("Search shared details, filenames or dates").accessibilityIdentifier("albums.filter")
  }
  private var tripFiltersButton: some View {
    Button("Filters", systemImage: familyFilter.hasFilters || !groupDuplicates ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease") { showFamilyFilters = true }
      .frame(minHeight: 44).fixedSize(horizontal: true, vertical: false)
      .accessibilityLabel(familyFilter.hasFilters || !groupDuplicates ? "Filters, active" : "Filter people, place and dates")
      .accessibilityIdentifier("albums.family.filters")
  }
  @ViewBuilder private var tripSearchStatus: some View {
    if wantsWholeTripSearch && !model.searchMetadataComplete {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(searchError == nil ? "Searching trip…" : "Search incomplete")
            .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("albums.search.coverage")
          if searchError != nil {
            Button("Retry") { searchError = nil; startTripSearch() }
              .disabled(busy).accessibilityLabel("Retry trip search").accessibilityIdentifier("albums.search.retry")
          }
        }
        if let searchError { DisclosureGroup("Details") { Text(searchError).font(.caption).textSelection(.enabled) } }
      }
    } else if !wantsWholeTripSearch, let error = model.factsError {
      HStack {
        DisclosureGroup("Shared details unavailable") { Text(error).font(.caption).textSelection(.enabled) }
        Button("Retry") {
          let coverage = model.searchCoverageID
          run { try await model.loadNextSearchMetadataPage(expectedID: coverage) }
        }.disabled(busy).frame(minHeight: 44).accessibilityLabel("Retry shared details").accessibilityIdentifier("albums.details.loadMore")
      }
    } else if wantsWholeTripSearch, model.factsSupported == false {
      Text("Shared names and places unavailable.").font(.caption).foregroundStyle(.secondary)
    }
  }
  @ViewBuilder private var tripDownloadControls: some View {
    if let downloadProgress {
      VStack(alignment: .leading, spacing: 8) {
        Text(downloadProgress.message).font(.subheadline).accessibilityIdentifier("albums.download.progress")
        if downloadProgress.phase == .packaging { ProgressView() }
        else { ProgressView(value: Double(downloadProgress.completed), total: Double(max(1, downloadProgress.total))) }
        Button("Cancel download", role: .cancel) {
          cleanupTripDownload(); operation?.cancel(); operation = nil; operationID = nil
          feedback = "Trip download cancelled."
        }.accessibilityIdentifier("albums.download.cancel")
      }.frame(maxWidth: .infinity, alignment: .leading)
    } else if let downloadError {
      DisclosureGroup("Download details") { Text(downloadError).font(.caption).textSelection(.enabled) }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
  private func cleanupTripDownload() {
    downloadToken = UUID(); downloadProgress = nil; showTripShare = false
    downloadedTrip?.remove(); downloadedTrip = nil
  }
  private func downloadTrip() {
    cleanupTripDownload(); downloadError = nil
    let token = downloadToken
    run {
      do {
        let result = try await model.downloadTrip(progress: { value in
          if downloadToken == token { downloadProgress = value }
        })
        guard downloadToken == token, scenePhase == .active, !Task.isCancelled else { result.remove(); throw CancellationError() }
        downloadedTrip = result; downloadProgress = nil
        feedback = "\(result.originals) originals ready · \(result.omittedCopies) identical copies omitted."
        showTripShare = true
      } catch {
        if downloadToken == token {
          downloadProgress = nil
          if !(error is CancellationError), !Task.isCancelled {
            downloadError = error.localizedDescription
            feedback = "Trip download couldn't finish. Try again."
          }
        }
        throw error is CancellationError || Task.isCancelled ? CancellationError() : FotoroError("Trip download couldn't finish. Try again.")
      }
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
      Text("Members can add photos. Details stay private until shared.").font(.footnote).foregroundStyle(.secondary)
      ForEach(album.definition.members, id: \.card.accountId) { member in
        VStack(alignment: .leading, spacing: 6) {
          Text(memberName(member.card.accountId, in: album.definition)).font(.headline)
          DisclosureGroup("Identity details") {
            Text(member.card.accountId).font(.caption.monospaced()).textSelection(.enabled)
            Text(member.card.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
            Text(member.card.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
          }
        }
      }
    }
  }
  private func prepareInvitation() async throws {
    guard let incoming, !invitationPrepared else { return }
    invitationUnavailable = false
    guard let album = model.albums.first(where: { $0.id == incoming.albumId }),
      album.definition.ownerAccountId == incoming.ownerCard.accountId,
      album.definition.members.first(where: { $0.card.accountId == incoming.ownerCard.accountId })?.card == incoming.ownerCard else {
      invitationUnavailable = true
      throw FotoroError("This trip invitation is unavailable for this account.")
    }
    invitationPrepared = true
    if album.overview.endedAt != nil { feedback = "Trip access has ended." }
    else if album.needsTrust { trustCandidate = album }
    else if album.overview.membership == "accepted" { try await model.open(album.id) }
    else { feedback = "Join the trip below." }
  }
  private func finishPickerAddition(_ action: @MainActor () async throws -> Void) async throws {
    guard let context = NativeAlbumPickerContext.current(services), let album = model.opened,
      showPicker else { throw CancellationError() }
    try await action()
    try Task.checkCancellation()
    guard scenePhase == .active, showPicker, NativeAlbumPickerContext.current(services) == context,
      model.opened?.id == album.id, model.opened?.overview.definition == album.overview.definition else {
      throw CancellationError()
    }
    feedback = "Photos added."; showPicker = false
  }
  private func addDevicePhotos(_ sources: [RecentPhotoSource]) async throws {
    guard let context = NativeAlbumPickerContext.current(services), let album = model.opened,
      model.currentOpenedPhotoAccess == context.access else { throw CancellationError() }
    try NativeAlbumDeviceSelection.validate(sources)
    let worker = services.backup
    try services.startPhotosBackup(selection: sources)
    savingDevicePhotos = true
    defer { savingDevicePhotos = false }
    await withTaskCancellationHandler {
      await worker.waitUntilSettled()
    } onCancel: {
      Task { @MainActor in worker.pause() }
    }
    try Task.checkCancellation()
    guard scenePhase == .active, NativeAlbumPickerContext.current(services) == context,
      model.currentOpenedPhotoAccess == context.access, model.opened?.id == album.id,
      model.opened?.overview.definition == album.overview.definition else { throw CancellationError() }
    let sourceRecords = Dictionary(try services.store.backupSources().map { ($0.id, $0) },
      uniquingKeysWith: { first, _ in first })
    let photos = try NativeAlbumDeviceSelection.resolve(sources, lookupSource: { sourceRecords[$0] }, lookupPhoto: services.consumerSavedPhoto, sourceCurrent: { source in
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [source.id], options: nil).firstObject,
        !asset.isHidden else { return false }
      return RecentPhoto.sourceRevision(asset) == source.revision
    })
    try await model.append(photos)
  }
  private func suspendAlbum() {
    if let intent = NativeAlbumReturnIntent.capture(from: model, filter: familyFilter) {
      resumeState.intent = intent
    }
    stop(); authenticationTask?.cancel(); authenticationTask = nil; model.clear()
  }
  private func refreshAlbums(reopenCurrent: Bool = false) async throws {
    let openedID = reopenCurrent ? model.opened?.id : nil
    try await model.refresh()
    try Task.checkCancellation()
    if let returning = resumeState.intent {
      let filter = try await resumeState.reopen(in: model, services: services)
      try Task.checkCancellation()
      guard resumeState.intent?.id == returning.id else { throw CancellationError() }
      if let filter { familyFilter = filter; feedback = nil }
      else { resumeState.intent = nil; try await prepareInvitation() }
      resumeState.intent = nil
    } else {
      if let openedID, model.opened?.id == openedID { try await model.refreshOpened() }
      try await prepareInvitation()
    }
  }
  private func startTripSearch() {
    let previous = searchTask
    previous?.cancel()
    guard scenePhase == .active, !busy, model.opened != nil, wantsWholeTripSearch,
      !model.searchMetadataComplete, searchError == nil else { return }
    let id = UUID(), coverage = model.searchCoverageID
    searchTaskID = id
    searchTask = Task { @MainActor in
      await previous?.value
      defer { if searchTaskID == id { searchTask = nil; searchTaskID = nil } }
      do {
        try await Task.sleep(for: .milliseconds(250))
        while searchTaskID == id, wantsWholeTripSearch, !busy, scenePhase == .active,
          model.searchCoverageID == coverage, !model.searchMetadataComplete {
          try Task.checkCancellation()
          try await model.loadNextSearchMetadataPage(expectedID: coverage)
          try await Task.sleep(for: .milliseconds(30))
        }
      } catch is CancellationError {} catch {
        if !Task.isCancelled, searchTaskID == id, model.searchCoverageID == coverage {
          searchError = error.localizedDescription
        }
      }
    }
  }
  private func stop() { searchTask?.cancel(); searchTask = nil; searchTaskID = nil; searchError = nil; cleanupTripDownload(); operation?.cancel(); operation = nil; operationID = nil; viewer = nil; showPicker = false; link = nil; familyFilter = NativeAlbumSearchFilter(); showFamilyFilters = false; showTripPicks = false; showCreation = false; showCreationContacts = false; showDetails = false; trustCandidate = nil }
  private func run(navigating: Bool = false, _ action: @escaping @MainActor () async throws -> Void) {
    if navigating { resumeState.deliberateNavigation(in: model) }
    let pendingSearch = searchTask
    pendingSearch?.cancel(); searchTask = nil; searchTaskID = nil
    operation?.cancel(); let id = UUID(); operationID = id; feedback = nil
    operation = Task {
      defer { if operationID == id { operation = nil; operationID = nil } }
      await pendingSearch?.value
      guard !Task.isCancelled, operationID == id else { return }
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
  let adding: Bool
  let additionFeedback: String?
  let pendingAddition: Bool
  let cancelAddition: () -> Void
  let retryAddition: () -> Void
  let addDevice: ([RecentPhotoSource]) -> Void
  let add: ([LocalPhoto]) -> Void
  @State private var showDevicePicker = false
  @State private var permissionTask: Task<Void, Never>?
  @State private var picker = NativeAlbumPhotoPickerStore()
  @State private var feedback: String?
  @State private var attemptedDeviceSources: [RecentPhotoSource] = []
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var context: NativeAlbumPickerContext? {
    scenePhase == .active ? NativeAlbumPickerContext.current(services) : nil
  }
  var body: some View {
    NavigationStack {
      List {
        Button("Choose from Photos", systemImage: "photo.on.rectangle") {
          let captured = context
          permissionTask?.cancel()
          permissionTask = Task {
            let permission = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard !Task.isCancelled, captured != nil, captured == context else { return }
            if RecentPhotosPolicy.canRead(permission) { showDevicePicker = true }
            else { feedback = "Allow Photos access to choose device photos." }
          }
        }.disabled(adding || pendingAddition).accessibilityIdentifier("albums.picker.device")
        Text("Choose up to 100 photos. Device photos are saved in Fotoro before adding.").font(.footnote).foregroundStyle(.secondary)
        if adding { ProgressView(attemptedDeviceSources.isEmpty ? "Adding photos…" : "Saving and adding photos…") }
        if let message = feedback ?? additionFeedback ?? picker.feedback { Text(message).foregroundStyle(.secondary) }
        if pendingAddition {
          Button("Retry adding photos", action: retryAddition).disabled(adding)
            .accessibilityIdentifier("albums.picker.retry")
        } else if additionFeedback != nil, !attemptedDeviceSources.isEmpty {
          Button("Retry chosen Photos") { addDevice(attemptedDeviceSources) }.disabled(adding)
            .accessibilityIdentifier("albums.picker.device.retry")
        }
        ForEach(picker.isCurrent(services) ? picker.photos : []) { photo in
          Toggle(isOn: Binding(get: { picker.selection.contains(photo.id) }, set: { enabled in
            if enabled != picker.selection.contains(photo.id) { feedback = nil; picker.toggle(photo, services: services) }
          })) {
            HStack(spacing: 12) {
              LazyImage(url: photo.thumbnailURL) { state in
                if let image = state.image { image.resizable().scaledToFill() }
                else { Rectangle().fill(.quaternary) }
              }.frame(width: 60, height: 60).clipped().accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 4) {
                Text(photo.metadata.filename).lineLimit(2)
                if let date = Wire.parseDate(photo.metadata.sourceDate) {
                  Text((["photos", "exif"].contains(photo.metadata.dateSource) ? "Photo date · " : "Import date · ") + date.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }.disabled(adding || pendingAddition).accessibilityLabel(NativeAlbumPhotoAccessibility.label(photo))
        }
        if picker.busy { ProgressView("Loading Saved photos…") }
        else if picker.isCurrent(services) {
          if picker.hasMore {
            Button("Load more Saved photos") { feedback = nil; picker.loadMore(services) }
              .disabled(adding).accessibilityIdentifier("albums.picker.loadMore")
          }
        }
      }.navigationTitle("Add photos")
      .interactiveDismissDisabled(adding)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Menu("More", systemImage: "ellipsis") {
            Button("Refresh Saved photos") { feedback = nil; picker.refresh(services) }
              .disabled(picker.busy || adding).accessibilityIdentifier("albums.picker.refresh")
          }
        }
        ToolbarItem(placement: .cancellationAction) {
          Button(adding ? "Cancel adding" : "Cancel") {
            if adding { cancelAddition() } else { dismiss() }
          }.accessibilityIdentifier("albums.picker.cancel")
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Add \(picker.selection.count)") {
            do {
              let photos = try picker.chosen(services)
              feedback = nil; attemptedDeviceSources = []; add(photos)
            } catch is CancellationError {} catch { feedback = error.localizedDescription }
          }.disabled(adding || pendingAddition || !picker.isCurrent(services) || picker.selection.count == 0)
            .accessibilityIdentifier("albums.picker.add")
        }
      }
      .task(id: context) {
        feedback = nil
        if context == nil { picker.clear() } else { picker.open(services, initial: initial) }
      }
      .sheet(isPresented: $showDevicePicker) {
        NativeAlbumDevicePicker { selection in
          showDevicePicker = false
          guard let ids = selection else { feedback = "A selected photo is unavailable. Choose it again."; return }
          guard context != nil, picker.isCurrent(services), !ids.isEmpty else { return }
          do {
            let sources = try ids.map { id -> RecentPhotoSource in
              guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
                !asset.isHidden else { throw FotoroError("A selected photo is unavailable. Choose it again.") }
              return RecentPhotoSource(RecentPhoto(asset: asset))
            }
            try NativeAlbumDeviceSelection.validate(sources)
            feedback = nil; attemptedDeviceSources = sources; addDevice(sources)
          } catch { feedback = error.localizedDescription }
        }
      }
      .onDisappear { permissionTask?.cancel(); permissionTask = nil; picker.clear() }
    }
  }
}

private struct NativeAlbumThumbnail: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  let open: () -> Void
  @State private var url: URL?
  @State private var unavailable = false
  @State private var retry = 0
  @State private var loadedIdentity: Identity?
  private struct Identity: Equatable {
    let id: String
    let signature: String
    let access: PhotoAccountAccess?
    let retry: Int
  }
  private var identity: Identity {
    Identity(id: item.id, signature: item.signedManifest.signature,
      access: model.currentOpenedPhotoAccess, retry: retry)
  }
  var body: some View {
    let current = identity
    LazyImage(url: loadedIdentity == current && current.access != nil ? url : nil) { state in
      if loadedIdentity == current, current.access != nil, let image = state.image {
        Button(action: open) { image.resizable().scaledToFill() }.buttonStyle(.plain)
      } else if loadedIdentity == current && (unavailable || state.error != nil) {
        Rectangle().fill(.secondary.opacity(0.2)).overlay {
          VStack(spacing: 8) {
            Button(action: open) {
              Label("Preview unavailable", systemImage: "icloud.slash").font(.caption)
            }.buttonStyle(.plain)
            Button("Try again") {
              guard current.access != nil, identity == current else { return }
              retry += 1
            }.frame(minHeight: 44).accessibilityIdentifier("albums.thumbnail.retry")
          }.padding(4)
        }
      } else {
        Button(action: open) {
          Rectangle().fill(.secondary.opacity(0.2)).overlay { ProgressView() }
        }.buttonStyle(.plain)
      }
    }.frame(height: 110).clipped()
      .task(id: current) {
        url = nil; unavailable = false; loadedIdentity = current
        guard current.access != nil else { return }
        do {
          let loaded = try await model.thumbnail(item, preservingTransientFailure: true)
          try Task.checkCancellation()
          guard identity == current else { return }
          url = loaded; unavailable = loaded == nil
        } catch is CancellationError {
        } catch {
          guard !Task.isCancelled, identity == current else { return }
          unavailable = true
        }
      }
  }
}

private struct NativeAlbumPhotoView: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  @State private var preview: URL?
  @State private var previewUnavailable = false
  @State private var previewRetry = 0
  @State private var loadedPreviewIdentity: PreviewIdentity?
  @State private var player: AVPlayer?
  @State private var motionExports: [URL] = []
  @State private var exports: [URL] = []
  @State private var showShare = false
  @State private var feedback: String?
  @State private var operation: Task<Void, Never>?
  @State private var loading = false
  @State private var savedOriginals = Set<String>()
  @State private var showDetailsEditor = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  private struct PreviewIdentity: Equatable {
    let id: String
    let signature: String
    let access: PhotoAccountAccess?
    let retry: Int
    let foreground: Bool
  }
  private var previewIdentity: PreviewIdentity {
    PreviewIdentity(id: item.id, signature: item.signedManifest.signature,
      access: model.currentOpenedPhotoAccess, retry: previewRetry, foreground: scenePhase != .background)
  }
  private var originalIdentity: String {
    item.photo.metadata.originalSha256 + "|\(item.photo.metadata.originalBytes)|" + item.photo.metadata.mediaType
  }
  var body: some View {
    let current = previewIdentity
    NavigationStack {
      VStack {
        if let feedback { Text(feedback).foregroundStyle(.secondary) }
        if current.access != nil, let player { VideoPlayer(player: player) }
        else {
          LazyImage(url: loadedPreviewIdentity == current && current.access != nil ? preview : nil) { state in
            if loadedPreviewIdentity == current, current.access != nil, let image = state.image {
              image.resizable().scaledToFit()
            } else if current.access == nil || (loadedPreviewIdentity == current && (previewUnavailable || state.error != nil)) {
              VStack(spacing: 12) {
                Label("Preview unavailable", systemImage: "icloud.slash")
                Button("Try again") {
                  guard current.access != nil, current.foreground, previewIdentity == current else { return }
                  feedback = nil; previewRetry += 1
                }.frame(minHeight: 44).disabled(current.access == nil || !current.foreground)
                  .accessibilityIdentifier("albums.photo.preview.retry")
              }.accessibilityIdentifier("albums.photo.preview.unavailable")
            } else { ProgressView() }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if let date = Wire.parseDate(item.photo.metadata.sourceDate) {
          Text(date.formatted(date: .abbreviated, time: .omitted)).font(.caption).foregroundStyle(.secondary)
        }
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
            guard let access = model.currentOpenedPhotoAccess else { return }
            operation?.cancel(); cleanupMotion(); loading = true
            operation = Task {
              var pending: [URL] = []
              defer { removeExports(pending); loading = false; operation = nil }
              do {
                pending = try await model.export(item); try Task.checkCancellation()
                guard scenePhase == .active, model.currentOpenedPhotoAccess == access,
                  pending.count == (item.photo.metadata.mediaType == CameraMedia.liveType ? 2 : 1) else { throw CancellationError() }
                motionExports = pending; pending = []
                let movie = item.photo.metadata.mediaType == CameraMedia.liveType ? motionExports[1] : motionExports[0]
                player = AVPlayer(url: movie); player?.play()
              } catch is CancellationError {} catch {
                guard !Task.isCancelled, scenePhase == .active, model.currentOpenedPhotoAccess == access else { return }
                feedback = error.localizedDescription
              }
            }
          }.disabled(loading) }
        }
        ToolbarItem(placement: .bottomBar) { Button("Share original", systemImage: "square.and.arrow.up") {
          guard let access = model.currentOpenedPhotoAccess else { return }
          operation?.cancel(); loading = true
          operation = Task {
            var pending: [URL] = []
            defer { removeExports(pending); loading = false; operation = nil }
            do {
              pending = try await model.export(item); try Task.checkCancellation()
              guard scenePhase == .active, model.currentOpenedPhotoAccess == access else { throw CancellationError() }
              cleanup(); exports = pending; pending = []; showShare = true
            }
            catch is CancellationError {} catch {
              guard !Task.isCancelled, scenePhase == .active, model.currentOpenedPhotoAccess == access else { return }
              feedback = error.localizedDescription
            }
          }
        }.disabled(loading) }
        ToolbarItem(placement: .bottomBar) {
          Button(savedOriginals.contains(originalIdentity) ? "Saved to Photos" : "Save to Photos", systemImage: "square.and.arrow.down") {
            guard !loading, !savedOriginals.contains(originalIdentity) else { return }
            let identity = originalIdentity
            loading = true
            operation = Task {
              defer { loading = false; operation = nil }
              do {
                try await model.saveToPhotos(item)
                try Task.checkCancellation()
                savedOriginals.insert(identity)
                feedback = "Original saved to Photos."
              } catch is CancellationError {} catch { feedback = error.localizedDescription }
            }
          }.disabled(loading || savedOriginals.contains(originalIdentity))
            .accessibilityIdentifier("albums.photo.saveToPhotos")
        }
      }
      .task(id: current) {
        preview = nil; previewUnavailable = false; loadedPreviewIdentity = current
        guard current.access != nil, current.foreground else { return }
        do {
          let loaded = try await model.preview(item, reload: current.retry > 0)
          try Task.checkCancellation()
          guard previewIdentity == current else { return }
          preview = loaded; previewUnavailable = loaded == nil
        } catch is CancellationError {
          guard !Task.isCancelled, previewIdentity == current else { return }
          previewUnavailable = true
        } catch {
          guard !Task.isCancelled, previewIdentity == current else { return }
          previewUnavailable = true; feedback = error.localizedDescription
        }
      }
      .sheet(isPresented: $showShare, onDismiss: cleanup) { OriginalShareSheet(urls: exports) { _ in cleanup() } }
      .sheet(isPresented: $showDetailsEditor) { NativeAlbumSharedDetailsEditor(model: model, item: item) }
      .onChange(of: model.currentOpenedPhotoAccess) { _, access in
        if access == nil { operation?.cancel(); cleanup(); cleanupMotion(); preview = nil }
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .inactive { player?.pause() }
        if phase == .background { operation?.cancel(); cleanup(); cleanupMotion(); preview = nil; dismiss() }
      }
      .onDisappear { operation?.cancel(); cleanup(); cleanupMotion(); preview = nil; loadedPreviewIdentity = nil }
    }
  }
  private func cleanupMotion() {
    player?.pause(); player = nil
    removeExports(motionExports)
    motionExports = []
  }
  private func cleanup() {
    removeExports(exports)
    exports = []; showShare = false
  }
  private func removeExports(_ urls: [URL]) {
    for directory in Set(urls.map { $0.deletingLastPathComponent() }) {
      try? FileManager.default.removeItem(at: directory)
    }
  }
}


// Only the explicitly reviewed revisions may become contributions; partial saves
// remain in Saved and never silently produce a partial trip addition.
enum NativeAlbumDeviceSelection {
  static func validate(_ sources: [RecentPhotoSource]) throws {
    guard (1...100).contains(sources.count), Set(sources.map(\.id)).count == sources.count,
      sources.allSatisfy({ !$0.id.isEmpty && !$0.revision.isEmpty }) else {
      throw FotoroError("Choose 1–100 different photos.")
    }
  }
  static func resolve(_ sources: [RecentPhotoSource], lookupSource: (String) throws -> BackupSource?,
    lookupPhoto: (String) throws -> LocalPhoto?, sourceCurrent: (RecentPhotoSource) -> Bool) throws -> [LocalPhoto] {
    try validate(sources)
    var ids = Set<String>()
    return try sources.compactMap { selected in
      guard sourceCurrent(selected), let source = try lookupSource(selected.id),
        source.sourceRevision == selected.revision, source.phase == .committed,
        let photo = try lookupPhoto(source.photoId), photo.id == source.photoId,
        source.originalSha256 == photo.metadata.originalSha256,
        ["saved", "committed"].contains(photo.transferState) else {
        throw FotoroError("Some selected photos could not be saved or changed. Review Saved photos before adding them.")
      }
      return ids.insert(photo.id).inserted ? photo : nil
    }
  }
}

private struct NativeAlbumDevicePicker: UIViewControllerRepresentable {
  let finished: ([String]?) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(finished: finished) }
  func makeUIViewController(context: Context) -> PHPickerViewController {
    var configuration = PHPickerConfiguration(photoLibrary: .shared())
    configuration.selectionLimit = 100
    configuration.filter = .any(of: [.images, .videos])
    let picker = PHPickerViewController(configuration: configuration)
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
  final class Coordinator: NSObject, PHPickerViewControllerDelegate {
    let finished: ([String]?) -> Void
    init(finished: @escaping ([String]?) -> Void) { self.finished = finished }
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
      guard results.allSatisfy({ $0.assetIdentifier != nil }) else { finished(nil); return }
      finished(results.compactMap(\.assetIdentifier))
    }
  }
}
