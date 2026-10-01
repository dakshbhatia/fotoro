import NukeUI
import PhotosUI
import SwiftUI

struct LibraryView: View {
  @Bindable var services: AppServices
  @State private var query = ""
  @State private var searchResults: [LocalPhoto]?
  @State private var selection: Set<String> = []
  @State private var showingFiles = false
  @State private var viewer: LocalPhoto?
  @State private var showExchange = false
  @State private var showingBackup = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var scrollID: String?
  @State private var signingOut = false
  private let photoManager = PHCachingImageManager()
  var filtered: [LocalPhoto] {
    if !query.isEmpty, let searchResults { return searchResults }
    return services.photos.filter {
      services.matches($0, query: query)
    }
  }
  var days: [(String, [LocalPhoto])] {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    let groups = Dictionary(grouping: filtered) { photo in
      formatter.string(from: Wire.parseDate(photo.metadata.sourceDate) ?? Date())
    }
    return groups.keys.sorted(by: >).map { ($0, groups[$0]!) }
  }
  var body: some View {
    NavigationStack {
      Group {
        if !services.vault.isUnlocked {
          AccountView(services: services)
        } else {
          ScrollView {
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3
            ) {
              ForEach(days, id: \.0) { day in
                Section {
                  ForEach(day.1) { photo in
                    LibraryPhotoCell(
                      photo: photo, isSelected: selection.contains(photo.id),
                      open: { viewer = photo },
                      toggleSelection: { toggleSelection(photoID: photo.id) },
                      appeared: { loadMoreIfNeeded(photoID: photo.id) }
                    ).id(photo.id)
                  }
                } header: {
                  Text(day.0).font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                }
              }
            }.scrollTargetLayout()
            if filtered.isEmpty {
              ContentUnavailableView(
                "No photos", systemImage: "photo",
                description: Text(query.isEmpty ? "Sync your photos to find them on every device." : "Try a label, filename or words in a photo."))
              if query.isEmpty { Button("Sync my photos") { showingBackup = true }.buttonStyle(.borderedProminent) }
            }
            ForEach(services.notices, id: \.self) { Text($0).font(.caption).padding() }
          }.scrollPosition(id: $scrollID, anchor: .top)
            .searchable(text: $query, prompt: "Search")
            .task(id: query) {
              guard !query.isEmpty else { searchResults = nil; return }
              do { searchResults = try await services.searchCatalog(query) }
              catch is CancellationError {} catch { services.error = error.localizedDescription }
            }
            .toolbar {
              ToolbarItem(placement: .topBarLeading) {
                Button("Sync photos", systemImage: "arrow.triangle.2.circlepath") {
                  showingBackup = true
                }
              }
              ToolbarItem(placement: .topBarTrailing) {
                Menu("Add", systemImage: "plus") {
                  Button("Shared moments") { showExchange = true }
                  Button("Lock", systemImage: "lock") { services.lockAccount() }
                  Button("Sign out", systemImage: "person.crop.circle.badge.xmark") {
                    signingOut = true
                  }
                  Button("Files") { showingFiles = true }
                  PhotosPicker(
                    "Photos", selection: $selectedPhotos, maxSelectionCount: 100, matching: .images)
                  #if DEBUG
                    Button("Public sample") {
                      services.run {
                        guard
                          let url = Bundle.main.url(forResource: "singapore", withExtension: "jpg")
                        else { throw FotoroError("Sample missing") }
                        try await services.importFiles([url], publicSample: true)
                      }
                    }
                  #endif
                }
              }
              if !selection.isEmpty {
                ToolbarItem(placement: .bottomBar) {
                  Button("Share \(selection.count)", systemImage: "square.and.arrow.up") {
                    showExchange = true
                  }
                }
              }
            }
        }
      }.navigationTitle("Saved photos")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .overlay { if services.busy { ProgressView().padding().glassEffect() } }
        .sheet(item: $viewer, onDismiss: { viewer = nil }) { photo in
          PhotoViewer(
            services: services, initialID: photo.id, displayedPhotos: filtered)
        }
        .onChange(of: scenePhase) {
          if scenePhase != .active { services.backup.pause() }
          else if services.vault.isUnlocked { services.run { try await services.sync() } }
        }
        .sheet(isPresented: $showingBackup) { PhotosBackupView(services: services) }
        .sheet(isPresented: $showExchange) {
          ExchangeView(
            services: services, selected: services.photos.filter { selection.contains($0.id) })
        }
        .fileImporter(
          isPresented: $showingFiles, allowedContentTypes: [.jpeg, .png, .heic],
          allowsMultipleSelection: true
        ) { result in services.run { try await services.importFiles(result.get()) } }
        .onChange(of: selectedPhotos) { _, items in
          services.run {
            guard
              NativeBackupPolicy.allowsPrivatePhotos(
                accountId: services.session.accountId, fixture: services.session.fixture)
            else {
              throw FotoroError(
                "Public test accounts cannot import your Photos library. Use a real account.")
            }
            let selected = items.compactMap { item in
              item.itemIdentifier.map {
                SelectedResource(
                  id: Wire.id(), origin: .photos, resourceIdentifier: $0, fileURL: nil)
              }
            }
            guard selected.count == items.count else {
              throw FotoroError(
                "Original Photos identifiers unavailable; select an original from Files")
            }
            try await services.importPhotos(selected)
          }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked {
            viewer = nil
            showExchange = false
            showingBackup = false
            selection = []
            searchResults = nil
          }
        }
        .alert("Sign out?", isPresented: $signingOut) {
          Button("Sign out and remove local data", role: .destructive) {
            services.run { try services.signOut(discardPending: true) }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text(
            "Pending unsent imports, account wrappers, and local photo caches will be removed from this iPhone."
          )
        }
        .alert(
          "Fotoro",
          isPresented: Binding(
            get: { services.error != nil }, set: { if !$0 { services.error = nil } })
        ) {
          Button("OK") { services.error = nil }
        } message: {
          Text(services.error ?? "")
        }
    }
  }

  private func loadMoreIfNeeded(photoID: String) {
    if photoID == services.photos.last?.id { try? services.loadMore() }
  }

  private func toggleSelection(photoID: String) {
    if selection.contains(photoID) {
      selection.remove(photoID)
    } else {
      selection.insert(photoID)
    }
  }
}

private struct LibraryPhotoCell: View {
  let photo: LocalPhoto
  let isSelected: Bool
  let open: () -> Void
  let toggleSelection: () -> Void
  let appeared: () -> Void

  var body: some View {
    Button(action: open) {
      ZStack(alignment: .bottomTrailing) {
        GeometryReader { geometry in
          LazyImage(url: photo.thumbnailURL) { state in
            if let image = state.image {
              image.resizable().scaledToFill()
            } else {
              Rectangle().fill(.quaternary)
            }
          }.frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        if isSelected {
          Image(systemName: "checkmark.circle.fill").padding(8)
        }
      }.aspectRatio(1, contentMode: .fit)
    }.buttonStyle(.plain).accessibilityLabel(photo.metadata.filename)
      .onAppear(perform: appeared)
      .contextMenu {
        Button(isSelected ? "Deselect" : "Select", action: toggleSelection)
      }
  }
}
