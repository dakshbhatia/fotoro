import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

struct SelectedResource: Identifiable, Sendable {
  enum Origin: Sendable { case photos, file }
  var id: String
  var origin: Origin
  var resourceIdentifier: String
  var fileURL: URL?
}
struct ImportFailure: Identifiable, Sendable {
  var id: String
  var message: String
}
actor PhotoImport {
  let store: LibraryStore
  let crypto = CryptoAdapter()
  let sourceReader: (@Sendable (SelectedResource) async throws -> (Data, String, Bool))?
  private let sourceRevision: @Sendable (String) -> String?
  private let sourceCaptureMetadata: @Sendable (String) -> PhotoCaptureMetadata?
  private let sourceLocation: @Sendable (String) -> PhotoLocationV1?
  var failures: [ImportFailure] = []
  var notices: [String] = []
  init(
    store: LibraryStore,
    sourceReader: (@Sendable (SelectedResource) async throws -> (Data, String, Bool))? = nil,
    sourceRevision: (@Sendable (String) -> String?)? = nil,
    sourceLocation: (@Sendable (String) -> PhotoLocationV1?)? = nil,
    sourceCaptureMetadata: (@Sendable (String) -> PhotoCaptureMetadata?)? = nil
  ) {
    self.store = store
    self.sourceReader = sourceReader
    self.sourceRevision = sourceRevision ?? { id in
      PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject.map {
        RecentPhoto.sourceRevision($0)
      }
    }
    self.sourceCaptureMetadata = sourceCaptureMetadata ?? { id in
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject, !asset.isHidden else { return nil }
      return .photos(asset, includeDetails: true)
    }
    self.sourceLocation = sourceLocation ?? { id in
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
        let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
        !asset.isHidden else { return nil }
      return PhotoLocationV1.photos(asset.location)
    }
  }
  func importResources(
    _ selected: [SelectedResource], accountId: String, bundle: AccountBundle,
    valid: @escaping @Sendable () async -> Bool = { true }
  )
    async throws -> [LocalPhoto]
  {
    failures = []
    notices = []
    var imported: [LocalPhoto] = []
    for selection in selected {
      try Task.checkCancellation()
      guard await valid() else { throw CancellationError() }
      do {
        let revision = selection.origin == .photos ? sourceRevision(selection.resourceIdentifier) : nil
        let (bytes, filename, edited) = try await read(selection)
        guard await valid() else { throw CancellationError() }
        let capture = (selection.origin == .photos ? sourceCaptureMetadata(selection.resourceIdentifier) : nil)
          .map { $0.merging(Self.capture(bytes)) } ?? Self.capture(bytes)
        let currentDate = capture.items.first { $0.p == .photos && $0.k == "createdAt" }.flatMap { Wire.parseDate($0.v) }
        let photo = try await buildMedia(
          bytes: bytes, filename: filename, accountId: accountId, bundle: bundle, capturedAt: currentDate, permitOriginalCaptureDate: selection.origin != .photos)
        guard !Task.isCancelled, await valid() else {
          for url in Array(photo.staged.values)
            + [photo.originalURL, photo.thumbnailURL, photo.previewURL].compactMap({ $0 })
          {
            try? FileManager.default.removeItem(at: url)
          }
          throw CancellationError()
        }
        // Current Photos metadata may intentionally omit GPS retained by its original.
        let location = selection.origin == .photos ? sourceLocation(selection.resourceIdentifier) : Self.location(bytes)
        if let revision, sourceRevision(selection.resourceIdentifier) != revision {
          for url in Array(photo.staged.values) + [photo.originalURL, photo.thumbnailURL, photo.previewURL].compactMap({ $0 }) {
            try? FileManager.default.removeItem(at: url)
          }
          throw FotoroError("Photo changed during import. Try again.")
        }
        try persistLocation(location, photo: photo, accountId: accountId, bundle: bundle, insertPhoto: true, capture: capture)
        imported.append(photo)
        if edited {
          notices.append("Imported the unmodified original; Photos edits are not included.")
        }
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        failures.append(ImportFailure(id: selection.id, message: error.localizedDescription))
      }
    }
    return imported
  }
  func importResources(_ selected: [SelectedResource]) async throws -> [LocalPhoto] {
    throw FotoroError("An unlocked account bundle is required for import")
  }
  static func validate(_ bytes: Data, filename: String) throws -> String {
    guard !bytes.isEmpty, bytes.count <= 50 * 1024 * 1024 else {
      throw FotoroError("Original must be between 1 byte and 50 MiB")
    }
    let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let type = CGImageSourceGetType(source) as String?
    else {
      throw FotoroError("The original image cannot be decoded")
    }
    let supported: [String: (String, [String])] = [
      UTType.jpeg.identifier: ("image/jpeg", ["jpg", "jpeg"]),
      UTType.png.identifier: ("image/png", ["png"]),
      UTType.heic.identifier: ("image/heic", ["heic"]),
    ]
    guard let (mediaType, extensions) = supported[type], extensions.contains(ext) else {
      throw FotoroError("Choose an unmodified JPEG, PNG or HEIC original with a matching filename")
    }
    return mediaType
  }
  static func originalExtension(for mediaType: String) -> String {
    switch mediaType {
    case "image/png": return "png"
    case "image/heic": return "heic"
    case "video/mp4": return "mp4"
    case "video/quicktime": return "mov"
    case CameraMedia.liveType: return "fotoro-live"
    default: return "jpg"
    }
  }

  private func read(_ selected: SelectedResource) async throws -> (Data, String, Bool) {
    if let sourceReader { return try await sourceReader(selected) }
    switch selected.origin {
    case .file:
      guard let url = selected.fileURL else {
        throw FotoroError("Original file is unavailable; reselect it")
      }
      let granted = url.startAccessingSecurityScopedResource()
      defer { if granted { url.stopAccessingSecurityScopedResource() } }
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 50 * 1024 * 1024 else { throw FotoroError("Original exceeds 50 MiB") }
      return (try Data(contentsOf: url), url.lastPathComponent, false)
    case .photos:
      return try await CameraMedia.readPhotosOriginal(id: selected.resourceIdentifier, revision: sourceRevision(selected.resourceIdentifier))

    }
  }
  // One caller-owned preparation attempt; never retained as an importer cache.
  struct BackupOriginal: Sendable {
    let sourceID: String
    let revision: String?
    let bytes: Data
    let filename: String
    let digest: String

    fileprivate init(sourceID: String, revision: String?, bytes: Data, filename: String, digest: String) {
      self.sourceID = sourceID; self.revision = revision
      self.bytes = bytes; self.filename = filename; self.digest = digest
    }
  }
  func prepareBackupOriginal(
    _ source: BackupSource, valid: @escaping @Sendable () async -> Bool = { true }
  ) async throws -> BackupOriginal {
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    try Task.checkCancellation()
    try checkBackupRevision(source)
    let selection = SelectedResource(id: source.id, origin: .photos, resourceIdentifier: source.id, fileURL: nil)
    let (bytes, filename, _) = try await read(selection)
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    try checkBackupRevision(source)
    try CameraMedia.validateSize(bytes.count)
    let digest = bytes.digest
    try Task.checkCancellation()
    return BackupOriginal(sourceID: source.id, revision: source.sourceRevision, bytes: bytes, filename: filename, digest: digest)
  }
  private func checkBackupRevision(_ source: BackupSource) throws {
    guard let expected = source.sourceRevision else { return }
    guard sourceRevision(source.id) == expected else { throw FotoroError("Photo changed during sync. Try again.") }
  }
  func stageBackup(
    _ source: BackupSource, accountId: String, bundle: AccountBundle, capturedAt: Date? = nil,
    valid: @escaping @Sendable () async -> Bool = { true }, preparedOriginal: BackupOriginal? = nil
  ) async throws -> LocalPhoto {
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    try Task.checkCancellation()
    func checkRevision() throws {
      try checkBackupRevision(source)
    }
    try checkRevision()
    if let preparedOriginal {
      guard preparedOriginal.sourceID == source.id, preparedOriginal.revision == source.sourceRevision else {
        throw FotoroError("Prepared original does not match this Photos source")
      }
    }
    if let existing = try store.backupPhoto(source.photoId) { return existing }
    let original: BackupOriginal
    if let preparedOriginal { original = preparedOriginal }
    else { original = try await prepareBackupOriginal(source, valid: valid) }
    let bytes = original.bytes, filename = original.filename
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    try checkRevision()
    try Task.checkCancellation()
    let location = sourceLocation(source.id)
    let capture = (sourceCaptureMetadata(source.id) ?? PhotoCaptureMetadata()).merging(Self.capture(bytes))
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    try Task.checkCancellation()
    try checkRevision()
    if let reused = try store.ownedOriginal(digest: original.digest, accountId: accountId) {
      var checkpoint = source
      checkpoint.photoId = reused.photoId
      checkpoint.originalSha256 = reused.metadata.originalSha256
      checkpoint.message = nil
      if ["committed", "saved"].contains(reused.transferState) {
        checkpoint.phase = .committed
        try store.putBackupSource(checkpoint)
        try persistLocation(location, photo: reused, accountId: accountId, bundle: bundle, capture: capture)
      } else {
        try store.stageBackup(reused, source: checkpoint, location: location, bundle: bundle, capture: capture)
      }
      return reused
    }
    let photo = try await buildMedia(
      bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: source.photoId, backup: true, capturedAt: capturedAt, permitOriginalCaptureDate: false, originalDigest: original.digest)
    do {
      try checkRevision()
      try Task.checkCancellation()
      guard await valid() else { throw CancellationError() }
      try store.stageBackup(photo, source: source, location: location, bundle: bundle, capture: capture)
    } catch {
      for url in Array(photo.staged.values)
        + [photo.originalURL, photo.thumbnailURL, photo.previewURL].compactMap({ $0 })
      {
        try? FileManager.default.removeItem(at: url)
      }
      throw error
    }
    return photo
  }
  static func location(_ bytes: Data) -> PhotoLocationV1? {
    if let pair = try? CameraMedia.decodeLivePhoto(bytes) { return PhotoLocationV1.exif(pair.still.bytes) }
    return PhotoLocationV1.exif(bytes)
  }
  static func capture(_ bytes: Data) -> PhotoCaptureMetadata {
    .original((try? CameraMedia.decodeLivePhoto(bytes))?.still.bytes ?? bytes)
  }
  private func persistLocation(_ location: PhotoLocationV1?, photo: LocalPhoto, accountId: String,
    bundle: AccountBundle, insertPhoto: Bool = false, capture: PhotoCaptureMetadata? = nil) throws {
    // Keep GRDB's synchronous transaction here: intake fences stay current
    // through the original and encrypted location write without a suspension.
    try store.database.write { db in
      if insertPhoto { try store.put(photo, db: db) }
      try AnnotationLedger(store: store, accountId: accountId).seedMetadata(location: location, capture: capture, photo: photo, bundle: bundle, db: db)
    }
  }
  func buildMedia(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String = Wire.id(), backup: Bool = false, capturedAt: Date? = nil, permitOriginalCaptureDate: Bool = true
  ) async throws -> LocalPhoto {
    try CameraMedia.validateSize(bytes.count)
    return try await buildMedia(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: photoId, backup: backup, capturedAt: capturedAt, permitOriginalCaptureDate: permitOriginalCaptureDate,
      originalDigest: bytes.digest)
  }
  private func buildMedia(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String, backup: Bool, capturedAt: Date?, permitOriginalCaptureDate: Bool, originalDigest: String
  ) async throws -> LocalPhoto {
    try CameraMedia.validateSize(bytes.count)
    let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
    if ext == "fotoro-live" {
      let pair = try CameraMedia.decodeLivePhoto(bytes)
      guard try Self.validate(pair.still.bytes, filename: pair.still.filename) == pair.still.mediaType,
        try CameraMedia.videoType(filename: pair.motion.filename, bytes: pair.motion.bytes) == pair.motion.mediaType else {
        throw FotoroError("Live Photo original types do not match")
      }
      _ = try await CameraMedia.videoPoster(bytes: pair.motion.bytes, filename: pair.motion.filename)
      return try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
        photoId: photoId, backup: backup, capturedAt: capturedAt, permitOriginalCaptureDate: permitOriginalCaptureDate,
        mediaType: CameraMedia.liveType, originalDigest: originalDigest, posterBytes: pair.still.bytes)
    }
    if ["mov", "mp4", "m4v"].contains(ext) {
      let media = try CameraMedia.videoType(filename: filename, bytes: bytes)
      let poster = try await CameraMedia.videoPoster(bytes: bytes, filename: filename)
      return try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
        photoId: photoId, backup: backup, capturedAt: capturedAt, permitOriginalCaptureDate: permitOriginalCaptureDate, mediaType: media, originalDigest: originalDigest, posterBytes: poster)
    }
    return try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: photoId, backup: backup, capturedAt: capturedAt, permitOriginalCaptureDate: permitOriginalCaptureDate,
      mediaType: Self.validate(bytes, filename: filename), originalDigest: originalDigest)
  }
  func build(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String = Wire.id(), backup: Bool = false, capturedAt: Date? = nil, permitOriginalCaptureDate: Bool = true
  ) throws -> LocalPhoto {
    try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: photoId, backup: backup, capturedAt: capturedAt, permitOriginalCaptureDate: permitOriginalCaptureDate,
      mediaType: Self.validate(bytes, filename: filename), originalDigest: bytes.digest)
  }
  private func buildOriginal(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String, backup: Bool, capturedAt: Date?, permitOriginalCaptureDate: Bool,
    mediaType: String, originalDigest: String, posterBytes: Data? = nil
  ) throws -> LocalPhoto {
    let media = mediaType
    let metadataKey = crypto.randomKey()
    let vault = try Data(b64: bundle.vaultKey)
    var reps: [RepresentationV1] = []
    var keys: [String: String] = [:]
    var staged: [String: URL] = [:]
    var thumbURL: URL?
    var previewURL: URL?
    var completed = false
    defer {
      if !completed {
        for url in Array(staged.values) + [thumbURL, previewURL].compactMap({ $0 }) {
          try? FileManager.default.removeItem(at: url)
        }
      }
    }
    guard let source = CGImageSourceCreateWithData((posterBytes ?? bytes) as CFData, nil) else { throw FotoroError("Cannot decode original preview") }
    var sourceDate = capturedAt.map(Wire.date) ?? Wire.date()
    var provenance = capturedAt == nil ? "import" : "photos"
    if capturedAt == nil && permitOriginalCaptureDate {
      let capture = Self.capture(posterBytes ?? bytes)
      if let raw = capture.items.first(where: { $0.k == "originalDateTime" })?.v,
        let offset = capture.items.first(where: { $0.k == "offsetTimeOriginal" })?.v {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.isLenient = false
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss XXX"
        if let date = formatter.date(from: raw + " " + offset) { sourceDate = Wire.date(date); provenance = "exif" }
      }
    }
    for kind in ["original", "thumbnail", "preview"] {
      let representationId = Wire.id()
      let key = crypto.randomKey()
      let binding = MediaBinding(photoId: photoId, representationId: representationId, kind: kind)
      let plain: Data
      if kind == "original" {
        plain = bytes
      } else {
        plain = try Self.derivative(source, maxPixel: kind == "thumbnail" ? 320 : 1600)
      }
      let encrypted = try crypto.encrypt(plain, key: key, binding: binding)
      let path = try store.write(
        encrypted, name: (backup ? photoId + "-" + kind : representationId) + ".bin", pending: true)
      staged[representationId] = path
      keys[representationId] = key.b64
      reps.append(
        RepresentationV1(
          binding: binding, objectId: Wire.id(), header: encrypted.prefix(24).b64,
          ciphertextBytes: encrypted.count, ciphertextSha256: encrypted.digest))
      if kind == "thumbnail" { thumbURL = try store.write(plain, name: photoId + "-thumbnail.jpg") }
      if kind == "preview" { previewURL = try store.write(plain, name: photoId + "-preview.jpg") }
    }
    let metadata = PhotoMetadataV1(
      filename: filename, mediaType: media, sourceDate: sourceDate, dateSource: provenance,
      originalBytes: bytes.count, originalSha256: originalDigest, representationKeys: keys)
    let binding = MediaBinding(photoId: photoId, representationId: Wire.id(), kind: "metadata")
    let cipher = try crypto.encrypt(Wire.encode(metadata), key: metadataKey, binding: binding)
    staged[binding.representationId] = try store.write(
      cipher, name: (backup ? photoId + "-metadata" : binding.representationId) + ".bin",
      pending: true)
    let representation = RepresentationV1(
      binding: binding, objectId: Wire.id(), header: cipher.prefix(24).b64,
      ciphertextBytes: cipher.count, ciphertextSha256: cipher.digest)
    let manifest = PhotoManifestV1(
      photoId: photoId, ownerAccountId: accountId, representations: reps,
      metadataRepresentation: representation,
      ownerWrappedMetadataKey: try crypto.wrap(metadataKey, key: vault))
    let photo = LocalPhoto(
      photoId: photoId, manifest: manifest, metadata: metadata, transferState: "pending",
      originalURL: try store.write(
        bytes, name: photoId + "-original." + Self.originalExtension(for: media)),
      thumbnailURL: thumbURL, previewURL: previewURL, staged: staged)
    completed = true
    return photo
  }
  private static func derivative(_ source: CGImageSource, maxPixel: Int) throws -> Data {
    guard
      let image = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: maxPixel,
          kCGImageSourceCreateThumbnailWithTransform: true,
        ] as CFDictionary)
    else { throw FotoroError("Cannot decode original image") }
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw FotoroError("Cannot create preview") }
    CGImageDestinationAddImage(
      destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw FotoroError("Preview failed") }
    return data as Data
  }
}
