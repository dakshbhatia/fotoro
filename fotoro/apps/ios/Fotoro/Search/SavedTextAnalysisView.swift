import SwiftUI

struct SavedTextAnalysisView: View {
  let services: AppServices
  private var analysis: SavedTextAnalysis<LocalPhoto> { services.savedTextAnalysis }
  var body: some View {
    List {
      Section {
        Text("Checks up to 25 of your Saved photos per batch using previews already on this device. Existing text checks are kept, including checks with no recognized words.")
          .font(.caption).foregroundStyle(.secondary)
        Text("Text is recognized on this device with Apple Vision and saved in your encrypted annotations.")
          .font(.caption).foregroundStyle(.secondary)
        if !services.savedTextCheckAvailable {
          Text("Open Fotoro and resume sync before checking Saved photos.").foregroundStyle(.secondary)
        }
        if analysis.phase != .idle {
          Text(analysis.pageFailed ? "Saved photos could not be read" : analysis.phase == .checking ? "Checking Saved photos" : analysis.phase == .stopped ? (analysis.running ? "Stopping text check" : "Text check stopped") : "Batch checked")
            .accessibilityIdentifier("savedText.status")
          Text("\(analysis.processed) of \(analysis.total) photos attempted in this batch")
          Text("\(analysis.checked) added · \(analysis.existing) already checked")
          Text("\(analysis.unavailable) previews unavailable · \(analysis.failed) failed")
        }
        if analysis.running {
          Button("Stop checking", role: .cancel) { analysis.stop() }
            .accessibilityIdentifier("savedText.stop")
        } else {
          Button(analysis.phase == .idle ? "Check missing text" : "Retry this batch", systemImage: "text.viewfinder") {
            services.checkSavedText()
          }.disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.check")
          if analysis.hasMore {
            Button("Next batch", systemImage: "arrow.forward") { services.checkSavedText(nextBatch: true) }
              .disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.next")
          }
        }
      }
      Section("Annotation sync") {
        Text("\(services.consumerSyncSummary.annotationsPending) annotations pending sync")
          .accessibilityIdentifier("savedText.pending")
        Text("Text checks stay saved here while offline. Sync also sends any other pending photo edits.")
          .font(.caption).foregroundStyle(.secondary)
        Button("Sync pending annotations", systemImage: "arrow.triangle.2.circlepath") {
          Task { await services.syncAnnotations() }
        }.disabled(!services.savedTextCheckAvailable || services.annotations.busy)
          .accessibilityIdentifier("savedText.sync")
      }
    }.navigationTitle("Text in Saved photos")
      .onDisappear { analysis.stop() }
  }
}
