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
struct PhotoCleanupReview: View {
  @Bindable var services: AppServices
  @State private var source: [LocalPhoto] = []
  @State private var snapshot: [LocalPhoto]?
  @State private var batchNumber = 0
  private let batchSize = 200
  @State private var measurements: [String: AutomaticPhotoPickSignals] = [:]
  @State private var sourceCurrent: () -> Bool = { false }
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
          else { Text("\(done) scanned · \(max(0, (snapshot?.count ?? 0) - total)) remaining · \(result.unassessed) current previews unassessed · \(candidates.count) cleanup candidates") }
          if !busy, sourceCurrent(), let snapshot, total < snapshot.count {
            Button("Review next \(min(batchSize, snapshot.count - total)) photos") {
              guard !busy, sourceCurrent() else { return }
              busy = true
              batchNumber += 1
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
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .task(id: batchNumber) { await review() }
        .onChange(of: scenePhase) { _, value in if value != .active { dismiss() } }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in if !unlocked { dismiss() } }
        .sheet(item: $opened) { photo in PhotoViewer(services: services, initialID: photo.id, displayedPhotos: [photo]) }
    }
  }
  @MainActor private func review() async {
    let account = services.session.accountId, vault = services.vault.generation, catalog = services.store, access = services.photoAccountAccess
    if snapshot != nil && !sourceCurrent() { busy = false; return }
    if snapshot == nil {
      sourceCurrent = {
        access != nil && services.photoAccountAccess == access && services.vault.isUnlocked && services.vault.generation == vault
          && services.session.accountId == account && services.store === catalog
      }
      snapshot = services.photos.filter { !PhotoOrganizationFacts.trashed(services.photoAnnotations[$0.id]?.facts ?? []) }
    }
    guard sourceCurrent(), !Task.isCancelled else { busy = false; return }
    let batch = Array((snapshot ?? []).dropFirst(source.count).prefix(batchSize))
    source.append(contentsOf: batch)
    total = source.count
    busy = true
    func current(_ photo: LocalPhoto) -> Bool {
      sourceCurrent() && !Task.isCancelled && scenePhase == .active && services.vault.isUnlocked && services.vault.generation == vault
        && services.session.accountId == account && services.store === catalog
        && !PhotoOrganizationFacts.trashed(services.photoAnnotations[photo.id]?.facts ?? [])
        && ((try? services.consumerSavedPhoto(photo.id)).map { $0.metadata == photo.metadata && $0.manifest == photo.manifest } ?? false)
    }
    defer { busy = false }
    for photo in batch {
      guard sourceCurrent(), !Task.isCancelled, scenePhase == .active else { return }
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
        guard sourceCurrent(), !Task.isCancelled, scenePhase == .active else { return }
        measurements.removeValue(forKey: photo.id)
      }
      guard sourceCurrent(), !Task.isCancelled, scenePhase == .active else { return }
      done += 1
      await Task.yield()
    }
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
  private func reservedNames() async throws -> Set<String> {
    guard let account = services.session.accountId, presentation.current() else { throw FotoroError("Photo selection changed") }
    let selected = Set(presentation.photos.map(\.id)), revision = services.consumerCatalogGeneration
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
      let reserved = try await reservedNames()
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
            ForEach(preview) { entry in
              VStack(alignment: .leading) { Text(entry.before).foregroundStyle(.secondary); Text(entry.name) }
            }
            Button("Apply names") { work = Task { await apply(restoring: false) } }.disabled(busy)
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
