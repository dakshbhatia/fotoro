#if !FOTORO_LOCAL_PREVIEW
import NukeUI
#endif
import SwiftUI

struct LocalSearchView: View {
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  var choseMeaning: () -> Void = {}
  var inspect: (RecentPhoto) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      SearchAlternatives(search: search, selected: choseMeaning)
      if search.matchingPhotos.isEmpty {
        ContentUnavailableView("No photos found", systemImage: "magnifyingglass", description: Text("Try a label, a date or words in a photo."))
      } else {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
          ForEach(search.matchingPhotos) { photo in
            Button { inspect(photo) } label: {
              GeometryReader { geometry in
                PhotosImage(photo: photo, store: photos, networkAllowed: false).scaledToFill()
                  .frame(width: geometry.size.width, height: geometry.size.height).clipped()
              }.aspectRatio(1, contentMode: .fit)
            }.buttonStyle(.plain)
          }
        }
      }
      if search.indexing {
        Label("Preparing photo search…", systemImage: "text.viewfinder")
          .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
      }
      if let error = search.error { Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
    }
  }
}

struct SearchAlternatives: View {
  let search: LocalSearchStore
  var selected: () -> Void = {}
  var body: some View {
    if !search.response.alternatives.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack {
          ForEach(search.response.alternatives) { alternative in
            Button(alternative.display) {
              search.accept(alternative)
              selected()
            }.buttonStyle(.bordered)
          }
        }.padding(.horizontal)
      }.accessibilityLabel("Other matches")
    }
  }
}

#if !FOTORO_LOCAL_PREVIEW
struct ConsumerSearchResultsView: View {
  let hits: [ConsumerSearchHit]
  let saved: [String: LocalPhoto]
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  let inspectDevice: (RecentPhoto) -> Void
  let inspectSaved: (LocalPhoto) -> Void
  let choseAlternative: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      SearchAlternatives(search: search, selected: choseAlternative)
      if hits.isEmpty {
        ContentUnavailableView("No photos found", systemImage: "magnifyingglass", description: Text("Try a label, a date or words in a photo."))
      } else {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
          ForEach(hits) { hit in
            ConsumerSearchCell(hit: hit, saved: saved, search: search, photos: photos,
              inspectDevice: inspectDevice, inspectSaved: inspectSaved)
          }
        }
      }
      if search.indexing {
        Label("Preparing photo search…", systemImage: "text.viewfinder")
          .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
      }
      if let error = search.error {
        Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal)
      }
    }
  }
}

private struct ConsumerSearchCell: View {
  let hit: ConsumerSearchHit
  let saved: [String: LocalPhoto]
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  let inspectDevice: (RecentPhoto) -> Void
  let inspectSaved: (LocalPhoto) -> Void
  var body: some View {
    switch hit.photo {
    case .device(let id):
      if let photo = search.assets[id] {
        Button { inspectDevice(photo) } label: {
          GeometryReader { geometry in
            PhotosImage(photo: photo, store: photos, networkAllowed: false).scaledToFill()
              .frame(width: geometry.size.width, height: geometry.size.height).clipped()
          }.aspectRatio(1, contentMode: .fit)
        }.buttonStyle(.plain)
      }
    case .saved(let id):
      if let photo = saved[id] {
        Button { inspectSaved(photo) } label: {
          GeometryReader { geometry in
            LazyImage(url: photo.thumbnailURL ?? photo.previewURL) { state in
              if let image = state.image { image.resizable().scaledToFill() }
              else { Rectangle().fill(.quaternary).overlay { Image(systemName: "photo") } }
            }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
          }.aspectRatio(1, contentMode: .fit)
        }.buttonStyle(.plain).accessibilityLabel(photo.metadata.filename)
      }
    }
  }
}

#endif

struct LocalPhotoDetails: View {
  let photo: RecentPhoto
  let search: LocalSearchStore?
  @State private var labels: [String] = []
  @State private var label = ""
  @FocusState private var labelFocused: Bool
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      List {
        if let date = photo.capturedAt {
          Text(date.formatted(date: .complete, time: .shortened))
        } else {
          Text("Capture date unavailable").foregroundStyle(.secondary)
        }
        if photo.isFavorite { Label("Favorite", systemImage: "heart.fill") }
        if photo.isScreenshot { Label("Screenshot", systemImage: "rectangle.on.rectangle") }
        if photo.isLivePhoto { Label("Live Photo · still preview", systemImage: "livephoto") }
        if let location = photo.location { Label(location, systemImage: "location") }
        if let search {
          Section("Labels") {
            ForEach(Array(labels.enumerated()), id: \.offset) { at, value in
              HStack {
                Text(value)
                Spacer()
                Button("Remove", systemImage: "minus.circle") {
                  var proposed = labels
                  proposed.remove(at: at)
                  if search.setLabels(proposed, photoID: photo.id) { labels = proposed }
                }.labelStyle(.iconOnly).disabled(!search.canEditLabels(photo.id))
              }
            }
            HStack {
              TextField("Add label", text: $label).autocorrectionDisabled().focused($labelFocused)
              Button("Add") {
                let proposed = labels + [label]
                if search.setLabels(proposed, photoID: photo.id) {
                  labels = proposed
                  label = ""
                  labelFocused = false
                }
              }
              .disabled(SearchNormalization.text(label).isEmpty || label.unicodeScalars.count > 120 || labels.count >= 64 || !search.canEditLabels(photo.id))
            }
            if !search.canEditLabels(photo.id) {
              Text("The local index is preparing this photo.").font(.caption).foregroundStyle(
                .secondary)
            }
            Text(
              "Add words that help you find this photo."
            ).font(.caption).foregroundStyle(.secondary)
          }
          if let error = search.error { Text(error).font(.caption).foregroundStyle(.secondary) }
          if let meaning = search.response.meaning,
            search.matchingPhotos.contains(where: { $0.id == photo.id })
          {
            Section("Search") {
              Text(meaning.display)
              if let hit = search.response.results.first(where: { $0.id == photo.id || $0.children.contains(photo.id) }) {
                Text(hit.reason).font(.caption).foregroundStyle(.secondary)
              }
              DisclosureGroup("Improve this match") {
                Button("This matches my search") { search.confirm(photo.id) }
                Button("Show this photo first") { search.pin(photo.id) }
              }
            }
          }
        }
      }.navigationTitle("Photo details").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
    }.onAppear { labels = search?.labels(photo.id) ?? [] }
      .onChange(of: search?.canEditLabels(photo.id) ?? false) {
        labels = search?.labels(photo.id) ?? []
      }
      .presentationDetents([.medium, .large])
  }
}
