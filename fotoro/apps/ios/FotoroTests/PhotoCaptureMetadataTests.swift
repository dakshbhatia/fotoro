import ImageIO
import CoreLocation
import Photos
import UIKit
import XCTest
@testable import Fotoro

final class PhotoCaptureMetadataTests: XCTestCase {
  private let digest=String(repeating:"A",count:43)
  private var metadata:PhotoCaptureMetadata { PhotoCaptureMetadata(items:[
    .init(k:"width",p:.photos,v:"3024"),.init(k:"createdAt",p:.photos,v:"2026-10-07T12:00:00.000Z"),
    .init(k:"cameraModel",p:.original,v:"iPhone 18 Pro"),.init(k:"aperture",p:.original,v:"1.8"),
    .init(k:"exposureSeconds",p:.original,v:"0.004")]) }
  func testSourceBoundFactsRoundTripWithoutChangingWireMetadataOrRawSearchTokens() throws {
    let facts=metadata.facts(originalSha256:digest)
    XCTAssertEqual(facts.first,"fotoro.capture.v1:source:"+digest)
    XCTAssertTrue(facts.contains(#"fotoro.capture.v1:item:{"k":"cameraModel","p":"original","v":"iPhone 18 Pro"}"#))
    XCTAssertLessThanOrEqual(facts.count,33);XCTAssertTrue(facts.allSatisfy {$0.unicodeScalars.count<=240})
    let decoded=try XCTUnwrap(PhotoCaptureFacts.read(facts,originalSha256:digest))
    XCTAssertEqual(decoded.items.count,metadata.items.count)
    XCTAssertNil(PhotoCaptureFacts.read(facts,originalSha256:String(repeating:"B",count:43)))
    XCTAssertEqual(decoded.searchText,"iPhone 18 Pro")
    XCTAssertFalse(decoded.searchText.contains("2026"));XCTAssertTrue(PhotoCaptureFacts.isReserved("fotoro.capture.v2:future"))
    XCTAssertNil(PhotoCaptureFacts.read(facts+Array(repeating:"user fact",count:64),originalSha256:digest))
  }
  func testMalformedAmbiguousAndOutOfBoundsCaptureFactsFailClosed() {
    let source="fotoro.capture.v1:source:"+digest,prefix="fotoro.capture.v1:item:"
    let invalid=[
      #"{"k":"width","p":"original","v":"0"}"#,
      #"{"k":"orientation","p":"original","v":"9"}"#,
      #"{"k":"iso","p":"original","v":"100.5"}"#,
      #"{"k":"cameraModel","p":"photos","v":"invented"}"#,
      #"{"k":"createdAt","p":"photos","v":"2026-02-30T12:00:00.000Z"}"#,
      #"{"k":"cameraModel","p":"original","v":"Camera","extra":"wrong"}"#,
      #"{"k":"cameraModel","p":"original","v":"one","v":"two"}"#,
      #"{"k":"cameraModel","p":"original","v":"one","\u0076":"two"}"#,
      #"{"k":"peopleCount","p":"photos","v":"4"}"#,
      #"{"k":"latitude","p":"original","v":"40"}"#,
    ]
    for value in invalid { XCTAssertNil(PhotoCaptureFacts.read([source,prefix+value],originalSha256:digest),value) }
    let facts=metadata.facts(originalSha256:digest)
    XCTAssertNil(PhotoCaptureFacts.read(facts+[source],originalSha256:digest))
    XCTAssertNil(PhotoCaptureFacts.read(facts+[facts[1]],originalSha256:digest))
    let quoted=PhotoCaptureMetadata(items:[.init(k:"cameraModel",p:.original,v:#"Camera "k": model"#)])
    XCTAssertNotNil(PhotoCaptureFacts.read(quoted.facts(originalSha256:digest),originalSha256:digest))
  }
  func testExifParserKeepsRealCameraExposureAndRawTimeWithoutGPSOrInventedPeople() {
    let properties:[String:Any]=[
      kCGImagePropertyPixelWidth as String:3024,kCGImagePropertyPixelHeight as String:4032,kCGImagePropertyOrientation as String:6,
      kCGImagePropertyTIFFDictionary as String:[kCGImagePropertyTIFFMake as String:"Apple",kCGImagePropertyTIFFModel as String:"iPhone 18 Pro"],
      kCGImagePropertyExifDictionary as String:[kCGImagePropertyExifLensModel as String:"Back camera",kCGImagePropertyExifFNumber as String:1.8,
        kCGImagePropertyExifExposureTime as String:0.004,kCGImagePropertyExifFocalLength as String:6.86,
        kCGImagePropertyExifISOSpeedRatings as String:[100],kCGImagePropertyExifDateTimeOriginal as String:"2026:10:07 12:00:00",
        kCGImagePropertyExifOffsetTimeOriginal as String:"+08:00"],
      kCGImagePropertyGPSDictionary as String:["Latitude":40,"Longitude":-74]]
    let value=PhotoCaptureMetadata.originalProperties(properties,contentType:"public.jpeg")
    XCTAssertEqual(value.items.first {$0.k=="iso"}?.v,"100")
    XCTAssertEqual(value.items.first {$0.k=="exposureSeconds"}?.v,"0.004")
    XCTAssertFalse(value.items.contains {$0.k=="createdAt" || $0.k=="latitude" || $0.k=="peopleCount"})
    XCTAssertEqual(value.rows.first {$0.id=="original:originalDateTime"}?.group,.source)
    var invalid=properties;invalid[kCGImagePropertyPixelWidth as String]=true
    invalid[kCGImagePropertyExifDictionary as String]=[kCGImagePropertyExifFNumber as String:Double.infinity,kCGImagePropertyExifISOSpeedRatings as String:[true]]
    let rejected=PhotoCaptureMetadata.originalProperties(invalid)
    XCTAssertFalse(rejected.items.contains {$0.k=="width" || $0.k=="aperture" || $0.k=="iso"})
  }
  func testDerivedEnrichmentIsAdditiveAndMediaSearchUsesDisplayedWords() {
    let original=metadata.facts(originalSha256:digest)
    let extra=metadata.merging(PhotoCaptureMetadata(items:[.init(k:"lensModel",p:.original,v:"Back camera")]))
    XCTAssertTrue(PhotoCaptureFacts.isDerivedAddition(extra.facts(originalSha256:digest),from:original,originalSha256:digest))
    XCTAssertFalse(PhotoCaptureFacts.isDerivedAddition(Array(original.dropLast()),from:original,originalSha256:digest))
    XCTAssertFalse(PhotoCaptureFacts.isDerivedAddition(extra.facts(originalSha256:digest)+["fotoro.capture.v2:opaque"],from:original,originalSha256:digest))
    let features=PhotoCaptureMetadata(items:[.init(k:"mediaType",p:.photos,v:"image"),.init(k:"subtypes",p:.photos,v:"highFrameRate,livePhoto")])
    XCTAssertTrue(features.searchText.contains("Live Photo"));XCTAssertTrue(features.searchText.contains("High frame rate"))
    XCTAssertTrue(features.searchText.contains("Photo"))
  }
  func testCurrentRevisionOriginalMetadataPersistsThroughRefreshWithoutReplacingLabelsOrAnalysis() throws {
    let index=try SearchIndex();var record=SearchRecord(id:"source");record.revision="current";record.labels=["My exact label"]
    record.ocrStatus = .complete;record.ocrText="receipt";record.captureMetadata=PhotoCaptureMetadata(items:[.init(k:"width",p:.photos,v:"1000")])
    try index.replacePermitted([record]);try index.setWorkGeneration(2)
    XCTAssertFalse(try index.applyCaptureMetadata(metadata,photoID:record.id,revision:"old",generation:2))
    XCTAssertFalse(try index.applyCaptureMetadata(metadata,photoID:record.id,revision:"current",generation:1))
    XCTAssertTrue(try index.applyCaptureMetadata(metadata,photoID:record.id,revision:"current",generation:2))
    let current=try XCTUnwrap(index.record(record.id));XCTAssertEqual(current.labels,record.labels);XCTAssertEqual(current.ocrText,"receipt")
    XCTAssertEqual(current.captureMetadata?.items.first {$0.k=="width" && $0.p == .photos}?.v,"1000")
    try index.replacePermitted([record]);XCTAssertEqual(try index.search("iPhone").results.map(\.id),[record.id])
    XCTAssertTrue(try index.search("fotoro.capture").results.isEmpty)
    XCTAssertTrue(PhotoAnalysisScope.matchesMetadata(try XCTUnwrap(index.record(record.id)),text:"iPhone"))
    record.revision="changed";try index.replacePermitted([record]);XCTAssertTrue(try index.search("iPhone").results.isEmpty)
  }
  @MainActor func testSimulatorEditedPhotosMetadataAndLocalOriginalInfoLoader() async throws {
    #if targetEnvironment(simulator)
    guard ProcessInfo.processInfo.environment["FOTORO_TEST_PHOTOKIT_METADATA"] == "true" else {
      throw XCTSkip("Real PhotoKit fixture work requires explicit local metadata QA opt-in.")
    }
    guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)) else {
      throw XCTSkip("Simulator Photos permission is required for the synthetic metadata integration test.")
    }
    let albumTitle = "Fotoro Synthetic Metadata QA"
    let filenames = ["FOTORO-QA-SYNTHETIC-SINGAPORE.jpg", "FOTORO-QA-SYNTHETIC-LONDON.jpg", "FOTORO-QA-SYNTHETIC-GPS-REMOVED.jpg"]
    let labels = ["SYNTHETIC QA · SINGAPORE", "SYNTHETIC QA · LONDON", "SYNTHETIC QA · GPS REMOVED"]
    let options = PHFetchOptions(); options.predicate = NSPredicate(format: "title == %@", albumTitle)
    let albums = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: options)
    XCTAssertLessThanOrEqual(albums.count, 1, "Never alter an ambiguous album.")
    guard albums.count <= 1 else { return }
    var ids: [String] = []
    if let album = albums.firstObject {
      let assets = PHAsset.fetchAssets(in: album, options: nil)
      var byName: [String: String] = [:]
      assets.enumerateObjects { asset, _, _ in
        let name = PHAssetResource.assetResources(for: asset).first { $0.type == .photo }?.originalFilename ?? ""
        if filenames.contains(name), byName[name] == nil { byName[name] = asset.localIdentifier }
      }
      guard assets.count == 0 || (assets.count == 3 && byName.count == 3) else {
        XCTFail("The dedicated QA album contains unexpected assets; leave it untouched."); return
      }
      ids = filenames.compactMap { byName[$0] }
    }
    if ids.isEmpty {
      let bytes = try labels.enumerated().map { try syntheticMetadataJPEG(label: $0.element, index: $0.offset) }
      try await PHPhotoLibrary.shared().performChanges {
        let albumRequest: PHAssetCollectionChangeRequest?
        if let album = albums.firstObject { albumRequest = PHAssetCollectionChangeRequest(for: album) }
        else {
          let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: albumTitle)
          albumRequest = request
        }
        var placeholders: [PHObjectPlaceholder] = []
        for index in bytes.indices {
          let request = PHAssetCreationRequest.forAsset()
          let resource = PHAssetResourceCreationOptions(); resource.originalFilename = filenames[index]
          request.addResource(with: .photo, data: bytes[index], options: resource)
          request.creationDate = Date(timeIntervalSince1970: 946684800)
          request.location = CLLocation(latitude: 0, longitude: 0)
          if let placeholder = request.placeholderForCreatedAsset { placeholders.append(placeholder); ids.append(placeholder.localIdentifier) }
        }
        albumRequest?.addAssets(placeholders as NSArray)
      }
    }
    do {
      XCTAssertEqual(ids.count, 3)
      let now = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
      let dates = (1...3).map { now.addingTimeInterval(-Double($0) * 86400) }
      let locations: [CLLocation?] = [CLLocation(latitude: 1.3521, longitude: 103.8198), CLLocation(latitude: 51.5074, longitude: -0.1278), nil]
      // Metadata edits are a separate PhotoKit transaction from importing the original headers.
      try await PHPhotoLibrary.shared().performChanges {
        for index in ids.indices {
          guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ids[index]], options: nil).firstObject else { continue }
          let request = PHAssetChangeRequest(for: asset)
          request.creationDate = dates[index]; request.location = locations[index]
        }
      }
      for index in ids.indices {
        let asset = try XCTUnwrap(PHAsset.fetchAssets(withLocalIdentifiers: [ids[index]], options: nil).firstObject)
        let photo = RecentPhoto(asset: asset)
        XCTAssertEqual(try XCTUnwrap(photo.capturedAt).timeIntervalSince1970, dates[index].timeIntervalSince1970, accuracy: 0.01)
        if let location = locations[index] {
          let current = try XCTUnwrap(photo.photoLocation)
          XCTAssertEqual(current.source, "photos")
          XCTAssertEqual(current.latitude, location.coordinate.latitude, accuracy: 0.0001)
          XCTAssertEqual(current.longitude, location.coordinate.longitude, accuracy: 0.0001)
        } else { XCTAssertNil(photo.photoLocation, "An original GPS header must not restore removed Photos GPS.") }
        guard case .available(let metadata) = await PhotoCaptureMetadata.loadLocalOriginal(photo: photo) else {
          XCTFail("The local synthetic original must be available without network access."); continue
        }
        XCTAssertEqual(metadata.items.first { $0.k == "createdAt" && $0.p == .photos }, photo.captureMetadata.items.first { $0.k == "createdAt" && $0.p == .photos })
        XCTAssertEqual(metadata.items.first { $0.k == "cameraModel" && $0.p == .original }?.v, "Fotoro Synthetic QA Camera")
        XCTAssertEqual(metadata.items.first { $0.k == "originalDateTime" && $0.p == .original }?.v, "2000:01:01 00:00:00")
        XCTAssertEqual(metadata.items.first { $0.k == "offsetTimeOriginal" && $0.p == .original }?.v, "+00:00")
        XCTAssertFalse(metadata.items.contains { $0.k == "latitude" || $0.k == "longitude" })
      }
    }
    #else
    throw XCTSkip("Synthetic PhotoKit integration is Simulator-only.")
    #endif
  }
  @MainActor private func syntheticMetadataJPEG(label: String, index: Int) throws -> Data {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 480)).image { context in
      [UIColor.systemTeal, .systemIndigo, .systemOrange][index].setFill()
      context.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
      (label as NSString).draw(in: CGRect(x: 30, y: 190, width: 580, height: 100), withAttributes: [
        .font: UIFont.boldSystemFont(ofSize: 30), .foregroundColor: UIColor.white])
      ("Not a personal photo" as NSString).draw(at: CGPoint(x: 30, y: 300), withAttributes: [
        .font: UIFont.systemFont(ofSize: 24), .foregroundColor: UIColor.white])
    }
    let output = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil))
    let properties: [String: Any] = [
      kCGImagePropertyTIFFDictionary as String: [kCGImagePropertyTIFFMake as String: "Fotoro Synthetic QA", kCGImagePropertyTIFFModel as String: "Fotoro Synthetic QA Camera"],
      kCGImagePropertyExifDictionary as String: [kCGImagePropertyExifDateTimeOriginal as String: "2000:01:01 00:00:00", kCGImagePropertyExifOffsetTimeOriginal as String: "+00:00", kCGImagePropertyExifFNumber as String: 2.8, kCGImagePropertyExifISOSpeedRatings as String: [100]],
      kCGImagePropertyGPSDictionary as String: [kCGImagePropertyGPSLatitude as String: 0, kCGImagePropertyGPSLatitudeRef as String: "N", kCGImagePropertyGPSLongitude as String: 0, kCGImagePropertyGPSLongitudeRef as String: "E"]]
    CGImageDestinationAddImage(destination, try XCTUnwrap(image.cgImage), properties as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let bytes = output as Data
    XCTAssertEqual(PhotoLocationV1.exif(bytes)?.latitude, 0)
    XCTAssertEqual(PhotoLocationV1.exif(bytes)?.longitude, 0)
    return bytes
  }
}
