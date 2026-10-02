import Photos

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
    guard pending else { return }
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
