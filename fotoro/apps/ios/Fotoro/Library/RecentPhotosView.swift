import Photos
import SwiftUI
import UIKit

struct PhotosImage: View {
  let photo: RecentPhoto
  let store: RecentPhotosStore
  var large = false
  @State private var image: UIImage?
  @State private var request: PHImageRequestID?
  @State private var generation = UUID()
  @State private var active = false
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable()
      } else {
        Rectangle().fill(.quaternary).overlay { ProgressView() }
      }
    }
    .task(id: photo.id) {
      if let request { store.images.cancelImageRequest(request) }
      let token = UUID()
      generation = token
      active = true
      let options = PHImageRequestOptions()
      options.isNetworkAccessAllowed = true
      options.deliveryMode = .opportunistic
      request = store.images.requestImage(
        for: photo.asset,
        targetSize: large ? CGSize(width: 1800, height: 1800) : CGSize(width: 360, height: 360),
        contentMode: large ? .aspectFit : .aspectFill, options: options
      ) { value, info in
        guard (info?[PHImageCancelledKey] as? Bool) != true else { return }
        Task { @MainActor in
          guard active, generation == token else { return }
          if let value { image = value }
        }
      }
    }
    .onDisappear {
      active = false
      generation = UUID()
      if let request { store.images.cancelImageRequest(request) }
      image = nil
    }
    .accessibilityLabel(photo.capturedAt?.formatted(date: .complete, time: .shortened) ?? "Photo")
  }
}

struct OriginalShareSheet: UIViewControllerRepresentable {
  let urls: [URL]
  let completed: () -> Void
  func makeUIViewController(context: Context) -> UIActivityViewController {
    let controller = UIActivityViewController(activityItems: urls, applicationActivities: nil)
    controller.completionWithItemsHandler = { _, _, _, _ in completed() }
    return controller
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct RecentPhotoViewer: View {
  let store: RecentPhotosStore
  let photos: [RecentPhoto]
  let initialID: String
  var share: (RecentPhoto) -> Void
  @State private var selected = ""
  @State private var scale: CGFloat = 1
  @State private var details = false
  @Environment(\.dismiss) private var dismiss
  func shouldLoad(_ photo: RecentPhoto) -> Bool {
    guard let index = photos.firstIndex(where: { $0.id == photo.id }),
      let current = photos.firstIndex(where: { $0.id == (selected.isEmpty ? initialID : selected) })
    else { return false }
    return RecentPhotosPolicy.shouldLoadPage(index, current: current)
  }
  var current: RecentPhoto? { photos.first { $0.id == selected } }
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          Group {
            if shouldLoad(photo) {
              PhotosImage(photo: photo, store: store, large: true).scaledToFit()
            } else {
              Color.black
            }
          }
          .scaleEffect(scale).gesture(
            MagnifyGesture().onChanged { scale = min(5, max(1, $0.magnification)) }
          )
          .onTapGesture(count: 2) { scale = scale == 1 ? 2 : 1 }.tag(photo.id)
        }
      }.tabViewStyle(.page).background(.black).onAppear { selected = initialID }
        .onChange(of: selected) { scale = 1 }
        .toolbar {
          ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
          ToolbarItem(placement: .bottomBar) {
            Button("Info", systemImage: "info.circle") { details.toggle() }
          }
          ToolbarItem(placement: .bottomBar) {
            Button("Share", systemImage: "square.and.arrow.up") {
              if let current { share(current) }
            }
          }
        }
        .sheet(isPresented: $details) {
          if let current {
            List {
              if let date = current.capturedAt {
                Text(date.formatted(date: .complete, time: .shortened))
              }
              if current.isFavorite { Label("Favorite", systemImage: "heart.fill") }
              if current.isScreenshot { Label("Screenshot", systemImage: "rectangle.on.rectangle") }
              if current.isLivePhoto {
                Label("Live Photo · still preview", systemImage: "livephoto")
              }
              if let location = current.location { Label(location, systemImage: "location") }
            }.presentationDetents([.medium])
          }
        }
    }
  }
}

struct RecentPhotosView: View {
  @State private var store = RecentPhotosStore()
  @State private var query = ""
  @State private var selected: Set<String> = []
  @State private var selecting = false
  @State private var pendingShare: RecentPhoto?
  @State private var pendingBackup = false
  @Environment(\.scenePhase) private var scenePhase
  @State private var viewer: RecentPhoto?
  @State private var sharing: [URL] = []
  @State private var showShare = false
  @State private var settings = false
  @State private var services: AppServices?
  @State private var preparingShare = false
  var visible: [RecentPhoto] {
    store.photos.filter { query.isEmpty || $0.searchText.localizedCaseInsensitiveContains(query) }
  }
  var body: some View {
    NavigationStack {
      Group {
        if !store.opened {
          VStack(spacing: 18) {
            Image(systemName: "photo.on.rectangle").font(.system(size: 44))
            Text("Your last 30 days").font(.title2)
            Text("Browse photos on this iPhone.").foregroundStyle(.secondary)
            Button("Open Photos") { Task { await store.open() } }.buttonStyle(.borderedProminent)
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !RecentPhotosPolicy.canRead(store.status) {
          ContentUnavailableView {
            Label("Photos access is off", systemImage: "photo")
          } description: {
            Text("Allow selected photos or full access in Settings to browse here.")
          } actions: {
            Button("Open Settings") {
              UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
            }
          }
        } else {
          ScrollView {
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3
            ) {
              ForEach(visible) { photo in
                Button {
                  if selecting { toggleSelection(photo) } else { viewer = photo }
                } label: {
                  GeometryReader { geometry in
                    PhotosImage(photo: photo, store: store).scaledToFill()
                      .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                  }.aspectRatio(1, contentMode: .fit)
                    .overlay(alignment: .bottomTrailing) {
                      if selected.contains(photo.id) {
                        Image(systemName: "checkmark.circle.fill").padding(8)
                      }
                    }
                }.buttonStyle(.plain).id(photo.id)
                  .onAppear { store.cache([photo.asset], start: true) }
                  .onDisappear { store.cache([photo.asset], start: false) }
                  .contextMenu {
                    Button(selected.contains(photo.id) ? "Deselect" : "Select") {
                      if selected.contains(photo.id) {
                        selected.remove(photo.id)
                      } else {
                        selected.insert(photo.id)
                      }
                    }
                  }
              }
            }
            if visible.isEmpty {
              ContentUnavailableView("No photos in the last 30 days", systemImage: "photo")
            }
            if store.status == .limited {
              Text("Showing photos you’ve allowed.").font(.caption).foregroundStyle(.secondary)
                .padding()
            }
          }
        }
      }.navigationTitle("Fotoro")
        .toolbar {
          if store.opened, !store.photos.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
              Button(selecting ? "Done" : "Select") {
                selecting.toggle()
                if !selecting { selected.removeAll() }
              }.disabled(preparingShare)
            }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button("Settings", systemImage: "gearshape") { settings = true }
          }
        }
        .safeAreaInset(edge: .bottom) {
          if store.opened, RecentPhotosPolicy.canRead(store.status) {
            HStack {
              TextField("Search", text: $query).textFieldStyle(.plain)
              if !selected.isEmpty {
                Button("Share", systemImage: "square.and.arrow.up") {
                  share(store.photos.filter { selected.contains($0.id) })
                }.disabled(preparingShare || showShare)
              }
              Button(action: addPhotos) { Image(systemName: "plus") }
                .accessibilityLabel("Add photos")
            }.padding().glassEffect(.regular.interactive()).padding(.horizontal)
          }
        }
        .overlay {
          if preparingShare { ProgressView("Preparing originals…").padding().glassEffect() }
        }
        .sheet(
          item: $viewer,
          onDismiss: {
            if let photo = pendingShare {
              pendingShare = nil
              share([photo])
            }
          }
        ) { photo in
          RecentPhotoViewer(store: store, photos: visible, initialID: photo.id) { photo in
            pendingShare = photo
            viewer = nil
          }
        }
        .sheet(isPresented: $showShare, onDismiss: cleanupShare) {
          OriginalShareSheet(urls: sharing, completed: cleanupShare)
        }
        .sheet(
          isPresented: $settings,
          onDismiss: {
            if pendingBackup {
              pendingBackup = false
              do {
                services = try AppServices()
              } catch { store.error = error.localizedDescription }
            }
          }
        ) {
          NavigationStack {
            List {
              Text("Photos stay in your library. Fotoro does not upload them while you browse.")
              Button("Sync photos") {
                pendingBackup = true
                settings = false
              }
              if store.opened {
                Button("Refresh last 30 days") {
                  store.refresh()
                  settings = false
                }
              }
            }.navigationTitle("Settings")
          }
        }
        .onChange(of: scenePhase) {
          if scenePhase == .active { store.refresh() } else { services?.backup.pause() }
        }
        .sheet(item: $services) { service in LibraryView(services: service) }
        .alert(
          "Fotoro",
          isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })
        ) {
          Button("OK") { store.error = nil }
        } message: {
          Text(store.error ?? "")
        }
    }
  }
  func toggleSelection(_ photo: RecentPhoto) {
    if selected.contains(photo.id) { selected.remove(photo.id) } else { selected.insert(photo.id) }
  }
  func addPhotos() {
    if store.status == .limited {
      guard
        let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
        var controller = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController
      else { return }
      while let presented = controller.presentedViewController { controller = presented }
      PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { _ in
        Task { @MainActor in store.refresh() }
      }
    } else {
      store.refresh()
    }
  }
  func share(_ photos: [RecentPhoto]) {
    guard !preparingShare, !showShare, !photos.isEmpty else { return }
    preparingShare = true
    Task {
      defer { preparingShare = false }
      do {
        sharing = try await store.shareOriginals(photos)
        showShare = true
      } catch { store.error = error.localizedDescription }
    }
  }
  func cleanupShare() {
    let roots = Set(sharing.map { $0.deletingLastPathComponent().deletingLastPathComponent() })
    for root in roots { try? FileManager.default.removeItem(at: root) }
    showShare = false
    sharing = []
  }
}
