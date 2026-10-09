import SwiftUI

struct NativeAlbumSharedDetailsEditor: View {
  let model: NativeAlbumService
  let item: NativeAlbumItem
  @State private var review: NativeAlbumFactsReview?
  @State private var names = Set<String>()
  @State private var includeLocation = false
  @State private var operation: Task<Void, Never>?
  @State private var operationID: UUID?
  @State private var busy = false
  @State private var needsReview = false
  @State private var feedback: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    NavigationStack {
      Form {
        if let feedback { Section { Text(feedback).foregroundStyle(.secondary) } }
        if let review, model.isCurrent(review.context) {
          Section("Share details") {
            Text("Choose details everyone in this album may search. Existing shared details stay selected when they still match this photo. New details start off.")
              .font(.footnote).foregroundStyle(.secondary)
            if NativeAlbumFactsSelection(people: review.people, location: review.location, shared: review.shared).unavailableSharedDetails {
              Text("Some previously shared details changed or are no longer available. Saving replaces them with your selections.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(review.people.map { NativeAlbumPersonChoice(contributor: review.source.manifest.ownerAccountId, name: $0) }) { choice in
              Toggle(choice.name, isOn: Binding(get: { names.contains(choice.id) }, set: { selected in
                if selected { names.insert(choice.id) } else { names.remove(choice.id) }
              })).disabled(busy || needsReview || (!names.contains(choice.id) && names.count >= 12))
            }
            if let location = review.location {
              Toggle("Share location", isOn: $includeLocation).disabled(busy || needsReview)
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
      .onChange(of: model.services.photoAccountAccess) { _, _ in stop(); dismiss() }
      .onChange(of: model.opened?.overview.definition) { _, _ in stop(); dismiss() }
      .onDisappear { stop() }
    }
  }
  private func refresh() {
    operation?.cancel(); let token = UUID(); operationID = token
    busy = true; feedback = nil; review = nil; names = []; includeLocation = false
    operation = Task {
      defer { if operationID == token { busy = false; operation = nil; operationID = nil } }
      do {
        let loaded = try await model.prepareSharedDetails(item)
        try Task.checkCancellation()
        guard operationID == token, scenePhase == .active, model.isCurrent(loaded.context) else { return }
        let selection = NativeAlbumFactsSelection(people: loaded.people, location: loaded.location, shared: loaded.shared)
        names = Set(selection.people.map { NativeAlbumPersonChoice(contributor: loaded.source.manifest.ownerAccountId, name: $0).id })
        includeLocation = selection.includeLocation; review = loaded; needsReview = false
      }
      catch is CancellationError {}
      catch { if operationID == token, !Task.isCancelled { feedback = error.localizedDescription; needsReview = true } }
    }
  }
  private func save(_ review: NativeAlbumFactsReview, clear: Bool) {
    guard model.isCurrent(review.context) else { stop(); dismiss(); return }
    operation?.cancel(); let token = UUID(); operationID = token; busy = true; feedback = nil
    let chosen = clear ? [] : review.people.filter { names.contains(NativeAlbumPersonChoice(contributor: review.source.manifest.ownerAccountId, name: $0).id) }
    let location = !clear && includeLocation
    operation = Task {
      defer { if operationID == token { busy = false; operation = nil; operationID = nil } }
      do {
        try await model.shareDetails(review, names: chosen, includeLocation: location); try Task.checkCancellation()
        guard operationID == token, scenePhase == .active, model.isCurrent(review.context) else { return }
        dismiss()
      }
      catch is CancellationError {}
      catch { if operationID == token, !Task.isCancelled, model.isCurrent(review.context) { feedback = error.localizedDescription; needsReview = true } }
    }
  }
  private func stop() { operationID = nil; operation?.cancel(); operation = nil; review = nil; names = []; includeLocation = false; busy = false }
}
