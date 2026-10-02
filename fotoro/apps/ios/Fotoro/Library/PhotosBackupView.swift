import SwiftUI
import UIKit
import Photos

enum SyncPhotosAccessPolicy {
  static func needsAccess(_ permission: PHAuthorizationStatus, action: ConsumerSyncAction,
    enabled: Bool, hasQueuedUploads: Bool) -> Bool {
    guard !RecentPhotosPolicy.canRead(permission) else { return false }
    if action == .start { return true }
    return enabled && !hasQueuedUploads && (action == .continue || action == .retry)
  }
}

struct PhotosBackupView: View {
  @Bindable var services: AppServices
  @State private var savedPhotos = false
  @State private var exchange = false
  @State private var signingOut = false
  @State private var savedPassword: SavedAccountPassword?
  @State private var photosPermission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var summary: ConsumerSyncSummary { services.consumerSyncSummary }
  var body: some View {
    NavigationStack {
      Group {
        if services.auth.startPassword != nil || !services.vault.isUnlocked || (!services.session.isSignedIn && !services.session.fixture) {
          AccountView(services: services, onSignOut: { signingOut = true })
        } else {
          List {
            Section {
              AccountIdentityView(session: services.session, unlocked: services.vault.isUnlocked)
                .padding(.vertical, 4)
              if services.auth.hasSavedPassword {
                Button("Your Fotoro password", systemImage: "key") {
                  do { savedPassword = SavedAccountPassword(value: try services.auth.savedPassword()) }
                  catch { services.error = error.localizedDescription }
                }.accessibilityIdentifier("account.showPassword")
              }
            }
            overview
            if summary.state == .needsAttention || summary.skippedPhotos > 0 {
              Section("Needs attention") {
                if let detail = summary.detail { Text(detail) }
                if summary.skippedPhotos > 0 {
                  Text("\(summary.skippedPhotos) skipped · videos and Live Photo motion aren't saved.")
                }
                Button("Review saved photos") { savedPhotos = true }
                ForEach(Array(services.annotations.errors.keys.sorted()), id: \.self) { id in
                  Text(services.annotations.errors[id] ?? "").font(.footnote).foregroundStyle(.secondary)
                }
              }
            }
            Section {
              Button("Saved photos", systemImage: "photo.stack") { savedPhotos = true }
                .accessibilityIdentifier("account.savedPhotos")
              Button("Refresh saved photos", systemImage: "arrow.clockwise") {
                services.run { try await services.sync() }
              }.disabled(services.busy)
              DisclosureGroup("More options") {
                Button("Lock saved photos", systemImage: "lock") { services.lockAccount() }
                Button("Encrypted sharing", systemImage: "person.2") { exchange = true }
                Button("Sign out", role: .destructive) { signingOut = true }
              }
            }
          }
        }
      }.navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .sheet(isPresented: $savedPhotos) { LibraryView(services: services) }
        .sheet(isPresented: $exchange) { ExchangeView(services: services, selected: []) }
        .sheet(item: $savedPassword) { password in
          NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
              Text("Use this password to open your Fotoro on any device.").foregroundStyle(.secondary)
              Text(password.value).font(.system(.callout, design: .monospaced))
                .textSelection(.enabled).privacySensitive()
              Button("Copy password", systemImage: "doc.on.doc") { UIPasteboard.general.string = password.value }
              ShareLink("Save password", item: password.value)
              Spacer()
            }.padding().navigationTitle("Fotoro password").navigationBarTitleDisplayMode(.inline)
              .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { savedPassword = nil } } }
          }
        }
        .onAppear { refreshPhotosPermission() }
        .onDisappear { services.auth.cancelStart(); savedPassword = nil }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active { refreshPhotosPermission() }
        }
        .onChange(of: services.vault.isUnlocked) { _, unlocked in
          if !unlocked { savedPhotos = false; exchange = false; savedPassword = nil }
        }
        .onChange(of: scenePhase) { _, phase in
          if phase != .active { savedPassword = nil }
        }
        .alert("Sign out?", isPresented: $signingOut) {
          Button("Sign out and remove local data", role: .destructive) {
            services.run { try services.signOut(discardPending: true) }
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("Pending unsent imports, account wrappers and local account caches will be removed from this iPhone. Your Photos library stays here.")
        }
    }
  }
  private var overview: some View {
    Section {
      VStack(alignment: .leading, spacing: 14) {
        Text(title).font(.title2.bold())
        Text("Automatic sync is off. Save your current picks when you choose.").foregroundStyle(.secondary)
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
        if let error = services.error {
          Text(error).foregroundStyle(.red).accessibilityIdentifier("account.error")
        }
        action.disabled(services.busy)
        if [.preparing, .uploading].contains(summary.state) || services.journal.backgroundPending > 0 {
          Button("Pause saving") { services.pauseSync() }
        }
        if !NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture) {
          Text("Sign in to your own account to save photos.").font(.footnote).foregroundStyle(.secondary)
        }
      }.padding(.vertical, 8)
    }
  }
  @ViewBuilder private var action: some View {
    if requiresPhotosAccess {
      if photosPermission == .notDetermined {
        Button("Allow Photos") {
          services.run {
            defer { refreshPhotosPermission() }
            try await services.requestPhotosAccessForSync()
          }
        }.buttonStyle(.borderedProminent)
          .disabled(!NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture))
        Text("Choose which photos Fotoro can access.").font(.footnote).foregroundStyle(.secondary)
      } else {
        Button("Open Settings", action: openPhotosSettings).buttonStyle(.borderedProminent)
        Text("Photos access is off. Your saved photos are still available.").font(.footnote).foregroundStyle(.secondary)
      }
    } else { syncAction }
  }
  @ViewBuilder private var syncAction: some View {
    switch summary.action {
    case .start:
      Button("Save picks") {
        do { try services.startPhotosBackup() } catch { services.error = error.localizedDescription }
      }.buttonStyle(.borderedProminent)
        .accessibilityIdentifier("account.savePicks")
        .disabled(!NativeBackupPolicy.allowsPrivatePhotos(accountId: services.session.accountId, fixture: services.session.fixture))
    case .continue:
      Button("Continue saving") {
        services.run { try await services.continueSync() }
      }.buttonStyle(.borderedProminent)
    case .retry:
      Button("Try again") {
        services.run { try await services.continueSync() }
      }.buttonStyle(.borderedProminent)
    case .review:
      Button("Review saved photos") { savedPhotos = true }.buttonStyle(.borderedProminent)
    case .openSettings:
      Button("Open Settings", action: openPhotosSettings)
        .buttonStyle(.borderedProminent)
    case .signIn, .none: EmptyView()
    }
  }
  private var requiresPhotosAccess: Bool {
    SyncPhotosAccessPolicy.needsAccess(photosPermission, action: summary.action,
      enabled: (try? services.store.syncEnabled()) == true,
      hasQueuedUploads: (try? services.journal.entries().isEmpty) == false)
  }
  private func refreshPhotosPermission() {
    photosPermission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
  }
  private func openPhotosSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }
  private var title: String {
    switch summary.state {
    case .notStarted: return "Save your picks"
    case .preparing: return "Preparing photos"
    case .uploading: return "Saving photos"
    case .checking: return "Refreshing saved photos"
    case .upToDate: return "Photos saved"
    case .paused: return "Saving paused"
    case .offline: return "Waiting for a connection"
    case .needsAttention: return "Some photos need attention"
    }
  }
}

private struct SavedAccountPassword: Identifiable {
  let id = UUID()
  let value: String
}
