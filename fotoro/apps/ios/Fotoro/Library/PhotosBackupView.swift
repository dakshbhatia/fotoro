import Photos

enum SyncPhotosAccessPolicy {
  static func needsAccess(_ permission: PHAuthorizationStatus, action: ConsumerSyncAction,
    enabled: Bool, hasQueuedUploads: Bool) -> Bool {
    guard !RecentPhotosPolicy.canRead(permission) else { return false }
    if action == .start { return true }
    return enabled && !hasQueuedUploads && (action == .continue || action == .retry)
  }
}

struct ManualPhotoSaveIntent {
  let sources: [RecentPhotoSource]
  private(set) var pending = true
  private(set) var wasConsumed = false
  init(_ sources: [RecentPhotoSource]) { self.sources = sources }
  mutating func consume(active: Bool, unlocked: Bool) -> [RecentPhotoSource]? {
    guard pending, active, unlocked, !sources.isEmpty else { return nil }
    pending = false
    wasConsumed = true
    return sources
  }
  mutating func cancel() { pending = false }
}
