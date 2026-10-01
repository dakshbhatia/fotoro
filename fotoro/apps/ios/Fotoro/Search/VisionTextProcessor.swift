import CoreGraphics
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
/// Synchronous actor work runs off the main actor and cannot overlap another OCR request.
actor VisionTextProcessor {
  static func boundedSize(width: Int, height: Int) -> (Int, Int) {
    let scale = min(1, 1600 / Double(max(1, width, height)))
    return (max(1, Int(Double(width) * scale)), max(1, Int(Double(height) * scale)))
  }
  func recognize(_ preview: SearchPreview) throws -> SearchOCRResult {
    try Task.checkCancellation()
    return try autoreleasepool {
      let (width, height) = Self.boundedSize(
        width: preview.image.width, height: preview.image.height)
      guard
        let context = CGContext(
          data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { throw FotoroError("Text preview could not be decoded.") }
      context.interpolationQuality = .high
      context.draw(preview.image, in: CGRect(x: 0, y: 0, width: width, height: height))
      guard let image = context.makeImage() else {
        throw FotoroError("Text preview is unavailable.")
      }
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
}
enum LocalSearchPhotosPolicy {
  static func includes(image: Bool, hidden: Bool, capturedAt: Date?, authorized: Bool) -> Bool {
    authorized && image && !hidden
  }
}
