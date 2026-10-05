import NukeUI
import Observation
import SwiftUI

struct IncomingInvitationPasswordRetry {
  let link: FotoroShareLink
  let origin: String
  private(set) var pending = true
  private var authorization: PhotoAccountAccess?
  init(link: FotoroShareLink, origin: String) {
    self.link = link
    self.origin = origin
  }
  var awaitingPassword: Bool { pending && authorization == nil }
  var presented: Bool { !pending && authorization != nil }
  mutating func authorize(_ access: PhotoAccountAccess?, origin: String) {
    guard pending, authorization == nil, self.origin == origin, let access else { return }
    authorization = access
  }
  func isAuthorized(_ access: PhotoAccountAccess?, origin: String) -> Bool {
    authorization != nil && authorization == access && self.origin == origin
  }
  mutating func consume(active: Bool, access: PhotoAccountAccess?, origin: String) -> FotoroShareLink? {
    guard pending, active, isAuthorized(access, origin: origin) else { return nil }
    pending = false
    return link
  }
  mutating func cancel() { pending = false; authorization = nil }
}

struct LibraryView: View {
  @Bindable var services: AppServices
  let saveSelection: [RecentPhotoSource]?
  @State private var pendingIncoming: FotoroShareLink?
  @State private var invitationPasswordRetry: IncomingInvitationPasswordRetry?
  @State private var sharedPhotos: SharedPhotosPresentation?
  @State private var saveIntent: ManualPhotoSaveIntent?
  @State private var authenticationTask: Task<Void, Never>?
  @State private var query = ""
  @State private var favoritesOnly = false
  @State private var catalogSearch = SavedCatalogSearch()
  @State private var searchAttempt: UInt64 = 0
  @State private var selection = SavedPhotoSelection()
  @State private var catalogRefresh = SavedLibraryRefresh()
  @State private var reopeningAccount = false
  @State private var viewer: SavedPhotoViewerPresentation?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @State private var scrollID: String?
  @State private var originalURLs: [URL] = []
  @State private var sharingOriginals = false
  @State private var preparingShare = false
  @State private var shareTask: Task<Void, Never>?
  @State private var shareSources: [LocalPhoto] = []
  init(services: AppServices, saveSelection: [RecentPhotoSource]? = nil, incomingLink: FotoroShareLink? = nil) {
    self.services = services
    self.saveSelection = saveSelection
    _saveIntent = State(initialValue: saveSelection.map(ManualPhotoSaveIntent.init))
    _pendingIncoming = State(initialValue: incomingLink)
  }
  private var searchID: SavedCatalogSearchPresentationID {
    SavedCatalogSearchPresentationID(query: query, catalog: services.consumerCatalogGeneration,
      binding: SavedLibraryOpenBinding(services))
  }
  private var hasQuery: Bool { !SearchNormalization.text(query).isEmpty }
  var filtered: [LocalPhoto] {
    let current = hasQuery ? (catalogSearch.results(for: searchID) ?? []) : services.photos
    return current.filter {
      !favoritesOnly || services.annotation($0).favorite == true
    }
  }
  var days: [(String, [LocalPhoto])] {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    let groups = Dictionary(grouping: filtered) { photo in
      Wire.parseDate(photo.metadata.sourceDate).map(formatter.string) ?? "Date unavailable"
    }
    return groups.keys.sorted { lhs, rhs in
      if lhs == "Date unavailable" { return false }
      if rhs == "Date unavailable" { return true }
      return lhs > rhs
    }.map { ($0, groups[$0]!) }
  }
  var body: some View {
    NavigationStack {
      Group {
        if reopeningAccount || invitationPasswordRetry?.awaitingPassword == true || services.auth.startPassword != nil || services.photoAccountAccess == nil {
          VStack(alignment: .leading, spacing: 0) {
            if let saveSelection {
              Text("Open Fotoro to save \(saveSelection.count) \(saveSelection.count == 1 ? "photo" : "photos")")
                .font(.headline).padding(.horizontal).padding(.top)
            }
            if invitationPasswordRetry?.awaitingPassword == true {
              Text("Open the Fotoro this invitation was sent to.").font(.headline).padding(.horizontal).padding(.top)
            }
            AccountView(services: services, enterPassword: invitationPasswordRetry?.awaitingPassword == true,
              reauthenticate: catalogRefresh.requiresAuthentication(services), diagnosticDetail: catalogRefresh.authenticationFailure(services), onSignedIn: openedAccount,
              onAuthenticationTask: { authenticationTask = $0 })
          }
        } else if authenticationTask != nil {
          ProgressView("Opening Fotoro…")
        } else {
          ScrollView {
            savingFeedback
            catalogFeedback
            searchFeedback
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3
            ) {
              ForEach(days, id: \.0) { day in
                Section {
                  ForEach(day.1) { photo in
                    LibraryPhotoCell(
                      photo: photo, isSelected: selection.contains(photo.id),
                      open: { viewer = SavedPhotoViewerPresentation(initial: photo, photos: filtered) },
                      toggleSelection: { selection.toggle(photo) },
                      appeared: { loadMoreIfNeeded(photoID: photo.id) }
                    ).id(photo.id)
                  }
                } header: {
                  Text(day.0).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                }
              }
            }.scrollTargetLayout()
            if filtered.isEmpty && !catalogRefresh.isRefreshing,
              !hasQuery || (catalogSearch.hasCompleted(searchID) && catalogSearch.failure(for: searchID) == nil) {
              ContentUnavailableView(
                hasQuery ? "No photos found" : "No photos", systemImage: "photo",
                description: Text(!hasQuery ? savedLibraryEmptyMessage(sync: services.automaticPhotoSync,
                  favoritesOnly: favoritesOnly) : "Try a label, filename or words in a photo."))
            }
            ForEach(services.notices, id: \.self) { Text($0).font(.caption).padding() }
          }.scrollPosition(id: $scrollID, anchor: .top)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await catalogRefresh.refresh(services) }
            .task(id: SavedLibraryReadPresentation(services, isActive: scenePhase == .active)) {
              guard !Task.isCancelled else { return }
              guard scenePhase == .active else { catalogRefresh.cancel(); return }
              await catalogRefresh.open(services, recheck: true)
            }
            .searchable(text: $query, prompt: "Search")
            .task(id: SavedCatalogSearchRequestID(presentation: searchID,
              isActive: scenePhase == .active, attempt: searchAttempt)) {
              guard !Task.isCancelled else { return }
              guard scenePhase == .active, hasQuery, services.photoAccountAccess != nil else {
                catalogSearch.cancel(clearResults: true)
                return
              }
              let searched = searchID
              await catalogSearch.search(searched, current: { searchID }) {
                let found = try await services.searchCatalog(searched.query)
                // Search may span catalog pages. Recheck each returned saved source before presentation.
                return try found.compactMap { photo in
                  guard let current = try services.consumerSavedPhoto(photo.id),
                    current.metadata == photo.metadata, current.manifest == photo.manifest else { return nil }
                  return current
                }
              }
            }
            .toolbar {
              if selection.count > 0 {
                ToolbarItem(placement: .bottomBar) {
                  Button("Clear selection", systemImage: "xmark.circle") { selection.removeAll() }
                    .disabled(preparingShare || sharingOriginals)
                    .accessibilityIdentifier("saved.selection.clear")
                }
                ToolbarItem(placement: .bottomBar) {
                  Menu("Share \(selection.count)", systemImage: "square.and.arrow.up") {
                    Button("Share photos") { shareOriginals() }
                    Button("Share in Fotoro") { shareInFotoro() }
                  }.disabled(preparingShare || sharingOriginals)
                }
              }
              ToolbarItem(placement: .topBarTrailing) {
                Menu("Saved options", systemImage: "ellipsis.circle") {
                  Toggle("Favorites", isOn: $favoritesOnly)
                  Button("Refresh", systemImage: "arrow.clockwise") {
                    Task { await catalogRefresh.refresh(services) }
                  }.accessibilityIdentifier("saved.refresh")
                }
              }
            }
        }
      }.navigationTitle("Saved photos").navigationBarTitleDisplayMode(.inline)
        .task {
          resumeSelectedSave()
          openIncomingLink()
        }
        .toolbar {
          if services.photoAccountAccess != nil {
            ToolbarItem(placement: .topBarLeading) {
              Button("Shared photos", systemImage: "person.2") { sharedPhotos = SharedPhotosPresentation() }
            }
          }
          ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
        }
        .overlay { if services.busy { ProgressView().padding().glassEffect() } }
        .sheet(item: $viewer, onDismiss: { viewer = nil }) { presentation in
          PhotoViewer(
            services: services, initialID: presentation.initial.id, displayedPhotos: presentation.photos)
        }
        .sheet(item: $sharedPhotos, onDismiss: {
          if invitationPasswordRetry?.presented == true { invitationPasswordRetry = nil }
        }) { presentation in
          ExchangeView(services: services, selected: presentation.photos, incoming: presentation.incoming,
            onRetryPassword: retryInvitationPassword)
        }
        .onChange(of: authenticationTask == nil) { openIncomingLink() }
        .onChange(of: services.photoAccountAccess) {
          resumeSelectedSave()
          openIncomingLink()
        }
        .onChange(of: scenePhase) {
          if scenePhase == .background {
            catalogSearch.cancel(clearResults: true)
            pendingIncoming = nil; sharedPhotos = nil
            cancelAuthentication()
            services.setPhotoSyncForeground(false)
          } else if scenePhase == .active {
            services.setPhotoSyncForeground(true)
            resumeSelectedSave()
            openIncomingLink()
          } else {
            services.setPhotoSyncForeground(false)
          }
        }
        .sheet(isPresented: $sharingOriginals, onDismiss: cleanupShare) {
          OriginalShareSheet(urls: originalURLs) { _ in cleanupShare() }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked {
            if authenticationTask == nil { saveIntent?.cancel(); pendingIncoming = nil }
            if authenticationTask == nil && invitationPasswordRetry?.awaitingPassword != true { invitationPasswordRetry = nil }
            sharedPhotos = nil
            viewer = nil
            shareTask?.cancel()
            cleanupShare()
            selection.removeAll()
            catalogSearch.cancel(clearResults: true)
            catalogRefresh.cancel()
          }
        }
        .onChange(of: services.vault.generation) {
          catalogSearch.cancel(clearResults: true)
          if !services.vault.isUnlocked {
            sharedPhotos = nil
            if authenticationTask == nil { pendingIncoming = nil }
          }
          shareTask?.cancel(); cleanupShare(); selection.removeAll(); catalogRefresh.cancel()
        }
        .onChange(of: services.session.accountId) {
          catalogSearch.cancel(clearResults: true)
          if authenticationTask == nil && invitationPasswordRetry?.isAuthorized(services.photoAccountAccess, origin: services.api.origin) != true {
            pendingIncoming = nil; sharedPhotos = nil; invitationPasswordRetry = nil
          }
        }
        .onChange(of: services.api.origin) { pendingIncoming = nil; sharedPhotos = nil; cancelAuthentication() }
        .onChange(of: services.consumerCatalogGeneration) { validateSelection() }
        .onDisappear {
          cancelAuthentication(); shareTask?.cancel(); cleanupShare(); catalogRefresh.cancel()
          catalogSearch.cancel(clearResults: true)
        }
        .alert(
          "Fotoro",
          isPresented: Binding(
            get: { services.error != nil && services.vault.isUnlocked && viewer == nil && !sharingOriginals },
            set: { if !$0 && viewer == nil && !sharingOriginals { services.error = nil } })
        ) {
          Button("OK") { services.error = nil }
        } message: {
          Text(services.error ?? "")
        }
    }.preferredColorScheme(.dark)
  }

  private func openedAccount() {
    reopeningAccount = false
    if invitationPasswordRetry != nil {
      invitationPasswordRetry?.authorize(services.photoAccountAccess, origin: services.api.origin)
      openIncomingLink()
      return
    }
    saveIntent?.authorize(services.photoAccountAccess)
    startSelectedSave()
    openIncomingLink()
  }
  private func openIncomingLink() {
    guard scenePhase == .active, authenticationTask == nil, services.auth.startPassword == nil,
      services.photoAccountAccess != nil else { return }
    if let incoming = invitationPasswordRetry?.consume(active: true, access: services.photoAccountAccess, origin: services.api.origin) {
      sharedPhotos = SharedPhotosPresentation(incoming: incoming)
      return
    }
    guard invitationPasswordRetry == nil, let incoming = pendingIncoming else { return }
    pendingIncoming = nil
    sharedPhotos = SharedPhotosPresentation(incoming: incoming)
  }
  private func retryInvitationPassword(_ link: FotoroShareLink) {
    guard scenePhase == .active, !services.busy, case .moment = link else { return }
    cancelAuthentication()
    pendingIncoming = nil; sharedPhotos = nil
    invitationPasswordRetry = IncomingInvitationPasswordRetry(link: link, origin: services.api.origin)
    services.error = nil
    services.lockAccount()
  }
  private func shareInFotoro() {
    do { sharedPhotos = SharedPhotosPresentation(photos: try selection.resolve(using: services.consumerSavedPhoto)) }
    catch { validateSelection(); services.error = error.localizedDescription }
  }
  private func startSelectedSave() {
    guard services.session.isSignedIn, services.auth.startPassword == nil,
      let sources = saveIntent?.consume(active: scenePhase == .active, access: services.photoAccountAccess) else { return }
    services.error = nil
    do { try services.startPhotosBackup(selection: sources) }
    catch {
      saveIntent = ManualPhotoSaveIntent(sources)
      saveIntent?.cancel()
      services.error = error.localizedDescription
    }
  }
  private func resumeSelectedSave() {
    guard scenePhase == .active, authenticationTask == nil, services.auth.startPassword == nil else { return }
    saveIntent?.authorize(services.photoAccountAccess)
    startSelectedSave()
  }
  private func cancelAuthentication() {
    saveIntent?.cancel()
    invitationPasswordRetry?.cancel(); invitationPasswordRetry = nil
    authenticationTask?.cancel()
    authenticationTask = nil
    services.auth.cancelStart()
  }
  @ViewBuilder private var savingFeedback: some View {
    let summary = services.consumerSyncSummary
    ConsumerSaveStatus(services: services).padding(.horizontal)
    if !services.backup.isRunning, !services.journal.running,
      summary.action != .continue, summary.action != .retry,
      let saveSelection, saveIntent?.pending == false,
      saveIntent?.wasConsumed == false || summary.state == .needsAttention {
      Button("Save selected photos", systemImage: "icloud.and.arrow.up") {
        saveIntent = ManualPhotoSaveIntent(saveSelection)
        openedAccount()
      }.disabled(services.busy).padding()
    }
  }
  private func loadMoreIfNeeded(photoID: String) {
    if photoID == services.photos.last?.id { try? services.loadMore() }
  }
  @ViewBuilder private var catalogFeedback: some View {
    if catalogRefresh.isRefreshing {
      ProgressView("Loading saved photos…").padding()
    } else if catalogRefresh.requiresAuthentication(services) {
      Button("Open Fotoro", systemImage: "person.crop.circle") { reopeningAccount = true }.padding()
    } else if catalogRefresh.error != nil {
      Button("Try again", systemImage: "arrow.clockwise") {
        Task { await catalogRefresh.refresh(services) }
      }.padding()
    }
  }
  @ViewBuilder private var searchFeedback: some View {
    if hasQuery, !catalogRefresh.isRefreshing {
      if catalogSearch.isPending(searchID) {
        ProgressView("Searching saved photos…").padding()
      } else if let error = catalogSearch.failure(for: searchID) {
        VStack(alignment: .leading, spacing: 8) {
          Text(error).font(.footnote).foregroundStyle(.secondary)
          Button("Try again", systemImage: "arrow.clockwise") { searchAttempt &+= 1 }
            .accessibilityIdentifier("saved.search.retry")
        }.frame(maxWidth: .infinity, alignment: .leading).padding()
      }
    }
  }
  private func validateSelection() {
    selection.removeWithdrawn(using: services.consumerSavedPhoto)
    if !shareSources.isEmpty,
      !SavedPhotoSelection.isCurrent(shareSources, lookup: services.consumerSavedPhoto) {
      shareTask?.cancel()
      cleanupShare()
    }
  }
  private func shareOriginals() {
    guard selection.count > 0, !preparingShare, !sharingOriginals else { return }
    let selected: [LocalPhoto]
    do { selected = try selection.resolve(using: services.consumerSavedPhoto) }
    catch { validateSelection(); services.error = error.localizedDescription; return }
    let generation = services.vault.generation
    let account = services.session.accountId
    let catalog = services.store
    preparingShare = true
    shareSources = selected
    shareTask = Task {
      var urls: [URL] = []
      defer {
        ConsumerShareExports.remove(urls)
        preparingShare = false
        shareTask = nil
        if !sharingOriginals { shareSources = [] }
      }
      do {
        for photo in selected {
          let original = try await services.consumerShareOriginal(photo)
          urls.append(original)
          try Task.checkCancellation()
          if photo.metadata.mediaType == CameraMedia.liveType {
            let exported = try CameraMedia.exportOriginals(try Data(contentsOf: original), metadata: photo.metadata,
              directory: original.deletingLastPathComponent())
            urls.removeLast()
            urls.append(contentsOf: exported)
          }
          try Task.checkCancellation()
        }
        guard services.vault.isUnlocked, services.vault.generation == generation,
          services.session.accountId == account, services.store === catalog else { throw CancellationError() }
        for photo in selected {
          guard let current = try services.consumerSavedPhoto(photo.id),
            current.metadata == photo.metadata, current.manifest == photo.manifest else { throw CancellationError() }
        }
        originalURLs = urls
        sharingOriginals = true
        urls = []
      } catch is CancellationError {} catch { services.error = error.localizedDescription }
    }
  }
  private func cleanupShare() {
    ConsumerShareExports.remove(originalURLs)
    sharingOriginals = false
    originalURLs = []
    shareSources = []
  }
}

struct SavedPhotoSelection {
  private var sources: [String: LocalPhoto] = [:]
  var count: Int { sources.count }
  var ids: Set<String> { Set(sources.keys) }
  func contains(_ id: String) -> Bool { sources[id] != nil }
  mutating func toggle(_ photo: LocalPhoto) {
    if sources.removeValue(forKey: photo.id) == nil { sources[photo.id] = photo }
  }
  mutating func removeAll() { sources = [:] }
  mutating func removeWithdrawn(using lookup: (String) throws -> LocalPhoto?) {
    sources = sources.filter { Self.isCurrent([$0.value], lookup: lookup) }
  }
  static func isCurrent(_ photos: [LocalPhoto], lookup: (String) throws -> LocalPhoto?) -> Bool {
    photos.allSatisfy { photo in
      guard let current = try? lookup(photo.id) else { return false }
      return current.metadata == photo.metadata && current.manifest == photo.manifest
    }
  }
  func resolve(using lookup: (String) throws -> LocalPhoto?) throws -> [LocalPhoto] {
    try sources.values.sorted {
      $0.metadata.sourceDate == $1.metadata.sourceDate ? $0.id < $1.id : $0.metadata.sourceDate > $1.metadata.sourceDate
    }.map { photo in
      guard let current = try lookup(photo.id), current.metadata == photo.metadata,
        current.manifest == photo.manifest else { throw FotoroError("A selected photo changed. Select it again to share.") }
      return current
    }
  }
}

struct ConsumerSaveStatus: View {
  @Bindable var services: AppServices
  var showsIdleSummary = true
  private var summary: ConsumerSyncSummary { services.consumerSyncSummary }
  private var saving: Bool { services.backup.isRunning || services.journal.running }
  private var title: String {
    let automatic = services.automaticPhotoSync
    if !showsIdleSummary, !saving, summary.state == .notStarted || summary.state == .upToDate,
      !automatic.enabled || automatic.phase == .ready { return summary.detail ?? "" }
    if automatic.enabled {
      switch automatic.phase {
      case .paused: return "Sync paused"
      case .locked: return "Open Fotoro to resume sync"
      case .permissionRequired: return "Photos access needed"
      case .background: return "Sync resumes when you open Fotoro"
      case .ready: return "Sync on"
      case .needsAttention: return "Sync needs attention"
      case .off, .syncing: break
      }
    }
    if summary.state == .preparing { return "Preparing photos…" }
    if saving {
      if let completed = summary.completedPhotos, let total = summary.totalPhotos {
        return "\(completed) of \(total) saved"
      }
      return "Saving photos…"
    }
    if summary.state == .paused { return "Saving paused" }
    if summary.state == .offline { return "You’re offline. Your chosen photos are kept." }
    if summary.state == .needsAttention { return "Some photos need attention" }
    if let completed = summary.completedPhotos, completed > 0 { return "\(completed) saved" }
    return ""
  }
  var body: some View {
    if !title.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 10) {
          if saving { ProgressView().controlSize(.small) }
          Text(title).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          if saving {
            Button("Pause") { services.pauseSync() }.font(.footnote).frame(minHeight: 44)
          } else if services.automaticPhotoSync.enabled && services.automaticPhotoSync.paused {
            Button("Resume") {
              do { try services.enableAutomaticPhotoSync() }
              catch { services.error = error.localizedDescription }
            }.font(.footnote).frame(minHeight: 44).disabled(services.busy || services.photoAccountAccess == nil)
          } else if !services.automaticPhotoSync.enabled && (summary.action == .continue || summary.action == .retry) {
            Button(summary.action == .retry ? "Try again" : "Continue") {
              services.run { try await services.continueSync() }
            }.font(.footnote).frame(minHeight: 44).disabled(services.busy)
          }
        }
        if services.automaticPhotoSync.enabled && services.automaticPhotoSync.phase == .needsAttention {
          Text(services.automaticPhotoSync.detail).font(.caption).foregroundStyle(.secondary)
        } else if !services.automaticPhotoSync.enabled, summary.state == .needsAttention, let detail = summary.detail {
          Text(detail).font(.caption).foregroundStyle(.secondary)
        }
      }.accessibilityElement(children: .contain)
    }
  }
}

@MainActor @Observable final class SavedLibraryRefresh {
  private(set) var isRefreshing = false
  private(set) var error: String?
  @ObservationIgnored private var openedBinding: SavedLibraryOpenBinding?
  @ObservationIgnored private var rejectedSession: (binding: SavedLibraryOpenBinding, detail: String)?
  @ObservationIgnored private var operation: UUID?
  @ObservationIgnored private var task: Task<Void, Never>?
  func open(_ services: AppServices, recheck: Bool = false) async {
    guard !Task.isCancelled else { return }
    if isRefreshing, task?.isCancelled == true { cancel() }
    let binding = SavedLibraryOpenBinding(services)
    guard services.photoAccountAccess != nil else { return }
    if openedBinding == binding && (isRefreshing || !recheck) { return }
    if isRefreshing { cancel() }
    await refresh(services)
  }
  func requiresAuthentication(_ services: AppServices) -> Bool {
    rejectedSession?.binding == SavedLibraryOpenBinding(services)
  }
  func authenticationFailure(_ services: AppServices) -> String? {
    requiresAuthentication(services) ? rejectedSession?.detail : nil
  }
  func failureDetails(_ services: AppServices) -> String? {
    if let rejected = authenticationFailure(services) { return rejected }
    return openedBinding == SavedLibraryOpenBinding(services) ? error : nil
  }
  func refresh(_ services: AppServices) async {
    guard !Task.isCancelled, !isRefreshing, services.photoAccountAccess != nil,
      !requiresAuthentication(services) else { return }
    openedBinding = SavedLibraryOpenBinding(services)
    rejectedSession = nil
    let token = UUID(), account = services.session.accountId, generation = services.vault.generation
    let catalog = services.store
    operation = token
    isRefreshing = true
    error = nil
    let loading = Task {
      do {
        try await services.sync()
      } catch is CancellationError {} catch {
        guard !Task.isCancelled, self.operation == token, services.session.accountId == account,
          services.vault.generation == generation, services.store === catalog else { return }
        self.error = error.localizedDescription
        if (error as? FotoroError)?.message == "UNAUTHENTICATED" {
          self.rejectedSession = (SavedLibraryOpenBinding(services), error.localizedDescription)
        }
      }
    }
    task = loading
    await withTaskCancellationHandler { await loading.value } onCancel: { loading.cancel() }
    if operation == token {
      if Task.isCancelled || loading.isCancelled { openedBinding = nil }
      isRefreshing = false
      task = nil
      operation = nil
    }
  }
  func cancel() {
    if isRefreshing { openedBinding = nil }
    task?.cancel()
    task = nil
    operation = nil
    isRefreshing = false
    error = nil
  }
}

struct SavedLibraryOpenBinding: Equatable {
  var account: String?
  var vault: UUID
  var catalog: ObjectIdentifier
  @MainActor init(_ services: AppServices) {
    account = services.session.accountId
    vault = services.vault.generation
    catalog = ObjectIdentifier(services.store)
  }
}

struct SavedLibraryReadPresentation: Equatable {
  var binding: SavedLibraryOpenBinding
  var isActive: Bool
  @MainActor init(_ services: AppServices, isActive: Bool) {
    binding = SavedLibraryOpenBinding(services)
    self.isActive = isActive
  }
}

func savedLibraryEmptyMessage(sync: AutomaticPhotoSyncStatus, favoritesOnly: Bool = false) -> String {
  if favoritesOnly { return "No saved favorites yet." }
  if sync.enabled {
    switch sync.phase {
    case .paused: return "Sync is paused. Resume to add your photos."
    case .locked: return "Open Fotoro to resume sync."
    case .permissionRequired: return "Allow Photos access in Settings to sync your photos."
    case .needsAttention: return "Open Sync to review what needs attention."
    case .background: return "Open Fotoro to continue syncing your photos."
    case .syncing: return "Photos appear here as they sync. Keep Fotoro open."
    case .ready: return "No photos saved yet. Sync is on for the photos you allow."
    case .off: break
    }
  }
  return "Save photos in Fotoro, or pull down to check photos saved on another device."
}

struct SavedCatalogSearchPresentationID: Equatable {
  var query: String
  var catalog: UInt64
  var binding: SavedLibraryOpenBinding
}

private struct SavedCatalogSearchRequestID: Equatable {
  var presentation: SavedCatalogSearchPresentationID
  var isActive: Bool
  var attempt: UInt64
}

@MainActor @Observable final class SavedCatalogSearch {
  private var requestedID: SavedCatalogSearchPresentationID?
  private var completedID: SavedCatalogSearchPresentationID?
  private var photos: [LocalPhoto] = []
  private var searching = false
  private var error: String?
  @ObservationIgnored private var operation: UUID?
  @ObservationIgnored private var task: Task<[LocalPhoto], Error>?
  func results(for id: SavedCatalogSearchPresentationID) -> [LocalPhoto]? {
    completedID == id ? photos : nil
  }
  func hasCompleted(_ id: SavedCatalogSearchPresentationID) -> Bool { completedID == id }
  func isPending(_ id: SavedCatalogSearchPresentationID) -> Bool { requestedID != id || searching }
  func failure(for id: SavedCatalogSearchPresentationID) -> String? { requestedID == id ? error : nil }
  func search(_ id: SavedCatalogSearchPresentationID,
    current: () -> SavedCatalogSearchPresentationID,
    read: @escaping @MainActor () async throws -> [LocalPhoto]) async {
    guard !Task.isCancelled, current() == id else { return }
    cancel()
    if completedID != id { completedID = nil; photos = [] }
    requestedID = id
    searching = true
    let token = UUID()
    operation = token
    let loading = Task { try await read() }
    task = loading
    defer {
      if operation == token { searching = false; operation = nil; task = nil }
    }
    do {
      let result = try await withTaskCancellationHandler { try await loading.value }
        onCancel: { loading.cancel() }
      guard !Task.isCancelled, !loading.isCancelled, operation == token, current() == id else { return }
      photos = result
      completedID = id
    } catch is CancellationError {} catch {
      guard !Task.isCancelled, !loading.isCancelled, operation == token, current() == id else { return }
      self.error = error.localizedDescription
    }
  }
  func cancel(clearResults: Bool = false) {
    task?.cancel()
    task = nil
    operation = nil
    requestedID = nil
    searching = false
    error = nil
    if clearResults { completedID = nil; photos = [] }
  }
}

struct LibraryPhotoCell: View {
  let photo: LocalPhoto
  let isSelected: Bool
  let open: () -> Void
  let toggleSelection: () -> Void
  let appeared: () -> Void

  var body: some View {
    Button(action: open) {
      ZStack(alignment: .bottomTrailing) {
        GeometryReader { geometry in
          LazyImage(url: photo.thumbnailURL) { state in
            if let image = state.image {
              image.resizable().scaledToFill()
            } else {
              Rectangle().fill(.quaternary)
            }
          }.frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        if isSelected {
          Image(systemName: "checkmark.circle.fill").padding(8)
        }
      }.aspectRatio(1, contentMode: .fit)
    }.buttonStyle(.plain).accessibilityLabel(photo.metadata.filename)
      .onAppear(perform: appeared)
      .contextMenu {
        Button(isSelected ? "Deselect" : "Select", action: toggleSelection)
      }
  }
}
