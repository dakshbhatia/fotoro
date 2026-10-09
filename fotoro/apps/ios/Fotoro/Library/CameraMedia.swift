import AVFoundation
import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

struct LivePhotoOriginalPart: Sendable, Equatable {
  var filename: String
  var mediaType: String
  var bytes: Data
}
enum CameraMediaAdmissionError: LocalizedError {
  case originalTooLarge
  var errorDescription: String? {
    "The complete original exceeds 50 MiB. It stays in Photos and was not partially saved."
  }
}

enum CameraMedia {
  static let liveType = "application/vnd.fotoro.live-photo"
  static let maximumOriginalBytes = 50 * 1024 * 1024
  static let mediaManifestKind = "photo-media-manifest-v1"
  static let supportedTypes = ["image/jpeg", "image/png", "image/heic", "video/mp4", "video/quicktime", liveType]
  private static let magic = Data("FOTOROLIVE1\n".utf8)
  private static let maximumHeader = 4096

  static func isMotion(_ mediaType: String) -> Bool {
    ["video/mp4", "video/quicktime", liveType].contains(mediaType)
  }
  static func manifestKind(for mediaType: String) -> String {
    isMotion(mediaType) ? mediaManifestKind : "photo-manifest"
  }
  static func acceptedManifestKind(_ signed: SignedPayloadV1) throws -> String {
    guard ["photo-manifest", mediaManifestKind].contains(signed.kind) else {
      throw FotoroError("Unsupported media manifest")
    }
    return signed.kind
  }
  static func validateSize(_ bytes: Int) throws {
    guard bytes > 0 else { throw FotoroError("The original is empty") }
    guard bytes <= maximumOriginalBytes else { throw CameraMediaAdmissionError.originalTooLarge }
  }
  static func supportedAsset(_ asset: PHAsset) -> Bool {
    asset.mediaType == .image || asset.mediaType == .video
  }
  static func sourceSkipReason(_ asset: PHAsset) -> String? {
    guard supportedAsset(asset) else { return "This Photos media type is not supported." }
    let resources = PHAssetResource.assetResources(for: asset)
    if asset.mediaType == .video {
      guard let video = resources.first(where: { $0.type == .video }),
        ["mov", "mp4", "m4v"].contains(URL(fileURLWithPath: video.originalFilename).pathExtension.lowercased()) else {
        return "This video original is not MP4 or MOV."
      }
      return nil
    }
    guard let photo = resources.first(where: { $0.type == .photo }),
      [UTType.jpeg.identifier, UTType.png.identifier, UTType.heic.identifier].contains(photo.uniformTypeIdentifier) else {
      return "This photo original is not JPEG, PNG or HEIC."
    }
    if asset.mediaSubtypes.contains(.photoLive), resources.first(where: { $0.type == .pairedVideo }) == nil {
      return "Both unmodified Live Photo resources are required. Nothing was saved."
    }
    return nil
  }
  static func originalResources(for asset: PHAsset, requireSupportedType: Bool = true) throws -> [PHAssetResource] {
    guard supportedAsset(asset) else { throw FotoroError("Original media is unavailable") }
    if requireSupportedType, let reason = sourceSkipReason(asset) { throw FotoroError(reason) }
    let resources = PHAssetResource.assetResources(for: asset)
    if asset.mediaSubtypes.contains(.photoLive) {
      guard let still = resources.first(where: { $0.type == .photo }),
        let motion = resources.first(where: { $0.type == .pairedVideo }) else { throw FotoroError("Complete Live Photo originals are unavailable") }
      return [still, motion]
    }
    let type: PHAssetResourceType = asset.mediaType == .video ? .video : .photo
    guard let original = resources.first(where: { $0.type == type }) else { throw FotoroError("Unmodified original is unavailable") }
    return [original]
  }
  static func readPhotosOriginal(id: String, revision: String? = nil) async throws -> (bytes: Data, filename: String, edited: Bool) {
    try Task.checkCancellation()
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
      !asset.isHidden, sourceSkipReason(asset) == nil else { throw FotoroError("Allow access to the complete original in Photos and retry") }
    let expected = revision ?? RecentPhoto.sourceRevision(asset)
    guard RecentPhoto.sourceRevision(asset) == expected else { throw FotoroError("Photos original changed. Open it again.") }
    let resources = PHAssetResource.assetResources(for: asset)
    let edited = resources.contains(where: { $0.type == .adjustmentData })
    let result: (Data, String, Bool)
    if asset.mediaSubtypes.contains(.photoLive) {
      guard let still = resources.first(where: { $0.type == .photo }),
        let motion = resources.first(where: { $0.type == .pairedVideo }) else { throw FotoroError("Both unmodified Live Photo resources are required") }
      let stillBytes = try await readResource(still)
      let motionBytes = try await readResource(motion, maximumBytes: maximumOriginalBytes - stillBytes.count)
      let imageType = try PhotoImport.validate(stillBytes, filename: still.originalFilename)
      let movieType = try videoType(filename: motion.originalFilename, bytes: motionBytes)
      let bytes = try encodeLivePhoto(still: LivePhotoOriginalPart(filename: still.originalFilename, mediaType: imageType, bytes: stillBytes),
        motion: LivePhotoOriginalPart(filename: motion.originalFilename, mediaType: movieType, bytes: motionBytes))
      result = (bytes, URL(fileURLWithPath: still.originalFilename).deletingPathExtension().lastPathComponent + ".fotoro-live", edited)
    } else {
      let type: PHAssetResourceType = asset.mediaType == .video ? .video : .photo
      guard let original = resources.first(where: { $0.type == type }) else { throw FotoroError("Unmodified original is unavailable") }
      result = (try await readResource(original), original.originalFilename, edited)
    }
    try Task.checkCancellation()
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
      let current = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject,
      !current.isHidden, RecentPhoto.sourceRevision(current) == expected else { throw CancellationError() }
    return result
  }
  static func originalType(bytes: Data, filename: String) throws -> String {
    let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
    if ext == "fotoro-live" { _ = try decodeLivePhoto(bytes); return liveType }
    if ["mp4", "mov", "m4v"].contains(ext) { return try videoType(filename: filename, bytes: bytes) }
    return try PhotoImport.validate(bytes, filename: filename)
  }
  private static func readResource(_ original: PHAssetResource, maximumBytes: Int = maximumOriginalBytes) async throws -> Data {
    let manager = PHAssetResourceManager.default()
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    return try await PhotosOriginalReader.read(maximumBytes: maximumBytes, start: { receive, finish in
      manager.requestData(for: original, options: options, dataReceivedHandler: receive) { error in
        finish(error.map { FotoroError("Original download failed: \($0.localizedDescription). Retry when iCloud is available.") })
      }
    }, cancel: { manager.cancelDataRequest($0) })
  }

  private struct Resource: Codable {
    var filename: String
    var mediaType: String
    var bytes: Int
    var sha256: String
    init(_ part: LivePhotoOriginalPart) {
      filename = part.filename; mediaType = part.mediaType
      bytes = part.bytes.count; sha256 = part.bytes.digest
    }
    func validate(still: Bool) throws {
      let allowed = still ? ["image/jpeg", "image/png", "image/heic"] : ["video/mp4", "video/quicktime"]
      let extensions = ["image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/heic": ["heic"],
        "video/mp4": ["mp4", "m4v"], "video/quicktime": ["mov"]]
      guard allowed.contains(mediaType), !filename.isEmpty, filename.utf8.count <= 255,
        extensions[mediaType]?.contains(URL(fileURLWithPath: filename).pathExtension.lowercased()) == true,
        ![".", ".."].contains(filename), !filename.contains("/"), !filename.contains("\\"),
        !filename.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
        bytes > 0, bytes <= maximumOriginalBytes,
        (try? Data(b64: sha256).count) == 32 else { throw FotoroError("Invalid Live Photo original") }
    }
  }
  private struct Header: Codable {
    var version = 1
    var still: Resource
    var motion: Resource
  }
  static func encodeLivePhoto(still: LivePhotoOriginalPart, motion: LivePhotoOriginalPart) throws -> Data {
    let header = Header(still: Resource(still), motion: Resource(motion))
    try header.still.validate(still: true); try header.motion.validate(still: false)
    let encoded = try Wire.encode(header)
    guard encoded.count <= maximumHeader else { throw FotoroError("Invalid Live Photo original") }
    try validateSize(magic.count + 4 + encoded.count + still.bytes.count + motion.bytes.count)
    var result = magic
    var length = UInt32(encoded.count).bigEndian
    withUnsafeBytes(of: &length) { result.append(contentsOf: $0) }
    result.append(encoded); result.append(still.bytes); result.append(motion.bytes)
    return result
  }
  static func decodeLivePhoto(_ bytes: Data) throws -> (still: LivePhotoOriginalPart, motion: LivePhotoOriginalPart) {
    try validateSize(bytes.count)
    let prefix = magic.count + 4
    guard bytes.count >= prefix, bytes.prefix(magic.count) == magic else { throw FotoroError("Invalid Live Photo original") }
    let count = bytes[magic.count..<prefix].reduce(0) { ($0 << 8) | Int($1) }
    guard count > 0, count <= maximumHeader, prefix + count <= bytes.count else { throw FotoroError("Invalid Live Photo original") }
    let encoded = bytes.subdata(in: prefix..<prefix + count)
    guard let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any],
      Set(object.keys) == ["version", "still", "motion"],
      let stillObject = object["still"] as? [String: Any], let motionObject = object["motion"] as? [String: Any],
      Set(stillObject.keys) == ["filename", "mediaType", "bytes", "sha256"],
      Set(motionObject.keys) == ["filename", "mediaType", "bytes", "sha256"] else { throw FotoroError("Invalid Live Photo original") }
    let header = try Wire.decode(Header.self, encoded)
    guard header.version == 1 else { throw FotoroError("Unsupported Live Photo original") }
    try header.still.validate(still: true); try header.motion.validate(still: false)
    let start = prefix + count, split = start + header.still.bytes
    guard split + header.motion.bytes == bytes.count else { throw FotoroError("Incomplete Live Photo original") }
    let still = bytes.subdata(in: start..<split), motion = bytes.subdata(in: split..<bytes.count)
    guard still.digest == header.still.sha256, motion.digest == header.motion.sha256 else { throw FotoroError("Live Photo original digest mismatch") }
    return (LivePhotoOriginalPart(filename: header.still.filename, mediaType: header.still.mediaType, bytes: still),
      LivePhotoOriginalPart(filename: header.motion.filename, mediaType: header.motion.mediaType, bytes: motion))
  }
  static func videoType(filename: String, bytes: Data) throws -> String {
    try validateSize(bytes.count)
    let ext = URL(fileURLWithPath: filename).pathExtension.lowercased()
    guard ["mp4", "mov", "m4v"].contains(ext), bytes.count >= 12 else { throw FotoroError("Choose an original MP4 or MOV video") }
    let box = String(data: bytes.subdata(in: 4..<8), encoding: .ascii)
    let brand = String(data: bytes.subdata(in: 8..<12), encoding: .ascii)
    if ext == "mov" {
      guard (box == "ftyp" && brand == "qt  ") || ["wide", "moov", "mdat"].contains(box ?? "") else { throw FotoroError("Video type does not match its filename") }
      return "video/quicktime"
    }
    guard box == "ftyp", brand != "qt  " else { throw FotoroError("Video type does not match its filename") }
    return "video/mp4"
  }
  static func videoPoster(bytes: Data, filename: String) async throws -> Data {
    _ = try videoType(filename: filename, bytes: bytes)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fotoro-video-" + Wire.id())
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("source." + URL(fileURLWithPath: filename).pathExtension)
    try bytes.write(to: url, options: [.atomic, .completeFileProtection])
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    let duration = try await asset.load(.duration)
    guard !tracks.isEmpty, duration.seconds.isFinite, duration.seconds > 0 else { throw FotoroError("The original video cannot be played") }
    try Task.checkCancellation()
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1600, height: 1600)
    let result = try await generator.image(at: .zero)
    try Task.checkCancellation()
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw FotoroError("Cannot create video preview") }
    CGImageDestinationAddImage(destination, result.image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw FotoroError("Cannot create video preview") }
    return output as Data
  }
  static func exportOriginals(_ bytes: Data, metadata: PhotoMetadataV1, directory: URL) throws -> [URL] {
    guard bytes.count == metadata.originalBytes, bytes.digest == metadata.originalSha256,
      supportedTypes.contains(metadata.mediaType) else { throw FotoroError("Original could not be verified") }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let parts: [LivePhotoOriginalPart]
    if metadata.mediaType == liveType {
      let pair = try decodeLivePhoto(bytes)
      parts = [pair.still, pair.motion]
    } else {
      let name = URL(fileURLWithPath: metadata.filename).lastPathComponent
      guard !["", ".", ".."].contains(name) else { throw FotoroError("Invalid original filename") }
      parts = [LivePhotoOriginalPart(filename: name, mediaType: metadata.mediaType, bytes: bytes)]
    }
    guard Set(parts.map(\.filename)).count == parts.count else { throw FotoroError("Invalid original filenames") }
    return try parts.map { part in
      let url = directory.appendingPathComponent(part.filename)
      try part.bytes.write(to: url, options: [.atomic, .completeFileProtection])
      return url
    }
  }
  // File reads, verification and Live Photo expansion must not stall UI gestures.
  // The caller owns the export directory and removes it on failure or cancellation.
  static func exportOriginalFile(_ url: URL, metadata: PhotoMetadataV1) async throws -> [URL] {
    let work = Task.detached(priority: .userInitiated) {
      try Task.checkCancellation()
      let bytes = try Data(contentsOf: url)
      try Task.checkCancellation()
      let urls = try exportOriginals(bytes, metadata: metadata, directory: url.deletingLastPathComponent())
      try Task.checkCancellation()
      return urls
    }
    return try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
  }
  static func restoreToPhotos(_ urls: [URL], mediaType: String) async throws {
    guard !urls.isEmpty, urls.count == (mediaType == liveType ? 2 : 1) else { throw FotoroError("Complete original resources are required") }
    try await PHPhotoLibrary.shared().performChanges {
      let request = PHAssetCreationRequest.forAsset()
      for (index, url) in urls.enumerated() {
        let type: PHAssetResourceType = mediaType == liveType ? (index == 0 ? .photo : .pairedVideo)
          : (isMotion(mediaType) ? .video : .photo)
        let options = PHAssetResourceCreationOptions()
        options.originalFilename = url.lastPathComponent
        request.addResource(with: type, fileURL: url, options: options)
      }
    }
  }
}

// PhotoKit may deliver a callback before requestData returns its cancellable ID.
// Keep the provider boundary injectable so those races can be reproduced without iCloud.
enum PhotosOriginalReader {
  static func read(maximumBytes: Int = CameraMedia.maximumOriginalBytes,
    temporaryRoot: URL = FileManager.default.temporaryDirectory,
    removeTemporary: @escaping @Sendable (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) },
    start: @escaping @Sendable (@escaping @Sendable (Data) -> Void, @escaping @Sendable (Error?) -> Void) -> PHAssetResourceDataRequestID,
    cancel: @escaping @Sendable (PHAssetResourceDataRequestID) -> Void) async throws -> Data {
    try Task.checkCancellation()
    guard maximumBytes > 0 else { throw CameraMediaAdmissionError.originalTooLarge }
    let request = try OriginalResourceRead(maximumBytes: maximumBytes, temporaryRoot: temporaryRoot, removeTemporary: removeTemporary, cancel: cancel)
    let bytes = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard request.install(continuation) else { return }
        let id = start({ request.receive($0) }, { request.complete($0) })
        request.install(id)
      }
    } onCancel: { request.cancel() }
    try Task.checkCancellation()
    return bytes
  }
}

private final class OriginalResourceRead: @unchecked Sendable {
  private let lock = NSLock()
  private let maximumBytes: Int
  private let directory: URL
  private let url: URL
  private let removeTemporary: @Sendable (URL) throws -> Void
  private let cancelProvider: @Sendable (PHAssetResourceDataRequestID) -> Void
  private var file: FileHandle?
  private var byteCount = 0
  private var continuation: CheckedContinuation<Data, Error>?
  private var result: Result<Data, Error>?
  private var requestID: PHAssetResourceDataRequestID?
  private var needsCancellation = false

  init(maximumBytes: Int, temporaryRoot: URL,
    removeTemporary: @escaping @Sendable (URL) throws -> Void,
    cancel: @escaping @Sendable (PHAssetResourceDataRequestID) -> Void) throws {
    self.maximumBytes = maximumBytes; self.cancelProvider = cancel; self.removeTemporary = removeTemporary
    directory = temporaryRoot.appendingPathComponent(Wire.id(), isDirectory: true)
    url = directory.appendingPathComponent("original")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
      guard FileManager.default.createFile(atPath: url.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600]) else {
        throw FotoroError("Cannot prepare the original download")
      }
      file = try FileHandle(forWritingTo: url)
    } catch { try? FileManager.default.removeItem(at: directory); throw error }
  }
  func install(_ continuation: CheckedContinuation<Data, Error>) -> Bool {
    lock.lock()
    if let result { lock.unlock(); continuation.resume(with: result); return false }
    self.continuation = continuation
    lock.unlock(); return true
  }
  func install(_ id: PHAssetResourceDataRequestID) {
    lock.lock()
    let shouldCancel = needsCancellation
    if result == nil { requestID = id }
    lock.unlock()
    if shouldCancel { cancelProvider(id) }
  }
  func receive(_ bytes: Data) {
    lock.lock()
    guard result == nil else { lock.unlock(); return }
    guard bytes.count <= maximumBytes - byteCount else {
      finishLocked(.failure(CameraMediaAdmissionError.originalTooLarge), cancelProvider: true); return
    }
    do { try file?.write(contentsOf: bytes); byteCount += bytes.count; lock.unlock() }
    catch { finishLocked(.failure(error), cancelProvider: true) }
  }
  func complete(_ error: Error?) {
    lock.lock()
    guard result == nil else { lock.unlock(); return }
    if let error { finishLocked(.failure(error)); return }
    do {
      guard byteCount > 0 else { throw FotoroError("The original is empty") }
      finishLocked(.success(try Data(contentsOf: url)))
    } catch { finishLocked(.failure(error)) }
  }
  func cancel() {
    lock.lock()
    guard result == nil else { lock.unlock(); return }
    finishLocked(.failure(CancellationError()), cancelProvider: true)
  }
  // Caller holds the lock. Cleanup precedes publishing any outcome, and provider
  // cancellation happens after unlocking because it can synchronously call back.
  private func finishLocked(_ outcome: Result<Data, Error>, cancelProvider shouldCancel: Bool = false) {
    var finalOutcome = outcome
    // Truncate before unlinking: if directory removal fails, it must not retain
    // the downloaded plaintext. A cleanup failure cannot publish a saved original.
    try? file?.truncate(atOffset: 0)
    try? file?.close(); file = nil
    do { try removeTemporary(directory) }
    catch { finalOutcome = .failure(FotoroError("Cannot clear the temporary original. Retry sync.")) }
    result = finalOutcome; needsCancellation = shouldCancel
    let waiting = continuation; continuation = nil
    let id = shouldCancel ? requestID : nil; requestID = nil
    lock.unlock()
    if let id { cancelProvider(id) }
    waiting?.resume(with: finalOutcome)
  }
}
