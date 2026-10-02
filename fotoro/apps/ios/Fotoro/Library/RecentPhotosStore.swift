import Foundation
import Observation
import Photos
import UIKit

struct RecentPhotoFacts {
  var capturedAt: Date?
  var favorite: Bool
  var screenshot: Bool
  var livePhoto: Bool
  var location: String?
  var searchText: String {
    [
      capturedAt?.formatted(date: .complete, time: .omitted), favorite ? "favorite" : nil,
      screenshot ? "screenshot" : nil, livePhoto ? "live photo" : nil,
      location == nil ? nil : "location gps", location,
    ].compactMap { $0 }.joined(separator: " ")
  }
}

struct RecentPhoto: Identifiable {
  let asset: PHAsset
  var id: String { asset.localIdentifier }
  var sourceRevision: String { Self.sourceRevision(asset) }
  static func sourceRevision(_ asset: PHAsset) -> String {
    "\(asset.modificationDate?.timeIntervalSince1970 ?? 0)|\(asset.pixelWidth)x\(asset.pixelHeight)"
  }
  var capturedAt: Date? { asset.creationDate }
  var isFavorite: Bool { asset.isFavorite }
  var isScreenshot: Bool { asset.mediaSubtypes.contains(.photoScreenshot) }
  var isLivePhoto: Bool { asset.mediaSubtypes.contains(.photoLive) }
  var location: String? {
    asset.location.map {
      String(format: "%.4f, %.4f", $0.coordinate.latitude, $0.coordinate.longitude)
    }
  }
  var searchText: String {
    RecentPhotoFacts(
      capturedAt: capturedAt, favorite: isFavorite, screenshot: isScreenshot,
      livePhoto: isLivePhoto, location: location
    ).searchText
  }
}

enum RecentPhotosPolicy {
  static func cutoff(now: Date, calendar: Calendar = .current) -> Date {
    calendar.date(byAdding: .day, value: -10, to: now)!
  }
  static func includes(_ date: Date?, now: Date, calendar: Calendar = .current) -> Bool {
    guard let date else { return false }
    return date >= cutoff(now: now, calendar: calendar) && date <= now
  }
  static func shouldLoadPage(_ index: Int, current: Int) -> Bool {
    abs(index - current) <= 1
  }
  static func canRead(_ status: PHAuthorizationStatus) -> Bool {
    status == .authorized || status == .limited
  }
}

@MainActor @Observable final class RecentPhotosStore {
  private(set) var photos: [RecentPhoto] = []
  private(set) var status = PHAuthorizationStatus.notDetermined
  private(set) var opened = false
  var error: String?
  var loading = false
  let images = PHCachingImageManager()
  @ObservationIgnored private let authorization: () -> PHAuthorizationStatus
  @ObservationIgnored private let requestAccess: () async -> PHAuthorizationStatus
  @ObservationIgnored private let readPhotos: @MainActor (Date) -> [RecentPhoto]
  init(
    authorization: @escaping () -> PHAuthorizationStatus = { PHPhotoLibrary.authorizationStatus(for: .readWrite) },
    requestAccess: @escaping () async -> PHAuthorizationStatus = { await PHPhotoLibrary.requestAuthorization(for: .readWrite) },
    readPhotos: @escaping @MainActor (Date) -> [RecentPhoto] = RecentPhotosStore.fetchRecentPhotos
  ) {
    self.authorization = authorization
    self.requestAccess = requestAccess
    self.readPhotos = readPhotos
  }
  func restoreAccess(now: Date = Date()) {
    status = authorization()
    opened = status != .notDetermined
    if opened { refresh(now: now) }
  }

  func open() async {
    status = await requestAccess()
    opened = true
    guard RecentPhotosPolicy.canRead(status) else {
      photos = []
      return
    }
    refresh()
  }
  func refresh(now: Date = Date()) {
    guard opened else { return }
    status = authorization()
    images.stopCachingImagesForAllAssets()
    guard RecentPhotosPolicy.canRead(status) else {
      photos = []
      return
    }
    photos = readPhotos(now)
  }
  private static func fetchRecentPhotos(now: Date) -> [RecentPhoto] {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(
      format: "mediaType == %d AND creationDate >= %@ AND creationDate <= %@",
      PHAssetMediaType.image.rawValue, RecentPhotosPolicy.cutoff(now: now) as NSDate, now as NSDate)
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    let result = PHAsset.fetchAssets(with: options)
    var values: [RecentPhoto] = []
    result.enumerateObjects { asset, _, _ in values.append(RecentPhoto(asset: asset)) }
    return values
  }
  func cache(_ assets: [PHAsset], start: Bool) {
    let target = CGSize(width: 360, height: 360)
    if start {
      images.startCachingImages(
        for: assets, targetSize: target, contentMode: .aspectFill, options: nil)
    } else {
      images.stopCachingImages(
        for: assets, targetSize: target, contentMode: .aspectFill, options: nil)
    }
  }
  func shareOriginals(_ photos: [RecentPhoto]) async throws -> [URL] {
    func checkAccess(_ photo: RecentPhoto) throws {
      guard RecentPhotosPolicy.canRead(PHPhotoLibrary.authorizationStatus(for: .readWrite)),
        let current = PHAsset.fetchAssets(withLocalIdentifiers: [photo.id], options: nil).firstObject,
        !current.isHidden, current.mediaType == .image,
        RecentPhoto.sourceRevision(current) == photo.sourceRevision else {
        throw FotoroError("This photo is no longer available. Choose it again from Photos.")
      }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    do {
      var urls: [URL] = []
      for photo in photos {
        try Task.checkCancellation()
        try checkAccess(photo)
        guard
          let resource = PHAssetResource.assetResources(for: photo.asset).first(where: {
            $0.type == .photo
          })
        else { throw FotoroError("The still original is unavailable in Photos.") }
        let folder = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(
          at: folder, withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.complete])
        let url = folder.appendingPathComponent(resource.originalFilename)
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation {
          (continuation: CheckedContinuation<Void, Error>) in
          PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: options) {
            error in
            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
          }
        }
        try Task.checkCancellation()
        try checkAccess(photo)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
        urls.append(url)
      }
      return urls
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }
}
