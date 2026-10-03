import Photos
import XCTest
@testable import Fotoro

@MainActor final class PhotoPickLifecycleTests: XCTestCase {
  private func candidate(_ id: String, revision: String = "1", screenshot: Bool = false) -> AutomaticPhotoPickCandidate {
    AutomaticPhotoPickCandidate(id: id, sourceRevision: revision, capturedAt: Date(), width: 120, height: 120, favorite: true, isScreenshot: screenshot)
  }
  private var signal: AutomaticPhotoPickSignals {
    AutomaticPhotoPickSignals(hash: 1, luminance: 0.5, contrast: 0.2, sharpness: 0.2, color: [0.3, 0.4, 0.3])
  }
  func testSnapshotDistinguishesMissingCaptureDateFromEpoch() {
    let missing = AutomaticPhotoPickCandidate(id: "a", sourceRevision: "1", capturedAt: nil, width: 100, height: 100, favorite: false, isScreenshot: false)
    let epoch = AutomaticPhotoPickCandidate(id: "a", sourceRevision: "1", capturedAt: Date(timeIntervalSince1970: 0), width: 100, height: 100, favorite: false, isScreenshot: false)
    let snapshot = PhotoPicksSnapshot(candidates: [missing], recommendations: AutomaticPhotoPickPolicy.recommend([], signals: [:]))
    XCTAssertFalse(snapshot.matches([epoch]))
  }
  func testBrowsingTenThousandSourcesReadsBoundedPagesAndReachesOlderAndUndatedSources() {
    let sources = (0..<10_000).map { "source-\($0)" } + ["oldest", "undated"]
    var reads: [Range<Int>] = []
    let browse = PhotoBrowseSource(count: sources.count) { range in
      reads.append(range)
      return Array(sources[range])
    }
    var loaded: [String] = []
    var offset = 0
    while offset < browse.count {
      let range = browse.range(after: offset)
      loaded.append(contentsOf: browse.photos(in: range))
      offset = range.upperBound
      XCTAssertLessThanOrEqual(range.count, RecentPhotosPolicy.browsePageSize)
    }
    XCTAssertEqual(reads.first, 0..<200)
    XCTAssertEqual(loaded, sources)
    XCTAssertEqual(Set(loaded).count, sources.count)
    XCTAssertEqual(Array(loaded.suffix(2)), ["oldest", "undated"])
    XCTAssertTrue(browse.range(after: Int.max).isEmpty)
    XCTAssertTrue(browse.range(after: -1, limit: 0).isEmpty)
    XCTAssertTrue(browse.photos(in: -1..<1).isEmpty)
    XCTAssertEqual(reads.count, 51)
  }
  func testBrowseFetchIncludesAllCaptureDatesWhilePicksKeepOnlyBoundedRecentStills() throws {
    let now = Date(timeIntervalSince1970: 1_780_315_200)
    let browse = RecentPhotosPolicy.browseFetchOptions()
    let picks = RecentPhotosPolicy.pickFetchOptions(now: now)
    let browsePredicate = try XCTUnwrap(browse.predicate)
    let picksPredicate = try XCTUnwrap(picks.predicate)
    let image = PHAssetMediaType.image.rawValue
    for date in [now.addingTimeInterval(-30 * 86400), now.addingTimeInterval(86400)] {
      let metadata: [String: Any] = ["mediaType": image, "creationDate": date]
      XCTAssertTrue(browsePredicate.evaluate(with: metadata))
      XCTAssertFalse(picksPredicate.evaluate(with: metadata))
    }
    XCTAssertTrue(browsePredicate.evaluate(with: ["mediaType": image]))
    XCTAssertTrue(picksPredicate.evaluate(with: ["mediaType": image, "creationDate": now] as [String: Any]))
    XCTAssertFalse(browsePredicate.evaluate(with: ["mediaType": PHAssetMediaType.video.rawValue]))
    XCTAssertEqual(browse.fetchLimit, 0, "The source retains all permitted stills without materializing them all")
    XCTAssertEqual(picks.fetchLimit, RecentPhotosPolicy.maximumPickCandidates)
    XCTAssertFalse(browse.includeHiddenAssets)
    XCTAssertTrue(browse.includeAllBurstAssets)
  }
  func testPermissionChangeDuringBrowseReadCannotPublishOrStartAnalysis() {
    var permission = PHAuthorizationStatus.authorized
    var previews = 0
    let analyzer = PhotoPickAnalyzer(preview: { _ in previews += 1; return self.signal }, isCurrent: { _ in true })
    let store = RecentPhotosStore(authorization: { permission }, readBrowseSource: { _ in
      PhotoBrowseSource(count: 300) { _ in permission = .denied; return [] }
    }, readRecentPhotos: { _ in [] }, picks: analyzer)
    store.restoreAccess()
    XCTAssertEqual(store.status, .denied)
    XCTAssertTrue(store.photos.isEmpty)
    XCTAssertTrue(store.recentPhotos.isEmpty)
    XCTAssertFalse(store.hasMorePhotos)
    XCTAssertNil(store.picksSnapshot)
    XCTAssertEqual(previews, 0)
    store.loadMorePhotos()
    XCTAssertTrue(store.photos.isEmpty)
    store.pauseAnalysis()
  }
  func testNonFavoriteScreenshotsUseNoPreviewWorkButFavoritesRemainEligible() async throws {
    var reads: [String] = []
    let analyzer = PhotoPickAnalyzer(preview: { candidate in reads.append(candidate.id); return self.signal },
      isCurrent: { _ in true })
    var ignored = candidate("ignored-screen", screenshot: true)
    ignored.favorite = false
    let favorite = candidate("favorite-screen", screenshot: true)
    let result = try await analyzer.snapshot([ignored, favorite])
    XCTAssertEqual(reads, [favorite.id])
    XCTAssertEqual(result.recommendations.ids, [favorite.id])
    XCTAssertEqual(result.recommendations.unassessed, 0)
    XCTAssertEqual(analyzer.completed, 2)
  }
  func testSerialAnalysisCachesByRevisionWithoutOriginalOrUploadWork() async throws {
    var reads: [String] = []
    var active = 0
    let analyzer = PhotoPickAnalyzer(preview: { source in
      active += 1
      XCTAssertEqual(active, 1)
      reads.append(source.id + source.sourceRevision)
      await Task.yield()
      active -= 1
      return self.signal
    }, isCurrent: { _ in true })
    let sources = [candidate("a"), candidate("b")]
    let first = try await analyzer.snapshot(sources)
    XCTAssertFalse(first.recommendations.ids.isEmpty)
    XCTAssertEqual(analyzer.completed, 2)
    _ = try await analyzer.snapshot(sources)
    XCTAssertEqual(reads, ["a1", "b1"])
    _ = try await analyzer.snapshot([candidate("a", revision: "2"), sources[1]])
    XCTAssertEqual(reads, ["a1", "b1", "a2"])
    XCTAssertFalse(analyzer.analyzing)
  }
  func testMissingPreviewNeverFallsBackToAllPhotosAndRetriesWhenAvailable() async throws {
    var available = false
    let analyzer = PhotoPickAnalyzer(preview: { _ in available ? self.signal : nil }, isCurrent: { _ in true })
    let missing = try await analyzer.snapshot([candidate("cloud-only")])
    XCTAssertTrue(missing.recommendations.ids.isEmpty)
    XCTAssertEqual(missing.recommendations.unassessed, 1)
    available = true
    let ready = try await analyzer.snapshot([candidate("cloud-only")])
    XCTAssertEqual(ready.recommendations.ids, ["cloud-only"])
  }
  func testForegroundAndExplicitSyncRetryAnIncompleteStoreSnapshot() async throws {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard RecentPhotosPolicy.canRead(permission) else {
      throw XCTSkip("Permit the public Simulator Photos library to verify foreground retry.")
    }
    var asset: PHAsset?
    PHAsset.fetchAssets(with: .image, options: nil).enumerateObjects { candidate, _, stop in
      if !candidate.isHidden, !candidate.mediaSubtypes.contains(.photoScreenshot) {
        asset = candidate
        stop.pointee = true
      }
    }
    let photo = RecentPhoto(asset: try XCTUnwrap(asset))
    for explicitSync in [false, true] {
      var available = false
      var reads = 0
      let analyzer = PhotoPickAnalyzer(preview: { _ in
        reads += 1
        return available ? self.signal : nil
      })
      let store = RecentPhotosStore(authorization: { permission }, readPhotos: { _ in [photo] }, picks: analyzer)
      let now = try XCTUnwrap(photo.capturedAt)
      store.restoreAccess(now: now)
      for _ in 0..<100 where store.picksSnapshot == nil { await Task.yield() }
      XCTAssertEqual(store.picksSnapshot?.recommendations.unassessed, 1)
      XCTAssertTrue(store.pickedPhotos.isEmpty)
      available = true
      if !explicitSync { store.restoreAccess(now: now) }
      let retried = try await store.completedPicks()
      XCTAssertEqual(retried.recommendations.ids, [photo.id])
      XCTAssertEqual(retried.recommendations.unassessed, 0)
      XCTAssertEqual(reads, 2)
      XCTAssertEqual(store.photos.map(\.id), [photo.id])
      store.pauseAnalysis()
    }
  }
  func testPermissionOrRevisionWithdrawalCannotPublishCompletedPicks() async throws {
    var permitted = true
    let gate = PickPreviewGate()
    let analyzer = PhotoPickAnalyzer(preview: { _ in await gate.wait(); return self.signal }, isCurrent: { _ in permitted })
    let run = Task { try await analyzer.snapshot([candidate("a")]) }
    while !gate.entered { await Task.yield() }
    permitted = false
    gate.open()
    do { _ = try await run.value; XCTFail("Withdrawn sources must not publish picks") }
    catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertFalse(analyzer.analyzing)
  }
  func testCancelledOrInvalidatedAnalysisCannotPublishLatePreview() async throws {
    for cancel in [false, true] {
      let gate = PickPreviewGate()
      let analyzer = PhotoPickAnalyzer(preview: { _ in await gate.wait(); return self.signal }, isCurrent: { _ in true })
      let run = Task { try await analyzer.snapshot([candidate("a")]) }
      while !gate.entered { await Task.yield() }
      if cancel { run.cancel() } else { analyzer.invalidate() }
      gate.open()
      do { _ = try await run.value; XCTFail("Late preview must not publish") }
      catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertFalse(analyzer.analyzing)
    }
  }
}

@MainActor private final class PickPreviewGate {
  var entered = false
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { entered = true; await withCheckedContinuation { continuation = $0 } }
  func open() { continuation?.resume(); continuation = nil }
}
