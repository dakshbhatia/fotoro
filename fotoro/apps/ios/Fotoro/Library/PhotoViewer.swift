import NukeUI
import SwiftUI

struct PhotoViewer: View {
  @Bindable var services: AppServices
  var photos: [LocalPhoto] { services.photos }
  let initialID: String
  @State private var selected = ""
  @State private var scale: CGFloat = 1
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
          Button("Zoom", systemImage: "plus.magnifyingglass") { scale = scale == 1 ? 2 : 1 }
        }
      }
    }
  }
}
