import SwiftUI

struct PhotosBackupView: View {
  @Bindable var services: AppServices
  @Environment(\.dismiss) private var dismiss
  var status: BackupStatus { services.backup.status }
  private var statusTitle: String {
    switch status.phase {
    case .idle: return "Ready to sync"
    case .scanning: return "Finding your photos…"
    case .running: return "Saving your photos…"
    case .paused: return "Sync paused"
    case .failed: return "Some photos need another try"
    case .partial: return "Still photos saved"
    case .complete: return "Your photos are saved"
    }
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Label(statusTitle, systemImage: status.phase == .complete ? "checkmark.icloud" : "icloud")
            .font(.title3)
          Text("Your last 30 days, privately saved in your account.").foregroundStyle(.secondary)
          if services.backup.isRunning { ProgressView() }
          if services.backup.isRunning || services.journal.backgroundPending > 0 {
            Button("Pause sync") {
              services.pauseSync()
            }
          } else {
            Button(status.phase == .idle ? "Start syncing" : "Continue sync") {
              do { try services.startPhotosBackup() } catch { services.error = error.localizedDescription }
            }.buttonStyle(.borderedProminent)
              .disabled(!services.vault.isUnlocked || !NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture))
          }
          Text("Open Fotoro to find and prepare photos. Scheduled encrypted uploads can continue in the background.")
            .font(.caption).foregroundStyle(.secondary)
          if !NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture) {
            Text("Use your own account to sync personal photos.").font(.caption)
          }
        }
        Section {
          LabeledContent("Saved", value: "\(status.completed)")
          LabeledContent("Waiting", value: "\(status.pending)")
          if services.journal.backgroundPending > 0 {
            Text(services.journal.backgroundStatus).font(.caption).foregroundStyle(.secondary)
          }
          if status.failed > 0 { LabeledContent("Needs another try", value: "\(status.failed)") }
          if status.skipped > 0 { LabeledContent("Skipped", value: "\(status.skipped)") }
          if let checked = status.lastChecked {
            Text("Last checked \(checked.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
          }
          if let message = status.message { Text(message).font(.caption).foregroundStyle(.secondary) }
          if let count = try? services.annotations.ledger.pendingIDs().count, count > 0 {
            Text("Labels and text waiting to sync: \(count)").font(.caption)
            Button("Retry labels and text") { Task { await services.syncAnnotations() } }
          }
          ForEach(Array(services.annotations.errors.keys.sorted()), id: \.self) { id in
            Text(services.annotations.errors[id] ?? "").font(.caption).foregroundStyle(.secondary)
          }
        }
        Section("Your originals") {
          Text("Photos keep their original quality. Labels and recognized text are encrypted for your account.")
          Text("Live Photo motion and videos are skipped.").font(.caption).foregroundStyle(.secondary)
          Text("Sign in to the same account on another device to find your saved photos.").font(.caption).foregroundStyle(.secondary)
        }
      }.navigationTitle("Photo sync")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }
  }
}
