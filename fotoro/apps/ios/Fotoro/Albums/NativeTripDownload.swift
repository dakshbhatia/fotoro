import Foundation

struct NativeTripDownloadProgress: Equatable {
  enum Phase: Equatable { case listing, originals, packaging }
  var phase: Phase
  var completed: Int
  var total: Int
  var message: String {
    switch phase {
    case .listing: return "Reading trip · \(completed) of \(total) contributions"
    case .originals: return "Checking originals · \(completed) of \(total)"
    case .packaging: return "Preparing trip ZIP…"
    }
  }
}
struct NativeTripDownloadResult {
  let directory: URL
  let archive: URL
  let originals: Int
  let omittedCopies: Int
  func remove() { try? FileManager.default.removeItem(at: directory) }
}

enum NativeTripArchive {
  static func safeFilename(_ original: String) -> String {
    var name = String(original.unicodeScalars.map { scalar -> Character in
      scalar.value < 32 || scalar.value == 127 || "\\/:*?\"<>|".unicodeScalars.contains(scalar) ? "_" : Character(String(scalar))
    })
    while name.hasSuffix(".") || name.hasSuffix(" ") { name.removeLast() }
    if name.isEmpty || [".", ".."].contains(name) { name = "original" }
    let reserved = Set(["CON", "PRN", "AUX", "NUL"] + (1...9).flatMap { ["COM\($0)", "LPT\($0)"] })
    let stem = name.split(separator: ".", omittingEmptySubsequences: false).first.map(String.init) ?? ""
    if reserved.contains(stem.trimmingCharacters(in: CharacterSet(charactersIn: " .")).uppercased()) { name = "_" + name }
    // Leave room for a collision suffix while retaining ordinary extensions.
    let candidateExtension = URL(fileURLWithPath: name).pathExtension
    let ext = candidateExtension.utf8.count <= 32 ? candidateExtension : ""
    var base = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
    let suffix = ext.isEmpty ? "" : "." + ext
    while (base + suffix).utf8.count > 240 && !base.isEmpty { base.removeLast() }
    if base.isEmpty { base = "original" }
    return base + suffix
  }
  static func sanitizeExports(_ urls: [URL], directory: URL) throws -> [URL] {
    let root = directory.standardizedFileURL
    guard !urls.isEmpty, urls.count <= 2, Set(urls).count == urls.count,
      urls.allSatisfy({ $0.isFileURL && $0.deletingLastPathComponent().standardizedFileURL == root }) else {
      throw FotoroError("Complete original resources are required for this trip ZIP.")
    }
    var used = Set<String>(), destinations: [URL] = []
    for url in urls {
      let safe = safeFilename(url.lastPathComponent)
      let ext = URL(fileURLWithPath: safe).pathExtension
      let base = ext.isEmpty ? safe : String(safe.dropLast(ext.count + 1))
      var name = safe, suffix = 2
      while !used.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted {
        name = base + "-" + String(suffix) + (ext.isEmpty ? "" : "." + ext); suffix += 1
      }
      destinations.append(root.appendingPathComponent(name))
    }
    // Stage every rename first: a sanitized name must not overwrite another
    // resource's current filename. Preserve resource order for Live Photos.
    var staged: [URL] = []
    for url in urls {
      try Task.checkCancellation()
      let temporary = root.appendingPathComponent(".fotoro-export-" + Wire.id())
      try FileManager.default.moveItem(at: url, to: temporary); staged.append(temporary)
    }
    for (index, url) in staged.enumerated() {
      try Task.checkCancellation()
      try FileManager.default.moveItem(at: url, to: destinations[index])
    }
    return destinations
  }
  static func fingerprint(_ bytes: Data, metadata: PhotoMetadataV1) throws -> String {
    struct Part: Encodable { let mediaType: String; let bytes: Int; let sha256: String }
    let parts: [Part]
    if metadata.mediaType == CameraMedia.liveType {
      let pair = try CameraMedia.decodeLivePhoto(bytes)
      parts = [pair.still, pair.motion].map { Part(mediaType: $0.mediaType, bytes: $0.bytes.count, sha256: $0.bytes.digest) }
    } else {
      parts = [Part(mediaType: metadata.mediaType, bytes: bytes.count, sha256: bytes.digest)]
    }
    // Keep ordered complete resource bundles. A still shared by different Live
    // Photos is not a duplicate of either complete Live Photo.
    return try Wire.encode(parts).digest
  }
  static func prepareDirectory(in temporary: URL) throws -> URL {
    let root = temporary.appendingPathComponent("fotoro-album-download-" + Wire.id(), isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o700])
    return root
  }
  static func create(folder: URL, destination: URL) throws {
    try Task.checkCancellation()
    var coordinationError: NSError?
    var result: Result<Void, Error>?
    NSFileCoordinator().coordinate(readingItemAt: folder, options: .forUploading, error: &coordinationError) { upload in
      result = Result {
        try Task.checkCancellation()
        // The coordinator removes its temporary ZIP after this accessor returns.
        try FileManager.default.copyItem(at: upload, to: destination)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600], ofItemAtPath: destination.path)
        try Task.checkCancellation()
      }
    }
    do {
      if let coordinationError { throw coordinationError }
      guard let result else { throw FotoroError("The trip ZIP could not be prepared. Try again.") }
      try result.get(); try Task.checkCancellation()
      let handle = try FileHandle(forReadingFrom: destination); defer { try? handle.close() }
      guard try handle.read(upToCount: 4) == Data([0x50, 0x4b, 0x03, 0x04]) else {
        throw FotoroError("The trip ZIP could not be verified. Try again.")
      }
    } catch { try? FileManager.default.removeItem(at: destination); throw error }
  }
}
