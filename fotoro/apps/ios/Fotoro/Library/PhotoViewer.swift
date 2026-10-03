import NukeUI
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
  private var photos: [LocalPhoto] { displayedPhotos ?? (receivedGrant == nil ? services.photos : services.received) }
  private var current: LocalPhoto? { photos.first { $0.id == (selected.isEmpty ? initialID : selected) } }
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          Group {
            if shouldLoad(photo) { SavedPhotoPage(services: services, photo: photo, receivedGrant: receivedGrant, receivedCards: receivedCards) }
            else { Color.black }
          }.scaleEffect(zoom.scale)
            .gesture(MagnifyGesture().onChanged { zoom.change($0.magnification) }
              .onEnded { zoom.settle($0.magnification) })
          .onTapGesture(count: 2) { zoom.toggle() }
            .onTapGesture { controlsVisible.toggle() }
            .tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black)
        .onChange(of: selected) { zoom.reset(); feedback = nil }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .bottomBar) {
            Button("Info", systemImage: "info.circle") { details = current }
          }
          if receivedGrant != nil {
            ToolbarItem(placement: .bottomBar) {
              Button(current.map { savedReceivedIDs.contains($0.id) } == true ? "Saved" : "Save", systemImage: "icloud.and.arrow.up", action: saveReceived)
                .disabled(services.busy || current == nil || current.map { savedReceivedIDs.contains($0.id) } == true)
            }
          } else {
          ToolbarItem(placement: .bottomBar) {
            Menu("Share", systemImage: "square.and.arrow.up") {
              Button("Share in Fotoro") {
                if let current { sharedPhotos = SharedPhotosPresentation(photos: [current]) }
              }
              Button("Share original", action: share)
            }
              .disabled(preparingShare || current == nil)
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
          OriginalShareSheet(urls: [original.url]) { _ in cleanupShare() }
        }
        .overlay(alignment: .bottom) {
          if let feedback { Text(feedback).font(.footnote).padding().background(.regularMaterial, in: .capsule).padding(.bottom, 60) }
        }
        .onChange(of: services.vault.generation) { shareTask?.cancel(); saveTask?.cancel(); cleanupShare(); dismiss() }
        .onChange(of: services.selectedGrant) {
          if let receivedGrant, services.selectedGrant != receivedGrant { saveTask?.cancel(); dismiss() }
        }
        .onChange(of: services.session.pinnedCards) {
          if let receivedCards, services.session.pinnedCards != receivedCards { saveTask?.cancel(); dismiss() }
        }
        .onChange(of: services.consumerCatalogGeneration) {
          if receivedGrant == nil, !SavedPhotosPresentationPolicy.isCurrent(photos, lookup: services.consumerSavedPhoto) { dismiss() }
        }
        .onChange(of: scenePhase) { if scenePhase == .background { shareTask?.cancel(); saveTask?.cancel(); cleanupShare() } }
        .onDisappear { shareTask?.cancel(); saveTask?.cancel(); cleanupShare() }
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
        originalExports = [url]
        sharedOriginal = ConsumerSharedOriginal(url: url)
        pendingExport = nil
      } catch is CancellationError {} catch { services.error = error.localizedDescription }
    }
  }
  private func saveReceived() {
    guard let photo = current, let receivedGrant, services.selectedGrant == receivedGrant, saveTask == nil else { return }
    saveTask = services.run(phase: .share) {
      defer { saveTask = nil }
      try await services.save(photo)
      try Task.checkCancellation()
      guard services.selectedGrant == receivedGrant else { throw CancellationError() }
      savedReceivedIDs.insert(photo.id)
      feedback = "Saved in your Fotoro."
    }
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
  var url: URL
}

private struct SavedPhotoPage: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  let receivedGrant: GrantV1?
  let receivedCards: [String: AccountCardV1]?
  @State private var loaded: LocalPhoto?
  @State private var failed = false
  var body: some View {
    LazyImage(url: (loaded ?? photo).previewURL ?? (loaded ?? photo).originalURL ?? photo.thumbnailURL) { state in
      if let image = state.image { image.resizable().scaledToFit() }
      else if failed || state.error != nil {
        Label("Preview unavailable", systemImage: "icloud.slash").foregroundStyle(.white)
      }
      else { ProgressView().tint(.white) }
    }.accessibilityLabel(photo.metadata.filename)
      .task(id: photo.id) {
        do {
          if let receivedGrant {
            guard services.selectedGrant == receivedGrant, services.session.pinnedCards == receivedCards else { throw CancellationError() }
          }
          try await services.ensurePreview(photo)
          try Task.checkCancellation()
          if let receivedGrant {
            guard services.selectedGrant == receivedGrant, services.session.pinnedCards == receivedCards,
              let current = services.received.first(where: { $0.id == photo.id && $0.metadata == photo.metadata && $0.manifest == photo.manifest })
            else { throw CancellationError() }
            loaded = current
          } else { loaded = try services.consumerSavedPhoto(photo.id) }
        } catch is CancellationError {} catch { failed = true }
      }
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
          }
          if services.annotation(photo).favorite == true { Label("Favorite", systemImage: "heart.fill") }
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
