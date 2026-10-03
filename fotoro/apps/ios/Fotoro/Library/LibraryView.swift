import NukeUI
import Observation
import SwiftUI

struct LibraryView: View {
  @Bindable var services: AppServices
  let saveSelection: [RecentPhotoSource]?
  @State private var pendingIncoming: FotoroShareLink?
  @State private var sharedPhotos: SharedPhotosPresentation?
  @State private var saveIntent: ManualPhotoSaveIntent?
  @State private var authenticationTask: Task<Void, Never>?
  @State private var query = ""
  @State private var favoritesOnly = false
  @State private var searchResults: [LocalPhoto]?
  @State private var selection = SavedPhotoSelection()
  @State private var catalogRefresh = SavedLibraryRefresh()
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
  var filtered: [LocalPhoto] {
    let current = !query.isEmpty && searchResults != nil ? searchResults! : services.photos.filter { services.matches($0, query: query) }
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
        if services.auth.startPassword != nil || services.photoAccountAccess == nil {
          VStack(alignment: .leading, spacing: 0) {
            if let saveSelection {
              Text("Open Fotoro to save \(saveSelection.count) \(saveSelection.count == 1 ? "photo" : "photos")")
                .font(.headline).padding(.horizontal).padding(.top)
            }
            AccountView(services: services, onSignedIn: openedAccount,
              onAuthenticationTask: { authenticationTask = $0 })
          }
        } else if authenticationTask != nil {
          ProgressView("Opening Fotoro…")
        } else {
          ScrollView {
            savingFeedback
            catalogFeedback
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3
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
            if filtered.isEmpty && !catalogRefresh.isRefreshing {
              ContentUnavailableView(
                "No photos", systemImage: "photo",
                description: Text(query.isEmpty ? "Save photos in Fotoro, or refresh photos you've already saved." : "Try a label, filename or words in a photo."))
            }
            ForEach(services.notices, id: \.self) { Text($0).font(.caption).padding() }
          }.scrollPosition(id: $scrollID, anchor: .top)
            .scrollDismissesKeyboard(.interactively)
            .task(id: SavedLibraryOpenBinding(services)) {
              await catalogRefresh.open(services)
            }
            .searchable(text: $query, prompt: "Search")
            .task(id: SavedCatalogSearchPresentationID(query: query,
              catalog: services.consumerCatalogGeneration, vault: services.vault.generation)) {
              guard !query.isEmpty else { searchResults = nil; return }
              let searchedQuery = query
              let generation = services.consumerCatalogGeneration
              do {
                let results = try await services.searchCatalog(searchedQuery)
                guard !Task.isCancelled, searchedQuery == query,
                  generation == services.consumerCatalogGeneration else { return }
                searchResults = results
              } catch is CancellationError {} catch {
                guard !Task.isCancelled, searchedQuery == query,
                  generation == services.consumerCatalogGeneration else { return }
                services.error = error.localizedDescription
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
                    Button("Share in Fotoro") { shareInFotoro() }
                    Button("Share originals") { shareOriginals() }
                  }.disabled(preparingShare || sharingOriginals)
                }
              }
              ToolbarItem(placement: .topBarTrailing) {
                Menu("Filter", systemImage: "line.3.horizontal.decrease") {
                  Toggle("Favorites", isOn: $favoritesOnly)
                }
              }
            }
        }
      }.navigationTitle("Saved photos").navigationBarTitleDisplayMode(.inline)
        .task {
          if authenticationTask == nil, services.auth.startPassword == nil {
            saveIntent?.authorize(services.photoAccountAccess)
          }
          startSelectedSave()
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
        .sheet(item: $sharedPhotos) { presentation in
          ExchangeView(services: services, selected: presentation.photos, incoming: presentation.incoming)
        }
        .onChange(of: authenticationTask == nil) { openIncomingLink() }
        .onChange(of: services.photoAccountAccess) { openIncomingLink() }
        .onChange(of: scenePhase) {
          if scenePhase == .background {
            pendingIncoming = nil; sharedPhotos = nil
            cancelAuthentication()
            services.pauseSync()
          } else if scenePhase == .active {
            startSelectedSave()
          } else {
            services.backup.pause()
          }
        }
        .sheet(isPresented: $sharingOriginals, onDismiss: cleanupShare) {
          OriginalShareSheet(urls: originalURLs) { _ in cleanupShare() }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked {
            if authenticationTask == nil { saveIntent?.cancel(); pendingIncoming = nil }
            sharedPhotos = nil
            viewer = nil
            shareTask?.cancel()
            cleanupShare()
            selection.removeAll()
            searchResults = nil
            catalogRefresh.cancel()
          }
        }
        .onChange(of: services.vault.generation) {
          sharedPhotos = nil
          if authenticationTask == nil { pendingIncoming = nil }
          shareTask?.cancel(); cleanupShare(); selection.removeAll(); catalogRefresh.cancel()
        }
        .onChange(of: services.consumerCatalogGeneration) { validateSelection() }
        .onDisappear { cancelAuthentication(); shareTask?.cancel(); cleanupShare(); catalogRefresh.cancel() }
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
    }
  }

  private func openedAccount() {
    saveIntent?.authorize(services.photoAccountAccess)
    startSelectedSave()
    openIncomingLink()
  }
  private func openIncomingLink() {
    guard scenePhase == .active, authenticationTask == nil, services.auth.startPassword == nil,
      services.photoAccountAccess != nil, let incoming = pendingIncoming else { return }
    pendingIncoming = nil
    sharedPhotos = SharedPhotosPresentation(incoming: incoming)
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
  private func cancelAuthentication() {
    saveIntent?.cancel()
    authenticationTask?.cancel()
    authenticationTask = nil
    services.auth.cancelStart()
  }
  @ViewBuilder private var savingFeedback: some View {
    let summary = services.consumerSyncSummary
    if services.backup.isRunning || services.journal.running {
      HStack {
        ProgressView("Saving photos…")
        Spacer()
        Button("Pause") { services.pauseSync() }
      }.padding()
    } else if summary.action == .continue || summary.action == .retry {
      Button("Continue saving", systemImage: "icloud.and.arrow.up") {
        services.run { try await services.continueSync() }
      }.disabled(services.busy).padding()
    } else if let saveSelection, saveIntent?.pending == false,
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
  private var catalogFeedback: some View {
    VStack(alignment: .leading, spacing: 8) {
      if catalogRefresh.isRefreshing {
        ProgressView("Loading saved photos…")
      } else if let error = catalogRefresh.error {
        Text(error).font(.footnote).foregroundStyle(.secondary)
        Button("Try again", systemImage: "arrow.clockwise") {
          Task { await catalogRefresh.refresh(services) }
        }
      } else {
        HStack {
          Spacer()
          Button("Refresh", systemImage: "arrow.clockwise") {
            Task { await catalogRefresh.refresh(services) }
          }.font(.footnote)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding()
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
          urls.append(try await services.consumerShareOriginal(photo))
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

@MainActor @Observable final class SavedLibraryRefresh {
  private(set) var isRefreshing = false
  private(set) var error: String?
  @ObservationIgnored private var openedBinding: SavedLibraryOpenBinding?
  @ObservationIgnored private var operation: UUID?
  @ObservationIgnored private var task: Task<Void, Never>?
  func open(_ services: AppServices) async {
    let binding = SavedLibraryOpenBinding(services)
    guard openedBinding != binding, services.photoAccountAccess != nil else { return }
    if isRefreshing { cancel() }
    openedBinding = binding
    await refresh(services)
  }
  func refresh(_ services: AppServices) async {
    guard !isRefreshing, services.photoAccountAccess != nil else { return }
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
      }
    }
    task = loading
    await withTaskCancellationHandler { await loading.value } onCancel: { loading.cancel() }
    if operation == token { isRefreshing = false; task = nil; operation = nil }
  }
  func cancel() {
    task?.cancel()
    task = nil
    operation = nil
    isRefreshing = false
    error = nil
  }
}

private struct SavedLibraryOpenBinding: Equatable {
  var account: String?
  var vault: UUID
  var catalog: ObjectIdentifier
  @MainActor init(_ services: AppServices) {
    account = services.session.accountId
    vault = services.vault.generation
    catalog = ObjectIdentifier(services.store)
  }
}

private struct SavedCatalogSearchPresentationID: Equatable {
  var query: String
  var catalog: UInt64
  var vault: UUID
}

private struct LibraryPhotoCell: View {
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
