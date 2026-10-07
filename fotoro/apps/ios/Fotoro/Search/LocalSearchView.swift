#if !FOTORO_LOCAL_PREVIEW
import NukeUI
#endif
import SwiftUI

struct LocalSearchView: View {
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  var review: PhotoPicksSnapshot? = nil
  var choseMeaning: () -> Void = {}
  var selectedIDs: Set<String> = []
  var selecting = false
  var toggleSelection: ((RecentPhoto) -> Void)? = nil
  var inspect: (RecentPhoto) -> Void
  private var matches: [RecentPhoto] {
    guard let review else { return search.matchingPhotos }
    return search.matchingPhotos.filter { review.recommendations.ids.contains("device:" + $0.id) }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      SearchAlternatives(search: search, selected: choseMeaning)
      SearchAnalysisActions(search: search)
      if matches.isEmpty {
        SearchEmptyResults(search: search, finished: search.hasCurrentResponse, reviewing: review != nil)
      } else {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
          ForEach(matches) { photo in
            Button {
              if selecting, let toggleSelection { toggleSelection(photo) }
              else { inspect(photo) }
            } label: {
              VStack(alignment: .leading, spacing: 0) {
                GeometryReader { geometry in
                  PhotosImage(photo: photo, store: photos, networkAllowed: false).scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                }.aspectRatio(1, contentMode: .fit)
                  .overlay(alignment: .bottomTrailing) {
                    if selectedIDs.contains(photo.id) {
                      Image(systemName: "checkmark.circle.fill").padding(8)
                    }
                  }
                if let reasons = review?.recommendations.reasons["device:" + photo.id] {
                  Text(reasons.prefix(2).joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).padding(8)
                }
              }
            }.buttonStyle(.plain).accessibilityValue(selectedIDs.contains(photo.id) ? "Selected" : "")
              .contextMenu {
                if let toggleSelection {
                  Button(selectedIDs.contains(photo.id) ? "Deselect" : "Select") { toggleSelection(photo) }
                }
              }
          }
        }
      }
      if !matches.isEmpty, search.searching || search.indexing {
        SearchProgressFeedback(search: search).padding(.horizontal)
      }
      if let error = search.error { Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal) }
    }
  }
}

private struct SearchAnalysisActions: View {
  let search: LocalSearchStore
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if search.analysisRemaining > 0 {
        Text("\(search.analysisRemaining) matching photos unattempted").font(.caption).foregroundStyle(.secondary)
        Button("Next batch", systemImage: "arrow.forward") { search.analyzeMetadataMatches(nextBatch: true) }
          .accessibilityIdentifier("search.analysis.next")
      } else if search.hasSearch || search.analysisUnavailable > 0 {
        Button(search.analysisUnavailable > 0 ? "Retry unavailable photos" : "Analyze metadata matches", systemImage: "text.viewfinder") { search.analyzeMetadataMatches() }
          .accessibilityIdentifier("search.analysis.matches")
        Text("Check up to 500 permitted photos matching this date and metadata search. Older OCR and visual results remain searchable.")
          .font(.caption).foregroundStyle(.secondary)
      }
      if search.analysisUnavailable > 0 {
        Text("\(search.analysisUnavailable) photos have incomplete analysis. Retry after the remaining batches.")
          .font(.caption).foregroundStyle(.secondary)
      }
    }.disabled(search.indexing || !search.canAnalyzeMetadataMatches).padding(.horizontal)
  }
}

private struct SearchEmptyResults: View {
  let search: LocalSearchStore
  var searchPending = false
  var finished = true
  var reviewing = false
  var body: some View {
    if searchPending || search.searching || search.indexing {
      SearchProgressFeedback(search: search, searchPending: searchPending)
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    } else if search.error != nil {
      ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
    } else if !finished {
      ContentUnavailableView("Search paused", systemImage: "magnifyingglass")
    } else {
      ContentUnavailableView(reviewing ? "No suggestions" : "No photos found", systemImage: "magnifyingglass",
        description: Text(reviewing ? "Use All matches to review every photo." : "Try a label, a date or words in a photo."))
    }
  }
}

private struct SearchProgressFeedback: View {
  let search: LocalSearchStore
  var searchPending = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ProgressView(searchPending || search.searching ? "Searching photos…" : "Preparing photo search…")
      if search.indexing, let progress = search.analysisProgress {
        Text("\(progress.processed) of \(progress.total) photos attempted")
      }
    }.font(.caption).foregroundStyle(.secondary)
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
  var searchPending: Bool = false
  var review: PhotoPicksSnapshot? = nil
  var selected: Set<ConsumerPhotoReference> = []
  var selecting = false
  var toggleDevice: ((RecentPhoto) -> Void)? = nil
  var toggleSaved: ((LocalPhoto) -> Void)? = nil
  let inspectDevice: (RecentPhoto) -> Void
  let inspectSaved: (LocalPhoto) -> Void
  let choseAlternative: () -> Void
  var editPeople: () -> Void = {}
  var selectResults: (() -> Void)?
  private var matches: [ConsumerSearchHit] {
    guard let review else { return hits }
    return hits.filter { review.recommendations.ids.contains($0.id) }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !search.peopleSelection.isEmpty {
        SearchPeopleSummary(search: search, edit: editPeople)
      }
      SearchAlternatives(search: search, selected: choseAlternative)
      SearchAnalysisActions(search: search)
      if matches.isEmpty {
        SearchEmptyResults(search: search, searchPending: searchPending, reviewing: review != nil)
      } else {
        if let selectResults {
          Button("Select results", systemImage: "checkmark.circle", action: selectResults)
            .padding(.horizontal).accessibilityIdentifier("search.selectResults")
        }
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 2), spacing: 3) {
          ForEach(matches) { hit in
            ConsumerSearchCell(hit: hit, saved: saved, search: search, photos: photos,
              reasons: review?.recommendations.reasons[hit.id] ?? [],
              selected: selected.contains(hit.photo), selecting: selecting,
              toggleDevice: toggleDevice, toggleSaved: toggleSaved,
              inspectDevice: inspectDevice, inspectSaved: inspectSaved)
          }
        }
      }
      if !matches.isEmpty, searchPending || search.searching || search.indexing {
        SearchProgressFeedback(search: search, searchPending: searchPending).padding(.horizontal)
      }
      if let error = search.error {
        Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal)
      }
    }
  }
}

private struct SearchPeopleSummary: View {
  let search: LocalSearchStore
  let edit: () -> Void
  private var names: String {
    search.peopleSelection.canonicalIDs.map { search.selectedPeopleNames[$0] ?? "Selected person" }.joined(separator: ", ")
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Button(search.peopleSelection.match.title, systemImage: "person.2", action: edit)
          .accessibilityIdentifier("search.people.edit")
        Spacer()
        Button("Clear people") { search.setPeopleSelection(PeopleSearchSelection()) }
          .accessibilityIdentifier("search.people.clear")
      }
      Text(names).font(.subheadline)
      if search.peopleSelection.match == .everyone {
        Text("Confirmed together in each photo.").font(.caption).foregroundStyle(.secondary)
      }
    }.padding(.horizontal)
  }
}

private struct ConsumerSearchCell: View {
  let hit: ConsumerSearchHit
  let saved: [String: LocalPhoto]
  let search: LocalSearchStore
  let photos: RecentPhotosStore
  let reasons: [String]
  let selected: Bool
  let selecting: Bool
  let toggleDevice: ((RecentPhoto) -> Void)?
  let toggleSaved: ((LocalPhoto) -> Void)?
  let inspectDevice: (RecentPhoto) -> Void
  let inspectSaved: (LocalPhoto) -> Void
  var body: some View {
    switch hit.photo {
    case .device(let id):
      if let photo = search.assets[id] {
        Button {
          if selecting, let toggleDevice { toggleDevice(photo) }
          else { inspectDevice(photo) }
        } label: {
          VStack(alignment: .leading, spacing: 0) {
            GeometryReader { geometry in
              PhotosImage(photo: photo, store: photos, networkAllowed: false).scaledToFill()
                .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }.aspectRatio(1, contentMode: .fit).overlay(alignment: .bottomTrailing) { selectionMark }
            reason
          }
        }.buttonStyle(.plain).accessibilityValue(selectionValue)
          .contextMenu {
            if let toggleDevice { Button(selected ? "Deselect" : "Select") { toggleDevice(photo) } }
          }
      }
    case .saved(let id):
      if let photo = saved[id] {
        Button {
          if selecting, let toggleSaved { toggleSaved(photo) }
          else { inspectSaved(photo) }
        } label: {
          VStack(alignment: .leading, spacing: 0) {
            GeometryReader { geometry in
              LazyImage(url: photo.thumbnailURL ?? photo.previewURL) { state in
                if let image = state.image { image.resizable().scaledToFill() }
                else { Rectangle().fill(.quaternary).overlay { Image(systemName: "photo") } }
              }.frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }.aspectRatio(1, contentMode: .fit).overlay(alignment: .bottomTrailing) { selectionMark }
            reason
          }
        }.buttonStyle(.plain).accessibilityLabel(photo.metadata.filename).accessibilityValue(selectionValue)
          .contextMenu {
            if let toggleSaved { Button(selected ? "Deselect" : "Select") { toggleSaved(photo) } }
          }
      }
    }
  }
  @ViewBuilder private var selectionMark: some View {
    if selected { Image(systemName: "checkmark.circle.fill").padding(8) }
  }
  @ViewBuilder private var reason: some View {
    if !reasons.isEmpty {
      Text(reasons.prefix(2).joined(separator: " · "))
        .font(.caption).foregroundStyle(.secondary).padding(8)
    }
  }
  private var selectionValue: String {
    (selected ? ["Selected"] + reasons : reasons).joined(separator: " · ")
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
          if let record = try? search.consumerRecord(photo.id), !record.visualLabels.isEmpty {
            Section("Inferred scenes") {
              ForEach(record.visualLabels, id: \.identifier) { evidence in
                Text(evidence.label)
              }
              Text("Detected on this iPhone. These are separate from your labels.")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
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
