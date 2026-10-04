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
  @State private var receivedFinalImage = false
  @Environment(\.displayScale) private var displayScale
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
      receivedFinalImage = false
      let token = UUID()
      generation = token
      active = true
      let options = PHImageRequestOptions()
      options.isNetworkAccessAllowed = networkAllowed
      options.deliveryMode = .opportunistic
      request = store.images.requestImage(
        for: photo.asset,
        targetSize: large ? CGSize(width: 1600, height: 1600)
          : CGSize(width: 360 * displayScale, height: 360 * displayScale),
        contentMode: large ? .aspectFit : .aspectFill, options: options
      ) { value, info in
        guard (info?[PHImageCancelledKey] as? Bool) != true else { return }
        Task { @MainActor in
          guard active, generation == token else { return }
          let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
          guard !degraded || !receivedFinalImage else { return }
          if let value {
            image = value
            if !degraded { receivedFinalImage = true }
          } else if !degraded {
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
  var save: ((RecentPhoto) -> Void)? = nil
  var share: (RecentPhoto) -> Void
  @State private var selected = ""
  @State private var zoom = PhotoViewerZoom()
  @State private var details = false
  @State private var controlsVisible = true
  @Environment(\.dismiss) private var dismiss
  init(store: RecentPhotosStore, photos: [RecentPhoto], initialID: String,
    search: LocalSearchStore? = nil, save: ((RecentPhoto) -> Void)? = nil,
    share: @escaping (RecentPhoto) -> Void) {
    self.store = store
    self.photos = photos
    self.initialID = initialID
    self.search = search
    self.save = save
    self.share = share
    _selected = State(initialValue: initialID)
  }
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
          .scaleEffect(zoom.scale).gesture(
            MagnifyGesture().onChanged { zoom.change($0.magnification) }
              .onEnded { zoom.settle($0.magnification) }
          )
          .onTapGesture(count: 2) { zoom.toggle() }
          .onTapGesture { controlsVisible.toggle() }.tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black)
        .onChange(of: selected) { zoom.reset() }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .bottomBar) {
            Button("Info", systemImage: "info.circle") { details.toggle() }
          }
          if let save {
            ToolbarItem(placement: .bottomBar) {
              Button("Save", systemImage: "icloud.and.arrow.up") {
                if let current { save(current) }
              }.accessibilityIdentifier("photo.save")
            }
          }
          ToolbarItem(placement: .bottomBar) {
            Button("Share", systemImage: "square.and.arrow.up") {
              if let current { share(current) }
            }
          }
        }
        .toolbar(controlsVisible ? .visible : .hidden, for: .navigationBar, .bottomBar)
        .sheet(isPresented: $details) {
          if let current {
            LocalPhotoDetails(photo: current, search: search)
          }
        }
    }.preferredColorScheme(.dark)
  }
}

private struct RecentPhotoViewerPresentation: Identifiable {
  let initial: RecentPhoto
  let photos: [RecentPhoto]
  let sources: [RecentPhotoSource]
  var id: String { initial.id }
  init(initial: RecentPhoto, photos: [RecentPhoto]) {
    self.initial = initial; self.photos = photos; sources = photos.map(RecentPhotoSource.init)
  }
}

private struct SelectedRecentPhoto {
  let photo: RecentPhoto
  let source: RecentPhotoSource
  init(_ photo: RecentPhoto) { self.photo = photo; source = RecentPhotoSource(photo) }
}

#if !FOTORO_LOCAL_PREVIEW
private struct PhotosAccountPresentation: Identifiable {
  let id = UUID()
  let services: AppServices
  let selection: [RecentPhotoSource]?
  var incoming: FotoroShareLink? = nil
}
private struct PhotoSyncPresentation: Identifiable {
  let id = UUID()
  let services: AppServices
}
#endif

enum RecentPhotosContentMode {
  case openPhotos, accessOff, gallery, search

  static func select(query: String, opened: Bool, status: PHAuthorizationStatus) -> Self {
    if !query.isEmpty { return .search }
    if !opened { return .openPhotos }
    if !RecentPhotosPolicy.canRead(status) { return .accessOff }
    return .gallery
  }
}

private enum PhotoHomeScope: String, CaseIterable, Identifiable, Hashable {
  case picks = "Picks", photos = "Photos"
  #if !FOTORO_LOCAL_PREVIEW
    case saved = "Saved"
  #endif
  var id: String { rawValue }
  var hint: String {
    switch self {
    case .photos: "On this device."
    case .picks: "Your best recent shots."
    #if !FOTORO_LOCAL_PREVIEW
    case .saved: "Photos saved to Fotoro, across your devices."
    #endif
    }
  }
}

struct RecentPhotosView: View {
  @State private var store = RecentPhotosStore()
  @State private var search = LocalSearchStore()
  @State private var bestShots = FindBestShotsReview()
  @State private var bestShotsTask: Task<Void, Never>?
  @State private var preparingBestShots = false
  @State private var bestShotsRequest = UUID()
  @State private var query = ""
  @FocusState private var queryFocused: Bool
#if !FOTORO_LOCAL_PREVIEW
  @State private var services: AppServices?
  @State private var backupAccount: PhotosAccountPresentation?
  @State private var photoSyncPresentation: PhotoSyncPresentation?
  @State private var pendingPhotoSync = false
  @State private var searchHits: [ConsumerSearchHit] = []
  @State private var savedResults: [String: LocalPhoto] = [:]
  @State private var savedViewer: SavedPhotoViewerPresentation?
  @State private var pendingBackup = false
  @State private var pendingSavePhoto: RecentPhoto?
  @State private var savedPassword: FotoroPassword?
  @State private var signingOut = false
  @State private var homeAuthenticationTask: Task<Void, Never>?
  @State private var selectedSavedPhotos = SavedPhotoSelection()
  @State private var sharedSavedPhotos: SharedPhotosPresentation?
  @State private var savedRefresh = SavedLibraryRefresh()
  @State private var savedFavoritesOnly = false
  @State private var savedScrollID: String?
#endif
  @State private var selectedPhotos: [String: SelectedRecentPhoto] = [:]
  @State private var selecting = false
  @State private var scope = PhotoHomeScope.photos
  @State private var browseScrollIDs: [PhotoHomeScope: String] = [:]
  @State private var browseFilter = PhotoBrowseFilter.all
  @State private var groupMoments = false
  @State private var viewer: RecentPhotoViewerPresentation?
  @State private var pendingShare: RecentPhoto?
  @State private var shareTask: Task<Void, Never>?
  @State private var sharing: [URL] = []
  @State private var showShare = false
  @State private var preparingShare = false
  @State private var shareMeaning: String?
  @State private var sharedPhotoIDs: [String] = []
  @State private var shareSources: [RecentPhotoSource] = []
  @State private var settings = false
  @Environment(\.scenePhase) private var scenePhase

  private var allPhotos: Bool { scope == .photos }
  private var baseHomePhotos: [RecentPhoto] {
    if allPhotos { return store.photos }
    return store.picksSnapshot == nil ? store.recentPhotos : store.pickedPhotos
  }
  private var homeGroups: [PhotoBrowseGroup] {
    PhotoBrowsing.groups(baseHomePhotos.map { photo in
      PhotoBrowseItem(source: RecentPhotoSource(photo), facts: RecentPhotoFacts(
        capturedAt: photo.capturedAt, favorite: photo.isFavorite, screenshot: photo.isScreenshot,
        livePhoto: photo.isLivePhoto, location: photo.location))
    }, filter: browseFilter, grouping: groupMoments ? .moments : .days)
  }
  private var homePhotos: [RecentPhoto] {
    let current = Dictionary(baseHomePhotos.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    return homeGroups.flatMap(\.sources).compactMap { source in
      guard let photo = current[source.id], photo.sourceRevision == source.revision else { return nil }
      return photo
    }
  }
  private var selected: Set<String> { Set(selectedPhotos.keys) }
  private var selectedCount: Int {
    #if FOTORO_LOCAL_PREVIEW
      selected.count
    #else
      selected.count + selectedSavedPhotos.count
    #endif
  }
  private var searchPhotos: [RecentPhoto] {
#if FOTORO_LOCAL_PREVIEW
    search.matchingPhotos
#else
    searchHits.compactMap {
      if case .device(let id) = $0.photo { return search.assets[id] }
      return nil
    }
#endif
  }
  private var visible: [RecentPhoto] {
    guard !query.isEmpty else { return homePhotos }
    guard let result = bestShots.snapshot else { return searchPhotos }
    return searchPhotos.filter { result.recommendations.ids.contains("device:" + $0.id) }
  }
  private var searchMatchCount: Int {
    #if FOTORO_LOCAL_PREVIEW
      searchPhotos.count
    #else
      searchHits.count
    #endif
  }
#if !FOTORO_LOCAL_PREVIEW
  private var savedPhotos: [LocalPhoto] {
    searchHits.filter { bestShots.snapshot?.recommendations.ids.contains($0.id) ?? true }.compactMap {
      if case .saved(let id) = $0.photo { return savedResults[id] }
      return nil
    }
  }
  private var selectedReferences: Set<ConsumerPhotoReference> {
    Set(selected.map(ConsumerPhotoReference.device) + selectedSavedPhotos.ids.map(ConsumerPhotoReference.saved))
  }
  private var ownedPhotos: [LocalPhoto] {
    guard let services, services.photoAccountAccess != nil else { return [] }
    return services.photos.filter {
      $0.manifest.ownerAccountId == services.session.accountId && ["committed", "saved"].contains($0.transferState)
        && (!savedFavoritesOnly || services.annotation($0).favorite == true)
    }
  }
  private var savedDays: [(String, [LocalPhoto])] {
    let groups = Dictionary(grouping: ownedPhotos) { photo in
      Wire.parseDate(photo.metadata.sourceDate).map { Calendar.current.startOfDay(for: $0).timeIntervalSince1970.description }
        ?? "unknown"
    }
    return groups.keys.sorted {
      if $0 == "unknown" { return false }
      if $1 == "unknown" { return true }
      return (Double($0) ?? 0) > (Double($1) ?? 0)
    }.map { ($0, groups[$0]!) }
  }
  @ViewBuilder private var savedContent: some View {
    if let services {
      if services.photoAccountAccess == nil || services.auth.startPassword != nil {
        AccountView(services: services, onAuthenticationTask: { homeAuthenticationTask = $0 })
      } else {
        ScrollView {
          HStack {
            Text("Saved photos").font(.title3.weight(.semibold))
            Spacer()
            Menu("Saved options", systemImage: "ellipsis.circle") {
              Toggle("Favorites", isOn: $savedFavoritesOnly)
              Button("Shared photos", systemImage: "person.2") { sharedSavedPhotos = SharedPhotosPresentation() }
              Button("Refresh", systemImage: "arrow.clockwise") { Task { await savedRefresh.refresh(services) } }
            }.labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
            selectionToggle
          }.padding(.horizontal, 16).padding(.bottom, 12)
          if savedRefresh.isRefreshing { ProgressView("Loading saved photos…").padding(.bottom, 12) }
          if let error = savedRefresh.error {
            VStack(spacing: 8) {
              Text(error).font(.footnote).foregroundStyle(.secondary)
              Button("Try again") { Task { await savedRefresh.refresh(services) } }
            }.padding()
          }
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
            ForEach(savedDays, id: \.0) { day in
              Section {
                ForEach(day.1) { photo in
                  LibraryPhotoCell(photo: photo, isSelected: selectedSavedPhotos.contains(photo.id),
                    open: {
                      if selecting { toggleSavedSelection(photo) }
                      else { savedViewer = SavedPhotoViewerPresentation(initial: photo, photos: ownedPhotos) }
                    }, toggleSelection: { toggleSavedSelection(photo) }, appeared: {
                      if photo.id == ownedPhotos.last?.id { try? services.loadMore() }
                    }).id(photo.id)
                }
              } header: {
                HStack {
                  Text(Double(day.0).map { Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .omitted) }
                    ?? "Date unavailable")
                  Spacer()
                }.font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.vertical, 12)
              }
            }
          }
          .scrollTargetLayout()
          if ownedPhotos.isEmpty && !savedRefresh.isRefreshing {
            ContentUnavailableView("No saved photos", systemImage: "photo.stack",
              description: Text(savedFavoritesOnly ? "No saved favorites yet." : "Choose photos, then Save to keep them in Fotoro."))
          }
        }.scrollPosition(id: $savedScrollID, anchor: .top).scrollDismissesKeyboard(.interactively)
          .task(id: SavedLibraryOpenBinding(services)) { await savedRefresh.open(services) }
      }
    } else {
      ProgressView("Opening Fotoro…")
    }
  }
  private func toggleSavedSelection(_ photo: LocalPhoto) {
    guard let services, let current = try? services.consumerSavedPhoto(photo.id),
      current.metadata == photo.metadata, current.manifest == photo.manifest else { return }
    selectedSavedPhotos.toggle(photo)
  }
  private func shareSelectedSavedPhotos() {
    guard let services else { return }
    do { sharedSavedPhotos = SharedPhotosPresentation(photos: try selectedSavedPhotos.resolve(using: services.consumerSavedPhoto)) }
    catch { validateSavedPresentation(); store.error = error.localizedDescription }
  }
  private var searchTaskID: ConsumerSearchPresentationID {
    ConsumerSearchPresentationID(query: query, library: search.libraryGeneration,
      results: search.response.results, indexed: search.response.indexed,
      response: search.response.generation, acceptedMeaning: search.acceptedMeaningID,
      catalog: services?.consumerCatalogGeneration,
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
      .sheet(item: $savedViewer) { presentation in
        if let services { PhotoViewer(services: services, initialID: presentation.initial.id, displayedPhotos: presentation.photos) }
      }
      .sheet(item: $sharedSavedPhotos) { presentation in
        if let services { ExchangeView(services: services, selected: presentation.photos) }
      }
      .sheet(item: $backupAccount) {
        LibraryView(services: $0.services, saveSelection: $0.selection, incomingLink: $0.incoming)
      }
      .sheet(item: $photoSyncPresentation) { PhotoSyncView(services: $0.services) }
      .onOpenURL { url in
        do {
          let incoming = try FotoroShareLinks.parse(url, expectedOrigin: services?.api.origin ?? FotoroShareLinks.origin)
          if services == nil { services = try AppServices() }
          services?.bindLocalSearch(search); services?.bindRecentPhotos(store)
          queryFocused = false; pendingShare = nil; shareTask?.cancel(); cleanupShare()
          settings = false; viewer = nil; savedViewer = nil
          photoSyncPresentation = nil
          if let services { backupAccount = PhotosAccountPresentation(services: services, selection: nil, incoming: incoming) }
        } catch { store.error = error.localizedDescription }
      }
      .task(id: searchTaskID) { await updateSearch() }
      .onChange(of: services?.consumerCatalogGeneration) { cancelBestShots(); validateSavedPresentation() }
      .onChange(of: services?.session.accountId) { cancelBestShots() }
      .onChange(of: searchHits) { cancelBestShots() }
      .onChange(of: services?.vault.generation) {
        cancelBestShots()
        store.restartAnalysis()
        savedViewer = nil
        selectedSavedPhotos.removeAll()
        sharedSavedPhotos = nil
        searchHits.removeAll { if case .saved = $0.photo { return true }; return false }
        savedResults = [:]
      }
  }
#endif
  private var sharedHome: some View {
    VStack(spacing: 0) {
      homeHeader
      content
    }.background(.black).preferredColorScheme(.dark)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom) { if selecting || selectedCount > 0 { selectionTray } }
        .overlay {
          if preparingShare { ProgressView("Preparing original…").padding().glassEffect() }
        }
        .sheet(item: $viewer, onDismiss: {
          if let photo = pendingShare { pendingShare = nil; share([photo]) }
#if !FOTORO_LOCAL_PREVIEW
          if let photo = pendingSavePhoto {
            pendingSavePhoto = nil
            reviewSave([RecentPhotoSource(photo)])
          }
#endif
        }) { presentation in
          RecentPhotoViewer(store: store, photos: presentation.photos, initialID: presentation.initial.id,
            search: search, save: saveFromViewer) {
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
          else if pendingPhotoSync { pendingPhotoSync = false; openPhotoSync() }
#endif
        }) { settingsView }
        .onChange(of: query) { cancelBestShots(); search.updateQuery(query) }
        .onChange(of: search.response.generation) { cancelBestShots() }
        .onChange(of: search.acceptedMeaningID) { cancelBestShots() }
        .onChange(of: store.status) { cancelBestShots() }
        .onChange(of: scope) {
          cancelBestShots()
          queryFocused = false
          #if !FOTORO_LOCAL_PREVIEW
            if scope != .saved { homeAuthenticationTask?.cancel(); homeAuthenticationTask = nil; savedRefresh.cancel() }
          #endif
        }
        .onChange(of: search.libraryGeneration) {
          cancelBestShots()
          validatePhotosPresentation()
#if !FOTORO_LOCAL_PREVIEW
          searchHits = []
          savedResults = [:]
          services?.kickAutomaticPhotoSync(sourcesChanged: true)
#endif
          store.refresh()
        }
        .onChange(of: scenePhase) {
          if scenePhase == .active {
            restorePhotos()
#if !FOTORO_LOCAL_PREVIEW
            services?.setPhotoSyncForeground(true)
            if let services { Task { await services.resumeSavedAccount() } }
#endif
          } else {
            cancelBestShots()
#if !FOTORO_LOCAL_PREVIEW
            services?.setPhotoSyncForeground(false)
            if scenePhase == .background {
              savedPassword = nil
              homeAuthenticationTask?.cancel()
              homeAuthenticationTask = nil
              savedRefresh.cancel()
            }
#endif
            store.pauseAnalysis()
            search.pause()
          }
        }
        .task {
          restorePhotos()
#if !FOTORO_LOCAL_PREVIEW
          do {
            if services == nil { services = try AppServices() }
            services?.bindLocalSearch(search)
            services?.bindRecentPhotos(store)
            services?.setPhotoSyncForeground(scenePhase == .active)
            await services?.resumeSavedAccount(initialRestoration: true)
          } catch { store.error = error.localizedDescription }
#endif
        }
        .onDisappear {
          cancelBestShots()
          shareTask?.cancel(); cleanupShare()
          #if !FOTORO_LOCAL_PREVIEW
            homeAuthenticationTask?.cancel(); homeAuthenticationTask = nil; savedRefresh.cancel()
          #endif
        }
        .alert("Fotoro", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
          Button("OK") { store.error = nil }
        } message: { Text(store.error ?? "") }
  }
  @ViewBuilder private var content: some View {
    #if !FOTORO_LOCAL_PREVIEW
    if scope == .saved && query.isEmpty {
      savedContent
    } else {
      deviceContent
    }
    #else
      deviceContent
    #endif
  }
  @ViewBuilder private var deviceContent: some View {
    let mode = RecentPhotosContentMode.select(query: query, opened: store.opened, status: store.status)
    if mode == .openPhotos {
      VStack(spacing: 18) {
        Image(systemName: "photo.on.rectangle").font(.system(size: 44))
        Text("Your photos").font(.title2.bold())
#if FOTORO_LOCAL_PREVIEW
        Text("Local-only beta").font(.subheadline).foregroundStyle(.secondary)
#endif
        Text("Browse the photos you allow. Your originals stay in Photos.").foregroundStyle(.secondary).multilineTextAlignment(.center)
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
          HStack {
            Text("Matches").font(.title3.weight(.semibold))
            Spacer()
            selectionToggle
          }.padding(.horizontal, 16).padding(.bottom, 12)
          bestShotsControls
#if FOTORO_LOCAL_PREVIEW
          LocalSearchView(search: search, photos: store, review: bestShots.snapshot, choseMeaning: { queryFocused = false },
            selectedIDs: selected, selecting: selecting, toggleSelection: toggleSelection) {
            queryFocused = false
            openViewer($0)
          }
#else
          ConsumerSearchResultsView(hits: searchHits, saved: savedResults, search: search, photos: store, review: bestShots.snapshot,
            selected: selectedReferences, selecting: selecting,
            toggleDevice: toggleSelection, toggleSaved: toggleSavedSelection,
            inspectDevice: { queryFocused = false; openViewer($0) },
            inspectSaved: { photo in
              queryFocused = false
              savedViewer = SavedPhotoViewerPresentation(initial: photo, photos: savedPhotos)
            },
            choseAlternative: { queryFocused = false })
#endif
        } else {
          galleryHeader
          gallery
          if allPhotos, store.hasMorePhotos {
            Button("More photos") { store.loadMorePhotos() }.padding()
          }
          if store.photos.isEmpty {
            ContentUnavailableView("No photos", systemImage: "photo", description: Text("Choose photos Fotoro may access in Settings."))
          } else if browseFilter != .all, homePhotos.isEmpty {
            ContentUnavailableView("No matching photos", systemImage: "line.3.horizontal.decrease",
              description: Text("Change the filter to see more photos."))
          } else if !allPhotos, store.picksSnapshot != nil, homePhotos.isEmpty {
            ContentUnavailableView("No picks yet", systemImage: "photo", description: Text("Open Photos to browse every photo you’ve allowed."))
          }
        }
        if store.status == .limited {
          Button("Manage selected photos", action: addPhotos)
            .font(.footnote).padding().accessibilityHint("Choose more photos Fotoro may access")
        }
      }
      .scrollPosition(id: browseScrollBinding, anchor: .top).scrollDismissesKeyboard(.interactively)
    }
  }
  private var browseScrollBinding: Binding<String?> {
    Binding(get: { query.isEmpty ? browseScrollIDs[scope] : nil }, set: {
      if query.isEmpty { browseScrollIDs[scope] = $0 }
    })
  }
  private var bestShotsControls: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Button("All matches", action: cancelBestShots)
          .tint(bestShots.showing || preparingBestShots ? .gray : .accentColor)
          .accessibilityValue(bestShots.showing || preparingBestShots ? "" : "Selected")
          .accessibilityIdentifier("find.allMatches")
        Button("Best shots", action: beginBestShots)
          .tint(bestShots.showing || preparingBestShots ? .accentColor : .gray)
          .disabled(searchMatchCount == 0 || preparingBestShots || bestShots.reviewing)
          .accessibilityValue(bestShots.showing || preparingBestShots ? "Selected" : "")
          .accessibilityIdentifier("find.bestShots")
      }.buttonStyle(.bordered)
      if preparingBestShots || bestShots.reviewing {
        ProgressView(preparingBestShots ? "Checking matches…" : "Reviewing previews…")
          .font(.footnote)
      } else if let result = bestShots.snapshot {
        Text("\(result.recommendations.ids.count) suggestions · \(result.candidates.count) of \(bestShots.matchCount) matches reviewed")
          .font(.footnote).foregroundStyle(.secondary)
        if result.recommendations.unassessed > 0 {
          Text("\(result.recommendations.unassessed) previews unavailable. All matches keeps every photo reviewable.")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      if bestShots.showing || preparingBestShots {
        Text("Uses available previews on this device. Your selection is unchanged.")
          .font(.caption).foregroundStyle(.secondary)
      }
      if let error = bestShots.error {
        Text(error).font(.caption).foregroundStyle(.secondary)
        Button("Try again", action: beginBestShots)
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 12)
  }
  private func cancelBestShots() {
    bestShotsRequest = UUID()
    bestShotsTask?.cancel(); bestShotsTask = nil
    preparingBestShots = false
    bestShots.showAll()
  }
  private func beginBestShots() {
    cancelBestShots()
    queryFocused = false
    let request = bestShotsRequest
    #if FOTORO_LOCAL_PREVIEW
      let matches = searchPhotos
    #endif
    let matchCount = searchMatchCount
    let queryToken = query
    let library = search.libraryGeneration
    let response = search.response.generation
    let meaning = search.acceptedMeaningID
    #if !FOTORO_LOCAL_PREVIEW
      let token = searchTaskID
      let hits = searchHits
      let originalServices = services
      let catalog = services?.store
    #endif
    @MainActor func valid() -> Bool {
      guard bestShotsRequest == request, scenePhase == .active, !queryToken.isEmpty,
        query == queryToken, search.libraryGeneration == library,
        search.response.generation == response, search.acceptedMeaningID == meaning else { return false }
      #if !FOTORO_LOCAL_PREVIEW
        return token == searchTaskID && hits == searchHits && services === originalServices
          && services?.store === catalog
      #else
        return true
      #endif
    }
    preparingBestShots = true
    bestShotsTask = Task {
      defer {
        if bestShotsRequest == request { preparingBestShots = false; bestShotsTask = nil }
      }
      do {
        var candidates: [AutomaticPhotoPickCandidate] = []
        #if !FOTORO_LOCAL_PREVIEW
          var saved: [String: LocalPhoto] = [:]
          var previews: [String: FindBestShotsCachedPreview] = [:]
          for hit in hits.prefix(FindBestShotsReview.maximumCandidates) {
            try Task.checkCancellation()
            guard valid() else { throw CancellationError() }
            switch hit.photo {
            case .device(let id):
              guard let photo = search.assets[id] else { throw CancellationError() }
              candidates.append(bestShotsCandidate(photo))
            case .saved(let id):
              guard let originalServices, let catalog,
                let shown = savedResults[id], let current = try originalServices.consumerSavedPhoto(id),
                shown.metadata == current.metadata, shown.manifest == current.manifest else { throw CancellationError() }
              let preview = try await cachedBestShotsPreview(current, root: catalog.root)
              try Task.checkCancellation()
              guard valid() else { throw CancellationError() }
              let annotations = originalServices.annotation(current)
              let revision = try Wire.encode(current.manifest).digest + "|" + Wire.encode(current.metadata).digest
                + "|" + (preview?.revision ?? "unavailable")
              candidates.append(AutomaticPhotoPickCandidate(id: hit.id, sourceRevision: revision,
                capturedAt: ["photos", "exif"].contains(current.metadata.dateSource) ? Wire.parseDate(current.metadata.sourceDate) : nil,
                width: preview?.width ?? 0, height: preview?.height ?? 0,
                favorite: annotations.favorite == true, isScreenshot: annotations.facts?.contains("screenshot") == true))
              saved[hit.id] = current
              previews[hit.id] = preview
            }
            await Task.yield()
          }
          @MainActor func current(_ sources: [AutomaticPhotoPickCandidate]) -> Bool {
            guard valid() else { return false }
            let device = sources.filter { $0.id.hasPrefix("device:") }.map { source in
              var value = source; value.id = String(source.id.dropFirst("device:".count)); return value
            }
            guard device.isEmpty || PhotoPickAnalyzer.isCurrent(device) else { return false }
            for source in sources where source.id.hasPrefix("saved:") {
              guard let originalServices, let captured = saved[source.id],
                let now = try? originalServices.consumerSavedPhoto(captured.id),
                now.metadata == captured.metadata, now.manifest == captured.manifest else { return false }
              let annotations = originalServices.annotation(now)
              guard (annotations.favorite == true) == source.favorite,
                (annotations.facts?.contains("screenshot") == true) == source.isScreenshot,
                previews[source.id]?.isCurrent ?? true else { return false }
            }
            return true
          }
          try Task.checkCancellation()
          guard valid() else { throw CancellationError() }
          bestShots.start(candidates, matchCount: matchCount, preview: { source in
            if source.id.hasPrefix("device:") {
              var device = source; device.id = String(source.id.dropFirst("device:".count))
              return try await PhotoPickAnalyzer.preview(device)
            }
            return try await previews[source.id]?.signals()
          }, isCurrent: current, valid: valid)
        #else
          for photo in matches.prefix(FindBestShotsReview.maximumCandidates) {
            try Task.checkCancellation()
            guard valid() else { throw CancellationError() }
            candidates.append(bestShotsCandidate(photo))
            await Task.yield()
          }
          try Task.checkCancellation()
          guard valid() else { throw CancellationError() }
          bestShots.start(candidates, matchCount: matchCount, preview: { source in
            var device = source; device.id = String(source.id.dropFirst("device:".count))
            return try await PhotoPickAnalyzer.preview(device)
          }, isCurrent: { sources in
            PhotoPickAnalyzer.isCurrent(sources.map { source in
              var device = source; device.id = String(source.id.dropFirst("device:".count)); return device
            })
          }, valid: valid)
        #endif
      } catch is CancellationError {
        if bestShotsRequest == request { cancelBestShots() }
      } catch {
        if bestShotsRequest == request { cancelBestShots(); store.error = error.localizedDescription }
      }
    }
  }
  private func bestShotsCandidate(_ photo: RecentPhoto) -> AutomaticPhotoPickCandidate {
    AutomaticPhotoPickCandidate(id: "device:" + photo.id, sourceRevision: photo.sourceRevision,
      capturedAt: photo.capturedAt, width: photo.asset.pixelWidth, height: photo.asset.pixelHeight,
      favorite: photo.isFavorite, isScreenshot: photo.isScreenshot)
  }
  #if !FOTORO_LOCAL_PREVIEW
  private func cachedBestShotsPreview(_ photo: LocalPhoto, root: URL) async throws -> FindBestShotsCachedPreview? {
    let urls = [("thumbnail", photo.thumbnailURL), ("preview", photo.previewURL)].compactMap { kind, url -> URL? in
      guard let url, url != photo.originalURL,
        photo.manifest.representations.contains(where: { $0.binding.kind == kind && $0.binding.photoId == photo.id }) else { return nil }
      return url
    }
    let worker = Task.detached(priority: .userInitiated) { () -> FindBestShotsCachedPreview? in
      for url in urls {
        guard !Task.isCancelled else { return nil }
        if let preview = FindBestShotsCachedPreview(url: url, root: root) { return preview }
      }
      return nil
    }
    return await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
  }
  #endif
  private var galleryHeader: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(allPhotos ? "Your photos" : "Your picks").font(.title3.weight(.semibold))
        Spacer()
        filterMenu
        selectionToggle
      }
      if !allPhotos {
        if store.picksSnapshot == nil {
          Text("Finding your picks. Showing recent photos for now.")
            .font(.footnote).foregroundStyle(.secondary)
        } else if let missing = store.picksSnapshot?.recommendations.unassessed, missing > 0 {
          Text("Some previews are unavailable. Every original stays in Photos.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
    }.padding(.horizontal, 16).padding(.bottom, 12)
  }
  private var filterMenu: some View {
    Menu {
      Picker("Show", selection: $browseFilter) {
        Text("All").tag(PhotoBrowseFilter.all)
        Text("Favorites").tag(PhotoBrowseFilter.favorites)
        Text("Screenshots").tag(PhotoBrowseFilter.screenshots)
        Text("With a location").tag(PhotoBrowseFilter.withLocation)
      }
      if allPhotos { Toggle("Group by moment", isOn: $groupMoments) }
    } label: {
      Image(systemName: browseFilter == .all ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        .frame(minWidth: 44, minHeight: 44)
    }.accessibilityLabel("Filter photos").accessibilityIdentifier("gallery.filter")
  }
  private var selectionToggle: some View {
    Button(selecting ? "Done" : "Select") { selecting.toggle(); queryFocused = false }
      .frame(minHeight: 44).disabled(preparingShare)
      .accessibilityIdentifier("gallery.select")
  }
  private var gallery: some View {
    let current = Dictionary(baseHomePhotos.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
      ForEach(homeGroups) { group in
        Section {
          ForEach(group.sources, id: \.id) { source in
            if let photo = current[source.id], photo.sourceRevision == source.revision {
        RecentPhotoCell(photo: photo, store: store, selected: selected.contains(photo.id), open: {
          if selecting { toggleSelection(photo) } else { openViewer(photo) }
        }, toggle: { toggleSelection(photo) })
          .onAppear { loadMoreDevicePhotos(after: photo.id) }
            }
          }
        } header: {
          if allPhotos {
            HStack {
              Text(group.start?.formatted(date: .abbreviated, time: .omitted) ?? "Date unavailable")
              if groupMoments, let start = group.start { Text(start.formatted(date: .omitted, time: .shortened)).foregroundStyle(.secondary) }
              Spacer()
            }.font(.subheadline).padding(.horizontal).padding(.vertical, 12)
          }
        }
      }
    }.scrollTargetLayout()
  }
  private var homeHeader: some View {
    VStack(spacing: 14) {
      HStack {
        Text("Fotoro").font(.system(.largeTitle, design: .rounded, weight: .bold))
        Spacer()
#if !FOTORO_LOCAL_PREVIEW
        Button("Sync", systemImage: services?.automaticPhotoSync.enabled == true ? "icloud.fill" : "icloud") { openPhotoSync() }
          .labelStyle(.iconOnly).font(.title3).frame(width: 44, height: 44)
          .background(.white.opacity(0.12), in: .circle).foregroundStyle(.white)
          .accessibilityIdentifier("home.sync")
#endif
        Button("Settings", systemImage: "gearshape") { queryFocused = false; settings = true }
          .labelStyle(.iconOnly).font(.title3).frame(width: 44, height: 44)
          .background(.white.opacity(0.12), in: .circle).foregroundStyle(.white)
          .accessibilityIdentifier("home.settings")
      }
      HStack(spacing: 12) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Search photos", text: $query).focused($queryFocused)
          .submitLabel(.search).onSubmit { queryFocused = false }
          .disabled(!canSearch).accessibilityIdentifier("find.query")
          .accessibilityHint("Find labels, dates and words in your photos")
        if !query.isEmpty {
          Button("Clear search", systemImage: "xmark.circle.fill") { query = ""; queryFocused = false }
            .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
        }
      }.padding(.leading, 16).padding(.trailing, 8).frame(minHeight: 48)
        .background(.white.opacity(0.10), in: .rect(cornerRadius: 16))
      VStack(alignment: .leading, spacing: 6) {
        Picker("Photo library", selection: $scope) {
          ForEach(PhotoHomeScope.allCases) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).accessibilityIdentifier("home.scope")
        Text(scope.hint).font(.footnote).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("home.scopeDescription")
      }
      #if !FOTORO_LOCAL_PREVIEW
        if let services { ConsumerSaveStatus(services: services) }
      #endif
    }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 18)
  }
  private var selectionTray: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) {
        selectionSummary
        Spacer(minLength: 0)
        selectionActions
      }
      VStack(alignment: .leading, spacing: 8) {
        selectionSummary
        HStack(spacing: 12) { selectionActions; Spacer(minLength: 0) }
      }
      VStack(alignment: .leading, spacing: 8) {
        selectionSummary
        selectionActions
      }
    }.padding(14).background(.regularMaterial, in: .rect(cornerRadius: 24))
      .padding(.horizontal, 12).padding(.bottom, 8)
  }
  private var selectionSummary: some View {
    Text(selectedCount == 0 ? "Select photos" : "\(selectedCount) selected")
      .font(.subheadline).monospacedDigit()
  }
  @ViewBuilder private var selectionActions: some View {
    Button("Clear") {
      selectedPhotos = [:]
      #if !FOTORO_LOCAL_PREVIEW
        selectedSavedPhotos.removeAll()
      #endif
    }.buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(selectedCount == 0 || preparingShare)
      .accessibilityIdentifier("selection.clear")
    #if !FOTORO_LOCAL_PREVIEW
    Button(selected.isEmpty && selectedSavedPhotos.count > 0 ? "Saved" : "Save", systemImage: "icloud.and.arrow.up") {
      reviewSave(selectedPhotos.values.map(\.source).sorted { $0.id < $1.id })
    }.buttonStyle(.borderedProminent).fixedSize(horizontal: true, vertical: false).accessibilityIdentifier("selection.save")
      .disabled(selected.isEmpty || preparingShare || showShare)
    if selectedSavedPhotos.count > 0 && !selected.isEmpty {
      Menu("Share", systemImage: "square.and.arrow.up") {
        Button("Share \(selected.count) originals") { shareSelectedDevicePhotos() }
        Button("Share \(selectedSavedPhotos.count) in Fotoro") { shareSelectedSavedPhotos() }
      }.buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(preparingShare || showShare)
    } else if selectedSavedPhotos.count > 0 {
      Button("Share", systemImage: "square.and.arrow.up", action: shareSelectedSavedPhotos)
        .buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(preparingShare || showShare)
    } else {
      Button("Share", systemImage: "square.and.arrow.up", action: shareSelectedDevicePhotos)
        .buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(selected.isEmpty || preparingShare || showShare)
    }
    #else
    Button("Share", systemImage: "square.and.arrow.up", action: shareSelectedDevicePhotos)
      .buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(selected.isEmpty || preparingShare || showShare)
    #endif
  }
  private func shareSelectedDevicePhotos() {
    share(selectedPhotos.values.map(\.photo).sorted { ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast) })
  }
  private func loadMoreDevicePhotos(after id: String) {
    guard allPhotos, store.hasMorePhotos,
      let index = store.photos.firstIndex(where: { $0.id == id }), index >= max(0, store.photos.count - 20) else { return }
    store.loadMorePhotos()
  }
  private var saveFromViewer: ((RecentPhoto) -> Void)? {
#if FOTORO_LOCAL_PREVIEW
    nil
#else
    { photo in pendingSavePhoto = photo; viewer = nil }
#endif
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
          if let services {
            AccountIdentityView(session: services.session, unlocked: services.vault.isUnlocked)
          }
          Button(services?.automaticPhotoSync.enabled == true ? "Sync settings" : "Turn on sync", systemImage: "icloud.and.arrow.up") {
            pendingPhotoSync = true; settings = false
          }.accessibilityIdentifier("settings.sync")
          Button("Saved photos") { pendingBackup = true; settings = false }
          if let services {
            if services.auth.hasSavedPassword {
              Button("Open on another device", systemImage: "laptopcomputer.and.iphone") {
                do { savedPassword = FotoroPassword(value: try services.auth.savedPassword()) }
                catch { services.error = error.localizedDescription }
              }.accessibilityIdentifier("account.otherDevice")
            }
            if !services.session.isSignedIn || !services.vault.isUnlocked {
              Button("Open Fotoro") { pendingBackup = true; settings = false }.disabled(services.busy)
            }
            if services.session.accountId != nil {
              Button("Sign out", role: .destructive) { signingOut = true }.disabled(services.busy)
            }
            if let error = services.error { Text(error).foregroundStyle(.red) }
          }
#endif
        }
        Section("Photos access") {
          Button("Refresh photos") { restorePhotos(); settings = false }
          if store.status == .limited { Button("Manage selected photos") { settings = false; addPhotos() } }
          Button("Open system settings", action: openSettings)
        }
        Section { Text(buildDescription).font(.caption).foregroundStyle(.secondary) }
      }.navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { settings = false } } }
#if !FOTORO_LOCAL_PREVIEW
        .sheet(item: $savedPassword) { FotoroPasswordView(password: $0) }
        .onChange(of: services?.vault.isUnlocked) { _, unlocked in
          if unlocked != true { savedPassword = nil }
        }
        .onDisappear { savedPassword = nil }
        .alert("Sign out?", isPresented: $signingOut) {
          Button("Sign out", role: .destructive) {
            services?.run { try services?.signOut(discardPending: true) }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("Unfinished uploads and unsent edits will be removed from this iPhone. Your Photos library and photos saved to Fotoro stay.")
        }
#endif
    }
  }
  private var buildDescription: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
#if FOTORO_LOCAL_PREVIEW
    return "Local-only beta · \(version) (\(build))"
#else
    return "Fotoro · \(version) (\(build))"
#endif
  }
  private func validatePhotosPresentation() {
    let selection = selectedPhotos.values.map(\.source)
    let pending = pendingShare.map { [RecentPhotoSource($0)] } ?? []
    let validation = store.validatePresentation(viewer: viewer?.sources ?? [], selection: selection,
      share: shareSources + pending)
    let previousCount = selectedPhotos.count
    selectedPhotos = selectedPhotos.filter { validation.selectedIDs.contains($0.key) }
    if previousCount > selectedPhotos.count {
      store.error = "Some selected photos changed or are no longer available."
    }
    if !validation.shareIsCurrent {
      pendingShare = nil
      shareTask?.cancel()
      cleanupShare()
    }
    if !validation.viewerIsCurrent { viewer = nil }
#if !FOTORO_LOCAL_PREVIEW
    if let photo = pendingSavePhoto,
      !store.validatePresentation(viewer: [], selection: [], share: [RecentPhotoSource(photo)]).shareIsCurrent {
      pendingSavePhoto = nil
    }
#endif
  }
  private func restorePhotos() {
    store.restoreAccess()
    validatePhotosPresentation()
#if !FOTORO_LOCAL_PREVIEW
    validateSavedPresentation()
#endif
    if RecentPhotosPolicy.canRead(store.status) { search.open(status: store.status) }
    else { search.auditAuthorization() }
  }
#if !FOTORO_LOCAL_PREVIEW
  private func validateSavedPresentation() {
    if let services {
      let previousCount = selectedSavedPhotos.count
      selectedSavedPhotos.removeWithdrawn(using: services.consumerSavedPhoto)
      if services.vault.isUnlocked, previousCount > selectedSavedPhotos.count {
        store.error = "Some selected photos changed or are no longer available."
      }
    }
    guard let presentation = savedViewer else { return }
    guard let services, SavedPhotosPresentationPolicy.isCurrent(presentation.photos, lookup: services.consumerSavedPhoto) else {
      savedViewer = nil
      return
    }
  }
  private func openBackup() {
    presentAccount()
  }
  private func openPhotoSync() {
    queryFocused = false
    do {
      if services == nil { services = try AppServices() }
      services?.bindLocalSearch(search)
      services?.bindRecentPhotos(store)
      services?.setPhotoSyncForeground(scenePhase == .active)
      if let services { photoSyncPresentation = PhotoSyncPresentation(services: services) }
    } catch { store.error = error.localizedDescription }
  }
  private func reviewSave(_ sources: [RecentPhotoSource]) {
    guard !sources.isEmpty else { return }
    let validation = store.validatePresentation(viewer: [], selection: sources, share: [])
    guard validation.selectedIDs.count == sources.count else {
      store.error = "Some selected photos changed or are no longer available. Select them again."
      return
    }
    presentAccount(selection: sources)
  }
  private func presentAccount(selection: [RecentPhotoSource]? = nil) {
    queryFocused = false
    do {
      if services == nil { services = try AppServices() }
      services?.bindLocalSearch(search)
      services?.bindRecentPhotos(store)
      if let services { backupAccount = PhotosAccountPresentation(services: services, selection: selection) }
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
      guard !Task.isCancelled, token == searchTaskID else { return }
      searchHits = []
      savedResults = [:]
      store.error = error.localizedDescription
    }
  }
#endif
  private func openViewer(_ photo: RecentPhoto) {
    viewer = RecentPhotoViewerPresentation(initial: photo, photos: visible)
  }
  private func toggleSelection(_ photo: RecentPhoto) {
    selecting = true
    if selectedPhotos.removeValue(forKey: photo.id) == nil { selectedPhotos[photo.id] = SelectedRecentPhoto(photo) }
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
    let sources = photos.map(RecentPhotoSource.init)
    shareSources = sources
    shareTask = Task {
      defer { preparingShare = false; shareTask = nil; if !showShare { shareSources = [] } }
      var exported: [URL] = []
      do {
        exported = try await store.shareOriginals(photos)
        try Task.checkCancellation()
        guard store.validatePresentation(viewer: [], selection: [], share: sources).shareIsCurrent else { throw CancellationError() }
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
    shareSources = []
  }
}

#if !FOTORO_LOCAL_PREVIEW
enum SavedPhotosPresentationPolicy {
  static func isCurrent(_ photos: [LocalPhoto], lookup: (String) throws -> LocalPhoto?) -> Bool {
    photos.allSatisfy { photo in
      guard let current = try? lookup(photo.id) else { return false }
      return current.metadata == photo.metadata && current.manifest == photo.manifest
    }
  }
}

struct ConsumerSearchPresentationID: Equatable {
  var query: String
  var library: UInt64
  var results: [SearchHit]
  var indexed: Int
  var response: UInt64
  var acceptedMeaning: String?
  var catalog: UInt64?
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
      .accessibilityValue(selected ? "Selected" : "")
      .onAppear { store.cache([photo.asset], start: true) }
      .onDisappear { store.cache([photo.asset], start: false) }
      .contextMenu { Button(selected ? "Deselect" : "Select", action: toggle) }
  }
}
