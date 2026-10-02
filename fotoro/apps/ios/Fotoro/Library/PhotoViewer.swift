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
  @State private var selected = ""
  @State private var zoom = PhotoViewerZoom()
  @State private var details: LocalPhoto?
  @State private var sharedOriginal: ConsumerSharedOriginal?
  @State private var originalExports: [URL] = []
  @State private var preparingShare = false
  @State private var shareTask: Task<Void, Never>?
  @Environment(\.dismiss) private var dismiss
  init(services: AppServices, initialID: String, displayedPhotos: [LocalPhoto]? = nil) {
    self.services = services
    self.initialID = initialID
    self.displayedPhotos = displayedPhotos
    _selected = State(initialValue: initialID)
  }
  private var photos: [LocalPhoto] { displayedPhotos ?? services.photos }
  private var current: LocalPhoto? { photos.first { $0.id == (selected.isEmpty ? initialID : selected) } }
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          Group {
            if shouldLoad(photo) { SavedPhotoPage(services: services, photo: photo) }
            else { Color.black }
          }.scaleEffect(zoom.scale)
            .gesture(MagnifyGesture().onChanged { zoom.change($0.magnification) }
              .onEnded { zoom.settle($0.magnification) })
            .onTapGesture(count: 2) { zoom.toggle() }
            .tag(photo.id)
        }
      }.tabViewStyle(.page(indexDisplayMode: .never)).background(.black)
        .onChange(of: selected) { zoom.reset() }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .bottomBar) {
            Button("Share", systemImage: "square.and.arrow.up", action: share)
              .disabled(preparingShare || current == nil)
          }
          ToolbarItem(placement: .bottomBar) {
            Button("Info", systemImage: "info.circle") { details = current }
          }
        }
        .overlay { if preparingShare { ProgressView("Preparing original…").padding().glassEffect() } }
        .sheet(item: $details) { SavedPhotoDetails(services: services, photo: $0) }
        .sheet(item: $sharedOriginal, onDismiss: cleanupShare) { original in
          OriginalShareSheet(urls: [original.url]) { _ in cleanupShare() }
        }
        .onChange(of: services.vault.generation) { shareTask?.cancel(); cleanupShare(); dismiss() }
        .onDisappear { shareTask?.cancel(); cleanupShare() }
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
          try await services.ensurePreview(photo)
          try Task.checkCancellation()
          loaded = try services.consumerSavedPhoto(photo.id)
        } catch is CancellationError {} catch { failed = true }
      }
  }
}

struct SavedPhotoDetails: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  @State private var label = ""
  @Environment(\.dismiss) private var dismiss
  private var labels: [String] { services.annotation(photo).labels ?? [] }
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
              }.labelStyle(.iconOnly)
            }
          }
          HStack {
            TextField("Add label", text: $label).autocorrectionDisabled()
            Button("Add") {
              do { try services.setLabels(labels + [label], photo: photo); label = "" }
              catch { services.error = error.localizedDescription }
            }.disabled(SearchNormalization.text(label).isEmpty || label.unicodeScalars.count > 120 || labels.count >= 64)
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
      }.navigationTitle("Info").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }.presentationDetents([.medium, .large])
  }
}
