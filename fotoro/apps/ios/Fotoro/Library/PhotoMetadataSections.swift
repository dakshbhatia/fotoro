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
  @State private var reasons: [String: [String]] = [:]
  @State private var done = 0
  @State private var total = 0
  @State private var unassessed = 0
  @State private var busy = true
  @State private var error: String?
  @State private var opened: LocalPhoto?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var candidates: [LocalPhoto] {
    services.photos.filter { reasons[$0.id] != nil && !PhotoOrganizationFacts.trashed(services.annotation($0).facts) }
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Review possible duplicates, blurry shots, and photos with little detail. Nothing is selected or removed automatically.")
          Text("Up to 200 loaded Saved photos. Trash is recoverable and does not affect device Photos or free storage.").font(.caption).foregroundStyle(.secondary)
          if busy { ProgressView("Checking previews… \(done) / \(total)") }
          else { Text("\(candidates.count) to review · \(unassessed) previews unassessed") }
        }
        if services.vault.isUnlocked {
          ForEach(candidates) { photo in
            Section {
              LibraryPhotoCell(photo: photo, isSelected: false, open: { opened = photo }, toggleSelection: {}, services: services).frame(maxHeight: 220)
              Text(PhotoOrganizationFacts.name(services.annotation(photo).facts, original: photo.metadata.filename))
              ForEach(reasons[photo.id] ?? [], id: \.self) { Text($0).font(.footnote) }
              if services.annotation(photo).favorite == true { Label("Favorite · review carefully", systemImage: "heart") }
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
        .task { await review() }
        .onChange(of: scenePhase) { _, value in if value != .active { dismiss() } }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in if !unlocked { dismiss() } }
        .sheet(item: $opened) { photo in PhotoViewer(services: services, initialID: photo.id, displayedPhotos: [photo]) }
    }
  }
  @MainActor private func review() async {
    let account = services.session.accountId, vault = services.vault.generation, catalog = services.store
    let source = Array(services.photos.filter { !PhotoOrganizationFacts.trashed(services.annotation($0).facts) }.prefix(200))
    total = source.count
    var digestKeepers: [String: String] = [:]
    // Keep a favorite as the representative when identical originals are loaded.
    for photo in source.sorted(by: { services.annotation($0).favorite == true && services.annotation($1).favorite != true }) {
      if digestKeepers[photo.metadata.originalSha256] == nil { digestKeepers[photo.metadata.originalSha256] = photo.id }
    }
    func current(_ photo: LocalPhoto) -> Bool {
      !Task.isCancelled && scenePhase == .active && services.vault.isUnlocked && services.vault.generation == vault
        && services.session.accountId == account && services.store === catalog
        && ((try? services.consumerSavedPhoto(photo.id)).map { $0.metadata == photo.metadata && $0.manifest == photo.manifest } ?? false)
    }
    defer { busy = false }
    for photo in source {
      guard current(photo) else { return }
      var why: [String] = []
      if digestKeepers[photo.metadata.originalSha256] != photo.id { why.append("Identical original · keep another copy") }
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
        guard current(photo) else { return }
        let annotation = services.annotation(photo)
        if let signals {
          if annotation.favorite != true && !PhotoOrganizationFacts.screenshot(annotation.facts, originalSha256: photo.metadata.originalSha256) {
            if signals.luminance < 0.025 || signals.luminance > 0.985 { why.append("Possibly too dark or bright") }
            else if signals.contrast < 0.012 { why.append("Very little visible detail") }
            else if signals.sharpness < 0.008 && signals.contrast > 0.025 { why.append("Possibly blurry") }
          }
        } else { unassessed += 1 }
      } catch {
        guard current(photo) else { return }
        unassessed += 1
      }
      guard current(photo) else { return }
      if !why.isEmpty { reasons[photo.id] = why }
      done += 1
      await Task.yield()
    }
    NativeDiagnostics.shared.record(NativeDiagnosticEvent(phase: .metadata, outcome: .completed, completed: done, unavailable: unassessed, step: .analysis))
  }
}
#endif
