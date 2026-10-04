import Photos
import SwiftUI
import UIKit

enum SyncPhotosAccessPolicy {
  static func needsAccess(_ permission: PHAuthorizationStatus, action: ConsumerSyncAction,
    enabled: Bool, hasQueuedUploads: Bool) -> Bool {
    guard !RecentPhotosPolicy.canRead(permission) else { return false }
    if action == .start { return true }
    return enabled && !hasQueuedUploads && (action == .continue || action == .retry)
  }
}

struct PhotoAccountAccess: Equatable {
  let account: String
  let vault: UUID
  let catalog: ObjectIdentifier
}

struct ManualPhotoSaveIntent {
  let sources: [RecentPhotoSource]
  private(set) var pending = true
  private(set) var wasConsumed = false
  private var authorization: PhotoAccountAccess?
  init(_ sources: [RecentPhotoSource]) { self.sources = sources }
  mutating func authorize(_ access: PhotoAccountAccess?) {
    guard pending, authorization == nil else { return }
    authorization = access
  }
  mutating func consume(active: Bool, access: PhotoAccountAccess?) -> [RecentPhotoSource]? {
    guard pending, active, let authorization, authorization == access, !sources.isEmpty else { return nil }
    pending = false
    wasConsumed = true
    return sources
  }
  mutating func cancel() { pending = false; authorization = nil }
}

struct AutomaticPhotoSyncConsent {
  private(set) var pending = true
  private var authorization: PhotoAccountAccess?
  private var origin: String?
  mutating func authorize(_ access: PhotoAccountAccess?, origin: String) {
    guard pending, authorization == nil, let access else { return }
    authorization = access
    self.origin = origin
  }
  mutating func consume(active: Bool, access: PhotoAccountAccess?, origin: String) -> Bool {
    guard pending, active, let authorization, authorization == access, self.origin == origin else { return false }
    pending = false
    return true
  }
  mutating func cancel() { pending = false; authorization = nil; origin = nil }
}

struct PhotoSyncView: View {
  @Bindable var services: AppServices
  @State private var consent: AutomaticPhotoSyncConsent?
  @State private var openingAccount = false
  @State private var authenticationTask: Task<Void, Never>?
  @State private var permissionTask: Task<Void, Never>?
  @State private var password: FotoroPassword?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  private var status: AutomaticPhotoSyncStatus { services.automaticPhotoSync }
  private var photosAccessBlocked: Bool {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return permission == .denied || permission == .restricted
  }
  var body: some View {
    NavigationStack {
      Group {
        if openingAccount && (services.photoAccountAccess == nil || services.auth.startPassword != nil) {
          VStack(alignment: .leading, spacing: 12) {
            Text("Open Fotoro to turn on sync").font(.headline).padding(.horizontal).padding(.top)
            AccountView(services: services, onSignedIn: openedAccount,
              onAuthenticationTask: { authenticationTask = $0 })
          }
        } else {
          List {
            Section {
              Text(status.enabled ? syncTitle : "Your photos, everywhere").font(.title2.weight(.semibold))
              Text(status.enabled ? syncDetail : "Turn on once. Fotoro saves the photos you allow and keeps new photos in sync.")
                .foregroundStyle(.secondary)
              if permissionTask != nil || authenticationTask != nil {
                ProgressView("Opening sync…")
              } else if photosAccessBlocked {
                Text("Allow Photos access in Settings to turn on sync.").font(.footnote).foregroundStyle(.secondary)
                Button("Open Photos settings", systemImage: "gearshape") {
                  UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
                }.accessibilityIdentifier("sync.photosSettings")
              } else if !status.enabled || status.paused || status.phase == .locked || status.phase == .permissionRequired {
                Button(status.enabled ? "Resume sync" : "Turn on sync", systemImage: "icloud.and.arrow.up", action: turnOn)
                  .accessibilityIdentifier("sync.enable")
              } else {
                Button("Pause sync", systemImage: "pause") { services.pauseAutomaticPhotoSync() }
                  .accessibilityIdentifier("sync.pause")
                if status.phase == .needsAttention {
                  Button("Try again", systemImage: "arrow.clockwise") { services.kickAutomaticPhotoSync() }
                }
              }
            }
            if services.photoAccountAccess != nil {
              if (try? services.annotations.ledger.pendingIDs().isEmpty) == false {
                Section {
                  Text("Photo changes are saved on this device.").font(.footnote).foregroundStyle(.secondary)
                  Button("Sync changes") { Task { await services.syncAnnotations() } }
                    .disabled(services.busy || services.annotations.busy ||
                      (try? services.store.uploadsPaused()) != false ||
                      !(services.session.isSignedIn || services.session.fixture))
                    .accessibilityIdentifier("sync.changes")
                }
              }
              Section {
                AccountIdentityView(session: services.session, unlocked: services.vault.isUnlocked)
                if services.auth.hasSavedPassword {
                  Button("Open on another device", systemImage: "laptopcomputer.and.iphone") {
                    do { password = FotoroPassword(value: try services.auth.savedPassword()) }
                    catch { services.error = error.localizedDescription }
                  }
                }
                Text("Synced photos appear in Saved, here and at fotoro.cloud/saved.").font(.footnote).foregroundStyle(.secondary)
              }
            }
            Section {
              if status.enabled {
                DisclosureGroup("How sync works") { syncExplanation }
                Button("Turn off automatic sync", role: .destructive) {
                  cancelConsent()
                  do { try services.disableAutomaticPhotoSync() }
                  catch { services.error = error.localizedDescription }
                }.accessibilityIdentifier("sync.disable")
              } else {
                syncExplanation
              }
            }.font(.footnote).foregroundStyle(.secondary)
          }
        }
      }.navigationTitle("Sync").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .sheet(item: $password) { FotoroPasswordView(password: $0) }
        .onChange(of: scenePhase) {
          if scenePhase == .active { resumeConsent() }
          else if scenePhase == .background { cancelConsent(); password = nil }
        }
        .onChange(of: services.photoAccountAccess) {
          if authenticationTask == nil { resumeConsent() }
          if services.photoAccountAccess == nil { password = nil }
        }
        .onChange(of: services.vault.generation) { password = nil }
        .onDisappear { cancelConsent(); password = nil }
        .alert("Fotoro", isPresented: Binding(get: { services.error != nil }, set: { if !$0 { services.error = nil } })) {
          Button("OK") { services.error = nil }
        } message: { Text(services.error ?? "") }
    }.preferredColorScheme(.dark)
  }
  private var syncTitle: String {
    switch status.phase {
    case .off: "Your photos, everywhere"
    case .paused: "Sync paused"
    case .locked: "Open Fotoro to resume"
    case .permissionRequired: "Photos access needed"
    case .background: "Sync will continue"
    case .syncing: "Syncing your photos"
    case .needsAttention: "Sync needs attention"
    case .ready: "Sync is on"
    }
  }
  private var syncDetail: String {
    if status.phase == .ready { return "New photos sync while Fotoro is open. Your originals stay in Photos." }
    return status.detail
  }
  private var syncExplanation: some View {
    Group {
      Text("Keep Fotoro open for the first sync. iOS can finish uploads already prepared after you leave the app.")
      Text("JPEG, PNG and HEIC photos up to 50 MB are supported. Videos and Live Photo pairs stay in Photos for now. Originals are never removed.")
    }
  }
  private func turnOn() {
    consent = AutomaticPhotoSyncConsent()
    openingAccount = services.photoAccountAccess == nil
    services.error = nil
    resumeConsent()
  }
  private func openedAccount() {
    openingAccount = false
    resumeConsent()
  }
  private func resumeConsent() {
    guard scenePhase == .active, permissionTask == nil, consent?.pending == true,
      services.auth.startPassword == nil, services.photoAccountAccess != nil else { return }
    consent?.authorize(services.photoAccountAccess, origin: services.api.origin)
    permissionTask = Task {
      defer { permissionTask = nil }
      do {
        if !RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) {
          try await services.requestPhotosAccessForSync()
        }
        guard !Task.isCancelled,
          consent?.consume(active: scenePhase == .active, access: services.photoAccountAccess, origin: services.api.origin) == true else { return }
        try services.enableAutomaticPhotoSync()
      } catch is CancellationError {} catch {
        if !Task.isCancelled { services.error = error.localizedDescription }
      }
    }
  }
  private func cancelConsent() {
    consent?.cancel()
    permissionTask?.cancel(); permissionTask = nil
    authenticationTask?.cancel(); authenticationTask = nil
    services.auth.cancelStart()
  }
}
