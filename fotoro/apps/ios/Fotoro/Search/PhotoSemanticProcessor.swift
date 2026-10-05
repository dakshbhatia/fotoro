import CoreImage
import CoreML
import CryptoKit
import Foundation

enum SemanticVector {
  static let processor = "tinyclip-39m-coreml-81f9caba-crop224-v1"
  static let dimensions = 512
  static func normalized(_ values: [Float]) -> [Float]? {
    guard values.count == dimensions, values.allSatisfy(\.isFinite) else { return nil }
    let magnitude = sqrt(values.reduce(0.0) { $0 + Double($1) * Double($1) })
    guard magnitude.isFinite, magnitude > 0 else { return nil }
    return values.map { Float(Double($0) / magnitude) }
  }
  static func similarity(_ left: [Float], _ right: [Float]) -> Double {
    guard left.count == dimensions, right.count == dimensions else { return -1 }
    return zip(left, right).reduce(0) { $0 + Double($1.0) * Double($1.1) }
  }
  static func data(_ values: [Float]) -> Data {
    var result = Data(capacity: values.count * 4)
    for value in values {
      let bits = value.bitPattern
      result.append(contentsOf: [UInt8(truncatingIfNeeded: bits), UInt8(truncatingIfNeeded: bits >> 8),
        UInt8(truncatingIfNeeded: bits >> 16), UInt8(truncatingIfNeeded: bits >> 24)])
    }
    return result
  }
  static func values(_ data: Data) -> [Float]? {
    guard data.count == dimensions * 4 else { return nil }
    let bytes = [UInt8](data)
    var result: [Float] = []
    result.reserveCapacity(dimensions)
    for index in stride(from: 0, to: bytes.count, by: 4) {
      let low = UInt32(bytes[index])
      let second = UInt32(bytes[index + 1]) << 8
      let third = UInt32(bytes[index + 2]) << 16
      let high = UInt32(bytes[index + 3]) << 24
      let bits = low | second | third | high
      result.append(Float(bitPattern: bits))
    }
    return result.allSatisfy(\.isFinite) ? result : nil
  }
}

// Model files are public; photo pixels, queries and embeddings never leave this actor/device.
// The pinned packages download once. A failed install leaves ordinary search available.
actor PhotoSemanticProcessor {
  static let shared = PhotoSemanticProcessor()
  private var imageModel: MLModel?
  private var textModel: MLModel?
  private var tokenizer: CLIPTokenizer?
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var installation: Task<URL, Error>?
  private var lastFailure: Date?
  private var textCache: [String: [Float]] = [:]
  private let directory: URL
  init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("FotoroVisualModels", isDirectory: true)) { self.directory = directory }
  var ready: Bool { imageModel != nil && textModel != nil }
  func clearQueryCache() { textCache.removeAll() }
  func prepare() async throws {
    if ready { return }
    if let lastFailure, Date().timeIntervalSince(lastFailure) < 60 { throw FotoroError("Visual search is preparing.") }
    let task: Task<URL, Error>
    if let installation { task = installation }
    else {
      let root = directory
      task = Task.detached(priority: .utility) { try await Self.install(in: root) }
      installation = task
    }
    do {
      let root = try await task.value
      try Task.checkCancellation()
      if ready { return }
      let config = MLModelConfiguration()
      #if targetEnvironment(simulator)
        config.computeUnits = .cpuOnly
      #else
        config.computeUnits = .all
      #endif
      imageModel = try MLModel(contentsOf: root.appendingPathComponent("image.mlmodelc"), configuration: config)
      textModel = try MLModel(contentsOf: root.appendingPathComponent("text.mlmodelc"), configuration: config)
      tokenizer = try CLIPTokenizer()
      installation = nil
    } catch {
      imageModel = nil; textModel = nil; tokenizer = nil
      installation = nil; lastFailure = Date()
      throw error
    }
  }
  func image(_ preview: SearchPreview) throws -> [Float] {
    try Task.checkCancellation()
    guard let imageModel else { throw FotoroError("Visual search is preparing.") }
    let image = CIImage(cgImage: preview.image).oriented(preview.orientation)
    let extent = image.extent
    let edge = min(extent.width, extent.height)
    guard edge > 0 else { throw FotoroError("Photo preview is unavailable.") }
    let cropped = image.cropped(to: CGRect(x: extent.midX - edge / 2, y: extent.midY - edge / 2, width: edge, height: edge))
    let upright = cropped.transformed(by: CGAffineTransform(translationX: -cropped.extent.minX, y: -cropped.extent.minY))
      .transformed(by: CGAffineTransform(scaleX: 224 / edge, y: 224 / edge))
    var buffer: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, 224, 224, kCVPixelFormatType_32ARGB,
      [kCVPixelBufferCGImageCompatibilityKey: true, kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary, &buffer) == kCVReturnSuccess,
      let buffer else { throw FotoroError("Photo preview is unavailable.") }
    context.render(upright, to: buffer)
    let input = try MLDictionaryFeatureProvider(dictionary: ["image": MLFeatureValue(pixelBuffer: buffer)])
    return try vector(imageModel.prediction(from: input))
  }
  func textIfReady(_ text: String) throws -> [Float]? {
    try Task.checkCancellation()
    guard let textModel, let tokenizer, !text.isEmpty else { return nil }
    if let cached = textCache[text] { return cached }
    let tokens = try tokenizer.encode(text)
    let array = try MLMultiArray(shape: [1, 77], dataType: .int32)
    for (index, token) in tokens.enumerated() { array[index] = NSNumber(value: token) }
    let input = try MLDictionaryFeatureProvider(dictionary: ["tokens": MLFeatureValue(multiArray: array)])
    let result = try vector(textModel.prediction(from: input))
    if textCache.count >= 16 { textCache.removeAll(keepingCapacity: true) }
    textCache[text] = result
    return result
  }
  private func vector(_ output: MLFeatureProvider) throws -> [Float] {
    guard let array = output.featureValue(for: "embedding")?.multiArrayValue,
      let values = SemanticVector.normalized((0..<array.count).map { array[$0].floatValue })
    else { throw FotoroError("Visual search output is invalid.") }
    try Task.checkCancellation()
    return values
  }
  private struct Asset: Sendable { let path: String; let bytes: Int; let digest: String }
  // MIT TinyCLIP39M community Core ML conversion; source and conversion are pinned.
  // See TinyCLIP-LICENSE.txt. Packages include RGB 1/255 + CLIP normalization.
  private static let revision = "81f9cabad48edb0b78ac83e8ffb8039c9fda6cd1"
  private static let assets: [Asset] = [
    Asset(path: "Image.mlpackage/Manifest.json", bytes: 617, digest: "500c1f477c4b51db7fb952981ec50b567ef1ecebf627c7755a56e214550e36f4"),
    Asset(path: "Image.mlpackage/Data/com.apple.CoreML/model.mlmodel", bytes: 149414, digest: "5044b753a14d5878c39364c375fbc63d4639653293a09142eb0bee50318ae001"),
    Asset(path: "Image.mlpackage/Data/com.apple.CoreML/weights/weight.bin", bytes: 29071936, digest: "62eebad13f401ccf016a1f1b6d8e4094a535d0dba232967df8418644383c9423"),
    Asset(path: "Text.mlpackage/Manifest.json", bytes: 617, digest: "172335d9832c92741f2476bea67d91868b96ea92d0df6583231fec5bc3634d31"),
    Asset(path: "Text.mlpackage/Data/com.apple.CoreML/model.mlmodel", bytes: 72169, digest: "95f55e40fbbf2b20fc018ee662db23bf33439e9ab466c19e0ca8699e52ad1060"),
    Asset(path: "Text.mlpackage/Data/com.apple.CoreML/weights/weight.bin", bytes: 89047168, digest: "71b0b55b4cc5e1898b69266ade691095016db65d3c01a17a26b0532b81aa3e50"),
  ]
  private nonisolated static func install(in directory: URL) async throws -> URL {
    let root = directory.appendingPathComponent(revision, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
    var protectedRoot = root; try protectedRoot.setResourceValues(excluded)
    if FileManager.default.fileExists(atPath: root.appendingPathComponent("ready").path),
      FileManager.default.fileExists(atPath: root.appendingPathComponent("image.mlmodelc").path),
      FileManager.default.fileExists(atPath: root.appendingPathComponent("text.mlmodelc").path) { return root }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 60; config.timeoutIntervalForResource = 300
    config.waitsForConnectivity = false
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    for asset in assets {
      try Task.checkCancellation()
      let target = root.appendingPathComponent(asset.path)
      if valid(target, asset: asset) { continue }
      let source = URL(string: "https://huggingface.co/nufrnd/lvc-tinyclip-coreml/resolve/\(revision)/\(asset.path)")!
      let (download, response) = try await session.download(from: source)
      defer { try? FileManager.default.removeItem(at: download) }
      guard (response as? HTTPURLResponse)?.statusCode == 200, valid(download, asset: asset) else {
        throw FotoroError("Visual search model could not be verified.")
      }
      try Task.checkCancellation()
      try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: download, to: target)
    }
    for kind in ["image", "text"] {
      try Task.checkCancellation()
      let package = kind == "image" ? "Image.mlpackage" : "Text.mlpackage"
      let compiled = try await MLModel.compileModel(at: root.appendingPathComponent(package))
      let target = root.appendingPathComponent("\(kind).mlmodelc")
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: compiled, to: target)
    }
    try Data(revision.utf8).write(to: root.appendingPathComponent("ready"), options: .atomic)
    return root
  }
  private nonisolated static func valid(_ url: URL, asset: Asset) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]), values.fileSize == asset.bytes,
      let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == asset.digest
  }
}
