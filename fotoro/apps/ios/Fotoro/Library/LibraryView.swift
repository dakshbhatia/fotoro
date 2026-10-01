import NukeUI
import PhotosUI
import SwiftUI

struct LibraryView: View {
  @Bindable var services: AppServices
  @State private var query = ""
  @State private var selection: Set<String> = []
  @State private var showingFiles = false
  @State private var viewer: LocalPhoto?
  @State private var showExchange = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var scrollID: String?
  @State private var signingOut = false
  private let photoManager = PHCachingImageManager()
  var filtered: [LocalPhoto] {
    services.photos.filter {
      query.isEmpty || $0.metadata.filename.localizedCaseInsensitiveContains(query)
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
                    Button {
                      viewer = photo

                    } label: {
                      ZStack(alignment: .bottomTrailing) {
                        LazyImage(url: photo.thumbnailURL) { state in
                          if let image = state.image {
                            image.resizable().scaledToFill()
                          } else {
                            Rectangle().fill(.quaternary)
                          }
                        }.frame(height: 140).clipped()
                        if selection.contains(photo.id) {
                          Image(systemName: "checkmark.circle.fill").padding(8)
                        }
                      }
                    }.buttonStyle(.plain).id(photo.id).accessibilityLabel(photo.metadata.filename)
                      .onAppear {
                        if photo.id == services.photos.last?.id { try? services.loadMore() }
                      }
                      .contextMenu {
                        Button(selection.contains(photo.id) ? "Deselect" : "Select") {
                          if selection.contains(photo.id) {
                            selection.remove(photo.id)
                          } else {
                            selection.insert(photo.id)
                          }
                        }
                      }
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
                description: Text("Add JPEG or PNG originals to your library."))
            }
            ForEach(services.notices, id: \.self) { Text($0).font(.caption).padding() }
          }.scrollPosition(id: $scrollID, anchor: .top)
            .searchable(text: $query, prompt: "Search")
            .toolbar {
              ToolbarItem(placement: .topBarTrailing) {
                Menu("Add", systemImage: "plus") {
                  Button("Shared moments") { showExchange = true }
                  Button("Lock", systemImage: "lock") { services.vault.lock() }
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
                        try await services.importFiles([url])
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
      }.navigationTitle("Fotoro")
        .overlay { if services.busy { ProgressView().padding().glassEffect() } }
        .sheet(item: $viewer, onDismiss: { viewer = nil }) { photo in
          PhotoViewer(
            services: services, initialID: photo.id)
        }
        .sheet(isPresented: $showExchange) {
          ExchangeView(
            services: services, selected: services.photos.filter { selection.contains($0.id) })
        }
        .fileImporter(
          isPresented: $showingFiles, allowedContentTypes: [.jpeg, .png],
          allowsMultipleSelection: true
        ) { result in services.run { try await services.importFiles(result.get()) } }
        .onChange(of: selectedPhotos) { _, items in
          services.run {
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
            let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
            guard status == .authorized || status == .limited else {
              throw FotoroError("Allow access to the selected originals or import from Files")
            }
            let assets = PHAsset.fetchAssets(
              withLocalIdentifiers: selected.map { $0.resourceIdentifier }, options: nil)
            var cached: [PHAsset] = []
            assets.enumerateObjects { asset, _, _ in cached.append(asset) }
            photoManager.startCachingImages(
              for: cached, targetSize: CGSize(width: 320, height: 320), contentMode: .aspectFill,
              options: nil)
            defer { photoManager.stopCachingImagesForAllAssets() }
            services.notices = [
              "Downloading selected unmodified originals. iCloud photos may need network access."
            ]
            let photos = try await services.importer.importResources(
              selected, accountId: services.session.accountId!,
              bundle: services.vault.requireBundle())
            for photo in photos { try services.journal.enqueue(photo) }
            services.notices = await services.importer.failures.map { $0.message }
            services.notices += await services.importer.notices
            try services.reload()
          }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked {
            viewer = nil
            showExchange = false
            selection = []
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
}
