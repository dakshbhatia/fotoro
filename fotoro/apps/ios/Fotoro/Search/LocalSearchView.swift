import SwiftUI

struct LocalSearchView: View {
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  var choseMeaning: () -> Void = {}
  var inspect: (RecentPhoto) -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let meaning = search.response.meaning {
        HStack {
          VStack(alignment: .leading) {
            Text(meaning.display).font(.title2)
            Text(meaning.reason).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button(search.acceptedMeaningID == meaning.id ? "Chosen" : "Choose meaning") {
            search.accept(meaning)
            choseMeaning()
          }
          .disabled(search.acceptedMeaningID == meaning.id).buttonStyle(.bordered)
        }
        if let photo = search.displayedPhoto, let hit = search.displayedHit {
          Button {
            inspect(photo)
          } label: {
            PhotosImage(photo: photo, store: photos, large: true, networkAllowed: false)
              .scaledToFit().frame(maxWidth: .infinity).frame(height: 310)
          }.buttonStyle(.plain).accessibilityLabel("Inspect result")
          Text(hit.reason).font(.caption).foregroundStyle(.secondary)
          if !hit.previewAvailable {
            Text("Preview may be unavailable on this device.").font(.caption).foregroundStyle(
              .secondary)
          }
          HStack {
            Button("Previous", systemImage: "chevron.left") { search.move(-1) }.labelStyle(
              .iconOnly)
            Text(
              "\((search.response.results.firstIndex(where:{$0.id==hit.id}) ?? 0)+1) of \(search.response.results.count)"
            )
            .font(.caption).monospacedDigit()
            Button("Next", systemImage: "chevron.right") { search.move(1) }.labelStyle(.iconOnly)
            Spacer()
            Button("This is the photo") { search.confirm(photo.id) }.buttonStyle(.bordered)
          }
          if !hit.children.isEmpty {
            Text("\(hit.children.count+1) photos in this burst · open to browse").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        if !search.response.alternatives.isEmpty {
          Text("Other meanings").font(.caption).foregroundStyle(.secondary)
          ForEach(search.response.alternatives) { alternative in
            Button {
              search.accept(alternative)
              choseMeaning()
            } label: {
              HStack {
                Text(alternative.display)
                Spacer()
                Text(alternative.reason).font(.caption).foregroundStyle(.secondary)
              }
            }.buttonStyle(.bordered)
          }
        }
      } else {
        ContentUnavailableView(
          "No supported match", systemImage: "magnifyingglass",
          description: Text("Labels, metadata and available text are searched locally."))
      }
      HStack {
        if search.indexing { ProgressView().controlSize(.mini) }
        Text(
          "\(search.response.total) permitted photos · text checked in \(search.response.indexed) · \(search.response.availablePreviews) local previews"
        )
        .font(.caption).foregroundStyle(.secondary)
      }
      if let error = search.error { Text(error).font(.caption).foregroundStyle(.secondary) }
    }.padding().gesture(
      DragGesture(minimumDistance: 40).onEnded {
        if abs($0.translation.width) > abs($0.translation.height) {
          search.move($0.translation.width < 0 ? 1 : -1)
        }
      })
  }
}

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
          Section("Supplied labels") {
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
              .disabled(SearchNormalization.text(label).isEmpty || !search.canEditLabels(photo.id))
            }
            if !search.canEditLabels(photo.id) {
              Text("The local index is preparing this photo.").font(.caption).foregroundStyle(
                .secondary)
            }
            Text(
              "Your labels associate words with this photo. Names are not detected face identity."
            ).font(.caption).foregroundStyle(.secondary)
          }
          if let error = search.error { Text(error).font(.caption).foregroundStyle(.secondary) }
          if let meaning = search.response.meaning,
            search.matchingPhotos.contains(where: { $0.id == photo.id })
          {
            Section(meaning.display) {
              Button("This is the photo") { search.confirm(photo.id) }
              Button("Use as representative") { search.pin(photo.id) }
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
