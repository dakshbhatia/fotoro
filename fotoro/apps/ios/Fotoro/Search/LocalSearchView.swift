#if !FOTORO_LOCAL_PREVIEW
import NukeUI
#endif
import SwiftUI
import Photos

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
              }.contentShape(.interaction, Rectangle())
            }.buttonStyle(.plain).accessibilityValue(selectedIDs.contains(photo.id) ? "Selected" : "")
              .contextMenu {
                if let toggleSelection {
                  Button(selectedIDs.contains(photo.id) ? "Deselect" : "Select") { toggleSelection(photo) }
                }
              }
          }
        }
      }
      SearchAnalysisActions(search: search)
      if !matches.isEmpty, search.searching || search.indexing {
        SearchProgressFeedback(search: search).padding(.horizontal)
      }
      if !matches.isEmpty, let error = search.error { DisclosureGroup("Details") { Text(error).textSelection(.enabled) }.font(.caption).padding(.horizontal) }
    }
  }
}

private struct SearchAnalysisActions: View {
  let search: LocalSearchStore
  var body: some View {
    if search.hasSearch || search.analysisRemaining > 0 || search.analysisUnavailable > 0 {
      if search.hasCurrentResponse, search.response.total > 0 {
        Text("Text checked in \(search.response.indexed) of \(search.response.total) photos on this device")
          .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
          .accessibilityIdentifier("search.coverage")
      }
      DisclosureGroup("Photo analysis") {
        VStack(alignment: .leading, spacing: 6) {
          Picker("Automatic analysis range", selection: Binding(
            get: { search.automaticAnalysisWindow }, set: { search.setAutomaticAnalysisWindow($0) })) {
              Text("Latest 10 days").tag(PhotoAnalysisWindow.tenDays)
              Text("All photos").tag(PhotoAnalysisWindow.allPhotos)
            }.accessibilityIdentifier("search.analysis.range")
          if search.automaticAnalysisWindow == .tenDays {
            Text("Automatic checks cover the latest 10 days. Earlier indexed photos remain searchable. Choose All photos to analyze older photos.")
              .font(.caption).foregroundStyle(.secondary)
          }
          if search.analysisRemaining > 0 {
            Text("\(search.analysisRemaining) more photos to check").font(.caption).foregroundStyle(.secondary)
            Button("Next batch", systemImage: "arrow.forward") { search.analyzeMetadataMatches(nextBatch: true) }
              .accessibilityIdentifier("search.analysis.next")
              .disabled(!search.canAnalyzeMetadataMatches)
          } else {
            Button(search.analysisUnavailable > 0 ? "Retry unavailable photos" : "Check matching photos", systemImage: "text.viewfinder") { search.analyzeMetadataMatches() }
              .accessibilityIdentifier("search.analysis.matches")
              .disabled(!search.canAnalyzeMetadataMatches)
            Text("Checks up to 500 matching photos on this device.")
              .font(.caption).foregroundStyle(.secondary)
          }
          if search.analysisUnavailable > 0 {
            Text("\(search.analysisUnavailable) photos need another attempt.")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
      }.font(.footnote).padding(.horizontal)
    }
  }
}

struct PhotoAnalysisStatusView: View {
  let search: LocalSearchStore
  @Environment(\.dismiss) private var dismiss
  @State private var snapshot: PhotoAnalysisStatusSnapshot?
  @State private var failure: String?
  @State private var loading = false
  @State private var refresh = 0
  @State private var completedRuns = 0
  private struct Request: Equatable {
    let window: PhotoAnalysisWindow
    let library: UInt64
    let refresh: Int
    let completedRuns: Int
  }
  private var request: Request {
    Request(window: search.automaticAnalysisWindow, library: search.libraryGeneration,
      refresh: refresh, completedRuns: completedRuns)
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(search.analysisActivity.label).accessibilityIdentifier("analysis.status.activity")
          if let progress = search.analysisProgress, search.indexing {
            Text("\(progress.processed) of \(progress.total) photos attempted in this batch")
              .font(.caption).foregroundStyle(.secondary)
          }
          Button("Refresh status", systemImage: "arrow.clockwise") { refresh += 1 }
            .disabled(loading).accessibilityIdentifier("analysis.status.refresh")
          if loading { ProgressView("Reading analysis status…") }
          if let failure { Text(failure).foregroundStyle(.secondary).accessibilityIdentifier("analysis.status.error") }
        }
        if let coverage = snapshot?.coverage {
          Section("Whole permitted library") {
            coverageRows(coverage.library, scope: "library")
          }.accessibilityIdentifier("analysis.status.library")
          Section(coverage.window == .tenDays ? "Automatic · Latest 10 days" : "Automatic · All photos") {
            coverageRows(coverage.automatic, scope: "window")
            Text("Counts are from the last status check. A completed text check can contain no recognized words.")
              .font(.caption).foregroundStyle(.secondary)
            Text("Checked \(coverage.capturedAt.formatted(date: .omitted, time: .shortened))")
              .font(.caption).foregroundStyle(.secondary)
          }.accessibilityIdentifier("analysis.status.window")
        }
        Section("Automatic analysis range") {
          Picker("Range", selection: Binding(get: { search.automaticAnalysisWindow }, set: { search.setAutomaticAnalysisWindow($0) })) {
            Text("Latest 10 days").tag(PhotoAnalysisWindow.tenDays)
            Text("All photos").tag(PhotoAnalysisWindow.allPhotos)
          }.accessibilityIdentifier("search.analysis.range")
          Text("Earlier indexed photos remain searchable. Choosing All photos explicitly expands automatic analysis. Photos are checked while Fotoro is open and browsing is idle.")
            .font(.caption).foregroundStyle(.secondary)
        }
        Section("Check a matching batch") {
          Text(search.hasSearch ? "Uses the current search and People filters." : "This explicit batch checks the last 30 days, separately from the automatic range. Use a date search to target older photos.")
            .font(.caption).foregroundStyle(.secondary)
          if search.analysisRemaining > 0 {
            Text("\(search.analysisRemaining) more photos to check")
            Button("Next batch", systemImage: "arrow.forward") { search.analyzeMetadataMatches(nextBatch: true) }
              .disabled(!search.canAnalyzeMetadataMatches).accessibilityIdentifier("search.analysis.next")
          } else {
            Button("Check matching photos", systemImage: "text.viewfinder") { search.analyzeMetadataMatches() }
              .disabled(!search.canAnalyzeMetadataMatches).accessibilityIdentifier("search.analysis.matches")
          }
          Text("Checks up to 500 matching photos. Existing completed stages are kept when interrupted.")
            .font(.caption).foregroundStyle(.secondary)
        }
      }.accessibilityIdentifier("analysis.status")
        .navigationTitle("Photo analysis")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task(id: request) {
          let captured = request
          snapshot = nil; failure = nil; loading = true
          do {
            let value = try await search.analysisStatusSnapshot(); try Task.checkCancellation()
            guard request == captured else { return }
            snapshot = value
          }
          catch is CancellationError {}
          catch { if !Task.isCancelled, request == captured { failure = error.localizedDescription } }
          if !Task.isCancelled, request == captured { loading = false }
        }
        .onChange(of: search.indexing) { wasRunning, running in if wasRunning && !running { completedRuns += 1 } }
    }
  }
  @ViewBuilder private func coverageRows(_ rows: [SearchStageCoverage], scope: String) -> some View {
    ForEach(rows, id: \.stage) { row in
      VStack(alignment: .leading, spacing: 4) {
        Text(row.stage == .ocr ? "Text in photos" : row.stage == .visual ? "Scenes and objects" : "Visual search vectors")
          .font(.headline)
        Text("\(row.complete) ready of \(row.total) · \(row.pending) pending")
        if row.unavailable > 0 || row.failed > 0 { Text("\(row.unavailable) unavailable · \(row.failed) failed") }
        if row.deferred > 0 { Text("\(row.deferred) waiting for retry") }
        if row.modelDeferred > 0 { Text("\(row.modelDeferred) waiting for the visual model") }
        if let retry = row.nextRetry { Text("Next retry after \(retry.formatted(date: .omitted, time: .shortened))") }
        if row.deferred > 0 || row.modelDeferred > 0 {
          Text("Waiting counts are included in pending, unavailable or failed photos.").foregroundStyle(.secondary)
        }
      }.font(.caption).accessibilityIdentifier("analysis.status.\(scope).\(row.stage.rawValue)")
    }
  }
}

private struct SearchEmptyResults: View {
  let search: LocalSearchStore
  var searchPending = false
  var visualPending = false
  var finished = true
  var reviewing = false
  var failure: String?
  var retry: (() -> Void)?
  var body: some View {
    if searchPending || search.searching || visualPending || (search.indexing && !search.hasCurrentResponse) {
      SearchProgressFeedback(search: search, searchPending: searchPending, visualPending: visualPending)
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    } else if let failure = failure ?? search.error {
      ContentUnavailableView {
        Label("Search unavailable", systemImage: "magnifyingglass")
      } description: {
        Text("Try the same search again.")
      } actions: {
        if let retry { Button("Try again", action: retry).accessibilityIdentifier("search.retry") }
        DisclosureGroup("Details") { Text(failure).textSelection(.enabled) }
          .font(.footnote).foregroundStyle(.secondary)
      }
    } else if !finished {
      ContentUnavailableView("Search paused", systemImage: "magnifyingglass")
    } else {
      ContentUnavailableView(reviewing ? "No suggestions" : "No photos found", systemImage: "magnifyingglass",
        description: Text(reviewing ? "Use All matches to review every photo." : "Try a tag, a place, a date or words in a photo."))
    }
  }
}

private struct SearchProgressFeedback: View {
  let search: LocalSearchStore
  var searchPending = false
  var visualPending = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ProgressView(searchPending || search.searching ? "Searching photos…" : visualPending ? "Checking visual matches…" : "Preparing photo search…")
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
    if let meaning = search.response.meaning, meaning.relation == .label {
      Button("Search only “\(meaning.display)”") {
        search.accept(meaning)
        selected()
      }.buttonStyle(.bordered)
        .accessibilityValue(search.acceptedMeaningID == meaning.id ? "Exact match" : "")
        .padding(.horizontal)
    }
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
  var visualPending: Bool = false
  var searchFailure: String?
  var searchFinished = true
  var retrySearch: (() -> Void)?
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
    let matches = matches
    VStack(alignment: .leading, spacing: 16) {
      if !search.peopleSelection.isEmpty {
        SearchPeopleSummary(search: search, edit: editPeople)
      }
      SearchAlternatives(search: search, selected: choseAlternative)
      if matches.isEmpty {
        SearchEmptyResults(search: search, searchPending: searchPending, visualPending: visualPending, finished: searchFinished, reviewing: review != nil, failure: searchFailure, retry: retrySearch)
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
      SearchAnalysisActions(search: search)
      if !matches.isEmpty, searchPending || search.searching || search.indexing || visualPending {
        SearchProgressFeedback(search: search, searchPending: searchPending, visualPending: visualPending).padding(.horizontal)
      }
      if !matches.isEmpty, let error = search.error {
        DisclosureGroup("Details") { Text(error).textSelection(.enabled) }.font(.caption).padding(.horizontal)
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
            }.aspectRatio(1, contentMode: .fit).modifier(NativeSearchResultVisibility())
              .overlay(alignment: .bottomTrailing) { selectionMark }
            reason
          }.contentShape(.interaction, Rectangle())
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
              NativeSearchSavedThumbnail(photo: photo)
                .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            }.aspectRatio(1, contentMode: .fit).modifier(NativeSearchResultVisibility())
              .overlay(alignment: .bottomTrailing) { selectionMark }
            reason
          }.contentShape(.interaction, Rectangle())
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
  @State private var nameDraft = PhotoNameDraft(savedName: "")
  @State private var organizationFacts: [String] = []
  @State private var capture: PhotoCaptureMetadata?
  @State private var readingCapture = false
  @State private var originalUnavailable = false
  @State private var sourceIsCurrent = false
  @FocusState private var labelFocused: Bool
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var readIdentity: PhotoMetadataReadIdentity {
    PhotoMetadataReadIdentity(id: photo.id, revision: photo.sourceRevision,
      generation: search?.libraryGeneration ?? 0, active: scenePhase == .active)
  }
  var body: some View {
    NavigationStack {
      List {
        if sourceIsCurrent {
        Section {
        if let date = photo.capturedAt {
          Text(date.formatted(date: .complete, time: .shortened))
        } else {
          Text("Capture date unavailable").foregroundStyle(.secondary)
        }
        if photo.isFavorite { Label("Favorite", systemImage: "heart.fill") }
        }
        if let location = photo.photoLocation { PhotoLocationSection(location: location) }
        if let search {
          #if !FOTORO_LOCAL_PREVIEW
          if let record = try? search.consumerRecord(photo.id), record.revision == photo.sourceRevision {
            let named = PhotoPeopleFacts.read(record.facts, enforceWireLimits: false)
            let detected = search.detectedFaceCount(for: photo)
            if !named.isEmpty || detected != nil {
              Section("People") {
                if let detected { LabeledContent("Faces detected", value: String(detected)) }
                ForEach(Array(Set(named.map(\.n))).sorted(), id: \.self) { Text($0) }
                Text("Faces detected on this iPhone; names you reviewed. Detection can miss people.")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          #endif
          nameSection.disabled(!search.canEditLabels(photo.id))
          Section("Tags") {
            ForEach(Array(labels.enumerated()), id: \.offset) { at, value in
              HStack {
                Text(value)
                Spacer()
                Button("Remove", systemImage: "minus.circle") {
                  guard organizationSourceIsCurrent(), search.canEditLabels(photo.id) else { return }
                  let proposed = search.labels(photo.id).filter { $0 != value }
                  if search.setLabels(proposed, photoID: photo.id) { labels = proposed }
                }.labelStyle(.iconOnly).accessibilityLabel("Remove tag \(value)").disabled(!search.canEditLabels(photo.id))
              }
            }
            HStack {
              TextField("Add a tag or place name", text: $label).autocorrectionDisabled().focused($labelFocused)
                .submitLabel(.done).onSubmit(addTag)
              Button("Add", action: addTag)
              .disabled(SearchNormalization.newPhotoTag(label, existing: labels) == nil || !search.canEditLabels(photo.id))
            }
            if !search.canEditLabels(photo.id) {
              Text("The local index is preparing this photo.").font(.caption).foregroundStyle(
                .secondary)
            }
            Text(
              "Use your own words, like BTS or Grandma’s house."
            ).font(.caption).foregroundStyle(.secondary)
          }
          if let record = try? search.consumerRecord(photo.id), !record.visualLabels.isEmpty {
            Section {
              DisclosureGroup("Detected scenes") {
              ForEach(record.visualLabels, id: \.identifier) { evidence in
                Text(evidence.label)
              }
              Text("Detected on this iPhone. These are separate from your tags.")
                .font(.caption).foregroundStyle(.secondary)
              }
            }
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
        if let capture { PhotoMetadataSections(metadata: capture) }
        if readingCapture { ProgressView("Reading technical details…") }
        if originalUnavailable {
          DisclosureGroup("More details") {
            Text("More camera details may be in the original. Info uses files already on this device.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }
        } else {
          ContentUnavailableView("Photo unavailable", systemImage: "photo",
            description: Text("This photo changed or is no longer permitted. Open it again from Photos."))
        }
      }.navigationTitle("Photo details").navigationBarTitleDisplayMode(.inline).toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
    }.onAppear {
      labels = search?.labels(photo.id) ?? []
      organizationFacts = (try? search?.record(photo.id)?.facts) ?? []
      nameDraft.receive(PhotoOrganizationFacts.name(organizationFacts, original: originalName))
    }
      .onChange(of: search?.canEditLabels(photo.id) ?? false) {
        labels = search?.labels(photo.id) ?? []
      }
      .onChange(of: search?.organizationGeneration) {
        guard let search, search.assets[photo.id]?.sourceRevision == photo.sourceRevision,
          let record = try? search.record(photo.id), record.revision == photo.sourceRevision else { return }
        organizationFacts = record.facts
        nameDraft.receive(PhotoOrganizationFacts.name(organizationFacts, original: originalName))
      }
      .task(id: readIdentity) { await readCapture() }
      .presentationDetents([.medium, .large])
  }

  private var originalName: String { (try? search?.record(photo.id)?.filename) ?? "Photo" }
  private var nameSection: some View {
    Section("Photo name") {
            TextField("Filename", text: Binding(get: { nameDraft.value }, set: { nameDraft.edit($0) })).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityLabel("Photo filename")
            Button("Suggest name") {
              guard organizationSourceIsCurrent(), let record = try? search?.record(photo.id) else { return }
              nameDraft.edit(PhotoOrganizationFacts.suggestedName(original: originalName, digest: nil,
                capturedAt: photo.capturedAt, labels: labels, place: photo.photoLocation?.name,
                screenshot: PhotoOrganizationFacts.screenshot(organizationFacts, detected: photo.isScreenshot),
                analysis: PhotoNameAnalysis(record: record, photoID: photo.id, revision: photo.sourceRevision)))
            }
            Button("Apply name") { applyOrganization(.name(nameDraft.value)) }
              .disabled(!PhotoOrganizationFacts.validName(nameDraft.value) || (nameDraft.value as NSString).pathExtension.lowercased() != (originalName as NSString).pathExtension.lowercased() || nameDraft.value == PhotoOrganizationFacts.name(organizationFacts, original: originalName))
            if PhotoOrganizationFacts.name(organizationFacts, original: originalName) != originalName {
              Button("Use original name") { applyOrganization(.name(nil)) }
            }
            if nameDraft.savedNameChanged && nameDraft.value != nameDraft.savedName {
              Text("The saved name changed. Your draft is kept.").font(.caption).foregroundStyle(.secondary)
              Button("Use saved name") { nameDraft.acknowledge(PhotoOrganizationFacts.name(organizationFacts, original: originalName)) }
            }
            Toggle("Screenshot", isOn: Binding(get: { PhotoOrganizationFacts.screenshot(organizationFacts, detected: photo.isScreenshot) }, set: { applyOrganization(.screenshot($0)) }))
            Text("Names stay in Fotoro; original files in Photos stay unchanged. Save and Sync for other devices.").font(.caption).foregroundStyle(.secondary)
          }
  }
  private func applyOrganization(_ change: PhotoOrganizationChange) {
    guard organizationSourceIsCurrent(), let search, search.setOrganization(change, photoID: photo.id) else { return }
    organizationFacts = (try? search.record(photo.id)?.facts) ?? []
    if case .name = change { nameDraft.acknowledge(PhotoOrganizationFacts.name(organizationFacts, original: originalName)) }
  }
  private func organizationSourceIsCurrent() -> Bool {
    guard sourceIsCurrent, let search, search.assets[photo.id]?.sourceRevision == photo.sourceRevision,
      let record = try? search.record(photo.id), record.revision == photo.sourceRevision,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [photo.id], options: nil).firstObject,
      !asset.isHidden, RecentPhoto.sourceRevision(asset) == photo.sourceRevision else {
      sourceIsCurrent = false
      return false
    }
    return true
  }
  private func addTag() {
    guard organizationSourceIsCurrent(), let search, search.canEditLabels(photo.id),
      let tag = SearchNormalization.newPhotoTag(label, existing: search.labels(photo.id)) else { return }
    let proposed = search.labels(photo.id) + [tag]
    if search.setLabels(proposed, photoID: photo.id) {
      labels = proposed; label = ""; labelFocused = false
    }
  }

  private func readCapture() async {
    capture = nil; originalUnavailable = false; readingCapture = false; sourceIsCurrent = false
    guard scenePhase == .active,
      RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [photo.id], options: nil).firstObject,
      !asset.isHidden, RecentPhoto.sourceRevision(asset) == photo.sourceRevision else { return }
    sourceIsCurrent = true
    capture = PhotoCaptureMetadata.photos(asset, includeDetails: true)
    if let record = try? search?.consumerRecord(photo.id), record.revision == photo.sourceRevision,
      let cached = record.captureMetadata, cached.items.contains(where: { $0.p == .original }) {
      capture = capture?.merging(PhotoCaptureMetadata(items: cached.items.filter { $0.p == .original }))
      return
    }
    readingCapture = true
    let result = await PhotoCaptureMetadata.loadLocalOriginal(photo: photo)
    guard !Task.isCancelled else { return }
    readingCapture = false
    switch result {
    case .available(let metadata):
      capture = metadata
      do { try search?.recordCaptureMetadata(metadata, for: photo) }
      catch is CancellationError {}
      catch { search?.error = error.localizedDescription }
    case .unavailable: originalUnavailable = true
    case .changed: capture = nil; sourceIsCurrent = false
    case .cancelled: capture = nil
    }
  }
}

private struct PhotoMetadataReadIdentity: Equatable {
  var id: String
  var revision: String
  var generation: UInt64
  var active: Bool
}
