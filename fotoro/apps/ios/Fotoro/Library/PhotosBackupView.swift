import SwiftUI
import UIKit

struct ConsumerBackupLabel: View {
  let summary: ConsumerSyncSummary
  var body: some View {
    Label(title, systemImage: symbol).font(.subheadline.weight(.medium))
  }
  private var title: String {
    switch summary.state {
    case .preparing, .uploading, .checking: return "Backing up"
    case .upToDate: return "Backed up"
    case .paused: return "Paused"
    case .offline: return "Offline"
    case .needsAttention: return "Backup"
    case .notStarted: return "Backup"
    }
  }
  private var symbol: String {
    switch summary.state {
    case .upToDate: return "checkmark.icloud"
    case .paused: return "pause.circle"
    case .offline: return "icloud.slash"
    case .needsAttention: return "exclamationmark.icloud"
    default: return "icloud"
    }
  }
}

struct PhotosBackupView: View {
  @Bindable var services: AppServices
  @State private var savedPhotos = false
  @State private var exchange = false
  @State private var signingOut = false
  @Environment(\.dismiss) private var dismiss
  private var summary: ConsumerSyncSummary { services.consumerSyncSummary }
  var body: some View {
    NavigationStack {
      Group {
        if !services.vault.isUnlocked {
          AccountView(services: services)
        } else {
          List {
            overview
            if summary.state == .needsAttention || summary.skippedPhotos > 0 {
              Section("Needs attention") {
                if let detail = summary.detail { Text(detail) }
                if summary.skippedPhotos > 0 {
                  Text("\(summary.skippedPhotos) skipped · videos and Live Photo motion aren't backed up.")
                }
                Button("Review saved photos") { savedPhotos = true }
                ForEach(Array(services.annotations.errors.keys.sorted()), id: \.self) { id in
                  Text(services.annotations.errors[id] ?? "").font(.footnote).foregroundStyle(.secondary)
                }
              }
            }
            Section {
              Button("Saved photos", systemImage: "photo.stack") { savedPhotos = true }
              DisclosureGroup("Account & privacy") {
                Text("Original quality. Encrypted photos, labels and text. Only you can open your account.")
                  .font(.footnote).foregroundStyle(.secondary)
                Button("Lock account", systemImage: "lock") { services.lockAccount() }
                Button("Encrypted sharing", systemImage: "person.2") { exchange = true }
                Button("Sign out", role: .destructive) { signingOut = true }
              }
            }
          }
        }
      }.navigationTitle("Backup").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .sheet(isPresented: $savedPhotos) { LibraryView(services: services) }
        .sheet(isPresented: $exchange) { ExchangeView(services: services, selected: []) }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked { savedPhotos = false; exchange = false }
        }
        .alert("Sign out?", isPresented: $signingOut) {
          Button("Sign out and remove local data", role: .destructive) {
            services.run { try services.signOut(discardPending: true) }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("Pending unsent imports, account wrappers and local account caches will be removed from this iPhone. Your Photos library stays here.")
        }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }
  }
  private var overview: some View {
    Section {
      VStack(alignment: .leading, spacing: 14) {
        Image(systemName: symbol).font(.system(size: 30)).foregroundStyle(.tint)
        Text(title).font(.title2.bold())
        Text("Your last 10 days, saved privately.").foregroundStyle(.secondary)
        if let completed = summary.completedPhotos {
          if let total = summary.totalPhotos {
            Text("\(completed) of \(total) photos saved").font(.headline).monospacedDigit()
            if total > 0 { ProgressView(value: Double(completed), total: Double(total)) }
          } else if completed > 0 { Text("\(completed) photos saved").font(.headline).monospacedDigit() }
        }
        if let checked = summary.lastCheckedAt {
          Text("Last checked \(checked.formatted(date: .abbreviated, time: .shortened))")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if let detail = summary.detail, summary.state != .needsAttention {
          Text(detail).font(.footnote).foregroundStyle(.secondary)
        }
        action
        if ![.notStarted, .paused].contains(summary.state) || services.journal.backgroundPending > 0 {
          Button("Pause backup") { services.pauseSync() }
        }
        if !NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture) {
          Text("Use your own account to back up personal photos.").font(.footnote).foregroundStyle(.secondary)
        }
        Text("Open Fotoro to find and prepare photos. Scheduled encrypted uploads can continue in the background.")
          .font(.footnote).foregroundStyle(.secondary)
      }.padding(.vertical, 8)
    }
  }
  @ViewBuilder private var action: some View {
    switch summary.action {
    case .start:
      Button("Back up last 10 days") {
        do { try services.startPhotosBackup() } catch { services.error = error.localizedDescription }
      }.buttonStyle(.borderedProminent)
        .disabled(!NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture))
    case .continue:
      Button("Continue backup") {
        services.run { try await services.continueSync() }
      }.buttonStyle(.borderedProminent)
    case .retry:
      Button("Try again") {
        services.run {
          if try services.store.syncEnabled() {
            try services.startPhotosBackup()
          } else {
            try await services.resumeTransfers()
            await services.syncAnnotations()
            try await services.sync()
          }
        }
      }.buttonStyle(.borderedProminent)
    case .review:
      Button("Review saved photos") { savedPhotos = true }.buttonStyle(.borderedProminent)
    case .openSettings:
      Button("Open Settings") { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) }
        .buttonStyle(.borderedProminent)
    case .signIn, .none: EmptyView()
    }
  }
  private var title: String {
    switch summary.state {
    case .notStarted: return "Keep your photos with you"
    case .preparing: return "Preparing your photos"
    case .uploading: return "Backing up your photos"
    case .checking: return "Checking your backup"
    case .upToDate: return "Your photos are backed up"
    case .paused: return "Backup paused"
    case .offline: return "Waiting for a connection"
    case .needsAttention: return "Some photos need attention"
    }
  }
  private var symbol: String {
    switch summary.state {
    case .upToDate: return "checkmark.icloud"
    case .paused: return "pause.circle"
    case .offline: return "icloud.slash"
    case .needsAttention: return "exclamationmark.icloud"
    default: return "icloud"
    }
  }
}
