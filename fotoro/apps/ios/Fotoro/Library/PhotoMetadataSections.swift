import SwiftUI
import ImageIO

// Presents measured capture details without turning technical metadata into user tags.
struct PhotoMetadataSections: View {
  private let summary: PhotoMetadataPresentation
  private let filename: String?
  init(metadata: PhotoCaptureMetadata?, filename: String? = nil) {
    summary = PhotoMetadataPresentation(metadata ?? PhotoCaptureMetadata(items: []))
    self.filename = filename
  }

  var body: some View {
    if filename != nil || !(summary.media + summary.camera + summary.details).isEmpty {
      Section {
        DisclosureGroup("Technical details") {
          if let filename { Text(filename).textSelection(.enabled) }
          ForEach(summary.media + summary.camera + summary.details) { PhotoMetadataRow(row: $0) }
        }
      }
    }
  }
}

struct PhotoLocationSection: View {
  let location: PhotoLocationV1
  var body: some View {
    if location.isValid {
      Section("Place") {
        if let url = location.mapURL {
          Link(location.name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? location.displayName : "View on map", destination: url)
        }
        DisclosureGroup("Location details") {
          Text(location.coordinates).textSelection(.enabled)
          Text(location.provenance).font(.caption).foregroundStyle(.secondary)
          if let accuracy = location.accuracyMeters {
            Text("Accuracy: about \(Int(accuracy.rounded())) m").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
    }
  }
}

// Current Photos measurements and original measurements stay distinct inside optional details.
struct PhotoMetadataPresentation {
  var media: [PhotoCaptureMetadata.Row] = []
  var camera: [PhotoCaptureMetadata.Row] = []
  var details: [PhotoCaptureMetadata.Row] = []

  init(_ metadata: PhotoCaptureMetadata) {
    let items = metadata.items.filter(PhotoCaptureMetadata.validated)
    func item(_ key: String, _ provenance: PhotoCaptureMetadata.Provenance) -> PhotoCaptureMetadata.Item? {
      items.first { $0.k == key && $0.p == provenance }
    }
    func row(_ id: String, _ title: String, _ value: String, _ group: PhotoCaptureMetadata.Group,
      _ provenance: PhotoCaptureMetadata.Provenance) -> PhotoCaptureMetadata.Row {
      PhotoCaptureMetadata.Row(id: id, title: title, value: value, group: group, provenance: provenance)
    }
    var preferredDimensions: String?
    for provenance in [PhotoCaptureMetadata.Provenance.photos, .original] {
      guard let width = item("width", provenance)?.v, let height = item("height", provenance)?.v else { continue }
      let dimensions = width + " × " + height
      if preferredDimensions == nil {
        media.append(row("dimensions", "Dimensions", dimensions + " px", .media, provenance))
        preferredDimensions = dimensions
      } else if dimensions != preferredDimensions {
        details.append(row("originalDimensions", "Original dimensions", dimensions + " px", .source, provenance))
      }
    }
    let features = ["panorama": "Panorama", "hdr": "HDR", "screenshot": "Screenshot",
      "livePhoto": "Live Photo", "depthEffect": "Portrait depth", "animation": "Animated",
      "spatial": "Spatial", "streamed": "Streamed", "highFrameRate": "High frame rate",
      "timelapse": "Time-lapse", "screenRecording": "Screen recording", "cinematic": "Cinematic"]
    let sourceNames = ["userLibrary": "Your library", "cloudShared": "iCloud shared album", "iTunesSynced": "Synced from a computer"]
    var preferredFormat: String?
    let keys = ["mediaType", "contentType", "subtypes", "duration", "cameraMake", "cameraModel",
      "lensMake", "lensModel", "aperture", "exposureSeconds", "iso", "focalLength", "focalLength35mm",
      "originalDateTime", "offsetTimeOriginal", "orientation", "hasAdjustments", "burst", "burstSelection",
      "modifiedAt", "addedAt", "sourceTypes"]
    let rows = metadata.rows
    for key in keys {
      for provenance in [PhotoCaptureMetadata.Provenance.photos, .original] {
        guard let value = item(key, provenance)?.v,
          var display = rows.first(where: { $0.id == provenance.rawValue + ":" + key }) else { continue }
        switch key {
        case "mediaType": display.value = ["image": "Photo", "video": "Video", "audio": "Audio"][value] ?? value
        case "contentType":
          display.value = ["public.jpeg": "JPEG", "public.png": "PNG", "public.heic": "HEIC",
            "public.heif": "HEIF", "com.apple.quicktime-movie": "QuickTime", "public.mpeg-4": "MPEG-4"][value] ?? value
          if preferredFormat == display.value { continue }
          if preferredFormat != nil { display.title = "Original format"; display.group = .source }
          preferredFormat = display.value
        case "subtypes": display.value = value.split(separator: ",").compactMap { features[String($0)] }.joined(separator: " · ")
        case "sourceTypes": display.value = value.split(separator: ",").compactMap { sourceNames[String($0)] }.joined(separator: " · ")
        case "hasAdjustments", "burst":
          if value == "false" { continue }
          display.value = "Yes"
        case "burstSelection": display.value = value.split(separator: ",").map { $0 == "autoPick" ? "Photos pick" : "Your pick" }.joined(separator: " · ")
        case "exposureSeconds":
          if let seconds = Double(value), seconds > 0, seconds < 1 {
            let denominator = (1 / seconds).rounded()
            if denominator.isFinite, denominator <= 1_000_000_000,
              abs(1 / denominator - seconds) / seconds < 0.005 {
              display.value = "1/\(Int(denominator)) s"
            }
          }
        case "orientation":
          display.value = ["1": "Upright", "2": "Mirrored", "3": "Rotated 180°", "4": "Mirrored vertically",
            "5": "Mirrored and rotated", "6": "Rotated 90° clockwise", "7": "Mirrored and rotated",
            "8": "Rotated 90° counterclockwise"][value] ?? value
          display.group = .source
        case "originalDateTime", "offsetTimeOriginal": display.group = .source
        default: break
        }
        switch display.group {
        case .media: media.append(display)
        case .camera: camera.append(display)
        case .exposure, .source: details.append(display)
        }
      }
    }
  }
}

private struct PhotoMetadataRow: View {
  let row: PhotoCaptureMetadata.Row

  var body: some View {
    LabeledContent {
      Text(row.value).multilineTextAlignment(.trailing).textSelection(.enabled)
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(row.title)
        Text(row.provenance.title).font(.caption2).foregroundStyle(.secondary)
      }
    }.accessibilityElement(children: .combine)
  }
}

#if !FOTORO_LOCAL_PREVIEW
struct SavedPhotoOrganizationSection: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  @State private var nameDraft = PhotoNameDraft(savedName: "")
  private var draft: String { nameDraft.value }
  private var value: PhotoAnnotationsV1 { services.annotation(photo) }
  private var name: String { PhotoOrganizationFacts.name(value.facts, original: photo.metadata.filename) }
  private var screenshot: Bool { PhotoOrganizationFacts.screenshot(value.facts, originalSha256: photo.metadata.originalSha256) }
  private var valid: Bool { PhotoOrganizationFacts.validName(draft) && (draft as NSString).pathExtension.lowercased() == (photo.metadata.filename as NSString).pathExtension.lowercased() }
  var body: some View {
    Section("Photo name") {
      TextField("Filename", text: Binding(get: { draft }, set: { nameDraft.edit($0) })).autocorrectionDisabled().textInputAutocapitalization(.never)
        .accessibilityLabel("Photo filename").submitLabel(.done).onSubmit { if valid && draft != name { apply(.name(draft)) } }
      Button("Suggest name") {
        nameDraft.edit(PhotoOrganizationFacts.suggestedName(original: photo.metadata.filename, digest: photo.metadata.originalSha256,
          capturedAt: CameraMedia.captureDate(photo.metadata), labels: value.labels ?? [], place: value.location?.name, screenshot: screenshot,
          analysis: PhotoNameAnalysis(annotation: value, photoID: photo.manifest.photoId, digest: photo.metadata.originalSha256)))
      }
      Button("Apply name") { apply(.name(draft)) }.disabled(!valid || draft == name)
      if name != photo.metadata.filename { Button("Use original name") { apply(.name(nil)) } }
      if nameDraft.savedNameChanged && draft != name {
        Text("The saved name changed. Your draft is kept.").font(.caption).foregroundStyle(.secondary)
        Button("Use saved name") { nameDraft.acknowledge(name) }
      }
      Text("Names follow this photo in Fotoro and on exported copies. The original stays unchanged.").font(.caption).foregroundStyle(.secondary)
      Toggle("Screenshot", isOn: Binding(get: { screenshot }, set: { apply(.screenshot($0)) }))
    }.onAppear { nameDraft.receive(name) }.onChange(of: name) { _, value in nameDraft.receive(value) }
    Section {
      Button(PhotoOrganizationFacts.trashed(value.facts) ? "Restore photo" : "Move to Fotoro Trash") { apply(.trash(!PhotoOrganizationFacts.trashed(value.facts))) }
      Text("Trash hides this photo in Fotoro. You can Restore it. Device Photos and storage use stay unchanged.").font(.caption).foregroundStyle(.secondary)
    }
  }
  private func apply(_ change: PhotoOrganizationChange) {
    do {
      try services.setOrganization(change, photo: photo)
      if case .name = change { nameDraft.acknowledge(name) }
    } catch { services.error = error.localizedDescription }
  }
}
#endif

#if !FOTORO_LOCAL_PREVIEW
import GRDB

struct PhotoCleanupJournalRecord: Codable {
  struct Source: Codable {
    var id: String
    var metadata: PhotoMetadataV1
    var manifest: PhotoManifestV1
    var transferState: String
    func matches(_ current: Source, account: String) -> Bool {
      id == current.id && current.manifest.photoId == id && current.manifest.ownerAccountId == account
        && ["committed", "saved"].contains(current.transferState) && metadata == current.metadata && manifest == current.manifest
    }
  }
  struct Signal: Codable {
    var hash: UInt64
    var luminance: Double
    var contrast: Double
    var sharpness: Double
    var color: [Double]
    init(_ value: AutomaticPhotoPickSignals) {
      hash = value.hash; luminance = value.luminance; contrast = value.contrast; sharpness = value.sharpness; color = value.color
    }
    var measured: AutomaticPhotoPickSignals? {
      guard [luminance, contrast, sharpness].allSatisfy({ $0.isFinite && (0...1).contains($0) }),
        color.count == 3, color.allSatisfy({ $0.isFinite && (0...255).contains($0) }) else { return nil }
      return AutomaticPhotoPickSignals(hash: hash, luminance: luminance, contrast: contrast, sharpness: sharpness, color: color)
    }
  }
  var version = 1
  var processor = "cleanup-preview-v1"
  var account: String
  var origin: String
  var sources: [Source]
  var completed: Int
  var signals: [String: Signal]

  func restored(current: [Source], retired: [Source], account: String, origin: String) -> (sources: [Source], completed: Int, signals: [String: AutomaticPhotoPickSignals])? {
    guard version == 1, processor == "cleanup-preview-v1", self.account == account, self.origin == origin,
      sources.count <= 4096, completed >= 0, completed <= sources.count, signals.count <= completed else { return nil }
    let available = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    let trashed = Dictionary(retired.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    guard available.count == current.count else { return nil }
    var ordered: [Source] = [], checked = 0, seen: Set<String> = [], removed: Set<String> = []
    for (index, original) in sources.enumerated() {
      guard seen.insert(original.id).inserted else { return nil }
      if let latest = available[original.id] {
        guard original.matches(latest, account: account) else { return nil }
        ordered.append(latest)
        if index < completed { checked += 1 }
      } else {
        guard let latest = trashed[original.id], original.matches(latest, account: account) else { return nil }
        removed.insert(original.id)
      }
    }
    guard ordered.count == current.count else { return nil }
    let assessedIDs = Set(sources.prefix(completed).map(\.id))
    var measured: [String: AutomaticPhotoPickSignals] = [:]
    for (id, signal) in signals {
      guard assessedIDs.contains(id), let value = signal.measured else { return nil }
      if !removed.contains(id) { measured[id] = value }
    }
    return (ordered, checked, measured)
  }
}

@MainActor private enum PhotoCleanupJournal {
  static let key = "cleanupReview.v1"
  static func source(_ photo: LocalPhoto) -> PhotoCleanupJournalRecord.Source {
    .init(id: photo.id, metadata: photo.metadata, manifest: photo.manifest, transferState: photo.transferState)
  }
  static func read(_ services: AppServices) throws -> PhotoCleanupJournalRecord? {
    guard services.photoAccountAccess != nil else { return nil }
    guard let encoded = try services.store.database.read({ try String.fetchOne($0, sql: "SELECT value FROM state WHERE key=?", arguments: [key]) }),
      encoded.utf8.count <= 4 * 1024 * 1024, let bytes = Data(base64Encoded: encoded) else { return nil }
    let envelope = try Wire.decode(WrappedKeyV1.self, bytes), bundle = try services.vault.requireBundle()
    let plain = try services.crypto.unwrap(envelope, key: Data(b64: bundle.vaultKey))
    guard plain.count <= 2 * 1024 * 1024 else { return nil }
    return try Wire.decode(PhotoCleanupJournalRecord.self, plain)
  }
  static func write(_ value: PhotoCleanupJournalRecord, services: AppServices, current: () -> Bool) throws -> Bool {
    guard current(), services.photoAccountAccess != nil, value.sources.count <= 4096 else { return false }
    let bytes = try Wire.encode(value)
    guard bytes.count <= 2 * 1024 * 1024 else { return false }
    let bundle = try services.vault.requireBundle()
    let envelope = try services.crypto.wrap(bytes, key: Data(b64: bundle.vaultKey))
    let encoded = try Wire.encode(envelope).base64EncodedString()
    return try services.store.database.write { database in
      guard current() else { return false }
      try database.execute(sql: "INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", arguments: [key, encoded])
      return true
    }
  }
}

struct PhotoCleanupReview: View {
  @Bindable var services: AppServices
  @State private var source: [LocalPhoto] = []
  @State private var snapshot: [LocalPhoto]?
  @State private var batchNumber = 0
  private let batchSize = 200
  @State private var measurements: [String: AutomaticPhotoPickSignals] = [:]
  @State private var sourceCurrent: () -> Bool = { false }
  @State private var runToken = UUID()
  @State private var progressNotice: String?
  @State private var done = 0
  @State private var total = 0
  @State private var busy = true
  @State private var error: String?
  @State private var opened: LocalPhoto?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var recommendations: PhotoCleanupRecommendations {
    guard sourceCurrent(), scenePhase == .active, services.vault.isUnlocked else { return PhotoCleanupRecommendations() }
    let generation = services.consumerCatalogGeneration
    let published = Dictionary(services.photos.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    // Rendering follows the published catalog. Scan admission and the actual
    // Trash action still validate the persisted row before accessing or editing it.
    func identity(_ photo: LocalPhoto) -> PhotoCleanupSourceIdentity {
      PhotoCleanupSourceIdentity(id: photo.id, metadata: photo.metadata, manifest: photo.manifest, transferState: photo.transferState)
    }
    let current = source.compactMap { photo -> PhotoCleanupCandidate? in
      guard identity(photo).matches(published[photo.id].map(identity), account: services.session.accountId),
        let annotation = services.photoAnnotations[photo.id], annotation.photoId == photo.id,
        annotation.originalSha256 == photo.metadata.originalSha256 else { return nil }
      return PhotoCleanupCandidate(id: photo.id, digest: photo.metadata.originalSha256,
        favorite: annotation.favorite == true,
        screenshot: PhotoOrganizationFacts.screenshot(annotation.facts, originalSha256: photo.metadata.originalSha256),
        eligible: !PhotoOrganizationFacts.trashed(annotation.facts))
    }
    guard sourceCurrent(), services.consumerCatalogGeneration == generation else { return PhotoCleanupRecommendations() }
    return PhotoCleanupPolicy.review(current, signals: measurements)
  }
  var body: some View {
    let result = recommendations
    let candidates = services.photos.filter { result.reasons[$0.id] != nil }
    NavigationStack {
      List {
        Section {
          Text("Review possible duplicates, blurry shots, and photos with little detail. Nothing is selected or removed automatically.")
          Text("Review loaded Saved photos in batches of 200. Photos outside this loaded snapshot have not been checked. Trash is recoverable and does not affect device Photos or free storage.").font(.caption).foregroundStyle(.secondary)
          if busy { ProgressView("Checking previews… \(done) / \(total)") }
          else { Text("\(done) scanned · \(max(0, (snapshot?.count ?? 0) - done)) remaining · \(result.unassessed) current previews unassessed · \(candidates.count) cleanup candidates") }
          if busy { Button("Pause review") { pauseReview() } }
          if let progressNotice { Text(progressNotice).font(.caption).foregroundStyle(.secondary) }
          if !busy, sourceCurrent(), let snapshot, total < snapshot.count {
            Button("Review next \(min(batchSize, snapshot.count - total)) photos") {
              guard !busy, sourceCurrent() else { return }
              busy = true
              batchNumber += 1
            }
          }
          if !busy, done > 0, sourceCurrent() {
            Button("Start review over") {
              source = []; measurements = [:]; done = 0; total = 0
              snapshot = eligibleLoadedPhotos
              persistProgress()
              busy = true; batchNumber += 1
            }
          }
        }
        if services.vault.isUnlocked {
          ForEach(candidates) { photo in
            Section {
              LibraryPhotoCell(photo: photo, isSelected: false, open: { opened = photo }, toggleSelection: {}, services: services).frame(maxHeight: 220)
              Text(PhotoOrganizationFacts.name(services.photoAnnotations[photo.id]?.facts ?? [], original: photo.metadata.filename))
              ForEach(result.reasons[photo.id] ?? [], id: \.self) { Text($0).font(.footnote) }
              if services.photoAnnotations[photo.id]?.favorite == true { Label("Favorite · review carefully", systemImage: "heart") }
              Button("Move to Fotoro Trash") {
                do { try services.setOrganization(.trash(true), photo: photo) } catch { self.error = error.localizedDescription }
              }
            }
          }
          if !busy && candidates.isEmpty { Text("No candidates found in this review. Unassessed photos have not been judged.") }
          Section {
            Text("Changes wait for Sync. You can find removed photos in Saved → Fotoro Trash.").font(.caption).foregroundStyle(.secondary)
            Button("Sync changes") { Task { await services.syncAnnotations() } }
          }
        }
        if let error { Text(error).foregroundStyle(.secondary) }
      }.navigationTitle("Review cleanup").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { persistProgress(); runToken = UUID(); dismiss() } } }
        .task(id: batchNumber) { await review() }
        .onDisappear { persistProgress(); runToken = UUID() }
        .onChange(of: scenePhase) { _, value in if value != .active { dismiss() } }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in if !unlocked { dismiss() } }
        .sheet(item: $opened) { photo in PhotoViewer(services: services, initialID: photo.id, displayedPhotos: [photo]) }
    }
  }
  private var eligibleLoadedPhotos: [LocalPhoto] {
    services.photos.filter { $0.manifest.ownerAccountId == services.session.accountId && ["committed", "saved"].contains($0.transferState)
      && !PhotoOrganizationFacts.trashed(services.photoAnnotations[$0.id]?.facts ?? []) }
  }
  @MainActor private func persistProgress() {
    guard sourceCurrent(), scenePhase == .active, let snapshot, let account = services.session.accountId,
      let origin = BackgroundUploadPolicy.origin(services.api.baseURL) else { return }
    let published = Dictionary(services.photos.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
    guard snapshot.allSatisfy({ original in
      guard let latest = published[original.id] else { return false }
      return PhotoCleanupJournal.source(original).matches(PhotoCleanupJournal.source(latest), account: account)
    }) else { progressNotice = "The loaded source changed. Reopen review to check current photos."; return }
    let retained = snapshot.filter { !PhotoOrganizationFacts.trashed(services.photoAnnotations[$0.id]?.facts ?? []) }
    let checkedIDs = Set(source.prefix(done).map(\.id))
    let checked = retained.filter { checkedIDs.contains($0.id) }
    let retainedIDs = Set(checked.map(\.id))
    let record = PhotoCleanupJournalRecord(account: account, origin: origin,
      sources: retained.map(PhotoCleanupJournal.source), completed: checked.count,
      signals: measurements.filter { retainedIDs.contains($0.key) }.mapValues(PhotoCleanupJournalRecord.Signal.init))
    do {
      let stored = try PhotoCleanupJournal.write(record, services: services, current: {
        sourceCurrent() && scenePhase == .active && services.session.accountId == account
          && BackgroundUploadPolicy.origin(services.api.baseURL) == record.origin
      })
      progressNotice = stored ? "Progress is kept encrypted on this device for this loaded scope." : "This review remains available while open. Its scope is too large to retain."
    } catch { progressNotice = "Progress could not be kept after restart. Completed previews remain available while open." }
  }
  @MainActor private func pauseReview() {
    runToken = UUID()
    source = Array(source.prefix(done)); total = done; busy = false
    persistProgress()
  }
  @MainActor private func review() async {
    let account = services.session.accountId, vault = services.vault.generation, catalog = services.store, access = services.photoAccountAccess
    guard let origin = BackgroundUploadPolicy.origin(services.api.baseURL) else { busy = false; return }
    if snapshot != nil && !sourceCurrent() { busy = false; return }
    if snapshot == nil {
      sourceCurrent = {
        access != nil && services.photoAccountAccess == access && services.vault.isUnlocked && services.vault.generation == vault
          && services.session.accountId == account && services.store === catalog
          && BackgroundUploadPolicy.origin(services.api.baseURL) == origin
      }
      snapshot = eligibleLoadedPhotos
      if let snapshot, let account {
        let retired = services.photos.filter { PhotoOrganizationFacts.trashed(services.photoAnnotations[$0.id]?.facts ?? []) }
        if let record = try? PhotoCleanupJournal.read(services),
          let restored = record.restored(current: snapshot.map(PhotoCleanupJournal.source), retired: retired.map(PhotoCleanupJournal.source),
            account: account, origin: origin) {
          let byID = Dictionary(snapshot.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
          self.snapshot = restored.sources.compactMap { byID[$0.id] }
          source = Array((self.snapshot ?? []).prefix(restored.completed)); done = restored.completed; total = done
          measurements = restored.signals; busy = false
          progressNotice = "Previous review restored. Continue explicitly to check more of this loaded scope."
          return
        }
      }
    }
    guard sourceCurrent(), !Task.isCancelled else { busy = false; return }
    let token = UUID(); runToken = token
    func running() -> Bool { runToken == token && sourceCurrent() && !Task.isCancelled && scenePhase == .active }
    let batch = Array((snapshot ?? []).dropFirst(source.count).prefix(batchSize))
    source.append(contentsOf: batch)
    total = source.count
    busy = true
    func current(_ photo: LocalPhoto) -> Bool {
      running() && services.vault.isUnlocked && services.vault.generation == vault
        && services.session.accountId == account && services.store === catalog
        && !PhotoOrganizationFacts.trashed(services.photoAnnotations[photo.id]?.facts ?? [])
        && ((try? services.consumerSavedPhoto(photo.id)).map { $0.metadata == photo.metadata && $0.manifest == photo.manifest } ?? false)
    }
    defer { if runToken == token { busy = false } }
    for photo in batch {
      guard running() else { return }
      guard current(photo), !PhotoOrganizationFacts.trashed(services.photoAnnotations[photo.id]?.facts ?? []) else {
        done += 1
        continue
      }
      do {
        try await services.ensurePreview(photo)
        guard current(photo), let url = try services.consumerSavedPhoto(photo.id)?.previewURL else { throw CancellationError() }
        let task = Task.detached(priority: .utility) { () throws -> AutomaticPhotoPickSignals? in
          try Task.checkCancellation()
          let data = try Data(contentsOf: url, options: .mappedIfSafe)
          guard data.count <= 2 * 1024 * 1024, let image = CGImageSourceCreateWithData(data as CFData, nil),
            let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 64] as CFDictionary) else { return nil }
          return try PhotoPickAnalyzer.measure(thumbnail)
        }
        let signals = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        guard current(photo) else { throw CancellationError() }
        if let signals { measurements[photo.id] = signals }
      } catch {
        guard running() else { return }
        measurements.removeValue(forKey: photo.id)
      }
      guard running() else { return }
      done += 1
      if done % 32 == 0 { persistProgress() }
      await Task.yield()
    }
    guard running() else { return }
    persistProgress()
    NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .metadata, outcome: .completed, completed: done, unavailable: recommendations.unassessed, step: .analysis))
  }
}
#endif

#if !FOTORO_LOCAL_PREVIEW
struct SavedBatchNamingPresentation: Identifiable {
  let id = UUID()
  let photos: [LocalPhoto]
  let current: @MainActor () -> Bool
}

struct SavedBatchNamingReview: View {
  @Bindable var services: AppServices
  let presentation: SavedBatchNamingPresentation
  @Environment(\.dismiss) private var dismiss
  @State private var preview: [Entry] = []
  @State private var undo: [Entry] = []
  @State private var status = ""
  @State private var busy = false
  @State private var work: Task<Void, Never>?
  struct Entry: Identifiable {
    let photo: LocalPhoto
    let before: String
    let previous: String?
    let name: String
    var id: String { photo.id }
  }
  private func key(_ value: String) -> String { value.precomposedStringWithCanonicalMapping.lowercased() }
  private func reservedNames(excluding excludedIDs: Set<String>? = nil) async throws -> Set<String> {
    guard let account = services.session.accountId, presentation.current() else { throw FotoroError("Photo selection changed") }
    let selected = excludedIDs ?? Set(presentation.photos.map(\.id)), revision = services.consumerCatalogGeneration
    var reserved = Set<String>(), cursor: String?
    while true {
      try Task.checkCancellation()
      guard presentation.current(), services.consumerCatalogGeneration == revision else { throw CancellationError() }
      let page = try services.store.ownedPhotos(accountId: account, after: cursor, limit: 200)
      for photo in page where !selected.contains(photo.id) {
        reserved.insert(key(PhotoOrganizationFacts.name(services.annotation(photo).facts, original: photo.metadata.filename)))
      }
      guard let last = page.last else { break }
      cursor = last.id
      await Task.yield()
      try Task.checkCancellation()
      guard presentation.current(), services.consumerCatalogGeneration == revision else { throw CancellationError() }
      if page.count < 200 { break }
    }
    return reserved
  }
  private func makePreview() async {
    guard !busy else { return }
    busy = true; defer { busy = false; work = nil }
    do {
      let revision = services.consumerCatalogGeneration
      var used = try await reservedNames(), entries: [Entry] = []
      for photo in presentation.photos.sorted(by: { $0.id < $1.id }) {
        try Task.checkCancellation()
        guard presentation.current(), let current = try services.consumerSavedPhoto(photo.id), current.metadata == photo.metadata, current.manifest == photo.manifest else { throw FotoroError("Photo source changed") }
        let value = services.annotation(photo)
        let proposed = PhotoOrganizationFacts.suggestedName(original: photo.metadata.filename, digest: photo.metadata.originalSha256,
          capturedAt: CameraMedia.captureDate(photo.metadata), labels: value.labels ?? [], place: value.location?.name,
          screenshot: PhotoOrganizationFacts.screenshot(value.facts, originalSha256: photo.metadata.originalSha256),
          analysis: PhotoNameAnalysis(annotation: value, photoID: photo.id, digest: photo.metadata.originalSha256))
        let ext = (proposed as NSString).pathExtension
        let suffix = ext.isEmpty ? "" : "." + ext
        let stem = suffix.isEmpty ? proposed : String(proposed.dropLast(suffix.count))
        var name = proposed, number = 1
        while used.contains(key(name)) {
          number += 1
          var bounded = stem
          let ending = "_\(number)" + suffix
          while !bounded.isEmpty && !PhotoOrganizationFacts.validName(bounded + ending) { bounded.removeLast() }
          name = bounded + ending
        }
        guard PhotoOrganizationFacts.validName(name) else { throw PhotoOrganizationError.invalid }
        used.insert(key(name))
        entries.append(Entry(photo: photo, before: PhotoOrganizationFacts.name(value.facts, original: photo.metadata.filename),
          previous: PhotoOrganizationFacts.one(value.facts, prefix: PhotoOrganizationFacts.namePrefix), name: name))
        if entries.count.isMultiple(of: 200) {
          await Task.yield()
          try Task.checkCancellation()
          guard presentation.current(), services.consumerCatalogGeneration == revision else { throw CancellationError() }
        }
      }
      preview = entries; status = ""
    } catch { preview = []; status = error.localizedDescription }
  }
  private func apply(restoring: Bool) async {
    guard !busy else { return }
    busy = true; defer { busy = false; work = nil }
    let entries = restoring ? undo : preview
    var completed: [Entry] = []
    do {
      let reserved = try await reservedNames(excluding: Set(entries.map(\.id)))
      var revision = services.consumerCatalogGeneration
      // Validate the whole reviewed plan before the first mutation.
      for entry in entries {
        guard presentation.current(), let current = try services.consumerSavedPhoto(entry.id),
          current.metadata == entry.photo.metadata, current.manifest == entry.photo.manifest,
          PhotoOrganizationFacts.name(services.annotation(current).facts, original: current.metadata.filename) == (restoring ? entry.name : entry.before),
          !reserved.contains(key(restoring ? (entry.previous ?? entry.photo.metadata.filename) : entry.name)) else { throw FotoroError("Selection or names changed. Preview again.") }
      }
      for entry in entries where entry.before != entry.name {
        try Task.checkCancellation()
        guard presentation.current(), services.consumerCatalogGeneration == revision, let live = try services.consumerSavedPhoto(entry.id),
          live.metadata == entry.photo.metadata, live.manifest == entry.photo.manifest,
          PhotoOrganizationFacts.name(services.annotation(live).facts, original: live.metadata.filename) == (restoring ? entry.name : entry.before)
          else { throw FotoroError("Photo selection or name changed") }
        try services.setOrganization(.name(restoring ? entry.previous : entry.name), photo: entry.photo)
        completed.append(entry)
        revision = services.consumerCatalogGeneration
        await Task.yield()
        try Task.checkCancellation()
        guard presentation.current(), services.consumerCatalogGeneration == revision else { throw CancellationError() }
      }
      status = restoring ? "Names restored." : "\(completed.count) names applied. Original files stay unchanged."
    } catch { status = "Stopped: \(error.localizedDescription). Completed changes are kept." }
    if restoring { undo.removeAll { entry in completed.contains { $0.id == entry.id } } }
    else { undo = completed; preview = [] }
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Review names for \(presentation.photos.count) selected photos. Original files stay unchanged.")
          Button("Preview names") { work = Task { await makePreview() } }.disabled(busy)
          if busy { ProgressView("Preparing names") }
        }
        if !preview.isEmpty {
          Section("Name preview") {
            if preview.allSatisfy({ $0.before == $0.name }) { Text("No better names to suggest from current photo details.") }
            ForEach(preview) { entry in
              VStack(alignment: .leading) { Text(entry.before).foregroundStyle(.secondary); Text(entry.name) }
            }
            Button("Apply names") { work = Task { await apply(restoring: false) } }.disabled(busy || preview.allSatisfy { $0.before == $0.name })
            Button("Cancel preview") { preview = [] }.disabled(busy)
          }
        }
        if !undo.isEmpty { Button("Undo names") { work = Task { await apply(restoring: true) } }.disabled(busy) }
        if !status.isEmpty { Text(status).accessibilityAddTraits(.updatesFrequently) }
      }
      .navigationTitle("Name selected photos")
      .onDisappear { work?.cancel(); work = nil }
      .onChange(of: presentation.current()) { _, valid in if !valid { dismiss() } }
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}
#endif
