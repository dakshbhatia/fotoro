import Photos
import SwiftUI

struct PhotoPeoplePresentation: Identifiable { let id = UUID() }
struct PhotoPeopleView: View {
  let search: LocalSearchStore
  @State private var people: PhotoPeopleStore
  @State private var names: [String: String] = [:]
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(search: LocalSearchStore) {
    self.search = search
    _people = State(initialValue: PhotoPeopleStore(search: search))
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Toggle("People on this device", isOn: Binding(get: { people.enabled }, set: { people.setEnabled($0) }))
            .accessibilityIdentifier("people.enable")
          Text("Find suggested face groups locally. Review matches before saving a name. Face templates stay on this device.")
            .font(.footnote).foregroundStyle(.secondary)
          if people.busy {
            ProgressView(value: Double(people.processed), total: Double(max(1, people.total)))
            Text("\(people.processed) of \(people.total) photos checked").font(.caption)
            Button("Pause People") { people.stop() }
          } else if people.enabled {
            Button("Find faces", systemImage: "arrow.clockwise") { people.scan() }.accessibilityIdentifier("people.scan")
          }
          if let error = people.error { Text(error).font(.footnote).foregroundStyle(.red) }
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
        .onChange(of: search.libraryGeneration) { people.stop(); people.refresh() }
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
