import Photos
import SwiftUI

struct PhotoPeoplePresentation: Identifiable { let id = UUID() }

struct PhotoPeopleSearchChoice: Identifiable, Equatable {
  var id: String
  var name: String
  static func merged(local: [PhotoPeopleGroup], saved: [Self]) -> [Self] {
    var choices: [String: Self] = [:]
    for choice in saved { choices[choice.id] = choice }
    for group in local where group.confirmedCount > 0 {
      guard let name = group.name, let id = UUID(uuidString: group.id)?.uuidString.lowercased() else { continue }
      choices[id] = Self(id: id, name: name)
    }
    return choices.values.sorted {
      let order = $0.name.localizedStandardCompare($1.name)
      return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
    }
  }
  static func canFind(_ selection: PeopleSearchSelection, choices: [Self]) -> Bool {
    selection.valid && !selection.isEmpty && Set(selection.canonicalIDs).isSubset(of: Set(choices.map(\.id)))
  }
}

struct SavedPeopleSearchContext: Equatable {
  let access: PhotoAccountAccess
  let origin: String
  let catalogGeneration: UInt64
  let cards: [String: AccountCardV1]
  @MainActor static func current(_ services: AppServices) -> Self? {
    guard let access = services.photoAccountAccess else { return nil }
    return Self(access: access, origin: services.api.baseURL.absoluteString,
      catalogGeneration: services.consumerCatalogGeneration, cards: services.session.pinnedCards)
  }
}

struct SavedPeopleSearchSnapshot {
  let context: SavedPeopleSearchContext
  let choices: [PhotoPeopleSearchChoice]
  private let sources: [LocalPhoto]
  @MainActor func isCurrent(_ services: AppServices, checkingSources: Bool = true) -> Bool {
    SavedPeopleSearchContext.current(services) == context
      && (!checkingSources || SavedPhotoSelection.isCurrent(sources, lookup: services.consumerSavedPhoto))
  }
  @MainActor static func load(_ services: AppServices) async throws -> Self? {
    guard let context = SavedPeopleSearchContext.current(services) else { return nil }
    // Read existing encrypted annotations only; no PhotoKit access or new face analysis.
    let photos = try await services.searchCatalog("")
    var choices: [String: PhotoPeopleSearchChoice] = [:]
    var sources: [LocalPhoto] = []
    for (offset, photo) in photos.enumerated() {
      try Task.checkCancellation()
      guard SavedPeopleSearchContext.current(services) == context else { throw CancellationError() }
      guard let current = try services.consumerSavedPhoto(photo.id),
        current.metadata == photo.metadata, current.manifest == photo.manifest else { continue }
      let assignments = PhotoPeopleFacts.read(services.annotation(current).facts ?? [],
        originalSha256: current.metadata.originalSha256)
      if !assignments.isEmpty { sources.append(current) }
      for assignment in assignments {
        guard let id = UUID(uuidString: assignment.p)?.uuidString.lowercased() else { continue }
        // Catalog order chooses the newest reviewed name for an existing person UUID.
        if choices[id] == nil { choices[id] = PhotoPeopleSearchChoice(id: id, name: assignment.n) }
      }
      if offset % 100 == 99 { await Task.yield() }
    }
    try Task.checkCancellation()
    let snapshot = Self(context: context, choices: PhotoPeopleSearchChoice.merged(local: [], saved: Array(choices.values)), sources: sources)
    guard snapshot.isCurrent(services) else { throw CancellationError() }
    return snapshot
  }
}
struct PhotoPeopleView: View {
  let search: LocalSearchStore
  let services: AppServices?
  @State private var savedPeople: SavedPeopleSearchSnapshot?
  @State private var savedPeopleError: String?
  @State private var people: PhotoPeopleStore
  @State private var names: [String: String] = [:]
  @State private var selection: PeopleSearchSelection
  var findPhotos: () -> Void = {}
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(search: LocalSearchStore, services: AppServices? = nil, findPhotos: @escaping () -> Void = {}) {
    self.search = search
    self.services = services
    self.findPhotos = findPhotos
    _people = State(initialValue: PhotoPeopleStore(search: search))
    _selection = State(initialValue: search.peopleSelection)
  }
  private var savedContext: SavedPeopleSearchContext? {
    guard scenePhase == .active, let services else { return nil }
    return SavedPeopleSearchContext.current(services)
  }
  private var choices: [PhotoPeopleSearchChoice] { searchChoices() }
  private func searchChoices(checkingSources: Bool = false) -> [PhotoPeopleSearchChoice] {
    let saved = services.flatMap { services in
      savedPeople.flatMap { $0.isCurrent(services, checkingSources: checkingSources) ? $0.choices : nil }
    } ?? []
    return PhotoPeopleSearchChoice.merged(local: search.peopleSnapshotReady ? people.groups : [], saved: saved)
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Toggle("People on this device", isOn: Binding(get: { people.enabled }, set: { people.setEnabled($0) }))
            .accessibilityIdentifier("people.enable")
          Text("Find suggested face groups locally. Review matches before saving a name. Face templates stay on this device.")
            .font(.footnote).foregroundStyle(.secondary)
          Toggle("Include older photos", isOn: Binding(get: { people.includesOlder }, set: { people.setIncludesOlder($0) }))
            .accessibilityIdentifier("people.scan.older")
          Text(search.query.isEmpty
            ? (people.includesOlder ? "Check permitted photos, including older and undated photos." : "Check photos from the last 30 days.")
            : (people.includesOlder || NaturalDateQuery.parse(search.query).datePhrase != nil
              ? "Check photos matching the current metadata and date search."
              : "Check the last 30 days matching the current metadata search."))
            .font(.footnote).foregroundStyle(.secondary)
          if people.busy {
            ProgressView(value: Double(people.processed), total: Double(max(1, people.total)))
            Text("\(people.processed) of \(people.total) photos attempted").font(.caption)
            Button("Pause People") { people.stop() }
          } else if people.enabled {
            Button(people.unavailable > 0 && people.remaining == 0 ? "Retry unavailable photos" : "Find faces", systemImage: "arrow.clockwise") { people.scan() }.accessibilityIdentifier("people.scan")
            if people.remaining > 0 {
              Text("\(people.remaining) matching photos unattempted").font(.caption).foregroundStyle(.secondary)
              Button("Next batch", systemImage: "arrow.forward") { people.scan(nextBatch: true) }
                .accessibilityIdentifier("people.scan.next")
            }
          }
          if people.unavailable > 0 {
            Text("\(people.unavailable) photos unavailable for face analysis. Retry after the remaining batches.")
              .font(.caption).foregroundStyle(.secondary)
          }
          if let error = people.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        Section("Find photos") {
          Picker("People match", selection: $selection.match) {
            ForEach(PeopleSearchMatch.allCases) { Text($0.title).tag($0) }
          }.accessibilityIdentifier("people.search.match")
          Text("Everyone selected must appear in the same photo. This does not establish who visited a place.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(choices) { choice in
            Toggle(choice.name, isOn: Binding(get: { selection.canonicalIDs.contains(choice.id) }, set: { selected in
              selection.personIDs = Set(selection.canonicalIDs)
              if selected { selection.personIDs.insert(choice.id) } else { selection.personIDs.remove(choice.id) }
            })).accessibilityIdentifier("people.search.person." + choice.id)
          }
          if choices.isEmpty {
            if savedContext != nil, savedPeople == nil, savedPeopleError == nil {
              ProgressView("Loading saved names…")
            } else {
              Text("Save a name on confirmed faces below to find that person.").font(.footnote).foregroundStyle(.secondary)
            }
          }
          if let savedPeopleError { Text(savedPeopleError).font(.footnote).foregroundStyle(.red) }
          Button("Find photos", systemImage: "magnifyingglass") {
            let current = searchChoices(checkingSources: true)
            guard PhotoPeopleSearchChoice.canFind(selection, choices: current) else { return }
            let names = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0.name) })
            selection.personIDs = Set(selection.canonicalIDs)
            search.setPeopleSelection(selection, names: names)
            findPhotos()
            dismiss()
          }.disabled(!PhotoPeopleSearchChoice.canFind(selection, choices: choices)).accessibilityIdentifier("people.search.find")
          if !selection.isEmpty || !search.peopleSelection.isEmpty {
            Button("Clear people") { selection = PeopleSearchSelection(); search.setPeopleSelection(selection) }
              .accessibilityIdentifier("people.search.clear")
          }
        }
        ForEach(people.groups) { group in
          Section {
            TextField("Person name", text: Binding(get: { names[group.id] ?? group.name ?? "" }, set: { names[group.id] = $0 }))
              .textInputAutocapitalization(.words)
            Button("Save name and confirm these faces") {
              people.name(group.id, names[group.id] ?? group.name ?? "")
            }.disabled(people.busy).accessibilityIdentifier("people.name")
            Text("\(group.confirmedCount) confirmed · \(group.faces.count-group.confirmedCount) suggested")
              .font(.caption).foregroundStyle(.secondary)
            ForEach(group.faces) { face in
              HStack {
                if let photo = search.assets[face.photoID] {
                  PhotoPeopleThumbnail(photo: photo, box: face.box).frame(width: 64, height: 64).clipped()
                }
                Text(face.confirmed ? "Confirmed face" : "Suggested face").font(.caption)
                Spacer()
                Menu("Correct face", systemImage: "ellipsis") {
                  Button("Separate this face") { people.split(face.id) }
                  Button("Reject this face", role: .destructive) { people.reject(face.id) }
                }.disabled(people.busy)
              }
            }
            if people.groups.count > 1 {
              Menu("Merge with another group") {
                ForEach(people.groups.filter { $0.id != group.id }) { target in
                  Button(target.name ?? "Unnamed group · \(target.faces.count) faces") { people.merge(group.id, into: target.id) }
                }
              }.disabled(people.busy)
            }
          } header: { Text(group.name ?? "Suggested group") }
        }
        if people.enabled || !people.groups.isEmpty {
          Section {
            Button("Delete local People data", role: .destructive) { people.erase() }
              .accessibilityIdentifier("people.erase")
          }
        }
      }.navigationTitle("People").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .task { people.refresh() }
        .task(id: savedContext) {
          savedPeople = nil; savedPeopleError = nil
          guard let services, let expected = savedContext else { return }
          do {
            let snapshot = try await SavedPeopleSearchSnapshot.load(services)
            try Task.checkCancellation()
            guard savedContext == expected else { return }
            savedPeople = snapshot
          } catch is CancellationError { return }
          catch { if savedContext == expected { savedPeopleError = error.localizedDescription } }
        }
        .onChange(of: search.query) { people.invalidateScope() }
        .onChange(of: search.peopleSelection) { people.invalidateScope() }
        .onChange(of: search.libraryGeneration) { people.invalidateScope(); people.refresh() }
        .onChange(of: search.peopleSnapshotReady) { people.refresh() }
        .onChange(of: scenePhase) { if scenePhase != .active { people.stop() } }
        .onDisappear { people.stop() }
    }.preferredColorScheme(.dark)
  }
}

private struct PhotoPeopleThumbnail: View {
  let photo: RecentPhoto
  let box: [Int]
  @State private var image: UIImage?
  @State private var request: PHImageRequestID?
  @State private var active = false
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFit() }
      else { Image(systemName: "person.crop.square").foregroundStyle(.secondary) }
    }.onAppear {
      active = true
      let options = PHImageRequestOptions()
      options.isNetworkAccessAllowed = false; options.deliveryMode = .highQualityFormat
      request = PHImageManager.default().requestImage(for: photo.asset, targetSize: CGSize(width: 800, height: 800),
        contentMode: .aspectFit, options: options) { value, info in
        guard (info?[PHImageResultIsDegradedKey] as? Bool) != true, let value, box.count == 4 else { return }
        DispatchQueue.main.async {
          guard active else { return }
          let width = CGFloat(box[2])/10000, height = CGFloat(box[3])/10000
          guard width > 0, height > 0 else { return }
          image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).image { _ in
            value.draw(in: CGRect(x: -CGFloat(box[0])/10000/width*80, y: -CGFloat(box[1])/10000/height*80,
              width: 80/width, height: 80/height))
          }
        }
      }
    }.onDisappear { active = false; if let request { PHImageManager.default().cancelImageRequest(request) }; request = nil; image = nil }
  }
}
