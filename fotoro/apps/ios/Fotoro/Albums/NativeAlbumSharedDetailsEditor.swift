import SwiftUI

struct NativeAlbumSharedDetailsEditor: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  @State private var review: NativeAlbumFactsReview?
  @State private var names = Set<String>()
  @State private var includeLocation = false
  @State private var operation: Task<Void, Never>?
  @State private var busy = false
  @State private var needsReview = false
  @State private var feedback: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    NavigationStack {
      Form {
        if let feedback { Section { Text(feedback).foregroundStyle(.secondary) } }
        if let review {
          Section("Share details") {
            Text("Choose details everyone in this album may search. This replaces the currently shared details. Nothing is selected automatically.")
              .font(.footnote).foregroundStyle(.secondary)
            ForEach(review.people.map { NativeAlbumPersonChoice(contributor: review.source.manifest.ownerAccountId, name: $0) }) { choice in
              Toggle(choice.name, isOn: Binding(get: { names.contains(choice.id) }, set: { selected in
                if selected { names.insert(choice.id) } else { names.remove(choice.id) }
              }))
            }
            if let location = review.location {
              Toggle("Share location", isOn: $includeLocation)
              Text(location.displayName + " · " + location.provenance).font(.caption).foregroundStyle(.secondary)
              Text("Includes exact coordinates for everyone with album access.").font(.caption).foregroundStyle(.secondary)
            }
            if review.people.isEmpty && review.location == nil {
              Text("This Saved photo has no reviewed names or location to share.").foregroundStyle(.secondary)
            }
            if names.count > 12 { Text("Choose up to 12 names.").foregroundStyle(.secondary) }
          }
          if let shared = review.shared, !shared.people.isEmpty || shared.location != nil {
            Section("Currently shared") {
              ForEach(shared.people.map { NativeAlbumPersonChoice(contributor: shared.ownerAccountId, name: $0) }) { Text($0.name) }
              if let location = shared.location { Text(location.displayName) }
              Button("Clear shared details", role: .destructive) { save(review, clear: true) }
                .disabled(busy || needsReview)
            }
          }
          Section {
            Button("Share selected details") { save(review, clear: false) }
              .disabled(busy || needsReview || names.count > 12 || (names.isEmpty && !includeLocation))
              .accessibilityIdentifier("albums.details.save")
            Button("Refresh and review") { refresh() }.disabled(busy)
              .accessibilityIdentifier("albums.details.refresh")
          }
        } else if busy { ProgressView("Loading photo details…") }
        else { Button("Retry loading details") { refresh() } }
      }
      .navigationTitle("Share photo details").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
      .task { refresh() }
      .onChange(of: scenePhase) { _, phase in if phase != .active { stop(); dismiss() } }
      .onDisappear { stop() }
    }
  }
  private func refresh() {
    operation?.cancel(); busy = true; feedback = nil; names = []; includeLocation = false
    operation = Task {
      defer { busy = false; operation = nil }
      do { review = try await model.prepareSharedDetails(item); needsReview = false }
      catch is CancellationError {}
      catch { feedback = error.localizedDescription; needsReview = true }
    }
  }
  private func save(_ review: NativeAlbumFactsReview, clear: Bool) {
    operation?.cancel(); busy = true; feedback = nil
    let chosen = clear ? [] : review.people.filter { names.contains(NativeAlbumPersonChoice(contributor: review.source.manifest.ownerAccountId, name: $0).id) }
    let location = !clear && includeLocation
    operation = Task {
      defer { busy = false; operation = nil }
      do { try await model.shareDetails(review, names: chosen, includeLocation: location); try Task.checkCancellation(); dismiss() }
      catch is CancellationError {}
      catch { feedback = error.localizedDescription; needsReview = true }
    }
  }
  private func stop() { operation?.cancel(); operation = nil; review = nil; names = []; includeLocation = false; busy = false }
}
