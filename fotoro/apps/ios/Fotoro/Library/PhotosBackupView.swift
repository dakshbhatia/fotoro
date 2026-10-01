import SwiftUI

struct PhotosBackupView: View {
  @Bindable var services: AppServices
  @Environment(\.dismiss) private var dismiss
  var status: BackupStatus { services.backup.status }
  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("Sync your last 30 days of photos to this account.")
          if !NativeBackupPolicy.allowsPrivatePhotos(
            accountId: services.session.accountId, fixture: services.session.fixture)
          {
            Text("Public test accounts cannot sync your Photos library. Use a real account.")
          }
          Text("Keep Fotoro open while syncing.").foregroundStyle(.secondary)
          if services.backup.isRunning {
            Button("Pause") { services.backup.pause() }
          } else {
            Button(status.phase == .idle ? "Sync last 30 days" : "Resume / retry") {
              do { try services.startPhotosBackup() } catch {
                services.error = error.localizedDescription
              }
            }.disabled(
              !services.vault.isUnlocked
                || !NativeBackupPolicy.allowsPrivatePhotos(
                  accountId: services.session.accountId, fixture: services.session.fixture)
            )
          }
        }
        Section("Status") {
          Text(status.phase.rawValue.capitalized)
          Text(
            "\(status.completed) synced · \(status.pending) pending · \(status.failed) failed · \(status.skipped) skipped"
          )
          if services.backup.isRunning { ProgressView() }
          if let checked = status.lastChecked {
            Text("Last checked \(checked.formatted())").font(.caption)
          }
          if let message = status.message { Text(message).foregroundStyle(.secondary) }
          if status.skipped > 0 {
            Text("Live Photo pairs and videos are skipped; motion is not backed up.")
          }
          if status.failed > 0 {
            ForEach(
              (try? services.store.backupSources().filter {
                $0.message != nil && $0.phase != .skipped
              }) ?? []
            ) { source in
              Text(source.message ?? "Retry this source.").font(.caption)
            }
          }
        }
        Section("Original quality") {
          Text("JPEG, PNG and HEIC originals stay unchanged. Up to 50 MiB per photo.")
          DisclosureGroup("Browsing copies") {
            Text(
              "320 px thumbnails and 1600 px previews, JPEG quality 82%. These do not replace your originals."
            ).font(.caption).foregroundStyle(.secondary)
          }
          Text("Open Safari and recover or sign in to the same account to see committed photos.")
            .font(.caption)
        }
      }.navigationTitle("Sync photos")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .alert(
          "Fotoro",
          isPresented: Binding(
            get: { services.error != nil }, set: { if !$0 { services.error = nil } })
        ) {
          Button("OK") { services.error = nil }
        } message: {
          Text(services.error ?? "")
        }
    }
  }
}
