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
  init(origin: String? = nil) { self.origin = origin }
  @discardableResult mutating func authorize(_ access: PhotoAccountAccess?, origin: String) -> Bool {
    guard pending, let access, self.origin == nil || self.origin == origin else { return false }
    if let authorization { return authorization == access }
    authorization = access
    self.origin = origin
    return true
  }
  mutating func consume(active: Bool, access: PhotoAccountAccess?, origin: String) -> Bool {
    guard pending, active, let authorization, authorization == access, self.origin == origin else { return false }
    pending = false
    return true
  }
  mutating func cancel() { pending = false; authorization = nil; origin = nil }
}

enum PhotoSyncAccountPolicy {
  static func requiresAuthentication(hasAccountAccess: Bool, isSignedIn: Bool,
    accountId: String?, fixture: Bool, rejectedSession: Bool) -> Bool {
    rejectedSession || !hasAccountAccess || !isSignedIn
      || !NativeBackupPolicy.allowsPrivatePhotos(accountId: accountId, fixture: fixture)
  }
}

struct PhotoSyncView: View {
  @Bindable var services: AppServices
  let savedRefresh: SavedLibraryRefresh?
  let openSaved: (() -> Void)?
  @State private var consent: AutomaticPhotoSyncConsent?
  @State private var openingAccount = false
  @State private var rejectedSession = false
  @State private var authenticationTask: Task<Void, Never>?
  @State private var permissionTask: Task<Void, Never>?
  @State private var password: FotoroPassword?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  init(services: AppServices, savedRefresh: SavedLibraryRefresh? = nil, requiresAuthentication: Bool = false,
    startAutomaticSync: Bool = false, openSaved: (() -> Void)? = nil) {
    self.services = services
    self.savedRefresh = savedRefresh
    self.openSaved = openSaved
    _consent = State(initialValue: startAutomaticSync ? AutomaticPhotoSyncConsent(origin: services.api.origin) : nil)
    let needsAccount = PhotoSyncAccountPolicy.requiresAuthentication(hasAccountAccess: services.photoAccountAccess != nil,
      isSignedIn: services.session.isSignedIn, accountId: services.session.accountId,
      fixture: services.session.fixture, rejectedSession: requiresAuthentication)
    _openingAccount = State(initialValue: requiresAuthentication || (startAutomaticSync && needsAccount))
    _rejectedSession = State(initialValue: requiresAuthentication)
  }
  private var status: AutomaticPhotoSyncStatus { services.automaticPhotoSync }
  private var catalogFailure: String? { savedRefresh?.failureDetails(services) }
  private var sessionRejected: Bool { rejectedSession || savedRefresh?.requiresAuthentication(services) == true }
  private var manualRecovery: Bool {
    !status.enabled && (services.consumerSyncSummary.action == .retry || services.consumerSyncSummary.action == .continue)
  }
  private var accountNeedsOpening: Bool {
    PhotoSyncAccountPolicy.requiresAuthentication(hasAccountAccess: services.photoAccountAccess != nil,
      isSignedIn: services.session.isSignedIn, accountId: services.session.accountId,
      fixture: services.session.fixture, rejectedSession: sessionRejected)
  }
  private var photosAccessBlocked: Bool {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    return permission == .denied || permission == .restricted
  }
  var body: some View {
    NavigationStack {
      Group {
        if openingAccount {
          AccountView(services: services, reauthenticate: sessionRejected, diagnosticDetail: catalogFailure,
            onSignedIn: openedAccount, onAuthenticationTask: { authenticationTask = $0 })
        } else {
          List {
            Section {
              Text(status.enabled ? syncTitle : "Sync your photos").font(.title2.weight(.semibold))
              if !status.enabled {
                Text("Keep Fotoro open to sync new photos.").foregroundStyle(.secondary)
              } else if status.phase != .ready {
                Text(status.detail).foregroundStyle(.secondary)
              }
              if savedRefresh?.isRefreshing == true {
                ProgressView("Loading photos…")
              } else if permissionTask != nil || authenticationTask != nil {
                ProgressView("Opening sync…")
              } else if accountNeedsOpening {
                Button("Open Fotoro", systemImage: "person.crop.circle") {
                  openingAccount = true
                  services.error = nil
                }.accessibilityIdentifier("sync.openAccount")
              } else if catalogFailure != nil, let savedRefresh, !savedRefresh.requiresAuthentication(services) {
                Button("Retry loading photos", systemImage: "arrow.clockwise") {
                  Task { await savedRefresh.refresh(services) }
                }.disabled(services.busy).accessibilityIdentifier("sync.retryCatalog")
              } else if manualRecovery {
                Button(services.consumerSyncSummary.action == .continue ? "Continue saving" : "Try saving again",
                  systemImage: "arrow.clockwise") {
                  services.run { try await services.continueSync() }
                }.disabled(services.busy).accessibilityIdentifier("sync.continueSave")
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
                  Button("Try again", systemImage: "arrow.clockwise") {
                    services.run {
                      try await services.retryAutomaticPhotoSync()
                    }
                  }.disabled(services.busy)
                }
              }
              if !status.enabled, !accountNeedsOpening, !photosAccessBlocked, catalogFailure != nil || manualRecovery {
                Button("Turn on sync", systemImage: "icloud.and.arrow.up", action: turnOn)
                  .disabled(services.busy || savedRefresh?.isRefreshing == true)
                  .accessibilityIdentifier("sync.enable")
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
                if let openSaved {
                  Button("View synced photos", systemImage: "photo.on.rectangle") { dismiss(); openSaved() }
                    .accessibilityIdentifier("sync.viewSaved")
                }
              }
            }
            Section {
              DisclosureGroup("How sync works") {
                syncExplanation
                if status.enabled {
                  Button("Turn off automatic sync", role: .destructive) {
                    cancelConsent()
                    do { try services.disableAutomaticPhotoSync() }
                    catch { services.error = error.localizedDescription }
                  }.accessibilityIdentifier("sync.disable")
                }
              }
            }.font(.footnote).foregroundStyle(.secondary)
            if catalogFailure != nil { Section { catalogDetails } }
          }
        }
      }.navigationTitle("Sync").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        .sheet(item: $password) { FotoroPasswordView(password: $0) }
        .task { resumeConsent() }
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
  @ViewBuilder private var catalogDetails: some View {
    if let catalogFailure {
      DisclosureGroup("Details") { Text(catalogFailure).textSelection(.enabled) }
        .font(.footnote).foregroundStyle(.secondary)
    }
  }
  private var syncTitle: String {
    switch status.phase {
    case .off: "Your photos, everywhere"
    case .paused: "Sync paused"
    case .locked: "Open Fotoro to resume"
    case .permissionRequired: "Photos access needed"
    case .background: "Sync will continue"
    case .syncing: "Syncing your photos"
    case .partial: "Some originals weren't synced"
    case .needsAttention: "Sync needs attention"
    case .ready: "Sync is on"
    }
  }
  private var syncExplanation: some View {
    Group {
      Text("Keep Fotoro open for the first sync. iOS can finish uploads already prepared after you leave the app.")
      Text("JPEG, PNG and HEIC photos, MP4 and MOV videos, and complete Live Photos are supported. Each complete original must fit within 50 MiB. Originals are never removed from Photos.")
    }
  }
  private func turnOn() {
    consent = AutomaticPhotoSyncConsent(origin: services.api.origin)
    openingAccount = accountNeedsOpening
    services.error = nil
    resumeConsent()
  }
  private func openedAccount() {
    rejectedSession = false
    guard !accountNeedsOpening else {
      services.error = "Open your private Fotoro account before enabling automatic sync."
      return
    }
    openingAccount = false
    resumeConsent()
  }
  private func resumeConsent() {
    guard scenePhase == .active, permissionTask == nil, consent?.pending == true,
      !accountNeedsOpening, services.auth.startPassword == nil, services.photoAccountAccess != nil else { return }
    guard consent?.authorize(services.photoAccountAccess, origin: services.api.origin) == true else { return }
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
