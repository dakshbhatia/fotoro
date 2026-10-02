import NukeUI
import Observation
import PhotosUI
import SwiftUI

struct LibraryView: View {
  @Bindable var services: AppServices
  @State private var query = ""
  @State private var searchResults: [LocalPhoto]?
  @State private var selection = SavedPhotoSelection()
  @State private var catalogRefresh = SavedLibraryRefresh()
  @State private var showingFiles = false
  @State private var viewer: SavedPhotoViewerPresentation?
  @State private var showExchange = false
  @State private var showingBackup = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var scrollID: String?
  @State private var signingOut = false
  @State private var originalURLs: [URL] = []
  @State private var sharingOriginals = false
  @State private var preparingShare = false
  @State private var shareTask: Task<Void, Never>?
  @State private var shareSources: [LocalPhoto] = []
  private let photoManager = PHCachingImageManager()
  var filtered: [LocalPhoto] {
    if !query.isEmpty, let searchResults { return searchResults }
    return services.photos.filter {
      services.matches($0, query: query)
    }
  }
  var days: [(String, [LocalPhoto])] {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    let groups = Dictionary(grouping: filtered) { photo in
      formatter.string(from: Wire.parseDate(photo.metadata.sourceDate) ?? Date())
    }
    return groups.keys.sorted(by: >).map { ($0, groups[$0]!) }
  }
  var body: some View {
    NavigationStack {
      Group {
        if !services.vault.isUnlocked {
          AccountView(services: services)
        } else {
          ScrollView {
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
                description: Text(query.isEmpty ? "Save picks from your account, or refresh photos you've already saved." : "Try a label, filename or words in a photo."))
              if query.isEmpty { Button("Account") { showingBackup = true }.buttonStyle(.borderedProminent) }
            }
            ForEach(services.notices, id: \.self) { Text($0).font(.caption).padding() }
          }.scrollPosition(id: $scrollID, anchor: .top)
            .task(id: SavedLibraryOpenBinding(account: services.session.accountId, vault: services.vault.generation)) {
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
              ToolbarItem(placement: .topBarLeading) {
                Button("Account", systemImage: "person.crop.circle") { showingBackup = true }
              }
              ToolbarItem(placement: .topBarTrailing) {
                Menu("More", systemImage: "ellipsis") {
                  Button("Encrypted sharing") { showExchange = true }
                  Button("Lock", systemImage: "lock") { services.lockAccount() }
                  Button("Sign out", systemImage: "person.crop.circle.badge.xmark") {
                    signingOut = true
                  }
                  Button("Files") { showingFiles = true }
                  PhotosPicker(
                    "Photos", selection: $selectedPhotos, maxSelectionCount: 100, matching: .images)
                  #if DEBUG
                    Button("Public sample") {
                      services.run {
                        guard
                          let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")
                        else { throw FotoroError("Sample missing") }
                        try await services.importFiles([url], publicSample: true)
                      }
                    }
                  #endif
                }
              }
              if selection.count > 0 {
                ToolbarItem(placement: .bottomBar) {
                  Button("Share \(selection.count)", systemImage: "square.and.arrow.up") {
                    shareOriginals()
                  }.disabled(preparingShare || sharingOriginals)
                }
              }
            }
        }
      }.navigationTitle("Saved photos")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .overlay { if services.busy { ProgressView().padding().glassEffect() } }
        .sheet(item: $viewer, onDismiss: { viewer = nil }) { presentation in
          PhotoViewer(
            services: services, initialID: presentation.initial.id, displayedPhotos: presentation.photos)
        }
        .onChange(of: scenePhase) {
          if scenePhase != .active { services.backup.pause() }
        }
        .sheet(isPresented: $showingBackup) { PhotosBackupView(services: services) }
        .sheet(isPresented: $sharingOriginals, onDismiss: cleanupShare) {
          OriginalShareSheet(urls: originalURLs) { _ in cleanupShare() }
        }
        .sheet(isPresented: $showExchange) {
          ExchangeView(
            services: services, selected: (try? selection.resolve(using: services.consumerSavedPhoto)) ?? [])
        }
        .fileImporter(
          isPresented: $showingFiles, allowedContentTypes: [.jpeg, .png, .heic],
          allowsMultipleSelection: true
        ) { result in services.run { try await services.importFiles(result.get()) } }
        .onChange(of: selectedPhotos) { _, items in
          services.run {
            guard
              NativeBackupPolicy.allowsPrivatePhotos(
                accountId: services.session.accountId, fixture: services.session.fixture)
            else {
              throw FotoroError(
                "Public test accounts cannot import your Photos library. Use a real account.")
            }
            let selected = items.compactMap { item in
              item.itemIdentifier.map {
                SelectedResource(
                  id: Wire.id(), origin: .photos, resourceIdentifier: $0, fileURL: nil)
              }
            }
            guard selected.count == items.count else {
              throw FotoroError(
                "Original Photos identifiers unavailable; select an original from Files")
            }
            try await services.importPhotos(selected)
          }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked {
            viewer = nil
            showExchange = false
            showingBackup = false
            shareTask?.cancel()
            cleanupShare()
            selection.removeAll()
            searchResults = nil
            catalogRefresh.cancel()
          }
        }
        .onChange(of: services.vault.generation) {
          shareTask?.cancel(); cleanupShare(); selection.removeAll(); catalogRefresh.cancel()
        }
        .onChange(of: services.consumerCatalogGeneration) { validateSelection() }
        .onDisappear { shareTask?.cancel(); cleanupShare(); catalogRefresh.cancel() }
        .alert("Sign out?", isPresented: $signingOut) {
          Button("Sign out and remove local data", role: .destructive) {
            services.run { try services.signOut(discardPending: true) }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text(
            "Pending unsent imports, account wrappers, and local photo caches will be removed from this iPhone."
          )
        }
        .alert(
          "Fotoro",
          isPresented: Binding(
            get: { services.error != nil && !showExchange && !showingBackup && viewer == nil && !sharingOriginals },
            set: { if !$0 && !showExchange && !showingBackup && viewer == nil && !sharingOriginals { services.error = nil } })
        ) {
          Button("OK") { services.error = nil }
        } message: {
          Text(services.error ?? "")
        }
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
    let binding = SavedLibraryOpenBinding(account: services.session.accountId, vault: services.vault.generation)
    guard openedBinding != binding, services.vault.isUnlocked else { return }
    if isRefreshing { cancel() }
    openedBinding = binding
    await refresh(services)
  }
  func refresh(_ services: AppServices) async {
    guard !isRefreshing, services.vault.isUnlocked else { return }
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
