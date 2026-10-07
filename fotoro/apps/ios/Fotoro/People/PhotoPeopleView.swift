import Photos
import SwiftUI

struct PhotoPeoplePresentation: Identifiable { let id = UUID() }
struct PhotoPeopleView: View {
  let search: LocalSearchStore
  @State private var people: PhotoPeopleStore
  @State private var names: [String: String] = [:]
  @State private var selection: PeopleSearchSelection
  var findPhotos: () -> Void = {}
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(search: LocalSearchStore, findPhotos: @escaping () -> Void = {}) {
    self.search = search
    self.findPhotos = findPhotos
    _people = State(initialValue: PhotoPeopleStore(search: search))
    _selection = State(initialValue: search.peopleSelection)
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
          ForEach(people.groups.filter { $0.name != nil && $0.confirmedCount > 0 }) { group in
            Toggle(group.name ?? "", isOn: Binding(get: { selection.personIDs.contains(group.id) }, set: { selected in
              if selected { selection.personIDs.insert(group.id) } else { selection.personIDs.remove(group.id) }
            })).accessibilityIdentifier("people.search.person." + group.id)
          }
          if people.groups.allSatisfy({ $0.name == nil || $0.confirmedCount == 0 }) {
            Text("Save a name on confirmed faces below to find that person.").font(.footnote).foregroundStyle(.secondary)
          }
          Button("Find photos", systemImage: "magnifyingglass") {
            let names = Dictionary(uniqueKeysWithValues: people.groups.compactMap { group in group.name.map { (group.id, $0) } })
            search.setPeopleSelection(selection, names: names)
            findPhotos()
            dismiss()
          }.disabled(selection.isEmpty || !search.peopleSnapshotReady).accessibilityIdentifier("people.search.find")
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
