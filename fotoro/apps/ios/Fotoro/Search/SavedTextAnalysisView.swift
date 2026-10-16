import SwiftUI

struct SavedTextAnalysisView: View {
  let services: AppServices
  private var analysis: SavedTextAnalysis<LocalPhoto> { services.savedTextAnalysis }
  private struct Request: Hashable {
    let account: String?
    let vault: UUID
    let catalog: ObjectIdentifier
    let origin: String?
  }
  private var request: Request {
    Request(account: services.photoAccountAccess?.account, vault: services.vault.generation,
      catalog: ObjectIdentifier(services.store), origin: BackgroundUploadPolicy.origin(services.api.baseURL))
  }
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
          if analysis.canResume && analysis.phase == .idle {
            Button("Resume text check", systemImage: "play") { services.checkSavedText(resume: true) }
              .disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.resume")
          }
          Button(analysis.phase == .idle && !analysis.canResume ? "Check missing text" : "Retry this batch", systemImage: "text.viewfinder") {
            services.checkSavedText()
          }.disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.check")
          if analysis.canResume {
            Button("Start over") { services.startSavedTextOver() }
              .disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.startOver")
          }
          if analysis.hasMore {
            Button("Next batch", systemImage: "arrow.forward") { services.checkSavedText(nextBatch: true) }
              .disabled(!services.savedTextCheckAvailable).accessibilityIdentifier("savedText.next")
          }
        }
      }
      if services.savedSemanticDeferred > 0 {
        Section("Saved visual search") {
          Text("\(services.savedSemanticDeferred) photos waiting to retry · \(services.savedSemanticFailed) failed")
          if let retry = services.savedSemanticNextRetry {
            Text("Eligible to retry after \(retry.formatted(date: .omitted, time: .shortened)) while visual search is active.")
              .font(.caption).foregroundStyle(.secondary)
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
      .task(id: request) {
        services.prepareSavedTextContinuation()
        await services.refreshSavedSemanticRetryStatus()
      }
      .onDisappear { analysis.stop() }
  }
}
