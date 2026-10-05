import MapKit
import SwiftUI

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
        capturedAt: Wire.parseDate(photo.metadata.sourceDate), location: item.location, owner: account)
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
  let store: RecentPhotosStore
  #if !FOTORO_LOCAL_PREVIEW
  let services: AppServices?
  #endif
  let open: (PhotoPlaceItem) -> Void
  @State private var camera = MapCameraPosition.automatic
  @State private var selectedID: String?
  @State private var loading = false
  @State private var error: String?

  private var items: [PhotoPlaceItem] {
    let device = RecentPhotosPolicy.canRead(store.status) ? store.photos.compactMap { photo -> PhotoPlaceItem? in
      guard let location = photo.photoLocation else { return nil }
      return PhotoPlaceItem(reference: .device(photo.id), revision: photo.sourceRevision,
        capturedAt: photo.capturedAt, location: location)
    } : []
    #if FOTORO_LOCAL_PREVIEW
      return PhotoPlacesPolicy.ordered(device)
    #else
      guard let services, let access = services.photoAccountAccess else { return PhotoPlacesPolicy.ordered(device) }
      let saved = services.photos.compactMap { photo -> PhotoPlacesPolicy.SavedItem? in
        guard let location = services.annotation(photo).location else { return nil }
        return PhotoPlacesPolicy.SavedItem(photo: photo, location: location)
      }
      return PhotoPlacesPolicy.items(device: device, saved: saved,
        sources: (try? services.store.backupSources()) ?? [], account: access.account)
    #endif
  }
  private var mapItems: [PhotoPlaceItem] { Array(items.prefix(200)) }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if !items.isEmpty {
          Map(position: $camera, interactionModes: [.pan, .zoom, .rotate], selection: $selectedID) {
            ForEach(mapItems) { item in
              Marker(item.location.displayName,
                coordinate: CLLocationCoordinate2D(latitude: item.location.latitude, longitude: item.location.longitude))
                .tag(item.id)
            }
          }.mapStyle(.standard(pointsOfInterest: .excludingAll)).frame(height: 260)
            .accessibilityIdentifier("places.map")
        }
        List {
          if loading { ProgressView("Loading photos…") }
          if let error { Text(error).font(.footnote).foregroundStyle(.secondary) }
          ForEach(items) { item in
            Button { openPhoto(item) } label: { PhotoPlaceRow(item: item) }
              .buttonStyle(.plain).accessibilityHint("Open photo")
          }
          if items.isEmpty, !loading {
            ContentUnavailableView("No photo locations", systemImage: "map",
              description: Text("Photos with location appear here. Their dates and GPS come from the photos you allow or save."))
          }
        }.listStyle(.plain)
      }
      .navigationTitle("Places").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
      .task(id: scenePhase) { await loadPhotos() }
      .onChange(of: selectedID) {
        guard let selectedID, let item = mapItems.first(where: { $0.id == selectedID }) else { return }
        openPhoto(item)
      }
      .onChange(of: store.browsePage) { selectedID = nil }
      #if !FOTORO_LOCAL_PREVIEW
      .onChange(of: services?.vault.generation) { selectedID = nil; camera = .automatic }
      .onChange(of: services?.session.accountId) { selectedID = nil; camera = .automatic }
      #endif
    }
  }
  private func openPhoto(_ item: PhotoPlaceItem) {
    guard items.contains(item) else { return }
    open(item)
    dismiss()
  }
  private func loadPhotos() async {
    guard scenePhase == .active else { return }
    loading = true
    defer { loading = false }
    while store.hasMorePhotos, !Task.isCancelled, scenePhase == .active {
      await store.loadMorePhotos(matching: .withLocation, whileActive: { scenePhase == .active })
    }
    #if !FOTORO_LOCAL_PREVIEW
    guard let services, let access = services.photoAccountAccess else { return }
    let vault = services.vault.generation
    while !Task.isCancelled, scenePhase == .active,
      services.photoAccountAccess == access, services.vault.generation == vault {
      let count = services.photos.count
      do { try services.loadMore() } catch { self.error = error.localizedDescription; return }
      guard services.photos.count > count else { return }
      await Task.yield()
    }
    #endif
  }
}

private struct PhotoPlaceRow: View {
  let item: PhotoPlaceItem
  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "photo").font(.title2).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 4) {
        Text(item.capturedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Date unavailable")
          .font(.subheadline)
        Text(item.location.displayName).font(.body)
        Text(item.location.provenance).font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
    }.padding(.vertical, 6)
  }
}
