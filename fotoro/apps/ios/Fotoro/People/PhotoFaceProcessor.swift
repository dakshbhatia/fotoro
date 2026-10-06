import CoreGraphics
import CoreImage
import CryptoKit
import Foundation
import OnnxRuntimeBindings

struct PhotoFaceEmbedding: Codable, Sendable {
  var box: [Int]
  var vector: [Float]
}
enum PhotoFaceVector {
  static let processor = "yunet-2023mar-sface-2021dec-v1"
  static func normalized(_ values: [Float]) -> [Float]? {
    guard values.count == 128, values.allSatisfy(\.isFinite) else { return nil }
    let magnitude = sqrt(values.reduce(Float(0)) { $0 + $1 * $1 })
    guard magnitude.isFinite, magnitude > 0.000001 else { return nil }
    return values.map { $0 / magnitude }
  }
  static func similarity(_ lhs: [Float], _ rhs: [Float]) -> Float {
    guard let a = normalized(lhs), let b = normalized(rhs) else { return -1 }
    return zip(a, b).reduce(Float(0)) { $0 + $1.0 * $1.1 }
  }
}
struct PhotoFaceAlignment {
  // OpenCV FaceRecognizerSF's five-point canonical RGB crop.
  static let target = [CGPoint(x: 38.2946, y: 51.6963), CGPoint(x: 73.5318, y: 51.5014),
    CGPoint(x: 56.0252, y: 71.7366), CGPoint(x: 41.5493, y: 92.3655), CGPoint(x: 70.7299, y: 92.2041)]
  static func transform(_ points: [CGPoint]) -> CGAffineTransform? {
    guard points.count == 5, points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { return nil }
    let src = CGPoint(x: points.map(\.x).reduce(0,+)/5, y: points.map(\.y).reduce(0,+)/5)
    let dst = CGPoint(x: target.map(\.x).reduce(0,+)/5, y: target.map(\.y).reduce(0,+)/5)
    var dot: CGFloat = 0, cross: CGFloat = 0, denominator: CGFloat = 0
    for (s, d) in zip(points, target) {
      let x = s.x-src.x, y = s.y-src.y, dx = d.x-dst.x, dy = d.y-dst.y
      dot += x*dx+y*dy; cross += x*dy-y*dx; denominator += x*x+y*y
    }
    guard denominator > 0.001 else { return nil }
    let a = dot/denominator, b = cross/denominator
    guard a*a+b*b > 0.000001 else { return nil }
    return CGAffineTransform(a: a, b: b, c: -b, d: a,
      tx: dst.x-a*src.x+b*src.y, ty: dst.y-b*src.x-a*src.y)
  }
}

// ONNX work is serialized off the main actor. No image or template leaves the device.
actor PhotoFaceProcessor {
  static let shared = PhotoFaceProcessor()
  private var environment: ORTEnv?
  private var session: ORTSession?
  private var detector: ORTSession?
  func prepare() throws {
    guard session == nil else { return }
    guard let model = Bundle.main.url(forResource: "face_recognition_sface_2021dec", withExtension: "onnx") else {
      throw FotoroError("The local People model is unavailable.")
    }
    let bytes = try Data(contentsOf: model, options: .mappedIfSafe)
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    guard digest == "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79" else {
      throw FotoroError("The local People model could not be verified.")
    }
    guard let detectionModel = Bundle.main.url(forResource: "face_detection_yunet_2023mar", withExtension: "onnx") else { throw FotoroError("The local People detector is unavailable.") }
    let detectionBytes = try Data(contentsOf:detectionModel,options:.mappedIfSafe)
    guard SHA256.hash(data:detectionBytes).map({ String(format:"%02x",$0) }).joined() == "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4" else { throw FotoroError("The local People detector could not be verified.") }
    let env = try ORTEnv(loggingLevel: .error)
    let options = try ORTSessionOptions(); try options.setIntraOpNumThreads(1)
    let recognizer = try ORTSession(env: env, modelPath: model.path, sessionOptions: options)
    detector = try ORTSession(env: env, modelPath: detectionModel.path, sessionOptions: options)
    session = recognizer; environment = env
  }

  func analyze(_ preview: SearchPreview) throws -> [PhotoFaceEmbedding] {
    try Task.checkCancellation(); try prepare()
    let ci = CIImage(cgImage: preview.image).oriented(forExifOrientation: Int32(preview.orientation.rawValue))
    let scale = min(1, 1600/max(ci.extent.width, ci.extent.height))
    let bounded = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let image = CIContext().createCGImage(bounded, from: bounded.extent),
      let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width*4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
      throw FotoroError("A face preview could not be prepared.")
    }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard let raw = context.data else { return [] }
    let pixels = raw.assumingMemoryBound(to: UInt8.self)
    let detections = try detect(pixels, width:image.width,height:image.height)
    var result: [PhotoFaceEmbedding] = []
    for face in detections.prefix(20) {
      try Task.checkCancellation()
      guard face.rect.width >= 32, face.rect.height >= 32 else { continue }
      let points = face.points
      guard let transform = PhotoFaceAlignment.transform(points) else { continue }
      let inverse = transform.inverted()
      var input = [Float](repeating: 0, count: 3*112*112)
      for y in 0..<112 { for x in 0..<112 {
        let src = CGPoint(x: CGFloat(x), y: CGFloat(y)).applying(inverse)
        let sx = Int(floor(src.x)), sy = Int(floor(src.y))
        guard sx >= 0, sy >= 0, sx+1 < image.width, sy+1 < image.height else { continue }
        let fx = Float(src.x-CGFloat(sx)), fy = Float(src.y-CGFloat(sy))
        for channel in 0..<3 {
          func sample(_ xx: Int, _ yy: Int) -> Float { Float(pixels[(yy*image.width+xx)*4+channel]) }
          let upper = sample(sx, sy)*(1-fx)+sample(sx+1, sy)*fx
          let lower = sample(sx, sy+1)*(1-fx)+sample(sx+1, sy+1)*fx
          input[channel*112*112+y*112+x] = upper*(1-fy)+lower*fy
        }
      } }
      let normalized = try embeddingForAlignedRGB(input)
      let rect = face.rect.intersection(CGRect(x:0,y:0,width:image.width,height:image.height))
      let x = max(0,min(9999,Int((rect.minX/CGFloat(image.width)*10000).rounded())))
      let y = max(0,min(9999,Int((rect.minY/CGFloat(image.height)*10000).rounded())))
      let box = [x,y,max(1,min(10000-x,Int((rect.width/CGFloat(image.width)*10000).rounded()))),max(1,min(10000-y,Int((rect.height/CGFloat(image.height)*10000).rounded())))]
      guard PhotoPersonAssignment(p: UUID().uuidString, n: "face", b: box).valid else { continue }
      result.append(PhotoFaceEmbedding(box: box, vector: normalized))
    }
    try Task.checkCancellation()
    return result
  }
  private struct Detection { var rect: CGRect; var points: [CGPoint]; var score: Float }
  private func detect(_ pixels: UnsafePointer<UInt8>, width: Int, height: Int) throws -> [Detection] {
    guard let detector else { throw FotoroError("The local People detector is unavailable.") }
    let scale = min(640/Double(width),640/Double(height))
    var input = [Float](repeating:0,count:3*640*640)
    for y in 0..<640 { for x in 0..<640 {
      let sx = Double(x)/scale, sy = Double(y)/scale
      let x0 = Int(sx), y0 = Int(sy)
      guard x0 < width, y0 < height else { continue }
      let fx = Float(sx-Double(x0)), fy = Float(sy-Double(y0))
      for channel in 0..<3 {
        func sample(_ xx: Int,_ yy: Int) -> Float { Float(pixels[(min(height-1,yy)*width+min(width-1,xx))*4+2-channel]) }
        input[channel*640*640+y*640+x] = (sample(x0,y0)*(1-fx)+sample(x0+1,y0)*fx)*(1-fy)+(sample(x0,y0+1)*(1-fx)+sample(x0+1,y0+1)*fx)*fy
      }
    } }
    try Task.checkCancellation()
    let bytes = input.withUnsafeBytes { NSMutableData(bytes:$0.baseAddress!,length:$0.count) }
    let tensor = try ORTValue(tensorData:bytes,elementType:.float,shape:[1,3,640,640])
    let names = Set([8,16,32].flatMap { stride in ["cls_\(stride)","obj_\(stride)","bbox_\(stride)","kps_\(stride)"] })
    let outputs = try detector.run(withInputs:["input":tensor],outputNames:names,runOptions:nil)
    var values: [String:[Float]] = [:]
    for (name,value) in outputs {
      let data = try value.tensorData() as Data
      values[name] = data.withUnsafeBytes { Array($0.bindMemory(to:Float.self)) }
    }
    var found: [Detection] = []
    for stride in [8,16,32] {
      let columns = 640/stride, count = columns*columns
      guard let cls = values["cls_\(stride)"],let object = values["obj_\(stride)"],let boxes = values["bbox_\(stride)"],let landmarks = values["kps_\(stride)"],
        cls.count == count,object.count == count,boxes.count == count*4,landmarks.count == count*10 else { throw FotoroError("Face detection output is invalid.") }
      for i in 0..<count {
        let score = sqrt(max(0,min(1,cls[i]))*max(0,min(1,object[i])))
        guard score.isFinite,score >= 0.8 else { continue }
        let col = Float(i%columns),row = Float(i/columns),step = Float(stride)
        let w = exp(boxes[i*4+2])*step,h = exp(boxes[i*4+3])*step
        let x = (col+boxes[i*4])*step-w/2,y = (row+boxes[i*4+1])*step-h/2
        guard [x,y,w,h].allSatisfy(\.isFinite),w > 0,h > 0 else { continue }
        let points = (0..<5).map { CGPoint(x:Double((landmarks[i*10+$0*2]+col)*step)/scale,y:Double((landmarks[i*10+$0*2+1]+row)*step)/scale) }
        let rect = CGRect(x:Double(x)/scale,y:Double(y)/scale,width:Double(w)/scale,height:Double(h)/scale)
        if rect.intersects(CGRect(x:0,y:0,width:width,height:height)) { found.append(Detection(rect:rect,points:points,score:score)) }
      }
    }
    found.sort { $0.score > $1.score }
    var kept: [Detection] = []
    for face in found {
      if kept.allSatisfy({ other in
        let overlap = face.rect.intersection(other.rect)
        let area = overlap.isNull ? 0 : overlap.width*overlap.height
        return area/max(0.000001,face.rect.width*face.rect.height+other.rect.width*other.rect.height-area) < 0.3
      }) { kept.append(face) }
    }
    guard kept.count <= 20 else { throw FotoroError("Too many faces to assess in one photo.") }
    try Task.checkCancellation(); return kept
  }
  func embeddingForAlignedRGB(_ input: [Float]) throws -> [Float] {
    try Task.checkCancellation(); try prepare()
    guard let session, input.count == 3*112*112, input.allSatisfy({ $0.isFinite && (0...255).contains($0) }) else {
      throw FotoroError("A face crop could not be prepared.")
    }
    let bytes = input.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress!, length: $0.count) }
    let tensor = try ORTValue(tensorData: bytes, elementType: .float, shape: [1,3,112,112])
    let outputs = try session.run(withInputs: ["data": tensor], outputNames: ["fc1"], runOptions: nil)
    guard let value = outputs["fc1"] else { throw FotoroError("A face template is unavailable.") }
    let output = try value.tensorData() as Data
    guard output.count == 128*MemoryLayout<Float>.size,
      let vector = PhotoFaceVector.normalized(output.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }) else {
      throw FotoroError("A face template is unavailable.")
    }
    try Task.checkCancellation(); return vector
  }
}
