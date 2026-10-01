import NukeUI
import SwiftUI

struct PhotoViewer: View {
  @Bindable var services: AppServices
  var photos: [LocalPhoto] {
    (displayedPhotos ?? services.photos).map { selected in
      services.photos.first { $0.id == selected.id } ?? selected
    }
  }
  let initialID: String
  var displayedPhotos: [LocalPhoto]? = nil
  @State private var selected = ""
  @State private var scale: CGFloat = 1
  @State private var details: LocalPhoto?
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      TabView(selection: $selected) {
        ForEach(photos) { photo in
          LazyImage(url: photo.previewURL ?? photo.originalURL) { state in
            if let image = state.image { image.resizable().scaledToFit() } else { ProgressView() }
          }
          .scaleEffect(scale).gesture(
            MagnifyGesture().onChanged { scale = min(5, max(1, $0.magnification)) }
          ).onTapGesture(count: 2) { scale = scale == 1 ? 2 : 1 }.tag(photo.id).accessibilityLabel(
            photo.metadata.filename
          )
          .task(id: photo.id) {
            do { try await services.ensurePreview(photo) } catch {
              services.error = error.localizedDescription
            }
          }
        }
      }.tabViewStyle(.page).background(.black).onAppear { selected = initialID }.onChange(
        of: selected
      ) { scale = 1 }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .bottomBar) {
          Button("Info", systemImage: "info.circle") { details = photos.first { $0.id == selected } }
        }
        ToolbarItem(placement: .bottomBar) {
          Button("Zoom", systemImage: "plus.magnifyingglass") { scale = scale == 1 ? 2 : 1 }
        }
      }
      .sheet(item: $details) { photo in SavedPhotoDetails(services: services, photo: photo) }
    }
  }
}


struct SavedPhotoDetails: View {
  @Bindable var services: AppServices
  let photo: LocalPhoto
  @State private var label = ""
  @Environment(\.dismiss) private var dismiss
  var labels: [String] { services.annotation(photo).labels ?? [] }
  var body: some View {
    NavigationStack {
      List {
        Text(photo.metadata.filename)
        Section("Labels") {
          ForEach(Array(labels.enumerated()), id: \.offset) { index, value in
            HStack {
              Text(value)
              Spacer()
              Button("Remove", systemImage: "minus.circle") {
                var next = labels
                next.remove(at: index)
                do { try services.setLabels(next, photo: photo) } catch { services.error = error.localizedDescription }
              }.labelStyle(.iconOnly)
            }
          }
          HStack {
            TextField("Add label", text: $label).autocorrectionDisabled()
            Button("Add") {
              do { try services.setLabels(labels + [label], photo: photo); label = "" }
              catch { services.error = error.localizedDescription }
            }.disabled(label.isEmpty || label.unicodeScalars.count > 120 || labels.count >= 64)
          }
        }
        if (try? services.annotations.ledger.state(photo.id)?.conflict) == true {
          Section("Labels changed on another device") {
            Text("Your edits are saved here. Choose which version to sync.")
            Button("Keep my changes") { services.run { try await services.resolveAnnotationConflict(photo, keepLocal: true) } }
            Button("Use the other device’s changes") { services.run { try await services.resolveAnnotationConflict(photo, keepLocal: false) } }
          }
        }
        if let caption = services.annotation(photo).caption { Section("Caption") { Text(caption) } }
        if let ocr = services.annotation(photo).ocr, !ocr.text.isEmpty {
          Section("Text in this photo") { Text(ocr.text).textSelection(.enabled) }
        }
        if let message = services.annotations.errors[photo.id] { Text(message).font(.caption).foregroundStyle(.secondary) }
        if let error = services.error { Text(error).font(.caption).foregroundStyle(.secondary) }
      }.navigationTitle("Photo details").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }.presentationDetents([.medium, .large])
  }
}
