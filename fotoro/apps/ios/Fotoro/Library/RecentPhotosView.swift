import Photos
import PhotosUI
import SwiftUI
import UIKit

struct PhotosImage: View {
  let photo: RecentPhoto
  let store: RecentPhotosStore
  var large = false
  var networkAllowed = true
  @State private var image: UIImage?
  @State private var request: PHImageRequestID?
  @State private var generation = UUID()
  @State private var active = false
  @State private var unavailable = false
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable()
      } else {
        Rectangle().fill(.quaternary).overlay {
          if unavailable {
            Label("Preview unavailable", systemImage: "icloud.slash").font(.caption)
          } else {
            ProgressView()
          }
        }
      }
    }
    .task(id: photo.id + "|" + photo.sourceRevision) {
      if let request { store.images.cancelImageRequest(request) }
      image = nil
      unavailable = false
      let token = UUID()
      generation = token
      active = true
      let options = PHImageRequestOptions()
      options.isNetworkAccessAllowed = networkAllowed
      options.deliveryMode = .opportunistic
      request = store.images.requestImage(
        for: photo.asset,
        targetSize: large ? CGSize(width: 1600, height: 1600) : CGSize(width: 360, height: 360),
        contentMode: large ? .aspectFit : .aspectFill, options: options
      ) { value, info in
        guard (info?[PHImageCancelledKey] as? Bool) != true else { return }
        Task { @MainActor in
          guard active, generation == token else { return }
          if let value {
            image = value
          } else if (info?[PHImageResultIsDegradedKey] as? Bool) != true {
            unavailable = true
          }
        }
      }
    }
    .onDisappear {
      active = false
      generation = UUID()
      if let request { store.images.cancelImageRequest(request) }
      image = nil
    }
    .accessibilityLabel(photo.capturedAt?.formatted(date: .complete, time: .shortened) ?? "Photo")
  }
}

struct OriginalShareSheet: UIViewControllerRepresentable {
  let urls: [URL]
  let completed: (Bool) -> Void
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: urls, applicationActivities: nil)
    controller.completionWithItemsHandler = { _, success, _, _ in completed(success) }
    return controller
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct RecentPhotoViewer: View {
  let store: RecentPhotosStore
  let photos: [RecentPhoto]
  let initialID: String
  var search: LocalSearchStore? = nil
  var share: (RecentPhoto) -> Void
  @State private var selected = ""
  @State private var scale: CGFloat = 1
  @State private var details = false
  @Environment(\.dismiss) private var dismiss
  func shouldLoad(_ photo: RecentPhoto) -> Bool {
    guard let index = photos.firstIndex(where: { $0.id == photo.id }),
      let current = photos.firstIndex(where: { $0.id == (selected.isEmpty ? initialID : selected) })
    else { return false }
    return RecentPhotosPolicy.shouldLoadPage(index, current: current)
  }
  var current: RecentPhoto? { photos.first { $0.id == selected } }
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          Group {
            if shouldLoad(photo) {
              PhotosImage(photo: photo, store: store, large: true).scaledToFit()
            } else {
              Color.black
            }
          }
          .scaleEffect(scale).gesture(
            MagnifyGesture().onChanged { scale = min(5, max(1, $0.magnification)) }
          )
          .onTapGesture(count: 2) { scale = scale == 1 ? 2 : 1 }.tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black).onAppear { selected = initialID }
        .onChange(of: selected) { scale = 1 }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .bottomBar) {
            Button("Info", systemImage: "info.circle") { details.toggle() }
          }
          ToolbarItem(placement: .bottomBar) {
            Button("Share", systemImage: "square.and.arrow.up") {
              if let current { share(current) }
            }
          }
        }
        .sheet(isPresented: $details) {
          if let current {
            LocalPhotoDetails(photo: current, search: search)
          }
        }
    }.preferredColorScheme(.dark)
  }
}

enum RecentPhotosContentMode {
  case openPhotos, accessOff, gallery, search

  static func select(query: String, opened: Bool, status: PHAuthorizationStatus) -> Self {
    if !query.isEmpty { return .search }
    if !opened { return .openPhotos }
    if !RecentPhotosPolicy.canRead(status) { return .accessOff }
    return .gallery
  }
}

struct RecentPhotosView: View {
  @State private var store = RecentPhotosStore()
  @State private var search = LocalSearchStore()
  @State private var query = ""
  @FocusState private var queryFocused: Bool
#if !FOTORO_LOCAL_PREVIEW
  @State private var services: AppServices?
  @State private var backupAccount: AppServices?
  @State private var searchHits: [ConsumerSearchHit] = []
  @State private var savedResults: [String: LocalPhoto] = [:]
  @State private var savedViewer: LocalPhoto?
  @State private var pendingBackup = false
#endif
  @State private var selected: Set<String> = []
  @State private var selecting = false
  @State private var viewer: RecentPhoto?
  @State private var pendingShare: RecentPhoto?
  @State private var shareTask: Task<Void, Never>?
  @State private var sharing: [URL] = []
  @State private var showShare = false
  @State private var preparingShare = false
  @State private var shareMeaning: String?
  @State private var sharedPhotoIDs: [String] = []
  @State private var settings = false
  @Environment(\.scenePhase) private var scenePhase

  private var visible: [RecentPhoto] {
#if FOTORO_LOCAL_PREVIEW
    query.isEmpty ? store.photos : search.matchingPhotos
#else
    query.isEmpty ? store.photos : searchHits.compactMap {
      if case .device(let id) = $0.photo { return search.assets[id] }
      return nil
    }
#endif
  }
#if !FOTORO_LOCAL_PREVIEW
  private var savedPhotos: [LocalPhoto] {
    searchHits.compactMap {
      if case .saved(let id) = $0.photo { return savedResults[id] }
      return nil
    }
  }
  private var searchTaskID: ConsumerSearchPresentationID {
    ConsumerSearchPresentationID(query: query, library: search.libraryGeneration,
      results: search.response.results.map(\.id), indexed: search.response.indexed,
      account: services?.session.accountId, vault: services?.vault.generation)
  }
#endif
  var body: some View {
    NavigationStack {
#if FOTORO_LOCAL_PREVIEW
      sharedHome
#else
      accountHome
#endif
    }
  }
#if !FOTORO_LOCAL_PREVIEW
  private var accountHome: some View {
    sharedHome
      .sheet(item: $savedViewer) { photo in
        if let services { PhotoViewer(services: services, initialID: photo.id, displayedPhotos: savedPhotos) }
      }
      .sheet(item: $backupAccount) { PhotosBackupView(services: $0) }
      .task(id: searchTaskID) { await updateSearch() }
      .onChange(of: services?.vault.generation) {
        savedViewer = nil
        searchHits.removeAll { if case .saved = $0.photo { return true }; return false }
        savedResults = [:]
      }
  }
#endif
  private var sharedHome: some View {
    content.navigationTitle("Photos")
        .toolbar { homeToolbar }
        .safeAreaInset(edge: .bottom) { searchBar }
        .overlay {
          if preparingShare { ProgressView("Preparing original…").padding().glassEffect() }
        }
        .sheet(item: $viewer, onDismiss: {
          if let photo = pendingShare { pendingShare = nil; share([photo]) }
        }) { photo in
          RecentPhotoViewer(store: store, photos: visible, initialID: photo.id, search: search) {
            pendingShare = $0
            viewer = nil
          }
        }
        .sheet(isPresented: $showShare, onDismiss: cleanupShare) {
          OriginalShareSheet(urls: sharing) { success in
            if success, let meaning = shareMeaning {
              for id in sharedPhotoIDs { search.confirm(id, meaningID: meaning) }
            }
            cleanupShare()
          }
        }
        .sheet(isPresented: $settings, onDismiss: {
#if !FOTORO_LOCAL_PREVIEW
          if pendingBackup { pendingBackup = false; openBackup() }
#endif
        }) { settingsView }
        .onChange(of: query) { search.updateQuery(query) }
        .onChange(of: search.libraryGeneration) {
          viewer = nil
          selected = []
          shareTask?.cancel()
          cleanupShare()
#if !FOTORO_LOCAL_PREVIEW
          searchHits = []
          savedResults = [:]
#endif
          store.refresh()
        }
        .onChange(of: scenePhase) {
          if scenePhase == .active {
            restorePhotos()
#if !FOTORO_LOCAL_PREVIEW
            if let services { Task { await services.resumeSavedAccount() } }
#endif
          } else {
#if !FOTORO_LOCAL_PREVIEW
            services?.backup.pause()
#endif
            search.pause()
          }
        }
        .task {
          restorePhotos()
#if !FOTORO_LOCAL_PREVIEW
          do {
            if services == nil { services = try AppServices() }
            services?.bindLocalSearch(search)
            await services?.resumeSavedAccount(initialRestoration: true)
          } catch { store.error = error.localizedDescription }
#endif
        }
        .alert("Fotoro", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
          Button("OK") { store.error = nil }
        } message: { Text(store.error ?? "") }
  }
  @ViewBuilder private var content: some View {
    let mode = RecentPhotosContentMode.select(query: query, opened: store.opened, status: store.status)
    if mode == .openPhotos {
      VStack(spacing: 18) {
        Image(systemName: "photo.on.rectangle").font(.system(size: 44))
        Text("Your last 10 days").font(.title2.bold())
#if FOTORO_LOCAL_PREVIEW
        Text("Local-only beta").font(.subheadline).foregroundStyle(.secondary)
#endif
        Text("Find a photo. Keep a moment.").foregroundStyle(.secondary)
        Button("Open Photos") {
          Task { await store.open(); search.open(status: store.status) }
        }.buttonStyle(.borderedProminent)
      }.padding().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if mode == .accessOff {
      ContentUnavailableView {
        Label("Photos access is off", systemImage: "photo")
      } description: {
#if FOTORO_LOCAL_PREVIEW
        Text("Allow selected photos or full access in Settings.")
#else
        Text("Allow selected photos or full access in Settings. Your saved account photos are still searchable after signing in.")
#endif
      } actions: { Button("Open Settings", action: openSettings) }
    } else {
      ScrollView {
        if mode == .search {
#if FOTORO_LOCAL_PREVIEW
          LocalSearchView(search: search, photos: store, choseMeaning: { queryFocused = false }) {
            queryFocused = false
            viewer = $0
          }
#else
          ConsumerSearchResultsView(hits: searchHits, saved: savedResults, search: search, photos: store,
            inspectDevice: { queryFocused = false; viewer = $0 },
            inspectSaved: { queryFocused = false; savedViewer = $0 },
            choseAlternative: { queryFocused = false })
#endif
        } else {
          HStack {
            Text("Last 10 days").font(.subheadline.weight(.medium))
            Spacer()
            Text("\(store.photos.count) photos").font(.subheadline).foregroundStyle(.secondary)
          }.padding(.horizontal).padding(.vertical, 10)
          gallery
          if store.photos.isEmpty {
            ContentUnavailableView("No recent photos", systemImage: "photo", description: Text("Search to find older photos, too."))
          }
        }
        if store.status == .limited {
          Button("Manage selected photos", action: addPhotos)
            .font(.footnote).padding().accessibilityHint("Choose more photos Fotoro may access")
        }
      }
      .scrollDismissesKeyboard(.interactively)
    }
  }
  private var gallery: some View {
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
      ForEach(store.photos) { photo in
        RecentPhotoCell(photo: photo, store: store, selected: selected.contains(photo.id), open: {
          if selecting { toggleSelection(photo) } else { viewer = photo }
        }, toggle: { toggleSelection(photo) })
      }
    }
  }
  @ToolbarContentBuilder private var homeToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
#if FOTORO_LOCAL_PREVIEW
      Text("Local-only beta").font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: true, vertical: false)
#else
      Button(action: openBackup) { ConsumerBackupLabel(summary: services?.consumerSyncSummary ?? ConsumerSyncSummary()) }
        .accessibilityLabel("Backup status")
#endif
    }
    ToolbarItem(placement: .topBarTrailing) {
      if store.opened, !store.photos.isEmpty {
        Button(selecting ? "Done" : "Select") {
          selecting.toggle()
          if !selecting { selected = [] }
        }.disabled(preparingShare)
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Button("Settings", systemImage: "gearshape") { settings = true }
    }
  }
  @ViewBuilder private var searchBar: some View {
    if canSearch {
      HStack(spacing: 12) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Search photos", text: $query).focused($queryFocused)
          .submitLabel(.search).onSubmit { queryFocused = false }
          .accessibilityHint("Find labels, dates and words in your photos")
        if !query.isEmpty {
          Button("Clear search", systemImage: "xmark.circle.fill") { query = ""; queryFocused = false }
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }
        if !selected.isEmpty {
          Button("Share", systemImage: "square.and.arrow.up") { share(store.photos.filter { selected.contains($0.id) }) }
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).disabled(preparingShare || showShare)
        }
      }.padding(.leading, 18).padding(.trailing, 8).frame(minHeight: 56)
        .glassEffect(.regular.interactive()).padding(.horizontal).padding(.bottom, 6)
    }
  }
  private var canSearch: Bool {
#if FOTORO_LOCAL_PREVIEW
    store.opened
#else
    store.opened || services?.vault.isUnlocked == true
#endif
  }
  private var settingsView: some View {
    NavigationStack {
      List {
        Section {
#if FOTORO_LOCAL_PREVIEW
          Text("Local-only beta").font(.headline)
          Text("Browse and search your Photos library on this device. Labels stay on this device. Nothing is backed up to Fotoro.")
#else
          Text("Photos stay in your library. Browsing does not upload them.")
          Button("Backup status") { pendingBackup = true; settings = false }
#endif
        }
        Section("Photos access") {
          Button("Refresh last 10 days") { restorePhotos(); settings = false }
          if store.status == .limited { Button("Manage selected photos") { settings = false; addPhotos() } }
          Button("Open system settings", action: openSettings)
        }
      }.navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { settings = false } } }
    }
  }
  private func restorePhotos() {
    store.restoreAccess()
    if RecentPhotosPolicy.canRead(store.status) { search.open(status: store.status) }
    else { search.auditAuthorization() }
  }
#if !FOTORO_LOCAL_PREVIEW
  private func openBackup() {
    queryFocused = false
    do {
      if services == nil { services = try AppServices() }
      services?.bindLocalSearch(search)
      backupAccount = services
    } catch { store.error = error.localizedDescription }
  }
  private func updateSearch() async {
    guard !query.isEmpty else { searchHits = []; savedResults = [:]; return }
    let token = searchTaskID
    do {
      try await Task.sleep(for: .milliseconds(100))
      guard let services else { return }
      let hits = try await services.consumerSearch(query, local: search)
      try Task.checkCancellation()
      guard token == searchTaskID else { return }
      var saved: [String: LocalPhoto] = [:]
      for hit in hits {
        if case .saved(let id) = hit.photo { saved[id] = try services.consumerSavedPhoto(id) }
      }
      searchHits = hits
      savedResults = saved
    } catch is CancellationError {} catch {
      searchHits = []
      savedResults = [:]
      store.error = error.localizedDescription
    }
  }
#endif
  private func toggleSelection(_ photo: RecentPhoto) {
    if selected.contains(photo.id) { selected.remove(photo.id) } else { selected.insert(photo.id) }
  }
  private func openSettings() {
    UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
  }
  private func addPhotos() {
    if store.status == .limited {
      guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
        var controller = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return }
      while let presented = controller.presentedViewController { controller = presented }
      PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { _ in
        Task { @MainActor in store.refresh(); search.refresh(status: store.status) }
      }
    } else { restorePhotos() }
  }
  private func share(_ photos: [RecentPhoto]) {
    guard !preparingShare, !showShare, !photos.isEmpty else { return }
    preparingShare = true
    let generation = search.libraryGeneration
    shareTask = Task {
      defer { preparingShare = false; shareTask = nil }
      var exported: [URL] = []
      do {
        exported = try await store.shareOriginals(photos)
        try Task.checkCancellation()
        guard generation == search.libraryGeneration, RecentPhotosPolicy.canRead(store.status) else { throw CancellationError() }
        sharing = exported
        shareMeaning = query.isEmpty ? nil : search.response.meaning?.id
        sharedPhotoIDs = photos.map(\.id)
        showShare = true
      } catch is CancellationError { removeShareFiles(exported) }
      catch { removeShareFiles(exported); store.error = error.localizedDescription }
    }
  }
  private func removeShareFiles(_ urls: [URL]) {
    for root in Set(urls.map { $0.deletingLastPathComponent().deletingLastPathComponent() }) {
      try? FileManager.default.removeItem(at: root)
    }
  }
  private func cleanupShare() {
    removeShareFiles(sharing)
    sharing = []
    showShare = false
    shareMeaning = nil
    sharedPhotoIDs = []
  }
}

#if !FOTORO_LOCAL_PREVIEW
private struct ConsumerSearchPresentationID: Equatable {
  var query: String
  var library: UInt64
  var results: [String]
  var indexed: Int
  var account: String?
  var vault: UUID?
}
#endif

private struct RecentPhotoCell: View {
  let photo: RecentPhoto
  let store: RecentPhotosStore
  let selected: Bool
  let open: () -> Void
  let toggle: () -> Void
  var body: some View {
    Button(action: open) {
      GeometryReader { geometry in
        PhotosImage(photo: photo, store: store).scaledToFill()
          .frame(width: geometry.size.width, height: geometry.size.height).clipped()
      }.aspectRatio(1, contentMode: .fit)
        .overlay(alignment: .bottomTrailing) {
          if selected { Image(systemName: "checkmark.circle.fill").padding(8) }
        }
    }.buttonStyle(.plain).id(photo.id)
      .onAppear { store.cache([photo.asset], start: true) }
      .onDisappear { store.cache([photo.asset], start: false) }
      .contextMenu { Button(selected ? "Deselect" : "Select", action: toggle) }
  }
}
