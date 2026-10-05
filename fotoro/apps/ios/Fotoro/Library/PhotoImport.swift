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
  var failures: [ImportFailure] = []
  var notices: [String] = []
  init(
    store: LibraryStore,
    sourceReader: (@Sendable (SelectedResource) async throws -> (Data, String, Bool))? = nil,
    sourceRevision: (@Sendable (String) -> String?)? = nil
  ) {
    self.store = store
    self.sourceReader = sourceReader
    self.sourceRevision = sourceRevision ?? { id in
      PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject.map {
        RecentPhoto.sourceRevision($0)
      }
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
        let (bytes, filename, edited) = try await read(selection)
        guard await valid() else { throw CancellationError() }
        let photo = try await buildMedia(
          bytes: bytes, filename: filename, accountId: accountId, bundle: bundle)
        guard !Task.isCancelled, await valid() else {
          for url in Array(photo.staged.values)
            + [photo.originalURL, photo.thumbnailURL, photo.previewURL].compactMap({ $0 })
          {
            try? FileManager.default.removeItem(at: url)
          }
          throw CancellationError()
        }
        try store.put(photo)
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
  func sourceDigest(_ id: String) async throws -> String {
    let bytes = try await read(SelectedResource(id: id, origin: .photos, resourceIdentifier: id, fileURL: nil)).0
    try CameraMedia.validateSize(bytes.count)
    return bytes.digest
  }
  func stageBackup(
    _ source: BackupSource, accountId: String, bundle: AccountBundle, capturedAt: Date? = nil,
    valid: @escaping @Sendable () async -> Bool = { true }
  ) async throws -> LocalPhoto {
    try Task.checkCancellation()
    guard await valid() else { throw CancellationError() }
    if let existing = try store.backupPhoto(source.photoId) { return existing }
    func checkRevision() throws {
      guard let expected = source.sourceRevision else { return }
      guard sourceRevision(source.id) == expected else { throw FotoroError("Photo changed during sync. Try again.") }
    }
    try checkRevision()
    try Task.checkCancellation()
    let selection = SelectedResource(
      id: source.id, origin: .photos, resourceIdentifier: source.id, fileURL: nil)
    let (bytes, filename, _) = try await read(selection)
    guard await valid() else { throw CancellationError() }
    try checkRevision()
    try Task.checkCancellation()
    if let reused = try store.ownedOriginal(digest: bytes.digest, accountId: accountId) {
      var checkpoint = source
      checkpoint.photoId = reused.photoId
      checkpoint.message = nil
      if ["committed", "saved"].contains(reused.transferState) {
        checkpoint.phase = .committed
        try store.putBackupSource(checkpoint)
      } else {
        try store.stageBackup(reused, source: checkpoint)
      }
      return reused
    }
    let photo = try await buildMedia(
      bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: source.photoId, backup: true, capturedAt: capturedAt)
    do {
      try checkRevision()
      try Task.checkCancellation()
      guard await valid() else { throw CancellationError() }
      try store.stageBackup(photo, source: source)
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
  func buildMedia(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String = Wire.id(), backup: Bool = false, capturedAt: Date? = nil
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
        photoId: photoId, backup: backup, capturedAt: capturedAt,
        mediaType: CameraMedia.liveType, posterBytes: pair.still.bytes)
    }
    if ["mov", "mp4", "m4v"].contains(ext) {
      let media = try CameraMedia.videoType(filename: filename, bytes: bytes)
      let poster = try await CameraMedia.videoPoster(bytes: bytes, filename: filename)
      return try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
        photoId: photoId, backup: backup, capturedAt: capturedAt, mediaType: media, posterBytes: poster)
    }
    return try build(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: photoId, backup: backup, capturedAt: capturedAt)
  }
  func build(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String = Wire.id(), backup: Bool = false, capturedAt: Date? = nil
  ) throws -> LocalPhoto {
    try buildOriginal(bytes: bytes, filename: filename, accountId: accountId, bundle: bundle,
      photoId: photoId, backup: backup, capturedAt: capturedAt,
      mediaType: Self.validate(bytes, filename: filename))
  }
  private func buildOriginal(
    bytes: Data, filename: String, accountId: String, bundle: AccountBundle,
    photoId: String, backup: Bool, capturedAt: Date?,
    mediaType: String, posterBytes: Data? = nil
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
    if let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
      let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any],
      let originalDate = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String
    {
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
      if let date = formatter.date(from: originalDate) {
        sourceDate = Wire.date(date)
        provenance = "exif"
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
      originalBytes: bytes.count, originalSha256: bytes.digest, representationKeys: keys)
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
