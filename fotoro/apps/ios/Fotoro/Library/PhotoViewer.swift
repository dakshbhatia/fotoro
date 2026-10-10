import NukeUI
import AVKit
import Photos
import SwiftUI

struct SavedPhotoViewerPresentation: Identifiable {
  let initial: LocalPhoto
  let photos: [LocalPhoto]
  var id: String { initial.id }
}

struct PhotoViewer: View {
  @Bindable var services: AppServices
  let initialID: String
  var displayedPhotos: [LocalPhoto]? = nil
  let receivedGrant: GrantV1?
  let receivedCards: [String: AccountCardV1]?
  @State private var selected = ""
  @State private var zoom = PhotoViewerZoom()
  @State private var details: LocalPhoto?
  @State private var sharedOriginal: ConsumerSharedOriginal?
  @State private var originalExports: [URL] = []
  @State private var preparingShare = false
  @State private var shareTask: Task<Void, Never>?
  @State private var sharedPhotos: SharedPhotosPresentation?
  @State private var controlsVisible = true
  @State private var saveTask: Task<Void, Never>?
  @State private var savedReceivedIDs: Set<String> = []
  @State private var feedback: String?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(services: AppServices, initialID: String, displayedPhotos: [LocalPhoto]? = nil, receivedGrant: GrantV1? = nil) {
    self.services = services
    self.initialID = initialID
    self.displayedPhotos = displayedPhotos
    self.receivedGrant = receivedGrant
    self.receivedCards = receivedGrant == nil ? nil : services.session.pinnedCards
    _selected = State(initialValue: initialID)
  }
  private var receivedUnavailable: Bool { receivedGrant.map { !services.isReceivedGrantCurrent($0) } ?? false }
  private var photos: [LocalPhoto] { receivedUnavailable ? [] : displayedPhotos ?? (receivedGrant == nil ? services.photos : services.received) }
  private var current: LocalPhoto? { photos.first { $0.id == (selected.isEmpty ? initialID : selected) } }
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          Group {
            if shouldLoad(photo) {
              if CameraMedia.isMotion(photo.metadata.mediaType) {
                SavedPhotoPage(services: services, photo: photo, receivedGrant: receivedGrant, receivedCards: receivedCards,
                  isCurrent: photo.id == selected)
              } else {
                SavedPhotoPage(services: services, photo: photo, receivedGrant: receivedGrant, receivedCards: receivedCards,
                  isCurrent: photo.id == selected)
                  .modifier(PhotoViewerStillInteraction(zoom: $zoom, controlsVisible: $controlsVisible, isCurrent: photo.id == selected))
              }
            }
            else { Color.black }
          }.tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black)
        .ignoresSafeArea(.container)
        .overlay {
          if receivedUnavailable {
            VStack {
              ContentUnavailableView("Shared photos unavailable", systemImage: "photo",
                description: Text("Copies you saved stay in your Fotoro."))
              if saveTask != nil { ProgressView("Finishing Save…") }
            }
          }
        }
        .onChange(of: selected) { zoom.reset(); feedback = nil; controlsVisible = true }
        .accessibilityAction(named: "Next photo") { movePage(forward: true) }
        .accessibilityAction(named: "Previous photo") { movePage(forward: false) }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          if current.map({ !CameraMedia.isMotion($0.metadata.mediaType) }) == true {
            ToolbarItem(placement: .topBarTrailing) {
              Button(zoom.scale == 1 ? "Zoom in" : "Reset zoom", systemImage: "plus.magnifyingglass") { zoom.toggle() }
                .accessibilityIdentifier("viewer.zoom")
            }
          }
          if receivedGrant != nil {
            ToolbarItem(placement: .bottomBar) {
              Button("Info", systemImage: "info.circle") { details = current }
            }
            ToolbarItem(placement: .bottomBar) {
              Button(current.map { savedReceivedIDs.contains($0.id) } == true ? "Saved" : "Save", systemImage: "icloud.and.arrow.up", action: saveReceived)
                .disabled(services.busy || preparingShare || current == nil || current.map { savedReceivedIDs.contains($0.id) } == true)
            }
            ToolbarItem(placement: .bottomBar) {
              Button("Save to Photos", systemImage: "square.and.arrow.down", action: restoreOriginal)
                .disabled(preparingShare || saveTask != nil || current == nil)
                .accessibilityIdentifier("viewer.saveToPhotos")
            }
          } else {
            ToolbarItem(placement: .bottomBar) {
              Button("Save to Photos", systemImage: "square.and.arrow.down", action: restoreOriginal)
                .disabled(preparingShare || current == nil)
                .accessibilityLabel("Save to Photos")
                .accessibilityIdentifier("viewer.saveToPhotos")
            }
            ToolbarItem(placement: .bottomBar) {
              Button("Share", systemImage: "square.and.arrow.up", action: share)
                .disabled(preparingShare || current == nil)
                .accessibilityIdentifier("viewer.share")
            }
            ToolbarItem(placement: .bottomBar) {
              Menu("More", systemImage: "ellipsis.circle") {
                Button("Info", systemImage: "info.circle") { details = current }
                Button("Share in Fotoro") {
                  if let current { sharedPhotos = SharedPhotosPresentation(photos: [current]) }
                }
              }
                .disabled(preparingShare || current == nil)
                .accessibilityIdentifier("viewer.more")
            }
          }
        }
        .toolbar(controlsVisible ? .visible : .hidden, for: .navigationBar, .bottomBar)
        .overlay { if preparingShare { ProgressView("Preparing original…").padding().glassEffect() } }
        .sheet(item: $details) { photo in
          if receivedGrant != nil { ReceivedPhotoDetails(photo: photo) }
          else { SavedPhotoDetails(services: services, photo: photo) }
        }
        .sheet(item: $sharedPhotos) { presentation in
          ExchangeView(services: services, selected: presentation.photos)
        }
        .sheet(item: $sharedOriginal, onDismiss: cleanupShare) { original in
          OriginalShareSheet(urls: original.urls) { _ in cleanupShare() }
        }
        .overlay(alignment: .bottom) {
          if let feedback { Text(feedback).font(.footnote).padding().background(.regularMaterial, in: .capsule).padding(.bottom, 60) }
        }
        .onChange(of: services.vault.generation) { cancelViewerWork(); dismiss() }
        .onChange(of: services.selectedGrant) {
          if receivedUnavailable {
            details = nil
            if saveTask == nil { dismiss() }
          }
        }
        .onChange(of: services.session.pinnedCards) {
          if let receivedCards, services.session.pinnedCards != receivedCards { saveTask?.cancel(); dismiss() }
        }
        .onChange(of: services.consumerCatalogGeneration) {
          if receivedGrant == nil, !SavedPhotosPresentationPolicy.isCurrent(photos, lookup: services.consumerSavedPhoto) { dismiss() }
        }
        .onChange(of: scenePhase) { (_: ScenePhase, newPhase: ScenePhase) in
          scenePhaseChanged(newPhase)
        }
        .onDisappear(perform: cancelViewerWork)
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }.preferredColorScheme(.dark)
  }
  private func shouldLoad(_ photo: LocalPhoto) -> Bool {
    guard let index = photos.firstIndex(where: { $0.id == photo.id }),
      let current = photos.firstIndex(where: { $0.id == (selected.isEmpty ? initialID : selected) }) else { return false }
    return RecentPhotosPolicy.shouldLoadPage(index, current: current)
  }
  private func movePage(forward: Bool) {
    if let id = RecentPhotosPolicy.adjacentPhotoID(photos.map(\.id), current: selected, forward: forward) { selected = id }
  }
  private func share() {
    guard let photo = current, !preparingShare else { return }
    let account = services.session.accountId
    let generation = services.vault.generation
    let catalog = services.store
    preparingShare = true
    shareTask = Task {
      var pendingExport: URL?
      defer {
        if let pendingExport { ConsumerShareExports.remove([pendingExport]) }
        preparingShare = false
        shareTask = nil
      }
      do {
        let url = try await services.consumerShareOriginal(photo)
        pendingExport = url
        try Task.checkCancellation()
        guard services.vault.isUnlocked, services.vault.generation == generation,
          services.session.accountId == account, services.store === catalog,
          let current = try services.consumerSavedPhoto(photo.id),
          current.metadata == photo.metadata, current.manifest == photo.manifest else { throw CancellationError() }
        let urls = try await CameraMedia.exportOriginalFile(url, metadata: photo.metadata)
        try Task.checkCancellation()
        guard services.vault.isUnlocked, services.vault.generation == generation,
          services.session.accountId == account, services.store === catalog,
          let current = try services.consumerSavedPhoto(photo.id),
          current.metadata == photo.metadata, current.manifest == photo.manifest else { throw CancellationError() }
        originalExports = urls
        sharedOriginal = ConsumerSharedOriginal(urls: urls)
        pendingExport = nil
      } catch is CancellationError {} catch { services.error = error.localizedDescription }
    }
  }
  private func restoreOriginal() {
    guard let photo = current, !preparingShare, saveTask == nil else { return }
    let account = services.session.accountId, generation = services.vault.generation, catalog = services.store
    let origin = BackgroundUploadPolicy.origin(services.api.baseURL), cards = services.session.pinnedCards
    let grant = receivedGrant
    preparingShare = true
    shareTask = Task {
      defer { preparingShare = false; shareTask = nil }
      @MainActor func check() throws {
        try Task.checkCancellation()
        guard services.vault.isUnlocked, services.vault.generation == generation,
          services.session.accountId == account, services.store === catalog,
          BackgroundUploadPolicy.origin(services.api.baseURL) == origin,
          services.session.pinnedCards == cards else { throw CancellationError() }
        if let grant {
          guard receivedCards == cards, services.isReceivedGrantCurrent(grant), services.received.contains(where: {
            $0.id == photo.id && $0.metadata == photo.metadata && $0.manifest == photo.manifest
          }) else { throw CancellationError() }
        } else {
          guard let current = try services.consumerSavedPhoto(photo.id),
            current.metadata == photo.metadata, current.manifest == photo.manifest else { throw CancellationError() }
        }
      }
      do {
        try check()
        let url = try await services.consumerMediaOriginal(photo, grant: grant)
        try await CameraMedia.restoreOriginalToPhotos(url, metadata: photo.metadata, check: check)
        feedback = "Original saved to Photos."
      } catch is CancellationError {} catch { services.error = error.localizedDescription }
    }
  }
  private func saveReceived() {
    guard let photo = current, let receivedGrant, services.isReceivedGrantCurrent(receivedGrant), saveTask == nil, !preparingShare else { return }
    saveTask = services.run(phase: .share) {
      defer {
        saveTask = nil
        if receivedUnavailable { dismiss() }
      }
      try await services.save(photo)
      try Task.checkCancellation()
      guard services.isReceivedGrantCurrent(receivedGrant) else { throw CancellationError() }
      savedReceivedIDs.insert(photo.id)
      feedback = "Saved in your Fotoro."
    }
  }
  private func scenePhaseChanged(_ phase: ScenePhase) {
    if phase == .background { cancelViewerWork() }
  }
  private func cancelViewerWork() {
    shareTask?.cancel()
    saveTask?.cancel()
    cleanupShare()
  }
  private func cleanupShare() {
    ConsumerShareExports.remove(originalExports)
    originalExports = []
    sharedOriginal = nil
  }
}

enum ConsumerShareExports {
  static func remove(_ urls: [URL]) {
    let temporary = FileManager.default.temporaryDirectory.standardizedFileURL
    for directory in Set(urls.map { $0.deletingLastPathComponent().standardizedFileURL }) {
      guard directory.lastPathComponent.hasPrefix("fotoro-share-"),
        directory.deletingLastPathComponent().path == temporary.path else { continue }
      try? FileManager.default.removeItem(at: directory)
    }
  }
}

private struct ConsumerSharedOriginal: Identifiable {
  let id = UUID()
  var urls: [URL]
}

private struct SavedPhotoPage: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  let receivedGrant: GrantV1?
  let receivedCards: [String: AccountCardV1]?
  let isCurrent: Bool
  @State private var loaded: LocalPhoto?
  @State private var failed = false
  @State private var retry = 0
  @State private var player: AVPlayer?
  @State private var playing = false
  @State private var motionTask: Task<Void, Never>?
  @State private var motionGeneration = UUID()
  @State private var motionExports: [URL] = []
  @State private var motionFailure: String?
  @Environment(\.scenePhase) private var scenePhase
  private var request: SavedPreviewReadIdentity {
    SavedPreviewReadIdentity(photo: photo, account: services.session.accountId,
      vault: services.vault.generation, catalog: ObjectIdentifier(services.store),
      grant: receivedGrant, cards: receivedCards, retry: retry)
  }
  private var displayed: LocalPhoto {
    guard let loaded, loaded.metadata == photo.metadata, loaded.manifest == photo.manifest else { return photo }
    return loaded
  }
  var body: some View {
    Group {
    if let player { VideoPlayer(player: player).accessibilityLabel(photo.metadata.filename) }
    else {
    LazyImage(url: displayed.previewURL ?? displayed.originalURL ?? photo.thumbnailURL) { state in
      ZStack(alignment: .bottom) {
        if let image = state.image { image.resizable().scaledToFit() }
        else if !failed && state.error == nil { ProgressView().tint(.white) }
        if failed || state.error != nil {
          VStack(spacing: 8) {
            Label("Preview unavailable", systemImage: "icloud.slash")
            Button("Try again") { retry += 1 }
              .accessibilityIdentifier("viewer.preview.retry")
          }.padding().background(.regularMaterial, in: .rect(cornerRadius: 16)).padding()
        }
      }
    }.id(retry).accessibilityLabel(photo.metadata.filename)
    }
    }.overlay(alignment: .bottom) {
      if CameraMedia.isMotion(photo.metadata.mediaType), player == nil {
        VStack {
          if let motionFailure { Text(motionFailure).font(.footnote).multilineTextAlignment(.center) }
          Button(playing ? "Opening original…" : photo.metadata.mediaType == CameraMedia.liveType ? "Play Live Photo" : "Play video", systemImage: "play.fill", action: play)
            .disabled(playing || !isCurrent).padding().background(.regularMaterial, in: .capsule)
        }.padding(.bottom, 70)
      }
    }
      .onChange(of: request) { cleanupMotion() }
      .onChange(of: isCurrent) { if !isCurrent { cleanupMotion() } }
      .onChange(of: scenePhase) { if scenePhase != .active { cleanupMotion() } }
      .onDisappear { cleanupMotion() }
      .task(id: request) {
        let identity = request
        failed = false
        loaded = nil
        do {
          if let receivedGrant {
            guard services.isReceivedGrantCurrent(receivedGrant), services.session.pinnedCards == receivedCards else { throw CancellationError() }
          }
          try await services.ensurePreview(photo)
          try Task.checkCancellation()
          guard request == identity else { throw CancellationError() }
          if let receivedGrant {
            guard services.isReceivedGrantCurrent(receivedGrant), services.session.pinnedCards == receivedCards,
              let current = services.received.first(where: { $0.id == photo.id && $0.metadata == photo.metadata && $0.manifest == photo.manifest })
            else { throw CancellationError() }
            loaded = current
          } else { loaded = try services.consumerSavedPhoto(photo.id) }
        } catch is CancellationError {} catch {
          if !Task.isCancelled, request == identity { failed = true }
        }
      }
  }
  private func play() {
    guard isCurrent, !playing, CameraMedia.isMotion(photo.metadata.mediaType) else { return }
    let identity = request, token = UUID()
    motionGeneration = token
    playing = true; motionFailure = nil
    motionTask = Task { @MainActor in
      var pending: [URL] = []
      defer { ConsumerShareExports.remove(pending); if request == identity, motionGeneration == token { playing = false; motionTask = nil } }
      do {
        let original = try await services.consumerMediaOriginal(photo, grant: receivedGrant)
        pending = [original]
        try Task.checkCancellation()
        guard isCurrent, request == identity, motionGeneration == token, scenePhase == .active else { throw CancellationError() }
        let urls = try await CameraMedia.exportOriginalFile(original, metadata: photo.metadata)
        pending = urls
        try Task.checkCancellation()
        guard isCurrent, request == identity, motionGeneration == token,
          receivedGrant.map(services.isReceivedGrantCurrent) ?? true,
          receivedGrant == nil || services.session.pinnedCards == receivedCards else { throw CancellationError() }
        let movie = photo.metadata.mediaType == CameraMedia.liveType ? urls[1] : urls[0]
        motionExports = urls; pending = []
        let next = AVPlayer(url: movie)
        player = next; next.play()
      } catch is CancellationError {} catch {
        if !Task.isCancelled, request == identity, motionGeneration == token { motionFailure = "The original cannot play here. You can still export its unchanged resources." }
      }
    }
  }
  private func cleanupMotion() {
    motionGeneration = UUID(); motionTask?.cancel(); motionTask = nil; playing = false
    player?.pause(); player = nil
    ConsumerShareExports.remove(motionExports); motionExports = []
  }

}

private struct SavedPreviewReadIdentity: Equatable {
  var photoID: String
  var metadata: PhotoMetadataV1
  var manifest: PhotoManifestV1
  var account: String?
  var vault: UUID
  var catalog: ObjectIdentifier
  var grant: GrantV1?
  var cards: [String: AccountCardV1]?
  var retry: Int
  init(photo: LocalPhoto, account: String?, vault: UUID, catalog: ObjectIdentifier,
    grant: GrantV1?, cards: [String: AccountCardV1]?, retry: Int) {
    photoID = photo.id; metadata = photo.metadata; manifest = photo.manifest
    self.account = account; self.vault = vault; self.catalog = catalog
    self.grant = grant; self.cards = cards; self.retry = retry
  }
}

private struct ReceivedPhotoDetails: View {
  let photo: LocalPhoto
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        Text(photo.metadata.filename)
        if let date = Wire.parseDate(photo.metadata.sourceDate) {
          Text(date.formatted(date: .complete, time: .shortened)).foregroundStyle(.secondary)
        }
        Text("Save to keep your own copy in Fotoro.").font(.footnote).foregroundStyle(.secondary)
      }.navigationTitle("Info").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }.presentationDetents([.medium, .large])
  }
}

struct SavedPhotoDetails: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  @State private var label = ""
  @FocusState private var labelFocused: Bool
  @Environment(\.dismiss) private var dismiss
  private var labels: [String] { services.annotation(photo).labels ?? [] }
  private var capture: PhotoCaptureMetadata? {
    PhotoCaptureFacts.read(services.annotation(photo).facts, originalSha256: photo.metadata.originalSha256)
  }
  private var namedPeople: [String] {
    Array(Set(PhotoPeopleFacts.read(services.annotation(photo).facts ?? [],
      originalSha256: photo.metadata.originalSha256).map(\.n))).sorted()
  }
  private var canAddLabel: Bool {
    !SearchNormalization.text(label).isEmpty && label.unicodeScalars.count <= 120 && labels.count < 64
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(photo.metadata.filename)
          if let date = Wire.parseDate(photo.metadata.sourceDate) {
            Text(date.formatted(date: .complete, time: .shortened)).foregroundStyle(.secondary)
            Text(photo.metadata.dateSource == "photos" ? "Date from Photos" :
              photo.metadata.dateSource == "exif" ? "Date from the original" : "Date imported · capture date unavailable")
              .font(.caption).foregroundStyle(.secondary)
          }
          if services.annotation(photo).favorite == true { Label("Favorite", systemImage: "heart.fill") }
        }
        if let capture { PhotoMetadataSections(metadata: capture) }
        if !namedPeople.isEmpty {
          Section("People you’ve named") {
            ForEach(namedPeople, id: \.self) { Text($0) }
            Text("Names you reviewed in Fotoro. A photo may include other people.")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
        Section("Labels") {
          ForEach(Array(labels.enumerated()), id: \.offset) { index, value in
            HStack {
              Text(value)
              Spacer()
              Button("Remove", systemImage: "minus.circle") {
                var next = labels
                next.remove(at: index)
                do { try services.setLabels(next, photo: photo) } catch { services.error = error.localizedDescription }
              }.labelStyle(.iconOnly).accessibilityLabel("Remove label \(value)")
            }
          }
          HStack {
            TextField("Add label", text: $label).autocorrectionDisabled()
              .focused($labelFocused).submitLabel(.done).onSubmit(addLabel)
            Button("Add", action: addLabel).disabled(!canAddLabel)
          }
        }
        if (try? services.annotations.ledger.state(photo.id)?.conflict) == true {
          Section("Changes on another device") {
            Text("Your edits are saved here. Choose which version to sync.")
            Button("Keep my changes") { services.run { try await services.resolveAnnotationConflict(photo, keepLocal: true) } }
            Button("Use the other device’s changes") { services.run { try await services.resolveAnnotationConflict(photo, keepLocal: false) } }
          }
        } else if (try? services.annotations.ledger.pendingIDs().contains(photo.id)) == true {
          Section {
            Text("Changes waiting to sync").font(.footnote).foregroundStyle(.secondary)
            Button("Sync changes") { Task { await services.syncAnnotations() } }
          }
        }
        if let caption = services.annotation(photo).caption { Section("Caption") { Text(caption) } }
        if let location = services.annotation(photo).location {
          Section("Location") {
            Text(location.displayName).textSelection(.enabled)
            if location.name != nil { Text(location.coordinates).foregroundStyle(.secondary) }
            Text(location.provenance).font(.caption).foregroundStyle(.secondary)
          }
        }
        if let ocr = services.annotation(photo).ocr, !ocr.text.isEmpty {
          Section("Text in this photo") { Text(ocr.text).textSelection(.enabled) }
        }
        if let message = services.annotations.errors[photo.id] { Text(message).font(.caption).foregroundStyle(.secondary) }
        if let error = services.error { Text(error).font(.caption).foregroundStyle(.secondary) }
      }.scrollDismissesKeyboard(.interactively)
        .navigationTitle("Info").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }.presentationDetents([.medium, .large])
  }
  private func addLabel() {
    guard canAddLabel else { return }
    do {
      try services.setLabels(labels + [label], photo: photo)
      label = ""
      labelFocused = false
    } catch { services.error = error.localizedDescription }
  }
}
