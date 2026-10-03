import CoreGraphics
import CoreML
import Foundation
import ImageIO
import Vision

struct SearchOCRResult: Sendable {
  var text: String
  var confidence: Double
}
struct SearchPreview: @unchecked Sendable {
  var image: CGImage
  var orientation = CGImagePropertyOrientation.up
}
// Synchronous actor work runs off the main actor; bounded requests never overlap.
actor VisionTextProcessor {
  // Simulator runtimes may advertise CPU support while lacking an inference
  // context. This specific environment failure is distinct from bad images
  // and other processing errors, which must continue to fail normally.
  static func isUnsupportedSimulatorClassifier(_ error: Error, isSimulator: Bool) -> Bool {
    guard isSimulator else { return false }
    let value = error as NSError
    guard value.domain == VNErrorDomain, value.code == VNErrorCode.internalError.rawValue else { return false }
    return value.localizedDescription.range(of: "could not create inference context",
      options: [.caseInsensitive]) != nil
  }
  private static func configureSupportedCPU(_ request: VNRequest) throws {
    let supported = try request.supportedComputeStageDevices
    for (stage, devices) in supported {
      if let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) {
        request.setComputeDevice(cpu, for: stage)
      }
    }
  }
  static func boundedSize(width: Int, height: Int, maximumEdge: Int = 1600) -> (Int, Int) {
    let scale = min(1, Double(maximumEdge) / Double(max(1, width, height)))
    return (max(1, Int(Double(width) * scale)), max(1, Int(Double(height) * scale)))
  }
  private static func boundedImage(_ preview: SearchPreview, maximumEdge: Int) throws -> CGImage {
    let (width, height) = boundedSize(width: preview.image.width, height: preview.image.height,
      maximumEdge: maximumEdge)
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw FotoroError("Search preview could not be decoded.") }
    context.interpolationQuality = .high
    context.draw(preview.image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let image = context.makeImage() else { throw FotoroError("Search preview is unavailable.") }
    return image
  }
  func recognize(_ preview: SearchPreview) throws -> SearchOCRResult {
    try Task.checkCancellation()
    return try autoreleasepool {
      let image = try Self.boundedImage(preview, maximumEdge: 1600)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.recognitionLanguages = ["en-US"]
      request.usesLanguageCorrection = true
      try VNImageRequestHandler(cgImage: image, orientation: preview.orientation).perform([request])
      try Task.checkCancellation()
      let candidates = (request.results ?? []).compactMap { $0.topCandidates(1).first }
      let text = candidates.map(\.string).joined(separator: "\n")
      let confidence =
        candidates.isEmpty
        ? 0 : candidates.reduce(0) { $0 + Double($1.confidence) } / Double(candidates.count)
      return SearchOCRResult(text: text, confidence: confidence)
    }
  }
  func classify(_ preview: SearchPreview) throws -> SearchVisualResult {
    try Task.checkCancellation()
    return try autoreleasepool {
      let image = try Self.boundedImage(preview, maximumEdge: 768)
      let request = VNClassifyImageRequest()
      request.revision = VNClassifyImageRequestRevision1
      #if targetEnvironment(simulator)
        try Self.configureSupportedCPU(request)
      #endif
      try VNImageRequestHandler(cgImage: image, orientation: preview.orientation).perform([request])
      try Task.checkCancellation()
      let labels = SearchVisualPolicy.labels((request.results ?? []).map {
        (identifier: $0.identifier, confidence: Double($0.confidence))
      })
      return SearchVisualResult(labels: labels, processor: SearchVisualPolicy.processor)
    }
  }
}
enum LocalSearchPhotosPolicy {
  static func includes(image: Bool, hidden: Bool, capturedAt: Date?, authorized: Bool) -> Bool {
    authorized && image && !hidden
  }
}
