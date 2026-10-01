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
  var failures: [ImportFailure] = []
  var notices: [String] = []
  init(
    store: LibraryStore,
    sourceReader: (@Sendable (SelectedResource) async throws -> (Data, String, Bool))? = nil
  ) {
    self.store = store
    self.sourceReader = sourceReader
  }
  func importResources(_ selected: [SelectedResource], accountId: String, bundle: AccountBundle)
    async throws -> [LocalPhoto]
  {
    failures = []
    notices = []
    var imported: [LocalPhoto] = []
    for selection in selected {
      do {
        let (bytes, filename, edited) = try await read(selection)
        let photo = try build(
          bytes: bytes, filename: filename, accountId: accountId, bundle: bundle)
        try store.put(photo)
        imported.append(photo)
        if edited {
          notices.append("Imported the unmodified original; Photos edits are not included.")
        }
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
    guard ["jpg", "jpeg", "png"].contains(ext) else {
      throw FotoroError(
        "Only unmodified JPEG and PNG originals are supported; HEIC, Live Photos and video are not converted"
      )
    }
    let jpeg = bytes.starts(with: [0xff, 0xd8, 0xff])
    let png = bytes.starts(with: [137, 80, 78, 71, 13, 10, 26, 10])
    guard jpeg || png, let source = CGImageSourceCreateWithData(bytes as CFData, nil),
      let type = CGImageSourceGetType(source) as String?,
      type == (jpeg ? UTType.jpeg.identifier : UTType.png.identifier)
    else { throw FotoroError("File type does not match an original JPEG or PNG") }
    guard (jpeg && ext != "png") || (png && ext == "png") else {
      throw FotoroError("Filename and original resource type do not match")
    }
    return jpeg ? "image/jpeg" : "image/png"
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
      guard
        let asset = PHAsset.fetchAssets(
          withLocalIdentifiers: [selected.resourceIdentifier], options: nil
        ).firstObject
      else { throw FotoroError("Selected Photos resource is unavailable; allow access and retry") }
      guard asset.mediaType == .image, !asset.mediaSubtypes.contains(.photoLive) else {
        throw FotoroError(
          "Live Photo pairs and video are not supported; original was not converted")
      }
      let resources = PHAssetResource.assetResources(for: asset)
      guard let original = resources.first(where: { $0.type == .photo }),
        [UTType.jpeg.identifier, UTType.png.identifier].contains(original.uniformTypeIdentifier)
      else {
        throw FotoroError(
          "This original is not JPEG or PNG. A transcoded JPEG is not imported as an original.")
      }
      let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id())
      defer { try? FileManager.default.removeItem(at: temporary) }
      let options = PHAssetResourceRequestOptions()
      options.isNetworkAccessAllowed = true
      try await withCheckedThrowingContinuation {
        (continuation: CheckedContinuation<Void, Error>) in
        PHAssetResourceManager.default().writeData(
          for: original, toFile: temporary, options: options
        ) { error in
          if let error {
            continuation.resume(
              throwing: FotoroError(
                "Original download failed: \(error.localizedDescription). Retry when iCloud is available."
              ))
          } else {
            continuation.resume()
          }
        }
      }
      let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 50 * 1024 * 1024 else { throw FotoroError("Original exceeds 50 MiB") }
      return (
        try Data(contentsOf: temporary), original.originalFilename,
        resources.contains(where: { $0.type == .adjustmentData })
      )
    }
  }
  func build(bytes: Data, filename: String, accountId: String, bundle: AccountBundle) throws
    -> LocalPhoto
  {
    let media = try Self.validate(bytes, filename: filename)
    let photoId = Wire.id()
    let metadataKey = crypto.randomKey()
    let vault = try Data(b64: bundle.vaultKey)
    var reps: [RepresentationV1] = []
    var keys: [String: String] = [:]
    var staged: [String: URL] = [:]
    var thumbURL: URL?
    var previewURL: URL?
    let source = CGImageSourceCreateWithData(bytes as CFData, nil)!
    var sourceDate = Wire.date()
    var provenance = "import"
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
      let path = try store.write(encrypted, name: representationId + ".bin", pending: true)
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
      cipher, name: binding.representationId + ".bin", pending: true)
    let representation = RepresentationV1(
      binding: binding, objectId: Wire.id(), header: cipher.prefix(24).b64,
      ciphertextBytes: cipher.count, ciphertextSha256: cipher.digest)
    let manifest = PhotoManifestV1(
      photoId: photoId, ownerAccountId: accountId, representations: reps,
      metadataRepresentation: representation,
      ownerWrappedMetadataKey: try crypto.wrap(metadataKey, key: vault))
    return LocalPhoto(
      photoId: photoId, manifest: manifest, metadata: metadata, transferState: "pending",
      originalURL: try store.write(
        bytes, name: photoId + "-original." + (media == "image/png" ? "png" : "jpg")),
      thumbnailURL: thumbURL, previewURL: previewURL, staged: staged)
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
