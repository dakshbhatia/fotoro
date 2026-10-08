import Photos
import PhotosUI
import SwiftUI
import UIKit
#if !FOTORO_LOCAL_PREVIEW
import AVKit
#endif

struct PhotosImage: View {
  let photo: RecentPhoto
  let store: RecentPhotosStore
  var large = false
  var networkAllowed = true
  @State private var image: UIImage?
  @State private var request: PHImageRequestID?
  @State private var generation = UUID()
  @State private var active = false
  @State private var progress = PhotoPreviewProgress()
  @State private var retry = 0
  @Environment(\.displayScale) private var displayScale
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable()
      } else {
        Rectangle().fill(.quaternary).overlay {
          if !progress.unavailable { ProgressView() }
        }
      }
    }
    .overlay(alignment: large ? .bottom : .center) {
      if progress.unavailable {
        VStack(spacing: 8) {
          Label("Preview unavailable", systemImage: "icloud.slash").font(.caption)
          if large {
            Button("Try again") {
              guard store.validatePresentation(viewer: [RecentPhotoSource(photo)], selection: [], share: []).viewerIsCurrent else { return }
              retry += 1
            }.accessibilityIdentifier("photo.preview.retry")
          }
        }.padding(8).background(.regularMaterial, in: .rect(cornerRadius: 12)).padding(large ? 16 : 4)
      }
    }
    .task(id: photo.id + "|" + photo.sourceRevision + "|\(retry)") {
      if let request { store.images.cancelImageRequest(request) }
      image = nil
      progress = PhotoPreviewProgress()
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
        let cancelled = (info?[PHImageCancelledKey] as? Bool) == true
        let failed = info?[PHImageErrorKey] != nil
        Task { @MainActor in
          guard active, generation == token else { return }
          let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
          if progress.receive(hasImage: value != nil, degraded: degraded, cancelled: cancelled, failed: failed) { image = value }
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

struct PhotoViewerStillInteraction: ViewModifier {
  @Binding var zoom: PhotoViewerZoom
  @Binding var controlsVisible: Bool
  let isCurrent: Bool
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  func body(content: Content) -> some View {
    GeometryReader { geometry in
      content.frame(width: geometry.size.width, height: geometry.size.height)
        .scaleEffect(zoom.scale).offset(zoom.offset)
        .highPriorityGesture(DragGesture()
          .onChanged { zoom.drag($0.translation, viewport: geometry.size) }
          .onEnded { zoom.settleDrag($0.translation, viewport: geometry.size) },
          including: zoom.scale > 1 ? .all : .none)
        .simultaneousGesture(MagnifyGesture()
          .onChanged { zoom.change($0.magnification); zoom.constrain(to: geometry.size) }
          .onEnded { zoom.settle($0.magnification); zoom.constrain(to: geometry.size) })
        .onTapGesture(count: 2) { zoom.toggle() }
        .onTapGesture { if !voiceOver { controlsVisible.toggle() } }
        .onChange(of: geometry.size) { if isCurrent { zoom.constrain(to: geometry.size) } }
        .onChange(of: voiceOver) { if isCurrent, voiceOver { controlsVisible = true } }
    }.clipped()
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
              #if !FOTORO_LOCAL_PREVIEW
              if photo.isVideo || photo.isLivePhoto {
                RecentMotionPhotoPage(photo: photo, store: store, isCurrent: photo.id == selected)
              } else {
                PhotosImage(photo: photo, store: store, large: true).scaledToFit()
                  .modifier(PhotoViewerStillInteraction(zoom: $zoom, controlsVisible: $controlsVisible, isCurrent: photo.id == selected))
              }
              #else
              PhotosImage(photo: photo, store: store, large: true).scaledToFit()
                .modifier(PhotoViewerStillInteraction(zoom: $zoom, controlsVisible: $controlsVisible, isCurrent: photo.id == selected))
              #endif
            } else {
              Color.black
            }
          }
          .tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black)
        .ignoresSafeArea(.container)
        .onChange(of: selected) { zoom.reset(); controlsVisible = true }
        .accessibilityAction(named: "Next photo") { movePage(forward: true) }
        .accessibilityAction(named: "Previous photo") { movePage(forward: false) }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          if current.map({ !$0.isVideo && !$0.isLivePhoto }) == true {
            ToolbarItem(placement: .topBarTrailing) {
              Button(zoom.scale == 1 ? "Zoom in" : "Reset zoom", systemImage: "plus.magnifyingglass") { zoom.toggle() }
                .accessibilityIdentifier("photo.zoom")
            }
          }
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
  private func movePage(forward: Bool) {
    if let id = RecentPhotosPolicy.adjacentPhotoID(photos.map(\.id), current: selected, forward: forward) { selected = id }
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
  let savedRefresh: SavedLibraryRefresh
  let requiresAuthentication: Bool
  var startAutomaticSync = false
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
  case photos = "Photos", picks = "Picks"
  #if !FOTORO_LOCAL_PREVIEW
    case saved = "Saved"
  #endif
  var id: String { rawValue }
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
  @State private var pendingPhotoSync: Bool?
  @State private var searchHits: [ConsumerSearchHit] = []
  @State private var searchCompletion = ConsumerSearchCompletion()
  @State private var searchAttempt: UInt64 = 0
  @State private var savedResults: [String: LocalPhoto] = [:]
  @State private var savedViewer: SavedPhotoViewerPresentation?
  @State private var pendingBackup = false
  @State private var pendingSavePhoto: RecentPhoto?
  @State private var savedPassword: FotoroPassword?
  @State private var signingOut = false
  @State private var homeAuthenticationTask: Task<Void, Never>?
  @State private var selectedSavedPhotos = SavedPhotoSelection()
  @State private var sharedSavedPhotos: SharedPhotosPresentation?
  @State private var albumPresentation: NativeAlbumPresentation?
  @State private var savedShareSources: [LocalPhoto] = []
  @State private var savedShareBinding: SavedLibraryOpenBinding?
  @State private var savedShareExports: [URL] = []
  @State private var deviceShareExports: [URL] = []
  @State private var savedRefresh = SavedLibraryRefresh()
  @State private var savedHasMore = true
  @State private var savedFavoritesOnly = false
  @State private var savedScrollID: String?
#endif
  @State private var selectedPhotos: [String: SelectedRecentPhoto] = [:]
  @State private var selecting = false
  @State private var scope = PhotoHomeScope.photos
  @State private var browseScrollIDs: [PhotoHomeScope: String] = [:]
  @State private var browseFilter = PhotoBrowseFilter.all
  @State private var browseDates = PhotoBrowseDateScope.recent
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
  @State private var places: PhotoPlacesPresentation?
  #if !FOTORO_LOCAL_PREVIEW
  @State private var people: PhotoPeoplePresentation?
  #endif
  @State private var pendingPlace: PhotoPlaceItem?
  @Environment(\.scenePhase) private var scenePhase

  private var allPhotos: Bool { scope == .photos }
  private var hasBrowseAccess: Bool {
    #if FOTORO_LOCAL_PREVIEW
      RecentPhotosPolicy.canRead(store.status)
    #else
      RecentPhotosPolicy.canRead(store.status) || services?.photoAccountAccess != nil
    #endif
  }
  private var hasSelectablePhotos: Bool {
    if selecting || selectedCount > 0 { return true }
    #if !FOTORO_LOCAL_PREVIEW
      if search.hasSearch { return !currentSearchHits.isEmpty }
      if query.isEmpty, scope == .saved { return !ownedPhotos.isEmpty }
      if query.isEmpty, allPhotos { return !timelineGroups.isEmpty }
      if !savedPhotos.isEmpty { return true }
    #endif
    return !visible.isEmpty
  }
  private var homeFilterIsActive: Bool {
    if !search.peopleSelection.isEmpty { return true }
    guard query.isEmpty else { return false }
    #if !FOTORO_LOCAL_PREVIEW
      if scope == .saved { return savedFavoritesOnly }
    #endif
    return browseFilter != .all
  }
  private var baseHomePhotos: [RecentPhoto] {
    if allPhotos { return store.photos }
    return store.picksSnapshot == nil ? store.recentPhotos : store.pickedPhotos
  }
  private var homeGroups: [PhotoBrowseGroup] {
    PhotoBrowsing.groups(baseHomePhotos.map { photo in
      PhotoBrowseItem(source: RecentPhotoSource(photo), facts: RecentPhotoFacts(
        capturedAt: photo.capturedAt, favorite: photo.isFavorite, screenshot: photo.isScreenshot,
        livePhoto: photo.isLivePhoto, location: photo.location))
    }, filter: browseFilter, grouping: groupMoments ? .moments : .days, dates: browseDates)
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
    currentSearchHits.compactMap {
      if case .device(let id) = $0.photo { return search.assets[id] }
      return nil
    }
#endif
  }
  private var visible: [RecentPhoto] {
    guard search.hasSearch else { return homePhotos }
    guard let result = bestShots.snapshot else { return searchPhotos }
    return searchPhotos.filter { result.recommendations.ids.contains("device:" + $0.id) }
  }
  private var searchMatchCount: Int {
    #if FOTORO_LOCAL_PREVIEW
      searchPhotos.count
    #else
      currentSearchHits.count
    #endif
  }
#if !FOTORO_LOCAL_PREVIEW
  private var currentSearchHits: [ConsumerSearchHit] {
    guard searchCompletion.permitsResults(for: searchTaskID) else { return [] }
    return searchHits
  }
  private var savedPhotos: [LocalPhoto] {
    currentSearchHits.filter { bestShots.snapshot?.recommendations.ids.contains($0.id) ?? true }.compactMap {
      if case .saved(let id) = $0.photo { return savedResults[id] }
      return nil
    }
  }
  private var selectedReferences: Set<ConsumerPhotoReference> {
    Set(selected.map(ConsumerPhotoReference.device) + selectedSavedPhotos.ids.map(ConsumerPhotoReference.saved))
  }
  private var ownedPhotos: [LocalPhoto] {
    allOwnedPhotos.filter { !savedFavoritesOnly || services?.annotation($0).favorite == true }
  }
  private var allOwnedPhotos: [LocalPhoto] {
    guard let services, services.photoAccountAccess != nil else { return [] }
    return services.photos.filter {
      $0.manifest.ownerAccountId == services.session.accountId && ["committed", "saved"].contains($0.transferState)
    }
  }
  private var timelineGroups: [PhotoBrowseGroup] {
    let device = baseHomePhotos.map { photo in
      PhotoBrowseItem(source: RecentPhotoSource(photo), facts: RecentPhotoFacts(
        capturedAt: photo.capturedAt, favorite: photo.isFavorite, screenshot: photo.isScreenshot,
        livePhoto: photo.isLivePhoto, location: photo.location))
    }
    let saved = allOwnedPhotos.map { photo in
      let annotation = services?.annotation(photo)
      return PhotoTimelineSavedItem(photo: photo, facts: RecentPhotoFacts(
        capturedAt: Wire.parseDate(photo.metadata.sourceDate), favorite: annotation?.favorite == true,
        screenshot: annotation?.facts?.contains("screenshot") == true,
        livePhoto: photo.metadata.mediaType == CameraMedia.liveType, location: annotation?.location?.displayName))
    }
    return PhotoTimelinePolicy.groups(device: device, saved: saved,
      sources: (try? services?.store.backupSources()) ?? [],
      account: services?.photoAccountAccess?.account, filter: browseFilter,
      grouping: groupMoments ? .moments : .days, dates: browseDates)
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
          if savedRefresh.isRefreshing, ownedPhotos.isEmpty { ProgressView().padding(.bottom, 12) }
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
              description: Text(savedLibraryEmptyMessage(sync: services.automaticPhotoSync,
                favoritesOnly: savedFavoritesOnly)))
          }
        }.scrollPosition(id: $savedScrollID, anchor: .top).scrollDismissesKeyboard(.interactively)
          .refreshable { await savedRefresh.refresh(services) }
          .task(id: SavedLibraryReadPresentation(services, isActive: scenePhase == .active)) {
            guard !Task.isCancelled else { return }
            guard scenePhase == .active else { savedRefresh.cancel(); return }
            await savedRefresh.open(services, recheck: true)
          }
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
  private var searchTaskID: ConsumerSearchPresentationID {
    ConsumerSearchPresentationID(query: query, library: search.libraryGeneration,
      results: search.response.results, indexed: search.response.indexed,
      response: search.response.generation, acceptedMeaning: search.acceptedMeaningID,
      catalog: services?.consumerCatalogGeneration,
      account: services?.session.accountId, vault: services?.vault.generation, people: search.peopleSelection)
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
      .fullScreenCover(item: $savedViewer) { presentation in
        if let services { PhotoViewer(services: services, initialID: presentation.initial.id, displayedPhotos: presentation.photos) }
      }
      .sheet(item: $sharedSavedPhotos) { presentation in
        if let services { ExchangeView(services: services, selected: presentation.photos) }
      }
      .sheet(item: $albumPresentation) { presentation in
        if let services { NativeAlbumView(services: services, selected: presentation.selected, incoming: presentation.incoming) }
      }
      .sheet(item: $backupAccount) {
        LibraryView(services: $0.services, saveSelection: $0.selection, incomingLink: $0.incoming)
      }
      .sheet(item: $photoSyncPresentation) {
        PhotoSyncView(services: $0.services, savedRefresh: $0.savedRefresh, requiresAuthentication: $0.requiresAuthentication,
          startAutomaticSync: $0.startAutomaticSync, openSaved: { query = ""; scope = .saved })
      }
      .onOpenURL { url in
        do {
          if url.fragment?.hasPrefix("album=") == true {
            let incoming = try NativeAlbumLinks.parse(url, origin: services?.api.origin ?? FotoroShareLinks.origin)
            openAlbums(incoming: incoming)
            return
          }
          let incoming = try FotoroShareLinks.parse(url, expectedOrigin: services?.api.origin ?? FotoroShareLinks.origin)
          if services == nil { services = try AppServices() }
          services?.bindLocalSearch(search); services?.bindRecentPhotos(store)
          queryFocused = false; pendingShare = nil; shareTask?.cancel(); cleanupShare()
          settings = false; viewer = nil; savedViewer = nil
          photoSyncPresentation = nil
          if let services { backupAccount = PhotosAccountPresentation(services: services, selection: nil, incoming: incoming) }
        } catch { store.error = error.localizedDescription }
      }
      .task(id: ConsumerSearchRequestID(presentation: searchTaskID, attempt: searchAttempt)) { await updateSearch() }
      .onChange(of: services?.consumerCatalogGeneration) {
        savedHasMore = true
        cancelBestShots(); validateSavedPresentation()
      }
      .onChange(of: services?.session.accountId) {
        cancelBestShots()
        if !savedShareSources.isEmpty { shareTask?.cancel(); cleanupShare() }
      }
      .onChange(of: searchHits) { cancelBestShots() }
      .onChange(of: services?.vault.generation) {
        savedHasMore = true
        cancelBestShots()
        store.restartAnalysis()
        savedViewer = nil
        selectedSavedPhotos.removeAll()
        sharedSavedPhotos = nil
        if !savedShareSources.isEmpty { shareTask?.cancel(); cleanupShare() }
        searchHits.removeAll { if case .saved = $0.photo { return true }; return false }
        savedResults = [:]
      }
  }
#endif
  private var sharedHome: some View {
    homeSearchContent.background(.black).preferredColorScheme(.dark)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(showsHomeNavigation ? .visible : .hidden, for: .navigationBar)
        .toolbar {
          if showsHomeNavigation {
            ToolbarItem(placement: .topBarLeading) { homeScopeMenu }
            #if !FOTORO_LOCAL_PREVIEW
              ToolbarItem(placement: .topBarTrailing) { homeSyncButton }
            #endif
          }
          if canSearch || search.hasSearch {
            DefaultToolbarItem(kind: .search, placement: .bottomBar)
          }
        }
        .safeAreaInset(edge: .bottom) { if selectedCount > 0 { selectionTray } }
        .overlay {
          if preparingShare { ProgressView("Preparing original…").padding().glassEffect() }
        }
        .fullScreenCover(item: $viewer, onDismiss: {
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
          else if let start = pendingPhotoSync { pendingPhotoSync = nil; openPhotoSync(startAutomaticSync: start) }
#endif
        }) { settingsView }
        .sheet(item: $places, onDismiss: openPendingPlace) { _ in
          #if FOTORO_LOCAL_PREVIEW
          PhotoPlacesView(store: store, search: search, open: { pendingPlace = $0 })
          #else
          PhotoPlacesView(store: store, search: search, services: services, open: { pendingPlace = $0 })
          #endif
        }
        #if !FOTORO_LOCAL_PREVIEW
        .sheet(item: $people) { _ in PhotoPeopleView(search: search, services: services, findPhotos: { queryFocused = false }) }
        #endif
        .onChange(of: query) { cancelBestShots(); search.updateQuery(query) }
        .onChange(of: search.response.generation) { cancelBestShots() }
        .onChange(of: search.acceptedMeaningID) { cancelBestShots() }
        .onChange(of: search.peopleSelection) { cancelBestShots() }
        .onChange(of: store.status) { cancelBestShots() }
        .onChange(of: browseDates) {
          cancelBestShots()
          browseScrollIDs = [:]
          store.setBrowseDates(browseDates)
        }
        .onChange(of: scope) {
          cancelBestShots()
          queryFocused = false
          #if !FOTORO_LOCAL_PREVIEW
            homeAuthenticationTask?.cancel(); homeAuthenticationTask = nil; savedRefresh.cancel()
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
              shareTask?.cancel(); cleanupShare()
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
    if scope == .saved && !search.hasSearch {
      savedContent
    } else {
      deviceContent
    }
    #else
      deviceContent
    #endif
  }
  @ViewBuilder private var deviceContent: some View {
    let mode = contentMode
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
        #if !FOTORO_LOCAL_PREVIEW
          if !hasBrowseAccess {
            Button("Open Saved photos", systemImage: "icloud") { scope = .saved }
              .accessibilityIdentifier("home.saved")
          }
        #endif
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
      } actions: {
        Button("Open Settings", action: openSettings)
        #if !FOTORO_LOCAL_PREVIEW
          if !hasBrowseAccess {
            Button("Open Saved photos", systemImage: "icloud") { scope = .saved }
              .accessibilityIdentifier("home.saved")
          }
        #endif
      }
    } else {
      ScrollView {
        if mode == .search {
          bestShotsControls
#if FOTORO_LOCAL_PREVIEW
          LocalSearchView(search: search, photos: store, review: bestShots.snapshot, choseMeaning: { queryFocused = false },
            selectedIDs: selected, selecting: selecting, toggleSelection: toggleSelection) {
            queryFocused = false
            openViewer($0)
          }
#else
          ConsumerSearchResultsView(hits: currentSearchHits, saved: savedResults, search: search, photos: store,
            searchPending: searchCompletion.isPending(searchTaskID),
            searchFailure: searchCompletion.failure(for: searchTaskID),
            searchFinished: searchCompletion.hasCompleted(searchTaskID),
            retrySearch: { search.error = nil; search.updateQuery(query); searchAttempt &+= 1 }, review: bestShots.snapshot,
            selected: selectedReferences, selecting: selecting,
            toggleDevice: toggleSelection, toggleSaved: toggleSavedSelection,
            inspectDevice: { queryFocused = false; openViewer($0) },
            inspectSaved: { photo in
              queryFocused = false
              savedViewer = SavedPhotoViewerPresentation(initial: photo, photos: savedPhotos)
            },
            choseAlternative: { queryFocused = false },
            editPeople: { queryFocused = false; people = PhotoPeoplePresentation() }, selectResults: selectSearchResults)
#endif
        } else {
          #if !FOTORO_LOCAL_PREVIEW
            if allPhotos { timelineFeedback }
          #endif
          gallery
          if allPhotos, browseDates == .recent, browseGalleryIsEmpty, !hasMoreBrowsePhotos {
            ContentUnavailableView {
              Label(browseFilter == .all ? "No photos in the last 30 days" : "No matching photos in the last 30 days", systemImage: "photo")
            } description: {
              Text("Check older photos and photos without capture dates.")
            } actions: {
              Button("Show all dates") { browseDates = .all }
                .accessibilityIdentifier("gallery.allDates")
            }
          } else if browseLibraryIsEmpty && !hasMoreBrowsePhotos {
            ContentUnavailableView("No photos", systemImage: "photo", description: Text("Choose photos Fotoro may access in Settings."))
          } else if browseFilter != .all, browseGalleryIsEmpty, !hasMoreBrowsePhotos {
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
      #if !FOTORO_LOCAL_PREVIEW
        .refreshable {
          if allPhotos, let services { await savedRefresh.refresh(services) }
        }
        .task(id: timelineReadPresentation) {
          guard allPhotos, query.isEmpty, scenePhase == .active, let services,
            services.photoAccountAccess != nil else { return }
          await savedRefresh.open(services, recheck: true)
        }
      #endif
    }
  }
  private var contentMode: RecentPhotosContentMode {
    if search.hasSearch { return .search }
    #if !FOTORO_LOCAL_PREVIEW
      if query.isEmpty, allPhotos, services?.photoAccountAccess != nil { return .gallery }
    #endif
    return RecentPhotosContentMode.select(query: query, opened: store.opened, status: store.status)
  }
  private var browseLibraryIsEmpty: Bool {
    #if !FOTORO_LOCAL_PREVIEW
      if allPhotos { return store.photos.isEmpty && allOwnedPhotos.isEmpty && !savedRefresh.isRefreshing }
    #endif
    return store.photos.isEmpty
  }
  private var browseGalleryIsEmpty: Bool {
    #if !FOTORO_LOCAL_PREVIEW
      if allPhotos { return timelineGroups.isEmpty }
    #endif
      return homePhotos.isEmpty
  }
  private var hasMoreBrowsePhotos: Bool {
    guard allPhotos else { return false }
    #if !FOTORO_LOCAL_PREVIEW
      return store.hasMorePhotos || (savedHasMore && services?.photoAccountAccess != nil)
    #else
      return store.hasMorePhotos
    #endif
  }
  #if !FOTORO_LOCAL_PREVIEW
    private var timelineReadPresentation: SavedLibraryReadPresentation? {
      guard let services, services.photoAccountAccess != nil else { return nil }
      return SavedLibraryReadPresentation(services, isActive: allPhotos && query.isEmpty && scenePhase == .active)
    }
    @ViewBuilder private var timelineFeedback: some View {
      if !RecentPhotosPolicy.canRead(store.status) {
        HStack {
          Text("Add photos from this iPhone").font(.footnote).foregroundStyle(.secondary)
          Spacer()
          if store.status == .notDetermined {
            Button("Open Photos") { Task { await store.open(); search.open(status: store.status) } }
          } else {
            Button("Open Settings", action: openSettings)
          }
        }.padding(.horizontal, 16).padding(.vertical, 10)
      }
      if savedRefresh.isRefreshing, store.photos.isEmpty, allOwnedPhotos.isEmpty { ProgressView().padding() }
    }
  #endif
  private var browseScrollBinding: Binding<String?> {
    Binding(get: { !search.hasSearch ? browseScrollIDs[scope] : nil }, set: {
      if !search.hasSearch { browseScrollIDs[scope] = $0 }
    })
  }
  private var bestShotsControls: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        if bestShots.showing || preparingBestShots {
          Button("All matches", action: cancelBestShots)
            .accessibilityIdentifier("find.allMatches")
        } else {
          Button("Best shots", systemImage: "sparkles", action: beginBestShots)
            .disabled(searchMatchCount == 0 || preparingShare)
            .accessibilityIdentifier("find.bestShots")
        }
        Spacer(minLength: 0)
        if hasSelectablePhotos { selectionToggle }
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
        if !result.recommendations.ids.isEmpty {
          Button("Select best shots", action: selectBestShots)
            .buttonStyle(.borderedProminent).disabled(preparingShare || showShare)
            .accessibilityIdentifier("find.selectBestShots")
        }
      }
      if let error = bestShots.error {
        Text(error).font(.caption).foregroundStyle(.secondary)
        Button("Try again", action: beginBestShots)
      }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 12)
  }
  private func selectBestShots() {
    guard !preparingShare, !showShare, scenePhase == .active else { return }
    let recommendations = bestShots.selectionCandidates()
    guard !recommendations.isEmpty else { return }
    let revisions = Dictionary(recommendations.map { ($0.id, $0.sourceRevision) }, uniquingKeysWith: { _, last in last })
    queryFocused = false
    for photo in searchPhotos where revisions["device:" + photo.id] == photo.sourceRevision && !selected.contains(photo.id) {
      toggleSelection(photo)
    }
    #if !FOTORO_LOCAL_PREVIEW
      for photo in savedPhotos where revisions["saved:" + photo.id] != nil && !selectedSavedPhotos.contains(photo.id) {
        toggleSavedSelection(photo)
      }
    #endif
    selecting = true
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
      guard bestShotsRequest == request, scenePhase == .active, search.hasSearch,
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
              try await originalServices.ensurePreview(current)
              guard let withPreview = try originalServices.consumerSavedPhoto(id) else { throw CancellationError() }
              let preview = try await cachedBestShotsPreview(withPreview, root: catalog.root)
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
  private var selectionToggle: some View {
    Button(selecting ? "Done" : "Select") { selecting.toggle(); queryFocused = false }
      .frame(minHeight: 44).disabled(preparingShare)
      .accessibilityIdentifier("gallery.select")
  }
  @ViewBuilder private var gallery: some View {
    #if !FOTORO_LOCAL_PREVIEW
      if allPhotos { timelineGallery } else { deviceGallery }
    #else
      deviceGallery
    #endif
  }
  private var deviceGallery: some View {
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
      if allPhotos, store.hasMorePhotos {
        Section {} footer: {
          ProgressView(browseFilter == .all ? "Loading photos…" : "Looking for matching photos…")
            .font(.footnote).padding().frame(maxWidth: .infinity)
            .task(id: PhotoBrowseContinuation(page: store.browsePage, filter: browseFilter, dates: browseDates, isActive: scenePhase == .active)) {
              guard scenePhase == .active else { return }
              await store.loadMorePhotos(matching: browseFilter, whileActive: { scenePhase == .active })
            }
        }
      }
    }.scrollTargetLayout()
  }
#if !FOTORO_LOCAL_PREVIEW
  private var timelineGallery: some View {
    let device = Dictionary(baseHomePhotos.map { (ConsumerPhotoReference.device($0.id).id, $0) }, uniquingKeysWith: { _, last in last })
    let saved = Dictionary(allOwnedPhotos.map { (ConsumerPhotoReference.saved($0.id).id, $0) }, uniquingKeysWith: { _, last in last })
    return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
      ForEach(timelineGroups) { group in
        Section {
          ForEach(group.sources, id: \.id) { source in
            if let photo = device[source.id], photo.sourceRevision == source.revision {
              RecentPhotoCell(photo: photo, store: store, selected: selected.contains(photo.id), open: {
                if selecting { toggleSelection(photo) } else { openViewer(photo) }
              }, toggle: { toggleSelection(photo) })
                .id(source.id).onAppear { loadMoreDevicePhotos(after: photo.id) }
            } else if let photo = saved[source.id] {
              LibraryPhotoCell(photo: photo, isSelected: selectedSavedPhotos.contains(photo.id), open: {
                if selecting { toggleSavedSelection(photo) }
                else { savedViewer = SavedPhotoViewerPresentation(initial: photo, photos: allOwnedPhotos) }
              }, toggleSelection: { toggleSavedSelection(photo) }, appeared: {})
                .id(source.id)
            }
          }
        } header: {
          HStack {
            Text(group.start?.formatted(date: .abbreviated, time: .omitted) ?? "Date unavailable")
            if groupMoments, let start = group.start {
              Text(start.formatted(date: .omitted, time: .shortened)).foregroundStyle(.secondary)
            }
            Spacer()
          }.font(.subheadline).padding(.horizontal).padding(.vertical, 12)
        }
      }
      if store.hasMorePhotos {
        Section {} footer: {
          ProgressView(browseFilter == .all ? "Loading photos…" : "Looking for matching photos…")
            .font(.footnote).padding().frame(maxWidth: .infinity)
            .task(id: PhotoBrowseContinuation(page: store.browsePage, filter: browseFilter, dates: browseDates, isActive: scenePhase == .active)) {
              guard scenePhase == .active else { return }
              await store.loadMorePhotos(matching: browseFilter, whileActive: { scenePhase == .active })
            }
        }
      }
      if savedHasMore, let services, services.photoAccountAccess != nil {
        Section {} footer: {
          ProgressView("Loading photos…").font(.footnote).padding().frame(maxWidth: .infinity)
            .task(id: SavedTimelinePage(count: services.photos.count, binding: SavedLibraryOpenBinding(services),
              filter: browseFilter, dates: browseDates, isActive: scenePhase == .active)) {
              guard !Task.isCancelled, scenePhase == .active, services.photoAccountAccess != nil else { return }
              do {
                let count = services.photos.count
                try services.loadMore()
                savedHasMore = services.photos.count > count
              } catch { savedHasMore = false; store.error = error.localizedDescription }
            }
        }
      }
    }.scrollTargetLayout()
  }
#endif
  @ViewBuilder private var homeSearchContent: some View {
    if canSearch || search.hasSearch {
      content
        .searchable(text: $query, placement: .toolbar, prompt: "Search photos")
        .searchFocused($queryFocused)
        .searchToolbarBehavior(.automatic)
        .searchPresentationToolbarBehavior(.avoidHidingContent)
        .onSubmit(of: .search) { queryFocused = false }
    } else {
      content
    }
  }
  private var showsHomeNavigation: Bool {
    #if FOTORO_LOCAL_PREVIEW
      hasBrowseAccess || search.hasSearch
    #else
      hasBrowseAccess || scope == .saved || search.hasSearch
    #endif
  }
  private var homeScopeMenu: some View {
    Menu {
      Picker("Photo library", selection: $scope) {
        ForEach(PhotoHomeScope.allCases) { Text($0.rawValue).tag($0) }
      }
      #if !FOTORO_LOCAL_PREVIEW
      Button("People", systemImage: "person.2") { queryFocused = false; people = PhotoPeoplePresentation() }
        .accessibilityIdentifier("home.people")
      Button("Albums", systemImage: "rectangle.stack.badge.person.crop") { openAlbums() }
        .accessibilityIdentifier("home.albums")
      #endif
      Button("Places", systemImage: "map") { queryFocused = false; places = PhotoPlacesPresentation() }
        .accessibilityIdentifier("home.places")
      if !search.hasSearch, hasBrowseAccess {
        #if !FOTORO_LOCAL_PREVIEW
          if scope != .saved { deviceBrowseOptions }
        #else
          deviceBrowseOptions
        #endif
      }
      #if !FOTORO_LOCAL_PREVIEW
        if !search.hasSearch, scope == .saved, let services, services.photoAccountAccess != nil {
          Toggle("Favorites", isOn: $savedFavoritesOnly)
          Button("Shared photos", systemImage: "person.2") { sharedSavedPhotos = SharedPhotosPresentation() }
          Button("Refresh", systemImage: "arrow.clockwise") { Task { await savedRefresh.refresh(services) } }
            .accessibilityIdentifier("saved.refresh")
        }
      #endif
      if !search.hasSearch, hasSelectablePhotos { selectionToggle }
      Button("Settings", systemImage: "gearshape") { queryFocused = false; settings = true }
        .accessibilityIdentifier("home.settings")
    } label: {
      HStack(spacing: 6) {
        Text(scope.rawValue).font(.headline)
        if homeFilterIsActive {
          Image(systemName: "line.3.horizontal.decrease.circle.fill").accessibilityLabel("Filter photos")
        }
        Image(systemName: "chevron.down").font(.caption.weight(.semibold))
      }.frame(minHeight: 44).fixedSize(horizontal: false, vertical: true)
    }.accessibilityLabel("Photo library").accessibilityValue(scope.rawValue)
      .accessibilityIdentifier("home.scope")
  }
  private var deviceBrowseOptions: some View {
    Group {
      if allPhotos {
        Picker("Dates", selection: $browseDates) {
          Text("Last 30 days").tag(PhotoBrowseDateScope.recent)
          Text("All dates").tag(PhotoBrowseDateScope.all)
        }.accessibilityIdentifier("gallery.dates")
      }
      Picker("Show", selection: $browseFilter) {
        Text("All").tag(PhotoBrowseFilter.all)
        Text("Favorites").tag(PhotoBrowseFilter.favorites)
        Text("Screenshots").tag(PhotoBrowseFilter.screenshots)
        Text("With a location").tag(PhotoBrowseFilter.withLocation)
      }.accessibilityIdentifier("gallery.filter")
      if allPhotos { Toggle("Group by moment", isOn: $groupMoments) }
    }
  }
  #if !FOTORO_LOCAL_PREVIEW
    private var homeSyncNeedsAttention: Bool {
      savedRefresh.error != nil || services.map { savedRefresh.requiresAuthentication($0) } == true
        || services?.consumerSyncSummary.state == .needsAttention
        || services?.automaticPhotoSync.phase == .needsAttention
        || services?.automaticPhotoSync.phase == .partial
    }
    @ViewBuilder private var homeSyncButton: some View {
      if homeSyncNeedsAttention {
        Button("Sync needs attention", systemImage: "exclamationmark.icloud") { openPhotoSync() }
          .labelStyle(.iconOnly).font(.title3)
          .frame(width: 44, height: 44).accessibilityIdentifier("home.sync")
      } else if store.opened, RecentPhotosPolicy.canRead(store.status), services?.automaticPhotoSync.enabled == false,
        services.map({ $0.session.accountId == nil
          || NativeBackupPolicy.allowsPrivatePhotos(accountId: $0.session.accountId, fixture: $0.session.fixture) }) != false {
        Button("Turn on sync", systemImage: "icloud.and.arrow.up") { openPhotoSync(startAutomaticSync: true) }
          .font(.subheadline.weight(.semibold)).buttonStyle(.borderedProminent)
          .frame(minHeight: 44).fixedSize(horizontal: false, vertical: true)
          .accessibilityHint("Choose to save your photos across your devices")
          .accessibilityIdentifier("home.sync")
      } else {
        Button("Sync", systemImage: services?.automaticPhotoSync.enabled == true ? "icloud.fill" : "icloud") { openPhotoSync() }
          .labelStyle(.iconOnly).font(.title3)
          .frame(width: 44, height: 44)
          .accessibilityIdentifier("home.sync")
      }
    }
  #endif
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
    }.padding(14).glassEffect(.regular, in: .rect(cornerRadius: 24))
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
    Button("Share", systemImage: "square.and.arrow.up", action: shareSelectedOriginals)
      .buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false)
      .disabled(selectedCount == 0 || preparingShare || showShare)
    if selectedSavedPhotos.count > 0 {
      Button("Album", systemImage: "rectangle.stack") { openAlbums() }
        .buttonStyle(.bordered).disabled(preparingShare || showShare)
        .accessibilityIdentifier("selection.album")
    }
    #else
    Button("Share", systemImage: "square.and.arrow.up", action: shareSelectedDevicePhotos)
      .buttonStyle(.bordered).fixedSize(horizontal: true, vertical: false).disabled(selected.isEmpty || preparingShare || showShare)
    #endif
  }
  #if !FOTORO_LOCAL_PREVIEW
  private func openAlbums(incoming: FotoroAlbumInvitation? = nil) {
    do {
      if services == nil { services = try AppServices() }
      guard let services else { return }
      services.bindLocalSearch(search); services.bindRecentPhotos(store)
      queryFocused = false; pendingShare = nil; shareTask?.cancel(); cleanupShare()
      settings = false; viewer = nil; savedViewer = nil; people = nil; places = nil
      sharedSavedPhotos = nil; backupAccount = nil; photoSyncPresentation = nil
      albumPresentation = try NativeAlbumPresentation.opening(incoming: incoming) {
        try selectedSavedPhotos.resolve(using: services.consumerSavedPhoto)
      }
    } catch { store.error = error.localizedDescription }
  }
  #endif
  private func shareSelectedDevicePhotos() {
    share(selectedPhotos.values.map(\.photo).sorted { ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast) })
  }
  private func loadMoreDevicePhotos(after id: String) {
    guard allPhotos, browseFilter == .all, store.hasMorePhotos,
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
    store.opened && RecentPhotosPolicy.canRead(store.status)
#else
    (store.opened && RecentPhotosPolicy.canRead(store.status)) || services?.photoAccountAccess != nil
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
            pendingPhotoSync = services?.automaticPhotoSync.enabled != true; settings = false
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
    if validation.withdrawsDeviceShare(shareSources + pending) {
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
    if !savedShareSources.isEmpty {
      guard let services, services.photoAccountAccess != nil,
        SavedLibraryOpenBinding(services) == savedShareBinding,
        SavedPhotoSelection.isCurrent(savedShareSources, lookup: services.consumerSavedPhoto) else {
        shareTask?.cancel(); cleanupShare(); savedViewer = nil; return
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
  private func openPhotoSync(startAutomaticSync: Bool = false) {
    queryFocused = false
    do {
      if services == nil { services = try AppServices() }
      services?.bindLocalSearch(search)
      services?.bindRecentPhotos(store)
      services?.setPhotoSyncForeground(scenePhase == .active)
      if let services {
        let requiresAuthentication = savedRefresh.requiresAuthentication(services)
          || (services.session.accountId != nil && PhotoSyncAccountPolicy.requiresAuthentication(
            hasAccountAccess: services.photoAccountAccess != nil, isSignedIn: services.session.isSignedIn,
            accountId: services.session.accountId, fixture: services.session.fixture, rejectedSession: false))
        photoSyncPresentation = PhotoSyncPresentation(services: services,
          savedRefresh: savedRefresh, requiresAuthentication: requiresAuthentication, startAutomaticSync: startAutomaticSync)
      }
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
    guard search.hasSearch else { searchHits = []; savedResults = [:]; searchCompletion = ConsumerSearchCompletion(); return }
    let token = searchTaskID
    searchCompletion.begin(token)
    do {
      if !search.indexing { try await Task.sleep(for: .milliseconds(100)) }
      try Task.checkCancellation()
      guard let services else { searchHits = []; savedResults = [:]; searchCompletion.succeed(token); return }
      let hits = try await services.withDiagnosticAction(.search) { try await services.consumerSearch(query, local: search) }
      try Task.checkCancellation()
      guard token == searchTaskID else { return }
      var saved: [String: LocalPhoto] = [:]
      for hit in hits {
        if case .saved(let id) = hit.photo { saved[id] = try services.consumerSavedPhoto(id) }
      }
      searchHits = hits
      savedResults = saved
      searchCompletion.succeed(token)
    } catch is CancellationError {} catch {
      guard !Task.isCancelled, token == searchTaskID else { return }
      searchHits = []
      savedResults = [:]
      searchCompletion.fail(token, message: error.localizedDescription)
    }
  }
  private func selectSearchResults() {
    guard !preparingShare else { return }
    selecting = true
    queryFocused = false
    selectedPhotos.removeAll()
    selectedSavedPhotos.removeAll()
    let references = ConsumerSearchBinding.selectionForResults(currentSearchHits, reviewedIDs: bestShots.snapshot?.recommendations.ids)
    for reference in references {
      switch reference {
      case .device(let id):
        if selectedPhotos[id] == nil, let photo = search.assets[id] { toggleSelection(photo) }
      case .saved(let id):
        if let photo = savedResults[id] { toggleSavedSelection(photo) }
      }
    }
  }
#endif
  private func openViewer(_ photo: RecentPhoto) {
    viewer = RecentPhotoViewerPresentation(initial: photo, photos: visible)
  }
  private func openPendingPlace() {
    guard let item = pendingPlace else { return }
    pendingPlace = nil
    switch item.reference {
    case .device(let id):
      guard let photo = search.assets[id] ?? store.photos.first(where: { $0.id == id }),
        photo.sourceRevision == item.revision, photo.photoLocation == item.location,
        store.validatePresentation(viewer: [RecentPhotoSource(photo)], selection: [], share: []).viewerIsCurrent else { return }
      // A map can index thousands of coordinates; opening one pin must not construct thousands of pages.
      viewer = RecentPhotoViewerPresentation(initial: photo, photos: [photo])
    case .saved(let id):
      #if !FOTORO_LOCAL_PREVIEW
      guard let services, services.photoAccountAccess?.account == item.owner,
        let photo = try? services.consumerSavedPhoto(id), PhotoPlacesPolicy.savedRevision(photo) == item.revision else { return }
      savedViewer = SavedPhotoViewerPresentation(initial: photo, photos: [photo])
      #endif
    }
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
    #if !FOTORO_LOCAL_PREVIEW
    shareOriginals(device: photos, saved: [])
    #else
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
        shareMeaning = search.hasSearch ? search.response.meaning?.id : nil
        sharedPhotoIDs = photos.map(\.id)
        showShare = true
      } catch is CancellationError { removeShareFiles(exported) }
      catch { removeShareFiles(exported); store.error = error.localizedDescription }
    }
    #endif
  }
  private func removeShareFiles(_ urls: [URL]) {
    RecentShareExports.remove(urls)
  }
  private func cleanupShare() {
    #if !FOTORO_LOCAL_PREVIEW
    removeShareFiles(deviceShareExports)
    ConsumerShareExports.remove(savedShareExports)
    deviceShareExports = []
    savedShareExports = []
    savedShareSources = []
    savedShareBinding = nil
    #else
    removeShareFiles(sharing)
    #endif
    sharing = []
    showShare = false
    shareMeaning = nil
    sharedPhotoIDs = []
    shareSources = []
  }
#if !FOTORO_LOCAL_PREVIEW
  private func shareSelectedOriginals() {
    do {
      let saved = try selectedSavedPhotos.resolve(using: { id in try services?.consumerSavedPhoto(id) })
      shareOriginals(device: selectedPhotos.values.map(\.photo).sorted {
        ($0.capturedAt ?? .distantPast) > ($1.capturedAt ?? .distantPast)
      }, saved: saved)
    } catch { validateSavedPresentation(); store.error = error.localizedDescription }
  }
  private func shareOriginals(device: [RecentPhoto], saved: [LocalPhoto]) {
    guard !preparingShare, !showShare, !device.isEmpty || !saved.isEmpty else { return }
    let sources = device.map(RecentPhotoSource.init)
    let services = services
    let binding = services.map(SavedLibraryOpenBinding.init)
    func check() throws {
      try Task.checkCancellation()
      if !sources.isEmpty,
        !store.validatePresentation(viewer: [], selection: [], share: sources).shareIsCurrent { throw CancellationError() }
      if !saved.isEmpty {
        guard let services, services.photoAccountAccess != nil, SavedLibraryOpenBinding(services) == binding,
          SavedPhotoSelection.isCurrent(saved, lookup: services.consumerSavedPhoto) else { throw CancellationError() }
      }
    }
    preparingShare = true
    shareSources = sources
    savedShareSources = saved
    savedShareBinding = saved.isEmpty ? nil : binding
    shareTask = Task {
      defer {
        preparingShare = false; shareTask = nil
        if !showShare { shareSources = []; savedShareSources = []; savedShareBinding = nil }
      }
      var pending: PhotoOriginalShareBatch.Exports?
      do {
        pending = try await PhotoOriginalShareBatch.prepare(device: sources, saved: saved, valid: check,
          exportDevice: { _ in try await store.shareOriginals(device) },
          exportSaved: { photo in
            guard let services else { throw CancellationError() }
            return try await services.consumerShareOriginal(photo)
          }, expandSaved: { url, photo in
            if photo.metadata.mediaType == CameraMedia.liveType {
              let metadata = photo.metadata, directory = url.deletingLastPathComponent()
              let work = Task.detached(priority: .userInitiated) {
                try Task.checkCancellation()
                let bytes = try Data(contentsOf: url)
                try Task.checkCancellation()
                let urls = try CameraMedia.exportOriginals(bytes, metadata: metadata, directory: directory)
                try Task.checkCancellation()
                return urls
              }
              return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
            }
            return [url]
          }, removeDevice: removeShareFiles, removeSaved: ConsumerShareExports.remove)
        try check()
        guard let completed = pending else { return }
        deviceShareExports = completed.device
        savedShareExports = completed.saved
        sharing = completed.urls
        shareMeaning = search.hasSearch ? search.response.meaning?.id : nil
        sharedPhotoIDs = device.map(\.id)
        showShare = true
        pending = nil
      } catch is CancellationError {
        if let pending { removeShareFiles(pending.device); ConsumerShareExports.remove(pending.saved) }
      } catch {
        if let pending { removeShareFiles(pending.device); ConsumerShareExports.remove(pending.saved) }
        store.error = error.localizedDescription
      }
    }
  }
#endif
}

extension RecentPhotosPresentationValidation {
  func withdrawsDeviceShare(_ sources: [RecentPhotoSource]) -> Bool {
    !sources.isEmpty && !shareIsCurrent
  }
}

#if !FOTORO_LOCAL_PREVIEW
private struct RecentMotionPhotoPage: View {
  let photo: RecentPhoto
  let store: RecentPhotosStore
  let isCurrent: Bool
  @State private var player: AVPlayer?
  @State private var livePhoto: PHLivePhoto?
  @State private var request: PHImageRequestID?
  @State private var generation = UUID()
  @State private var loading = false
  @State private var failed = false
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    Group {
      if let player { VideoPlayer(player: player) }
      else if let livePhoto { RecentLivePhotoPlayer(photo: livePhoto) }
      else {
        PhotosImage(photo: photo, store: store, large: true).scaledToFit().overlay {
          VStack(spacing: 12) {
            if loading { ProgressView("Loading original…") }
            else {
              Button(failed ? "Try again" : "Play", systemImage: "play.circle.fill", action: play)
                .font(.title2).buttonStyle(.borderedProminent).disabled(!isCurrent)
            }
            if failed { Text("The original could not be opened. Check your connection and try again.").font(.footnote) }
          }.padding().background(.regularMaterial, in: .rect(cornerRadius: 16))
        }
      }
    }
    .onChange(of: isCurrent) { if !isCurrent { stop() } }
    .onChange(of: scenePhase) { if scenePhase == .background { stop() } }
    .onDisappear { stop() }
  }
  private func play() {
    guard isCurrent, !loading,
      store.validatePresentation(viewer: [RecentPhotoSource(photo)], selection: [], share: []).viewerIsCurrent else { return }
    stop()
    let token = UUID()
    generation = token
    loading = true; failed = false
    if photo.isVideo {
      let options = PHVideoRequestOptions()
      options.isNetworkAccessAllowed = true
      request = store.images.requestPlayerItem(forVideo: photo.asset, options: options) { item, info in
        guard (info?[PHImageCancelledKey] as? Bool) != true else { return }
        Task { @MainActor in
          guard generation == token, isCurrent, scenePhase != .background,
            store.validatePresentation(viewer: [RecentPhotoSource(photo)], selection: [], share: []).viewerIsCurrent else { return }
          loading = false
          if let item { player = AVPlayer(playerItem: item); player?.play() }
          else { failed = true }
        }
      }
    } else {
      let options = PHLivePhotoRequestOptions()
      options.isNetworkAccessAllowed = true
      options.deliveryMode = .highQualityFormat
      request = store.images.requestLivePhoto(for: photo.asset, targetSize: CGSize(width: 1600, height: 1600),
        contentMode: .aspectFit, options: options) { value, info in
        guard (info?[PHImageCancelledKey] as? Bool) != true,
          (info?[PHImageResultIsDegradedKey] as? Bool) != true else { return }
        Task { @MainActor in
          guard generation == token, isCurrent, scenePhase != .background,
            store.validatePresentation(viewer: [RecentPhotoSource(photo)], selection: [], share: []).viewerIsCurrent else { return }
          loading = false
          livePhoto = value
          failed = value == nil
        }
      }
    }
  }
  private func stop() {
    generation = UUID()
    if let request { store.images.cancelImageRequest(request) }
    request = nil
    player?.pause(); player = nil; livePhoto = nil; loading = false
  }
}

private struct RecentLivePhotoPlayer: UIViewRepresentable {
  let photo: PHLivePhoto
  func makeUIView(context: Context) -> PHLivePhotoView {
    let view = PHLivePhotoView()
    view.contentMode = .scaleAspectFit
    view.livePhoto = photo
    view.startPlayback(with: .full)
    return view
  }
  func updateUIView(_ view: PHLivePhotoView, context: Context) {
    if view.livePhoto !== photo { view.livePhoto = photo; view.startPlayback(with: .full) }
  }
  static func dismantleUIView(_ view: PHLivePhotoView, coordinator: ()) { view.stopPlayback() }
}

@MainActor enum PhotoOriginalShareBatch {
  struct Exports {
    var device: [URL]
    var saved: [URL]
    var photoCount: Int
    var urls: [URL] { device + saved }
  }
  static func prepare(device: [RecentPhotoSource], saved: [LocalPhoto], valid: () throws -> Void,
    exportDevice: ([RecentPhotoSource]) async throws -> [URL], exportSaved: (LocalPhoto) async throws -> URL,
    expandSaved: (URL, LocalPhoto) async throws -> [URL], removeDevice: ([URL]) -> Void,
    removeSaved: ([URL]) -> Void) async throws -> Exports {
    var deviceURLs: [URL] = [], savedURLs: [URL] = [], pendingSaved: [URL] = []
    do {
      try Task.checkCancellation(); try valid()
      if !device.isEmpty {
        deviceURLs = try await exportDevice(device)
        try Task.checkCancellation(); try valid()
        guard deviceURLs.count >= device.count else { throw FotoroError("Some originals are unavailable. Nothing was shared.") }
      }
      for photo in saved {
        try Task.checkCancellation(); try valid()
        let original = try await exportSaved(photo)
        pendingSaved.append(original)
        try Task.checkCancellation(); try valid()
        let resources = try await expandSaved(original, photo)
        guard !resources.isEmpty else { throw FotoroError("The complete original is unavailable. Nothing was shared.") }
        savedURLs += resources
        try Task.checkCancellation(); try valid()
      }
      return Exports(device: deviceURLs, saved: savedURLs, photoCount: device.count + saved.count)
    } catch {
      removeDevice(deviceURLs)
      removeSaved(pendingSaved + savedURLs)
      throw error
    }
  }
}

struct PhotoTimelineSavedItem {
  let photo: LocalPhoto
  let facts: RecentPhotoFacts
}

private struct SavedTimelinePage: Equatable {
  let count: Int
  let binding: SavedLibraryOpenBinding
  let filter: PhotoBrowseFilter
  let dates: PhotoBrowseDateScope
  let isActive: Bool
}

enum PhotoTimelinePolicy {
  static func groups(device: [PhotoBrowseItem], saved: [PhotoTimelineSavedItem], sources: [BackupSource],
    account: String?, filter: PhotoBrowseFilter = .all, grouping: PhotoBrowseGrouping = .days,
    calendar: Calendar = .current, dates: PhotoBrowseDateScope = .all, now: Date = Date()) -> [PhotoBrowseGroup] {
    // Only current, permitted device revisions can hide their verified saved copy.
    // A saved favorite still appears when its device counterpart fails this filter.
    let records = Dictionary(device.filter { filter.includes($0.facts) && dates.includes($0.facts.capturedAt, now: now, calendar: calendar) }.map {
      ($0.source.id, SearchRecord(id: $0.source.id, revision: $0.source.revision))
    }, uniquingKeysWith: { _, current in current })
    let copies = ConsumerSearchBinding.verifiedCopies(sources: sources, records: records)
    var items = device.map { item in
      PhotoBrowseItem(source: RecentPhotoSource(id: ConsumerPhotoReference.device(item.source.id).id,
        revision: item.source.revision), facts: item.facts)
    }
    for item in saved {
      let photo = item.photo
      guard let account, photo.manifest.ownerAccountId == account,
        photo.manifest.photoId == photo.id, ["committed", "saved"].contains(photo.transferState),
        !ConsumerSearchBinding.duplicate(saved: photo, copies: copies) else { continue }
      items.append(PhotoBrowseItem(source: RecentPhotoSource(id: ConsumerPhotoReference.saved(photo.id).id,
        revision: photo.metadata.originalSha256 + "|" + photo.manifest.metadataRepresentation.ciphertextSha256), facts: item.facts))
    }
    return PhotoBrowsing.groups(items, filter: filter, grouping: grouping, calendar: calendar, dates: dates, now: now)
  }
}

enum SavedPhotosPresentationPolicy {
  static func isCurrent(_ photos: [LocalPhoto], lookup: (String) throws -> LocalPhoto?) -> Bool {
    photos.allSatisfy { photo in
      guard let current = try? lookup(photo.id) else { return false }
      return current.metadata == photo.metadata && current.manifest == photo.manifest
    }
  }
}

private struct ConsumerSearchRequestID: Equatable {
  var presentation: ConsumerSearchPresentationID
  var attempt: UInt64
}

struct ConsumerSearchCompletion {
  private var requested: ConsumerSearchPresentationID?
  private var completed: ConsumerSearchPresentationID?
  private var failed: ConsumerSearchPresentationID?
  private var message: String?
  mutating func begin(_ id: ConsumerSearchPresentationID) {
    requested = id; failed = nil; message = nil
  }
  mutating func succeed(_ id: ConsumerSearchPresentationID) {
    guard requested == id else { return }
    completed = id; failed = nil; message = nil
  }
  mutating func fail(_ id: ConsumerSearchPresentationID, message: String) {
    guard requested == id else { return }
    completed = nil; failed = id; self.message = message
  }
  func hasCompleted(_ id: ConsumerSearchPresentationID) -> Bool { completed == id }
  func permitsResults(for id: ConsumerSearchPresentationID) -> Bool {
    completed?.permitsResults(for: id) == true
  }
  func failure(for id: ConsumerSearchPresentationID) -> String? { failed == id ? message : nil }
  func isPending(_ id: ConsumerSearchPresentationID) -> Bool { !hasCompleted(id) && failed != id }
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
  var people = PeopleSearchSelection()
  func permitsResults(for current: Self) -> Bool {
    query == current.query && library == current.library && acceptedMeaning == current.acceptedMeaning
      && catalog == current.catalog && account == current.account && vault == current.vault && people == current.people
  }
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
        .overlay(alignment: .bottomLeading) {
          if photo.isVideo { Image(systemName: "play.fill").padding(8).accessibilityLabel("Video") }
          else if photo.isLivePhoto { Image(systemName: "livephoto").padding(8).accessibilityLabel("Live Photo") }
        }
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
