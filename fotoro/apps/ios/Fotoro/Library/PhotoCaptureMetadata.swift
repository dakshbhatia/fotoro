import Foundation
import ImageIO
import Photos

struct PhotoCaptureMetadata: Codable, Equatable, Sendable {
  enum Provenance: String, Codable, Sendable { case photos, original
    var title: String { self == .photos ? "Photos" : "Original" }
  }
  enum Group: String, CaseIterable, Sendable { case media, camera, exposure, source
    var title: String { rawValue.capitalized }
  }
  struct Item: Codable, Equatable, Sendable { var k: String; var p: Provenance; var v: String }
  struct Row: Identifiable, Sendable {
    var id: String; var title: String; var value: String; var group: Group; var provenance: Provenance
  }
  var items: [Item] = []
  static let prefix = "fotoro.capture.v1:"
  static let maximumItems = 32
  private static let labels: [String: String] = [
    "width":"Width", "height":"Height", "createdAt":"Taken", "modifiedAt":"Modified", "addedAt":"Added to Photos",
    "duration":"Duration", "mediaType":"Media", "contentType":"Format", "subtypes":"Media features", "sourceTypes":"Library source",
    "burst":"Burst", "burstSelection":"Burst selection", "hasAdjustments":"Photos edits", "cameraMake":"Camera maker", "cameraModel":"Camera",
    "lensMake":"Lens maker", "lensModel":"Lens", "iso":"ISO", "aperture":"Aperture", "exposureSeconds":"Shutter",
    "focalLength":"Focal length", "focalLength35mm":"35 mm equivalent", "orientation":"Original orientation",
    "originalDateTime":"Original capture time", "offsetTimeOriginal":"Original UTC offset"
  ]
  static let subtypeValues: Set<String> = ["panorama","hdr","screenshot","livePhoto","depthEffect","animation","spatial","streamed","highFrameRate","timelapse","screenRecording","cinematic"]
  static let sourceValues: Set<String> = ["userLibrary","cloudShared","iTunesSynced"]
  private static let photosOnly: Set<String> = ["createdAt","modifiedAt","addedAt","duration","mediaType","subtypes","sourceTypes","burst","burstSelection","hasAdjustments"]
  private static let originalOnly: Set<String> = ["cameraMake","cameraModel","lensMake","lensModel","iso","aperture","exposureSeconds","focalLength","focalLength35mm","orientation","originalDateTime","offsetTimeOriginal"]
  static func isReserved(_ value: String) -> Bool { value.hasPrefix("fotoro.capture.") }
  private static func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
    return formatter.string(from: date)
  }
  private static func validDate(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
    return formatter.date(from: value).map { formatter.string(from: $0) == value } ?? false
  }
  static func validated(_ item: Item) -> Bool {
    guard labels[item.k] != nil, !item.v.isEmpty, item.v.unicodeScalars.count <= 120,
      item.v == item.v.trimmingCharacters(in: .whitespacesAndNewlines),
      !item.v.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      !(item.p == .photos && originalOnly.contains(item.k)), !(item.p == .original && photosOnly.contains(item.k)) else { return false }
    func number(_ low: Double, _ high: Double, integer: Bool = false, positive: Bool = false) -> Bool {
      guard item.v.range(of: "^[0-9]+(?:\\.[0-9]+)?$", options: .regularExpression) != nil,
        let value = Double(item.v), value.isFinite, value >= low, value <= high, (!positive || value > 0) else { return false }
      return !integer || value.rounded() == value && !item.v.contains(".")
    }
    func list(_ allowed: Set<String>) -> Bool {
      let values = item.v.split(separator: ",").map(String.init)
      return !values.isEmpty && Set(values).count == values.count && values == values.sorted() && Set(values).isSubset(of: allowed)
    }
    switch item.k {
    case "width","height": return number(1,1_000_000,integer:true)
    case "createdAt","modifiedAt","addedAt": return validDate(item.v)
    case "duration": return number(0,1_000_000_000)
    case "mediaType": return ["image","video","audio"].contains(item.v)
    case "subtypes": return list(subtypeValues)
    case "sourceTypes": return list(sourceValues)
    case "burstSelection": return list(["autoPick","userPick"])
    case "burst","hasAdjustments": return ["true","false"].contains(item.v)
    case "iso": return number(1,10_000_000,integer:true)
    case "aperture": return number(0,128,positive:true)
    case "exposureSeconds": return number(0,86400,positive:true)
    case "focalLength","focalLength35mm": return number(0,100000,positive:true)
    case "orientation": return number(1,8,integer:true)
    case "originalDateTime":
      let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.timeZone=TimeZone(secondsFromGMT:0);formatter.dateFormat="yyyy:MM:dd HH:mm:ss";formatter.isLenient=false
      return formatter.date(from:item.v).map { formatter.string(from:$0)==item.v } ?? false
    case "offsetTimeOriginal":
      guard item.v.range(of:"^[+-][0-9]{2}:[0-9]{2}$",options:.regularExpression) != nil else { return false }
      return (Int(item.v.dropFirst().prefix(2)) ?? 24) < 24 && (Int(item.v.suffix(2)) ?? 60) < 60
    default: return true
    }
  }
  private mutating func add(_ key: String, _ value: String?, _ provenance: Provenance) {
    guard let value else { return };let item=Item(k:key,p:provenance,v:value)
    if Self.validated(item) { items.removeAll { $0.k==key && $0.p==provenance };items.append(item) }
  }
  static func photos(_ asset: PHAsset, includeDetails: Bool = false) -> Self {
    var result=Self()
    result.add("width",String(asset.pixelWidth),.photos);result.add("height",String(asset.pixelHeight),.photos)
    result.add("createdAt",asset.creationDate.map(iso),.photos);result.add("modifiedAt",asset.modificationDate.map(iso),.photos)
    if includeDetails {
      let addedDate: Date? = asset.addedDate
      result.add("addedAt",addedDate.map(iso),.photos);result.add("contentType",asset.contentType.identifier,.photos)
      result.add("hasAdjustments",String(asset.hasAdjustments),.photos)
    }
    result.add("mediaType",asset.mediaType == .image ? "image" : asset.mediaType == .video ? "video" : asset.mediaType == .audio ? "audio" : nil,.photos)
    if asset.mediaType == .video || asset.mediaType == .audio { result.add("duration",decimal(asset.duration),.photos) }
    var features:[(PHAssetMediaSubtype,String)]=[(.photoPanorama,"panorama"),(.photoHDR,"hdr"),(.photoScreenshot,"screenshot"),(.photoLive,"livePhoto"),(.photoDepthEffect,"depthEffect"),(.spatialMedia,"spatial"),(.videoStreamed,"streamed"),(.videoHighFrameRate,"highFrameRate"),(.videoTimelapse,"timelapse"),(.videoScreenRecording,"screenRecording"),(.videoCinematic,"cinematic")]
    #if compiler(>=6.4)
      features.append((.photoAnimation,"animation"))
    #endif
    result.add("subtypes",features.filter { asset.mediaSubtypes.contains($0.0) }.map(\.1).sorted().joined(separator:","),.photos)
    let sources:[(PHAssetSourceType,String)]=[(.typeUserLibrary,"userLibrary"),(.typeCloudShared,"cloudShared"),(.typeiTunesSynced,"iTunesSynced")]
    result.add("sourceTypes",sources.filter { asset.sourceType.contains($0.0) }.map(\.1).sorted().joined(separator:","),.photos)
    result.add("burst",String(asset.burstIdentifier != nil || asset.representsBurst),.photos)
    var picks:[String]=[];if asset.burstSelectionTypes.contains(.autoPick) { picks.append("autoPick") };if asset.burstSelectionTypes.contains(.userPick) { picks.append("userPick") }
    result.add("burstSelection",picks.joined(separator:","),.photos)
    return result
  }
  private static func decimal(_ value: Double) -> String? {
    guard value.isFinite else { return nil }
    let formatter=NumberFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.numberStyle = .decimal;formatter.usesGroupingSeparator=false;formatter.maximumFractionDigits=12
    return formatter.string(from:NSNumber(value:value))
  }
  static func original(_ bytes: Data) -> Self {
    guard let source=CGImageSourceCreateWithData(bytes as CFData,[kCGImageSourceShouldCache:false] as CFDictionary) else { return Self() }
    return original(source)
  }
  static func originalProperties(_ properties: [String: Any], contentType: String? = nil) -> Self {
    var result=Self();result.add("contentType",contentType,.original)
    func numeric(_ dictionary:[String:Any],_ key:CFString) -> String? {
      guard let value=dictionary[key as String] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
      return decimal(value.doubleValue)
    }
    result.add("width",numeric(properties,kCGImagePropertyPixelWidth),.original);result.add("height",numeric(properties,kCGImagePropertyPixelHeight),.original)
    result.add("orientation",numeric(properties,kCGImagePropertyOrientation),.original)
    let tiff=properties[kCGImagePropertyTIFFDictionary as String] as? [String:Any] ?? [:]
    let exif=properties[kCGImagePropertyExifDictionary as String] as? [String:Any] ?? [:]
    for (key,field) in [(kCGImagePropertyTIFFMake,"cameraMake"),(kCGImagePropertyTIFFModel,"cameraModel")] { result.add(field,(tiff[key as String] as? String)?.trimmingCharacters(in:.whitespacesAndNewlines),.original) }
    for (key,field) in [(kCGImagePropertyExifLensMake,"lensMake"),(kCGImagePropertyExifLensModel,"lensModel"),(kCGImagePropertyExifDateTimeOriginal,"originalDateTime"),(kCGImagePropertyExifOffsetTimeOriginal,"offsetTimeOriginal")] { result.add(field,exif[key as String] as? String,.original) }
    for (key,field) in [(kCGImagePropertyExifFNumber,"aperture"),(kCGImagePropertyExifExposureTime,"exposureSeconds"),(kCGImagePropertyExifFocalLength,"focalLength"),(kCGImagePropertyExifFocalLenIn35mmFilm,"focalLength35mm")] { result.add(field,numeric(exif,key),.original) }
    if let iso=(exif[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber])?.first,CFGetTypeID(iso) != CFBooleanGetTypeID() { result.add("iso",decimal(iso.doubleValue),.original) }
    return result
  }
  private static func original(_ source: CGImageSource) -> Self {
    guard let properties=CGImageSourceCopyPropertiesAtIndex(source,0,[kCGImageSourceShouldCache:false] as CFDictionary) as? [String:Any] else { return Self() }
    return originalProperties(properties,contentType:CGImageSourceGetType(source) as String?)
  }
  func merging(_ other: Self) -> Self {
    var result=self
    for item in other.items { result.add(item.k,item.v,item.p) }
    return result
  }
  var rows: [Row] {
    items.filter(Self.validated).sorted { ($0.p.rawValue,$0.k) < ($1.p.rawValue,$1.k) }.map { item in
      let group:Group = ["cameraMake","cameraModel","lensMake","lensModel"].contains(item.k) ? .camera
        : ["iso","aperture","exposureSeconds","focalLength","focalLength35mm"].contains(item.k) ? .exposure
        : ["sourceTypes","burst","burstSelection","hasAdjustments","addedAt","modifiedAt","originalDateTime","offsetTimeOriginal"].contains(item.k) ? .source : .media
      var value=item.v
      if ["createdAt","modifiedAt","addedAt"].contains(item.k) {
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        if let date=formatter.date(from:value) { value=date.formatted(date:.abbreviated,time:.shortened) }
      } else if item.k=="aperture" { value="ƒ/"+value }
      else if item.k=="exposureSeconds" || item.k=="duration" { value += " s" }
      else if item.k=="focalLength" || item.k=="focalLength35mm" { value += " mm" }
      else if item.k=="width" || item.k=="height" { value += " px" }
      else if item.k=="originalDateTime" { value += " (as recorded; timezone separate)" }
      return Row(id:item.p.rawValue+":"+item.k,title:Self.labels[item.k] ?? item.k,value:value,group:group,provenance:item.p)
    }
  }
  var searchText: String {
    items.filter { Self.validated($0) && ["cameraMake","cameraModel","lensMake","lensModel","mediaType","subtypes"].contains($0.k) }
      .map { item in
        if item.k == "mediaType" { return item.v == "image" ? "Photo image" : item.v.capitalized }
        if item.k == "subtypes" {
          let names = ["panorama":"Panorama","hdr":"HDR","screenshot":"Screenshot","livePhoto":"Live Photo","depthEffect":"Depth effect","animation":"Animation","spatial":"Spatial media","streamed":"Streamed video","highFrameRate":"High frame rate","timelapse":"Time lapse","screenRecording":"Screen recording","cinematic":"Cinematic"]
          return item.v.split(separator:",").map { names[String($0)] ?? String($0) }.joined(separator:" ")
        }
        return item.v
      }.joined(separator:" ")
  }
  func facts(originalSha256: String) -> [String] {
    guard Self.validDigest(originalSha256),items.count<=Self.maximumItems else { return [] }
    let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys,.withoutEscapingSlashes]
    let encoded=items.filter(Self.validated).sorted { ($0.p.rawValue,$0.k) < ($1.p.rawValue,$1.k) }.compactMap { item -> String? in
      guard let data=try? encoder.encode(item) else { return nil }
      let fact=Self.prefix+"item:"+String(decoding:data,as:UTF8.self)
      return fact.unicodeScalars.count<=240 ? fact : nil
    }
    return encoded.isEmpty ? [] : [Self.prefix+"source:"+originalSha256]+encoded
  }
  private static func validDigest(_ value:String) -> Bool { value.range(of:"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",options:.regularExpression) != nil }
  static func read(_ facts:[String], originalSha256:String) -> Self? {
    guard validDigest(originalSha256),facts.count<=64,facts.allSatisfy({$0.unicodeScalars.count<=240}) else { return nil }
    let values=facts.filter {$0.hasPrefix(prefix)},sources=values.filter {$0.hasPrefix(prefix+"source:")}
    guard sources==[prefix+"source:"+originalSha256],values.count>1,values.count<=maximumItems+1 else { return nil }
    var result=Self(),seen=Set<String>()
    for fact in values where !fact.hasPrefix(prefix+"source:") {
      let body=String(fact.dropFirst((prefix+"item:").count))
      let pair = #""(?:k|p|v)"\s*:\s*"(?:[^"\\]|\\.)*""#
      let pattern = "^\\s*\\{\\s*"+pair+"\\s*,\\s*"+pair+"\\s*,\\s*"+pair+"\\s*\\}\\s*$"
      guard fact.hasPrefix(prefix+"item:"),body.range(of:pattern,options:.regularExpression) != nil,
        let object=try? JSONSerialization.jsonObject(with:Data(body.utf8)) as? [String:Any],Set(object.keys)==["k","p","v"],
        let item=try? JSONDecoder().decode(Item.self,from:Data(fact.dropFirst((prefix+"item:").count).utf8)),validated(item),seen.insert(item.p.rawValue+":"+item.k).inserted else { return nil }
      result.items.append(item)
    }
    return result
  }
}

extension PhotoCaptureMetadata {
  enum LocalOriginalResult: Sendable { case available(PhotoCaptureMetadata), unavailable, changed, cancelled }
  @MainActor static func loadLocalOriginal(photo: RecentPhoto) async -> LocalOriginalResult {
    let id=photo.id,revision=photo.sourceRevision
    func current() -> PHAsset? {
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for:.readWrite)),
        let asset=PHAsset.fetchAssets(withLocalIdentifiers:[id],options:nil).firstObject,
        !asset.isHidden,RecentPhoto.sourceRevision(asset)==revision else { return nil }
      return asset
    }
    guard let asset=current() else { return .changed }
    let request=CaptureMetadataRequest(asset:asset)
    let input=await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        request.start(continuation)
        let options=PHContentEditingInputRequestOptions();options.isNetworkAccessAllowed=false
        // Ask for the unadjusted base rather than an editor's flattened derivative.
        options.canHandleAdjustmentData={ _ in true }
        let handle=asset.requestContentEditingInput(with:options) { input,_ in request.complete(input?.fullSizeImageURL) }
        request.setID(handle)
      }
    } onCancel: { request.cancel() }
    guard !Task.isCancelled else { return .cancelled }
    guard current() != nil else { return .changed }
    guard let input,input.isFileURL else { return .unavailable }
    let original=await Task.detached(priority:.utility) {
      guard let source=CGImageSourceCreateWithURL(input as CFURL,[kCGImageSourceShouldCache:false] as CFDictionary) else { return PhotoCaptureMetadata() }
      return PhotoCaptureMetadata.original(source)
    }.value
    guard !Task.isCancelled else { return .cancelled }
    guard let latest=current() else { return .changed }
    guard !original.items.isEmpty else { return .unavailable }
    return .available(photos(latest, includeDetails: true).merging(original))
  }
}

private final class CaptureMetadataRequest: @unchecked Sendable {
  private let asset:PHAsset
  private let lock=NSLock()
  private var id:PHContentEditingInputRequestID?
  private var continuation:CheckedContinuation<URL?,Never>?
  private var finished=false
  init(asset:PHAsset) { self.asset=asset }
  func start(_ value:CheckedContinuation<URL?,Never>) {
    lock.lock();if finished { lock.unlock();value.resume(returning:nil) } else { continuation=value;lock.unlock() }
  }
  func setID(_ value:PHContentEditingInputRequestID) {
    lock.lock();let cancelled=finished;id=value;lock.unlock()
    if cancelled { asset.cancelContentEditingInputRequest(value) }
  }
  func complete(_ url:URL?) {
    lock.lock();guard !finished else { lock.unlock();return };finished=true
    let value=continuation;continuation=nil;lock.unlock();value?.resume(returning:url)
  }
  func cancel() {
    lock.lock();let handle=id;lock.unlock();complete(nil)
    if let handle { asset.cancelContentEditingInputRequest(handle) }
  }
}

enum PhotoCaptureFacts {
  static func isReserved(_ fact:String) -> Bool { PhotoCaptureMetadata.isReserved(fact) }
  static func isDerivedAddition(_ facts: [String]?, from base: [String]?, originalSha256: String) -> Bool {
    let current = (facts ?? []).filter(isReserved), prior = (base ?? []).filter(isReserved)
    if current == prior { return true }
    guard current.allSatisfy({ $0.hasPrefix(PhotoCaptureMetadata.prefix) }),
      let value = read(facts, originalSha256: originalSha256) else { return false }
    if prior.isEmpty { return true }
    guard let before = read(base, originalSha256: originalSha256) else { return false }
    return before.items.allSatisfy { value.items.contains($0) }
  }
  static func read(_ facts:[String]?,originalSha256:String) -> PhotoCaptureMetadata? {
    PhotoCaptureMetadata.read(facts ?? [],originalSha256:originalSha256)
  }
}
