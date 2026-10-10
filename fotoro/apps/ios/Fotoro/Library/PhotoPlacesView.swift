import MapKit
import Photos
import SwiftUI
import Observation
#if !FOTORO_LOCAL_PREVIEW
import NukeUI
#endif

enum PhotoPlaceReference: Hashable {
  case device(String), saved(String)
  var id: String {
    switch self { case .device(let id): return "device:" + id; case .saved(let id): return "saved:" + id }
  }
}
struct PhotoPlaceItem: Identifiable, Equatable {
  var reference: PhotoPlaceReference
  var revision: String
  var capturedAt: Date?
  var location: PhotoLocationV1
  var owner: String?
  var id: String { reference.id }
}
struct PhotoPlacesPresentation: Identifiable { let id = UUID() }

@MainActor @Observable
final class PhotoPlaceNames {
  typealias Lookup = @MainActor (PhotoPlaceCoordinate) async throws -> String?
  static let maximumRequests = 8
  private(set) var names: [String: String] = [:]
  private(set) var loading = false
  private(set) var failed = false
  private var targets: [PhotoPlaceCluster] = []
  private var generation = UUID()

  func clear() {
    generation = UUID(); names = [:]; targets = []; loading = false; failed = false
  }
  func name(for cluster: PhotoPlaceCluster) -> String? {
    guard targets.contains(cluster) else { return nil }
    return names[cluster.id]
  }
  func load(_ clusters: [PhotoPlaceCluster], lookup: Lookup = PhotoPlaceNames.lookup) async {
    guard !Task.isCancelled, !loading else { return }
    clear()
    let token = generation
    targets = Array(clusters.filter { $0.name == nil && $0.coordinate.isValid }.prefix(Self.maximumRequests))
    let requested = targets
    loading = true
    defer { if generation == token { loading = false } }
    for cluster in requested {
      guard generation == token, !Task.isCancelled else { return }
      do {
        let result = try await lookup(cluster.coordinate)
        guard generation == token, !Task.isCancelled else { return }
        if let result = result?.trimmingCharacters(in: .whitespacesAndNewlines), !result.isEmpty, result.count <= 200 {
          names[cluster.id] = result
        }
      } catch {
        guard generation == token, !Task.isCancelled else { return }
        failed = true
      }
    }
  }
  private static func lookup(_ coordinate: PhotoPlaceCoordinate) async throws -> String? {
    guard coordinate.isValid,
      let request = MKReverseGeocodingRequest(location: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)) else { return nil }
    let result = try await withTaskCancellationHandler {
      try await request.mapItems
    } onCancel: { request.cancel() }
    try Task.checkCancellation()
    return result.first?.addressRepresentations?.cityWithContext ?? result.first?.name
  }
}

enum PhotoPlacesPolicy {
  static func ordered(_ items: [PhotoPlaceItem]) -> [PhotoPlaceItem] {
    var unique: [String: PhotoPlaceItem] = [:]
    for item in items { unique[item.id] = item }
    return unique.values.filter { $0.location.isValid }.sorted {
      let a = $0.capturedAt.flatMap { $0.timeIntervalSince1970.isFinite ? $0 : nil }
      let b = $1.capturedAt.flatMap { $0.timeIntervalSince1970.isFinite ? $0 : nil }
      if a == b { return $0.id < $1.id }
      guard let a else { return false }
      guard let b else { return true }
      return a > b
    }
  }
  #if !FOTORO_LOCAL_PREVIEW
  struct SavedItem { var photo: LocalPhoto; var location: PhotoLocationV1 }
  static func items(device: [PhotoPlaceItem], saved: [SavedItem], sources: [BackupSource], account: String?) -> [PhotoPlaceItem] {
    let records = Dictionary(device.compactMap { item -> (String, SearchRecord)? in
      guard item.location.isValid, case .device(let id) = item.reference else { return nil }
      return (id, SearchRecord(id: id, revision: item.revision))
    }, uniquingKeysWith: { _, last in last })
    let copies = ConsumerSearchBinding.verifiedCopies(sources: sources, records: records)
    let retained = saved.compactMap { item -> PhotoPlaceItem? in
      let photo = item.photo
      guard let account, photo.manifest.ownerAccountId == account, photo.manifest.photoId == photo.id,
        ["committed", "saved"].contains(photo.transferState), !ConsumerSearchBinding.duplicate(saved: photo, copies: copies)
      else { return nil }
      return PhotoPlaceItem(reference: .saved(photo.id), revision: savedRevision(photo),
        capturedAt: ["exif", "photos"].contains(photo.metadata.dateSource) ? Wire.parseDate(photo.metadata.sourceDate) : nil, location: item.location, owner: account)
    }
    return ordered(device + retained)
  }
  static func savedRevision(_ photo: LocalPhoto) -> String {
    photo.metadata.originalSha256 + "|" + photo.manifest.metadataRepresentation.ciphertextSha256
  }
  #endif
}

struct PhotoPlacesView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let store: RecentPhotosStore
  var search: LocalSearchStore? = nil
  #if !FOTORO_LOCAL_PREVIEW
  let services: AppServices?
  #endif
  let open: (PhotoPlaceItem) -> Void
  @State private var camera = MapCameraPosition.automatic
  @State private var viewport: PhotoPlaceViewport?
  @State private var selectedID: String?
  @State private var recentOnly = true
  @State private var loading = false
  @State private var error: String?
  @State private var items: [PhotoPlaceItem] = []
  @State private var byID: [String: PhotoPlaceItem] = [:]
  @State private var devicePhotos: [String: RecentPhoto] = [:]
  @State private var points: [PhotoPlacePoint] = []
  @State private var snapshot = PhotoPlaceMapSnapshot.empty
  @State private var visibleRows: [PhotoPlaceItem] = []
  @State private var areaCovers: [String: PhotoPlaceItem] = [:]
  @State private var focusedPhotoIDs: Set<String>?
  @State private var rowLimit = 80
  @State private var sourceToken = UUID()
  @State private var projection: Task<Void, Never>?
  @State private var placeNames = PhotoPlaceNames()
  @State private var nameLookup: Task<Void, Never>?
  @ScaledMetric(relativeTo: .body) private var mapHeight = 300.0
  @State private var devicePage: UUID?
  @State private var deviceStatus: PHAuthorizationStatus?
  @State private var searchGeneration: UInt64?
  @State private var searchAssetCount: Int?
  #if !FOTORO_LOCAL_PREVIEW
  @State private var savedAccess: PhotoAccountAccess?
  @State private var savedGeneration: UInt64?
  @State private var savedPageExhausted = false
  @State private var savedPhotos: [String: LocalPhoto] = [:]
  #endif

  private var sourceCurrent: Bool {
    guard scenePhase == .active, store.browsePage == devicePage, store.status == deviceStatus,
      PHPhotoLibrary.authorizationStatus(for: .readWrite) == store.status,
      search?.libraryGeneration == searchGeneration, search?.assets.count == searchAssetCount else { return false }
    #if !FOTORO_LOCAL_PREVIEW
    guard services?.photoAccountAccess == savedAccess, services?.consumerCatalogGeneration == savedGeneration else { return false }
    #endif
    return true
  }
  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack {
          Button(recentOnly ? "Last 30 days" : "All dates") { recentOnly.toggle(); refreshSources(recenter: true) }
            .accessibilityLabel(recentOnly ? "Include older photo locations" : "Show photo locations from the last 30 days")
          Spacer()
          if sourceCurrent, !items.isEmpty {
            Button("Fit locations", systemImage: "viewfinder") { fitLocations() }.labelStyle(.iconOnly)
              .accessibilityLabel("Fit all loaded photo locations")
          }
        }.padding(.horizontal).padding(.vertical, 8)
        if sourceCurrent, !items.isEmpty {
          Map(position: $camera, interactionModes: [.pan, .zoom, .rotate], selection: $selectedID) {
            ForEach(snapshot.clusters) { cluster in
              Marker(clusterLabel(cluster), coordinate: coordinate(cluster.coordinate)).tag(cluster.id)
            }
          }.mapStyle(.standard(pointsOfInterest: .excludingAll)).frame(height: min(450, mapHeight))
            .onMapCameraChange(frequency: .onEnd) { context in
              let next = PhotoPlaceViewport(center: PhotoPlaceCoordinate(latitude: context.region.center.latitude, longitude: PhotoPlaceGeometry.longitude(context.region.center.longitude)),
                latitudeSpan: min(180, context.region.span.latitudeDelta), longitudeSpan: min(360, context.region.span.longitudeDelta))
              guard next.isValid else { return }
              if camera.positionedByUser { focusedPhotoIDs = nil; rowLimit = 80 }
              viewport = next; selectedID = nil; updateMap()
            }
            .accessibilityIdentifier("places.map")
        }
        List {
          if sourceCurrent, !snapshot.clusters.isEmpty, focusedPhotoIDs == nil {
            Section {
              ForEach(snapshot.clusters) { cluster in
                Button { zoom(to: cluster) } label: {
                  HStack(spacing: 12) {
                    if let cover = areaCovers[cluster.id] {
                      thumbnail(cover, side: 76)
                        .id(cover.id + "|" + cover.revision)
                        .frame(width: 76, height: 76).clipped()
                        .clipShape(.rect(cornerRadius: 12)).accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                      Text(areaName(cluster)).font(.headline).foregroundStyle(.primary)
                      Text(photoCount(cluster.count)).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                  }.padding(.vertical, 4)
                }.buttonStyle(.plain)
                  .accessibilityHint("Show photos in this area")
              }
              if placeNames.loading { ProgressView("Finding area names…") }
              else { Button("Look up area names", systemImage: "map") { lookupAreaNames() } }
              if placeNames.failed { Text("Some area names are unavailable. Try again.").font(.footnote).foregroundStyle(.secondary) }
            } header: {
              Text("\(snapshot.scale.title) · \(photoCount(snapshot.visibleCount)) in map")
            } footer: {
              Text("Look up up to 8 map areas with Apple Maps. Only marker coordinates are sent. Names describe the area around each marker.")
            }
          }
          if loading { ProgressView("Loading location metadata…") }
          if search?.indexing == true && search?.assets.isEmpty == true { ProgressView("Updating location metadata…") }
          if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
          if sourceCurrent, !items.isEmpty {
            Section {
              ForEach(visibleRows) { item in
                Button { openPhoto(item) } label: {
                  HStack(spacing: 12) {
                    thumbnail(item, side: 60).frame(width: 60, height: 60).clipped().clipShape(.rect(cornerRadius: 8)).accessibilityHidden(true)
                    PhotoPlaceRow(item: item)
                  }
                }.buttonStyle(.plain).accessibilityHint("Open photo")
              }
              if visibleRows.count < displayedCount {
                Button("Show more nearby photos") { rowLimit += 80; updateRows() }
              }
            } header: {
              Text("Nearby photos · \(photoCount(displayedCount))")
            } footer: {
              Text("\(items.count) photo location\(items.count == 1 ? "" : "s") available. \(coverageDescription)")
            }
            if snapshot.visibleCount == 0 { Button("Fit loaded locations") { fitLocations() } }
          } else if !loading {
            ContentUnavailableView(recentOnly ? "No recent photo locations" : "No photo locations", systemImage: "map",
              description: Text("Photos with supplied GPS appear here. Load more location metadata or include older photos."))
            if recentOnly { Button("Include older photos") { recentOnly = false; refreshSources(recenter: true) } }
          }
          if hasMoreMetadata {
            Button(recentOnly ? "Load more location metadata" : "Load more older locations") { loadMoreMetadata() }.disabled(loading)
          }
        }.listStyle(.plain)
      }
      .navigationTitle("Places").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
      .task(id: scenePhase) { if scenePhase == .active { refreshSources() } else { clearPlaces() } }
      .onChange(of: selectedID) { selectMarker() }
      .onChange(of: store.browsePage) { refreshSources() }
      .onChange(of: store.status) { refreshSources(recenter: true) }
      .onChange(of: search?.libraryGeneration) { refreshSources() }
      .onChange(of: search?.assets.count) { refreshSources() }
      .onDisappear { clearPlaces() }
      #if !FOTORO_LOCAL_PREVIEW
      .onChange(of: services?.vault.generation) { savedPageExhausted = false; refreshSources(recenter: true) }
      .onChange(of: services?.session.accountId) { savedPageExhausted = false; refreshSources(recenter: true) }
      .onChange(of: services?.consumerCatalogGeneration) { refreshSources() }
      .onChange(of: services?.photos.count) { refreshSources() }
      #endif
    }
  }
  private var displayedCount: Int { focusedPhotoIDs?.count ?? snapshot.visibleCount }
  private func photoCount(_ count: Int) -> String { "\(count) photo\(count == 1 ? "" : "s")" }
  private var coverageDescription: String {
    #if FOTORO_LOCAL_PREVIEW
    return "Counts cover available device metadata."
    #else
    return "Counts cover available device metadata and loaded Saved metadata."
    #endif
  }
  private var hasMoreMetadata: Bool {
    guard sourceCurrent else { return false }
    #if FOTORO_LOCAL_PREVIEW
    return deviceNeedsMetadataPage
    #else
    return deviceNeedsMetadataPage || (services?.photoAccountAccess != nil && !savedPageExhausted && services?.photos.isEmpty == false)
    #endif
  }
  private var deviceNeedsMetadataPage: Bool {
    // A ready index has already published every permitted device metadata row.
    store.hasMorePhotos && !(search?.canAnalyzeMetadataMatches ?? false)
  }
  private func coordinate(_ value: PhotoPlaceCoordinate) -> CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: value.latitude, longitude: value.longitude)
  }
  private func region(_ value: PhotoPlaceViewport) -> MKCoordinateRegion {
    MKCoordinateRegion(center: coordinate(value.center), span: MKCoordinateSpan(latitudeDelta: value.latitudeSpan, longitudeDelta: value.longitudeSpan))
  }
  private func clusterLabel(_ cluster: PhotoPlaceCluster) -> String {
    "\(areaName(cluster)) · \(photoCount(cluster.count))"
  }
  private func areaName(_ cluster: PhotoPlaceCluster) -> String {
    cluster.name ?? placeNames.name(for: cluster).map { "Near " + $0 } ?? snapshot.scale.areaLabel
  }
  private func clearPlaces() {
    nameLookup?.cancel(); nameLookup = nil; placeNames.clear()
    projection?.cancel(); projection = nil; sourceToken = UUID(); selectedID = nil
    items = []; byID = [:]; devicePhotos = [:]; points = []; snapshot = .empty; visibleRows = []; areaCovers = [:]; focusedPhotoIDs = nil
    #if !FOTORO_LOCAL_PREVIEW
    savedPhotos = [:]
    #endif
    viewport = nil; camera = .automatic
  }
  private func refreshSources(recenter: Bool = false) {
    nameLookup?.cancel(); nameLookup = nil; placeNames.clear()
    guard scenePhase == .active else { clearPlaces(); return }
    projection?.cancel(); sourceToken = UUID(); selectedID = nil; focusedPhotoIDs = nil; snapshot = .empty; visibleRows = []; areaCovers = [:]; rowLimit = 80
    let page = store.browsePage, status = store.status
    let library = search?.libraryGeneration, assetCount = search?.assets.count
    // The index already holds permitted metadata; using it does not request originals or inference.
    // Its empty refresh snapshot must not fall back to potentially withdrawn old browse locations.
    var available = Dictionary(store.photos.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    if let search {
      if search.assets.isEmpty && search.indexing { available = [:] }
      else { available.merge(search.assets, uniquingKeysWith: { _, indexed in indexed }) }
    }
    let device = RecentPhotosPolicy.canRead(status) ? available.values.compactMap { photo -> PhotoPlaceItem? in
      guard let location = photo.photoLocation else { return nil }
      return PhotoPlaceItem(reference: .device(photo.id), revision: photo.sourceRevision, capturedAt: photo.capturedAt, location: location)
    } : []
    let projected: [PhotoPlaceItem]
    #if FOTORO_LOCAL_PREVIEW
    projected = PhotoPlacesPolicy.ordered(device)
    #else
    let access = services?.photoAccountAccess
    let generation = services?.consumerCatalogGeneration
    if let services, let access {
      let saved = services.photos.compactMap { photo -> PhotoPlacesPolicy.SavedItem? in
        guard let location = services.annotation(photo).location else { return nil }
        return PhotoPlacesPolicy.SavedItem(photo: photo, location: location)
      }
      projected = PhotoPlacesPolicy.items(device: device, saved: saved, sources: (try? services.store.backupSources()) ?? [], account: access.account)
    } else { projected = PhotoPlacesPolicy.ordered(device) }
    guard services?.photoAccountAccess == access, services?.consumerCatalogGeneration == generation else { clearPlaces(); return }
    savedAccess = access; savedGeneration = generation
    #endif
    guard store.browsePage == page, store.status == status, search?.libraryGeneration == library,
      search?.assets.count == assetCount else { clearPlaces(); return }
    let now = Date()
    let scoped = projected.filter { PhotoPlaceGeometry.includes(point($0), recentOnly: recentOnly, now: now) }
    devicePage = page; deviceStatus = status; searchGeneration = library; searchAssetCount = assetCount; items = scoped
    byID = Dictionary(scoped.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last }); points = scoped.map(point)
    devicePhotos = available.filter { byID["device:" + $0.key] != nil }
    #if !FOTORO_LOCAL_PREVIEW
    savedPhotos = Dictionary((services?.photos ?? []).filter { byID["saved:" + $0.id] != nil }.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    #endif
    if recenter { viewport = nil; camera = .automatic }
    if viewport == nil { fitLocations() } else { updateMap() }
  }
  private func point(_ item: PhotoPlaceItem) -> PhotoPlacePoint {
    PhotoPlacePoint(id: item.id, revision: item.revision, coordinate: PhotoPlaceCoordinate(latitude: item.location.latitude, longitude: item.location.longitude), capturedAt: item.capturedAt, name: item.location.name)
  }
  private func fitLocations() {
    guard sourceCurrent, let bounds = PhotoPlaceGeometry.bounds(points.map(\.coordinate))?.padded() else { return }
    viewport = bounds; focusedPhotoIDs = nil; selectedID = nil; rowLimit = 80; camera = .region(region(bounds)); updateMap()
  }
  private func updateMap() {
    nameLookup?.cancel(); nameLookup = nil; placeNames.clear()
    projection?.cancel()
    guard sourceCurrent, let viewport else { snapshot = .empty; visibleRows = []; areaCovers = [:]; return }
    let input = points, token = sourceToken
    projection = Task { @MainActor in
      let worker = Task.detached(priority: .userInitiated) {
        let value = PhotoPlaceGeometry.snapshot(input, viewport: viewport)
        // The snapshot orders valid capture dates newest first; derive covers once per projection.
        let rank = Dictionary(value.visiblePhotoIDs.enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { first, _ in first })
        let covers = Dictionary(value.clusters.compactMap { cluster -> (String, String)? in
          guard let id = cluster.photoIDs.min(by: { (rank[$0] ?? Int.max) < (rank[$1] ?? Int.max) }) else { return nil }
          return (cluster.id, id)
        }, uniquingKeysWith: { first, _ in first })
        return (snapshot: value, covers: covers)
      }
      let value = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
      guard !Task.isCancelled, sourceToken == token, sourceCurrent, self.viewport == viewport else { return }
      areaCovers = value.covers.compactMapValues { byID[$0] }
      snapshot = value.snapshot; updateRows()
    }
  }
  private func updateRows() {
    guard sourceCurrent else { visibleRows = []; return }
    let ids = snapshot.visiblePhotoIDs.filter { focusedPhotoIDs == nil || focusedPhotoIDs!.contains($0) }
    visibleRows = ids.prefix(rowLimit).compactMap { byID[$0] }
  }
  private func selectMarker() {
    guard sourceCurrent, let selectedID, let cluster = snapshot.clusters.first(where: { $0.id == selectedID }) else { return }
    self.selectedID = nil
    zoom(to: cluster)
  }
  private func lookupAreaNames() {
    guard sourceCurrent, !placeNames.loading else { return }
    nameLookup?.cancel()
    let clusters = snapshot.clusters, token = sourceToken
    nameLookup = Task { @MainActor in
      guard sourceCurrent, sourceToken == token else { return }
      await placeNames.load(clusters)
    }
  }
  private func zoom(to cluster: PhotoPlaceCluster) {
    guard sourceCurrent, snapshot.clusters.contains(cluster) else { return }
    focusedPhotoIDs = Set(cluster.photoIDs); rowLimit = 80; updateRows()
    let target = cluster.bounds.padded(1.4, minimum: 0.002)
    viewport = target
    withAnimation(reduceMotion ? nil : .default) { camera = .region(region(target)) }
    updateMap()
  }
  private func openPhoto(_ item: PhotoPlaceItem) {
    guard sourceCurrent, byID[item.id] == item else { return }
    switch item.reference {
    case .device(let id):
      guard RecentPhotosPolicy.canRead(store.status), let projected = devicePhotos[id],
        projected.sourceRevision == item.revision,
        store.validatePresentation(viewer: [RecentPhotoSource(projected)], selection: [], share: []).viewerIsCurrent,
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
        !asset.isHidden, RecentPhoto.sourceRevision(asset) == item.revision,
        PhotoLocationV1.photos(asset.location) == item.location,
        RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)), sourceCurrent
      else { refreshSources(); return }
    case .saved(let id):
      #if !FOTORO_LOCAL_PREVIEW
      guard let services, services.photoAccountAccess == savedAccess, let current = try? services.consumerSavedPhoto(id),
        current.manifest.ownerAccountId == item.owner, PhotoPlacesPolicy.savedRevision(current) == item.revision,
        services.annotation(current).location == item.location else { refreshSources(); return }
      #else
      return
      #endif
    }
    open(item); dismiss()
  }
  private func loadMoreMetadata() {
    guard sourceCurrent, !loading else { return }
    loading = true; error = nil
    // One explicit action loads one metadata page; map browsing never drains a library.
    if deviceNeedsMetadataPage { store.loadMorePhotos() }
    #if !FOTORO_LOCAL_PREVIEW
    if let services, let access = services.photoAccountAccess, !savedPageExhausted {
      let count = services.photos.count
      do { try services.loadMore(); savedPageExhausted = services.photos.count == count }
      catch { self.error = error.localizedDescription }
      guard services.photoAccountAccess == access else { loading = false; clearPlaces(); return }
    }
    #endif
    loading = false; refreshSources()
  }
  @ViewBuilder private func thumbnail(_ item: PhotoPlaceItem, side: CGFloat) -> some View {
    if sourceCurrent {
      switch item.reference {
      case .device(let id):
        if let photo = devicePhotos[id], photo.sourceRevision == item.revision {
          PhotosImage(photo: photo, store: store, networkAllowed: false, thumbnailSide: side).scaledToFill()
        } else { Image(systemName: "photo").foregroundStyle(.secondary) }
      case .saved(let id):
        #if !FOTORO_LOCAL_PREVIEW
        if let services, services.photoAccountAccess == savedAccess,
          let photo = savedPhotos[id], PhotoPlacesPolicy.savedRevision(photo) == item.revision {
          LazyImage(url: photo.thumbnailURL) { state in
            if let image = state.image { image.resizable().scaledToFill() }
            else { Image(systemName: "photo").foregroundStyle(.secondary) }
          }
        } else { Image(systemName: "photo").foregroundStyle(.secondary) }
        #else
        Image(systemName: "photo").foregroundStyle(.secondary)
        #endif
      }
    } else { Image(systemName: "photo").foregroundStyle(.secondary) }
  }
}

private struct PhotoPlaceRow: View {
  let item: PhotoPlaceItem
  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(item.location.displayName).font(.body)
        Text(item.capturedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Capture date unavailable").font(.subheadline)
        Text(item.location.provenance).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
    }.padding(.vertical, 6)
  }
}
