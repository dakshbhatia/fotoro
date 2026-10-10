import Photos
import UIKit
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
  func testPickDiagnosticsCountProcessedSourcesAndKeepCancelledRequestProgressSeparate() async throws {
    let gate = PickPreviewGate(), held = expectation(description: "Old pick request held")
    let analyzer = PhotoPickAnalyzer(preview: { candidate in
      if candidate.id == "held" { held.fulfill(); await gate.wait() }
      return candidate.id == "missing" ? nil : self.signal
    }, isCurrent: { _ in true })
    defer { gate.open() }
    let oldTrace = NativeDiagnosticTrace(.sync), replacementTrace = NativeDiagnosticTrace(.sync)
    let old = Task {
      try await NativeDiagnosticTrace.$current.withValue(oldTrace) {
        try await analyzer.snapshot([self.candidate("first"), self.candidate("held")])
      }
    }
    await fulfillment(of: [held], timeout: 1)
    var screenshot = candidate("screenshot", screenshot: true)
    screenshot.favorite = false
    let result = try await NativeDiagnosticTrace.$current.withValue(replacementTrace) {
      try await analyzer.snapshot([screenshot, candidate("missing"), candidate("usable")])
    }
    XCTAssertEqual(result.recommendations.unassessed, 1, "A processed source can still lack usable pick signals")
    gate.open()
    do { _ = try await old.value; XCTFail("Replaced request reported success") } catch is CancellationError {}
    let events = try JSONDecoder().decode([NativeDiagnosticEvent].self, from: NativeDiagnostics.shared.exportJSON())
    let replacement = try XCTUnwrap(events.last { $0.phase == .picks && $0.traceId == replacementTrace.id })
    XCTAssertEqual(replacement.outcome, .completed)
    XCTAssertEqual(replacement.completed, 3); XCTAssertEqual(replacement.pending, 0)
    let cancelled = try XCTUnwrap(events.last { $0.phase == .picks && $0.traceId == oldTrace.id })
    XCTAssertEqual(cancelled.outcome, .cancelled)
    XCTAssertEqual(cancelled.completed, 1); XCTAssertEqual(cancelled.pending, 1)
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
  func testDefaultBrowseExcludesHistoricalUndatedAndFuturePhotosBeforeReadingPixels() throws {
    let now = Date()
    let predicate = try XCTUnwrap(RecentPhotosPolicy.browseFetchOptions().predicate)
    let image = PHAssetMediaType.image.rawValue
    XCTAssertTrue(predicate.evaluate(with: ["mediaType": image, "creationDate": now.addingTimeInterval(-86400)] as [String: Any]))
    for date in [now.addingTimeInterval(-31 * 86400), now.addingTimeInterval(86400)] {
      XCTAssertFalse(predicate.evaluate(with: ["mediaType": image, "creationDate": date] as [String: Any]))
    }
    XCTAssertFalse(predicate.evaluate(with: ["mediaType": image]))
  }
  func testBrowseFetchIncludesAllCaptureDatesWhilePicksKeepOnlyBoundedRecentStills() throws {
    let now = Date(timeIntervalSince1970: 1_780_315_200)
    let browse = RecentPhotosPolicy.browseFetchOptions(dates: .all)
    let picks = RecentPhotosPolicy.pickFetchOptions(now: now)
    let browsePredicate = try XCTUnwrap(browse.predicate)
    let picksPredicate = try XCTUnwrap(picks.predicate)
    let image = PHAssetMediaType.image.rawValue
    for date in [now.addingTimeInterval(-31 * 86400), now.addingTimeInterval(86400)] {
      let metadata: [String: Any] = ["mediaType": image, "creationDate": date]
      XCTAssertTrue(browsePredicate.evaluate(with: metadata))
      XCTAssertFalse(picksPredicate.evaluate(with: metadata))
    }
    XCTAssertTrue(browsePredicate.evaluate(with: ["mediaType": image]))
    XCTAssertTrue(picksPredicate.evaluate(with: ["mediaType": image, "creationDate": now] as [String: Any]))
    #if FOTORO_LOCAL_PREVIEW
    XCTAssertFalse(browsePredicate.evaluate(with: ["mediaType": PHAssetMediaType.video.rawValue]))
    #else
    XCTAssertTrue(browsePredicate.evaluate(with: ["mediaType": PHAssetMediaType.video.rawValue]))
    #endif
    XCTAssertFalse(picksPredicate.evaluate(with: ["mediaType": PHAssetMediaType.video.rawValue, "creationDate": now] as [String: Any]))
    XCTAssertEqual(browse.fetchLimit, 0, "The source retains all permitted stills without materializing them all")
    XCTAssertEqual(picks.fetchLimit, RecentPhotosPolicy.maximumPickCandidates)
    XCTAssertFalse(browse.includeHiddenAssets)
    XCTAssertTrue(browse.includeAllBurstAssets)
  }
  func testChangingBrowseDatesResetsPagesAndStopsThePreviousMetadataContinuation() async {
    var reads: [Range<Int>] = []
    var recentReads = 0
    let store = RecentPhotosStore(authorization: { .authorized }, readBrowseSource: { _ in
      PhotoBrowseSource(count: 601) { range in reads.append(range); return [] }
    }, readRecentPhotos: { _ in recentReads += 1; return [] })
    defer { store.pauseAnalysis() }
    store.restoreAccess()
    store.loadMorePhotos()
    XCTAssertEqual(reads, [0..<200, 200..<400])
    await store.loadMorePhotos(matching: .favorites, whileActive: {
      store.setBrowseDates(.all)
      return true
    })
    XCTAssertEqual(reads, [0..<200, 200..<400, 0..<200], "The old date scope cannot append another page after expansion")
    XCTAssertEqual(recentReads, 1, "Changing browse dates must reuse the separate Picks source")
    XCTAssertEqual(store.browseDates, .all)
    XCTAssertTrue(store.hasMorePhotos)
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
  func testFilteredContinuationUsesBoundedMetadataPagesAndStopsWhenCancelledOrPermissionChanges() async {
    for withdrawPermission in [false, true] {
      var permission = PHAuthorizationStatus.authorized
      var reads: [Range<Int>] = []
      let store = RecentPhotosStore(authorization: { permission }, readBrowseSource: { _ in
        PhotoBrowseSource(count: 1001) { range in
          reads.append(range)
          if withdrawPermission && reads.count == 2 { permission = .denied }
          return []
        }
      }, readRecentPhotos: { _ in [] })
      defer { store.pauseAnalysis() }
      store.restoreAccess()
      XCTAssertEqual(reads, [0..<200])
      let continuation = Task { await store.loadMorePhotos(matching: .favorites) }
      if !withdrawPermission { continuation.cancel() }
      await continuation.value
      XCTAssertEqual(reads, withdrawPermission ? [0..<200, 200..<400] : [0..<200])
      XCTAssertEqual(store.status, withdrawPermission ? .denied : .authorized)
      XCTAssertTrue(store.photos.isEmpty)
      if withdrawPermission { XCTAssertFalse(store.hasMorePhotos) }
    }
  }
  func testFilteredContinuationFindsAnOlderFavoriteBeyondEmptyPagesWithoutAnalyzingPreviews() async throws {
    #if targetEnvironment(simulator)
      let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
      guard RecentPhotosPolicy.canRead(permission) else {
        throw XCTSkip("Permit the public Simulator Photos library to verify older favorite paging.")
      }
      let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "neutral-a", withExtension: "png"))
      let image = try XCTUnwrap(UIImage(contentsOfFile: fixture.path))
      var plainID = "", favoriteID = ""
      let olderDate = Date(timeIntervalSince1970: 1_577_880_000)
      try await PHPhotoLibrary.shared().performChanges {
        let plain = PHAssetChangeRequest.creationRequestForAsset(from: image)
        plain.creationDate = Date()
        plainID = plain.placeholderForCreatedAsset?.localIdentifier ?? ""
        let favorite = PHAssetChangeRequest.creationRequestForAsset(from: image)
        favorite.creationDate = olderDate
        favorite.isFavorite = true
        favoriteID = favorite.placeholderForCreatedAsset?.localIdentifier ?? ""
      }
      let plain = RecentPhoto(asset: try XCTUnwrap(PHAsset.fetchAssets(withLocalIdentifiers: [plainID], options: nil).firstObject))
      let favorite = RecentPhoto(asset: try XCTUnwrap(PHAsset.fetchAssets(withLocalIdentifiers: [favoriteID], options: nil).firstObject))
      XCTAssertTrue(favorite.isFavorite)
      XCTAssertFalse(RecentPhotosPolicy.includes(favorite.capturedAt, now: Date()))
      var reads: [Range<Int>] = []
      var previews = 0
      let analyzer = PhotoPickAnalyzer(preview: { _ in previews += 1; return self.signal }, isCurrent: { _ in true })
      let store = RecentPhotosStore(authorization: { permission }, readBrowseSource: { _ in
        PhotoBrowseSource(count: 1001) { range in
          reads.append(range)
          // Intervening pages contain no remaining permitted sources. Their
          // source offsets still advance, independently of visible cell count.
          if range.lowerBound == 0 { return [plain] }
          if range.lowerBound == 400 { return [favorite] }
          return []
        }
      }, readRecentPhotos: { _ in [] }, sourceRevisions: { _ in
        [plain.id: plain.sourceRevision, favorite.id: favorite.sourceRevision]
      }, picks: analyzer)
      defer { store.pauseAnalysis() }
      store.restoreAccess()
      XCTAssertTrue(store.photos.filter(\.isFavorite).isEmpty)
      XCTAssertTrue(store.hasMorePhotos)
      await store.loadMorePhotos(matching: .favorites)
      XCTAssertEqual(reads, [0..<200, 200..<400, 400..<600])
      XCTAssertEqual(store.photos.filter(\.isFavorite).map(\.id), [favorite.id])
      XCTAssertTrue(store.hasMorePhotos, "Finding a match does not eagerly materialize the remaining library")
      XCTAssertEqual(previews, 0, "Browsing filters must use metadata without pick analysis or image downloads")
    #else
      throw XCTSkip("Public favorite fixture injection is Simulator-only.")
    #endif
  }
  func testFilteredContinuationStopsMetadataPagingWhenPhotosLeavesForegroundAndResumesOnReturn() async {
    var active = true
    var reads: [Range<Int>] = []
    let store = RecentPhotosStore(authorization: { .authorized }, readBrowseSource: { _ in
      PhotoBrowseSource(count: 601) { range in
        reads.append(range)
        if range.lowerBound == 200 { active = false }
        return []
      }
    }, readRecentPhotos: { _ in [] })
    defer { store.pauseAnalysis() }
    store.restoreAccess()
    await store.loadMorePhotos(matching: .favorites, whileActive: { active })
    XCTAssertEqual(reads, [0..<200, 200..<400])
    XCTAssertTrue(store.hasMorePhotos)
    await store.loadMorePhotos(matching: .favorites, whileActive: { active })
    XCTAssertEqual(reads, [0..<200, 200..<400], "Inactive Photos cannot begin another metadata page")
    active = true
    await store.loadMorePhotos(matching: .favorites, whileActive: { active })
    XCTAssertEqual(reads, [0..<200, 200..<400, 400..<600, 600..<601])
    XCTAssertFalse(store.hasMorePhotos)
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
      defer { store.pauseAnalysis() }
      let now = try XCTUnwrap(photo.capturedAt)
      store.restoreAccess(now: now)
      // These injected reads use the asset's capture date as their clock. Real
      // Photos callbacks use today's date and do not belong to this fixture.
      PHPhotoLibrary.shared().unregisterChangeObserver(store)
      let missing = try await store.completedPicks()
      XCTAssertEqual(missing.recommendations.unassessed, 1)
      XCTAssertTrue(store.pickedPhotos.isEmpty)
      available = true
      if !explicitSync { store.restoreAccess(now: now) }
      let retried = try await store.completedPicks()
      XCTAssertEqual(retried.recommendations.ids, [photo.id])
      XCTAssertEqual(retried.recommendations.unassessed, 0)
      XCTAssertEqual(reads, 2)
      XCTAssertEqual(store.photos.map(\.id), [photo.id])
    }
  }
  func testCompletedPicksWaitsForTheSuccessorAfterExplicitRestartReplacesItsTask() async throws {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard RecentPhotosPolicy.canRead(permission) else {
      throw XCTSkip("Permit the public Simulator Photos library to verify pick refresh ordering.")
    }
    var asset: PHAsset?
    PHAsset.fetchAssets(with: .image, options: nil).enumerateObjects { candidate, _, stop in
      if !candidate.isHidden, !candidate.mediaSubtypes.contains(.photoScreenshot) {
        asset = candidate
        stop.pointee = true
      }
    }
    let photo = RecentPhoto(asset: try XCTUnwrap(asset))
    let now = try XCTUnwrap(photo.capturedAt)
    let initialGate = PickPreviewGate(), successorGate = PickPreviewGate()
    let initialStarted = expectation(description: "Initial preview is suspended")
    let successorStarted = expectation(description: "Successor preview is suspended")
    let waiterStarted = expectation(description: "Caller is waiting for the initial analysis")
    let returnedWhileBlocked = expectation(description: "Caller cannot finish before the successor preview")
    returnedWhileBlocked.isInverted = true
    var reads = 0, successorReleased = false
    let analyzer = PhotoPickAnalyzer(preview: { _ in
      reads += 1
      if reads == 1 { initialStarted.fulfill(); await initialGate.wait() }
      else { successorStarted.fulfill(); await successorGate.wait() }
      return self.signal
    })
    let store = RecentPhotosStore(authorization: { permission }, readPhotos: { _ in [photo] }, picks: analyzer)
    defer { store.pauseAnalysis(); initialGate.open(); successorGate.open() }
    store.restoreAccess(now: now)
    PHPhotoLibrary.shared().unregisterChangeObserver(store)
    let waiting = Task {
      waiterStarted.fulfill()
      defer { if !successorReleased { returnedWhileBlocked.fulfill() } }
      return try await store.completedPicks()
    }
    await fulfillment(of: [initialStarted, waiterStarted], timeout: 1)
    store.restartAnalysis()
    initialGate.open()
    await fulfillment(of: [successorStarted], timeout: 1)
    await fulfillment(of: [returnedWhileBlocked], timeout: 0.05)
    successorReleased = true
    successorGate.open()
    let result = try await waiting.value
    XCTAssertEqual(reads, 2)
    XCTAssertEqual(result.recommendations.ids, [photo.id])
    XCTAssertEqual(result.recommendations.unassessed, 0)
  }
  func testUnchangedRefreshKeepsInFlightPickAnalysis() async throws {
    let permission = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard RecentPhotosPolicy.canRead(permission) else {
      throw XCTSkip("Permit the public Simulator Photos library to verify in-flight picks.")
    }
    var asset: PHAsset?
    PHAsset.fetchAssets(with: .image, options: nil).enumerateObjects { candidate, _, stop in
      if !candidate.isHidden, !candidate.mediaSubtypes.contains(.photoScreenshot) {
        asset = candidate; stop.pointee = true
      }
    }
    let photo = RecentPhoto(asset: try XCTUnwrap(asset))
    let now = try XCTUnwrap(photo.capturedAt), gate = PickPreviewGate()
    let started = expectation(description: "Current pick preview held")
    var reads = 0
    let analyzer = PhotoPickAnalyzer(preview: { _ in
      reads += 1
      if reads == 1 { started.fulfill(); await gate.wait() }
      return self.signal
    })
    let store = RecentPhotosStore(authorization: { permission }, readPhotos: { _ in [photo] }, picks: analyzer)
    defer { store.pauseAnalysis(); gate.open() }
    store.restoreAccess(now: now)
    PHPhotoLibrary.shared().unregisterChangeObserver(store)
    await fulfillment(of: [started], timeout: 1)
    store.restoreAccess(now: now)
    store.refresh(now: now)
    store.setBrowseDates(.all, now: now)
    gate.open()
    let result = try await store.completedPicks()
    XCTAssertEqual(reads, 1, "Unchanged metadata and date-scope refreshes keep the held preview")
    XCTAssertEqual(result.recommendations.ids, [photo.id])
    XCTAssertEqual(result.recommendations.unassessed, 0)
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

  func testFindReviewRecomputesQualityWithinMatchesAndLeavesRecentPicksAlone() async throws {
    var sources = (0..<20).map { candidate("photo-\($0)") }
    for index in sources.indices { sources[index].capturedAt = nil }
    sources[19].favorite = true
    for index in 0..<19 { sources[index].favorite = false }
    var recentReads = 0
    let recent = PhotoPickAnalyzer(preview: { _ in recentReads += 1; return self.signal }, isCurrent: { _ in true })
    let recentResult = try await recent.snapshot(sources)
    XCTAssertTrue(recentResult.recommendations.ids.contains("photo-19"))
    let matches = Array(sources[5..<8])
    let review = FindBestShotsReview()
    review.start(matches, matchCount: matches.count, preview: { _ in self.signal }, isCurrent: { _ in true })
    await review.completedReview()
    XCTAssertEqual(review.snapshot?.recommendations.ids, ["photo-5"])
    XCTAssertEqual(review.snapshot?.recommendations.groupCount, 3)
    XCTAssertEqual(review.snapshot?.recommendations.reasons["photo-5"], ["Moment highlight"])
    XCTAssertEqual(review.snapshot?.candidates.map(\.id), matches.map(\.id))
    XCTAssertEqual(AutomaticPhotoPickPolicy.processor, "moment-highlights-v3")
    let unchanged = try await recent.snapshot(sources)
    XCTAssertEqual(unchanged.recommendations.ids, recentResult.recommendations.ids)
    XCTAssertEqual(recentReads, 20, "A Find review must not prune or replace the home Picks cache")
  }

  func testFindReviewUsesSimilarityOnlyInsideTheMoment() async throws {
    let date = Date(timeIntervalSince1970: 1_780_315_200)
    var soft = candidate("soft")
    var clear = candidate("clear")
    soft.capturedAt = date; clear.capturedAt = date.addingTimeInterval(20)
    soft.favorite = false; clear.favorite = false
    let review = FindBestShotsReview()
    review.start([soft, clear], matchCount: 2, preview: { source in
      var value = self.signal
      value.sharpness = source.id == "soft" ? 0.01 : 0.4
      return value
    }, isCurrent: { _ in true })
    await review.completedReview()
    XCTAssertEqual(review.snapshot?.recommendations.ids, ["clear"])
    XCTAssertEqual(review.snapshot?.recommendations.duplicateCount, 1)
    XCTAssertEqual(review.snapshot?.recommendations.reasons["clear"],
      ["Moment highlight", "Representative of 2 similar photos"])
  }

  func testFindReviewSelectionRequiresCompletedCurrentRecommendedSources() async {
    let gate = PickPreviewGate()
    let review = FindBestShotsReview()
    defer { review.showAll(); gate.open() }
    let firstPreview = expectation(description: "First recommendation preview is suspended")
    let completed = expectation(description: "Both recommendation previews finish")
    var sources = [candidate("device:a"), candidate("saved:b")]
    for index in sources.indices { sources[index].capturedAt = Date(timeIntervalSince1970: 1_780_315_200) }
    var currentRevisions = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0.sourceRevision) })
    var accountCurrent = true
    var currentSourceChecks: [[String]] = []
    review.start(sources, matchCount: 2, preview: { source in
      if source.id == "device:a" {
        firstPreview.fulfill()
        await gate.wait()
      }
      var signal = self.signal
      signal.hash = source.id == "device:a" ? 0 : UInt64.max
      return signal
    }, isCurrent: { candidates in
      currentSourceChecks.append(candidates.map(\.id))
      return candidates.allSatisfy { currentRevisions[$0.id] == $0.sourceRevision }
    }, valid: { accountCurrent })
    await fulfillment(of: [firstPreview], timeout: 1)
    guard gate.entered else { XCTFail("The first preview did not reach its gate"); return }
    XCTAssertTrue(review.selectionCandidates().isEmpty, "Reviewing must never select unfinished suggestions")
    gate.open()
    Task { await review.completedReview(); completed.fulfill() }
    await fulfillment(of: [completed], timeout: 1)
    currentSourceChecks = []
    XCTAssertEqual(review.snapshot?.recommendations.groupCount, 2, "Distinct perceptual fixtures must remain two recommendations")
    XCTAssertEqual(review.selectionCandidates().map(\.id), sources.map(\.id))
    XCTAssertEqual(currentSourceChecks, [["device:a", "saved:b"]], "Current suggestions should require one source fetch")
    currentRevisions["device:a"] = "2"
    XCTAssertEqual(review.selectionCandidates().map(\.id), ["saved:b"], "An edited source cannot be added from an old review")
    currentRevisions.removeValue(forKey: "saved:b")
    XCTAssertTrue(review.selectionCandidates().isEmpty, "Withdrawn sources cannot be selected")
    currentRevisions = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0.sourceRevision) })
    accountCurrent = false
    XCTAssertTrue(review.selectionCandidates().isEmpty, "Changing the review or account invalidates the shortlist")
    accountCurrent = true
    review.showAll()
    XCTAssertTrue(review.selectionCandidates().isEmpty)
  }

  func testFindReviewBoundsWorkAndUnavailableSavedPreviewsDoNotBecomeSuggestions() async {
    var reads: [String] = []
    let review = FindBestShotsReview()
    let matches = (0..<250).map { candidate("saved:\($0)") }
    review.start(matches, matchCount: matches.count, preview: { source in
      reads.append(source.id)
      return nil
    }, isCurrent: { _ in true })
    await review.completedReview()
    XCTAssertEqual(reads, matches.prefix(200).map(\.id))
    XCTAssertEqual(review.matchCount, 250)
    XCTAssertEqual(review.snapshot?.recommendations.unassessed, 200)
    XCTAssertTrue(review.snapshot?.recommendations.ids.isEmpty == true)
    review.showAll()
    XCTAssertNil(review.snapshot)
    XCTAssertFalse(review.showing)
  }

  func testFindReviewRevokesLateResultsForChangedSearchOrSourceAuthorization() async {
    for changedSearch in [false, true] {
      var searchCurrent = true
      var sourceCurrent = true
      let gate = PickPreviewGate()
      let review = FindBestShotsReview()
      review.start([candidate("a")], matchCount: 1, preview: { _ in
        await gate.wait(); return self.signal
      }, isCurrent: { _ in sourceCurrent }, valid: { searchCurrent })
      while !gate.entered { await Task.yield() }
      if changedSearch { searchCurrent = false } else { sourceCurrent = false }
      gate.open()
      await review.completedReview()
      XCTAssertNil(review.snapshot)
      XCTAssertFalse(review.showing)
      XCTAssertFalse(review.reviewing)
      XCTAssertNil(review.error)
    }
  }

  func testAllMatchesCancelsReviewAndLateResultCannotClearSuccessor() async {
    let gate = PickPreviewGate()
    let review = FindBestShotsReview()
    review.start([candidate("old")], matchCount: 1, preview: { _ in
      await gate.wait(); return self.signal
    }, isCurrent: { _ in true })
    while !gate.entered { await Task.yield() }
    review.showAll()
    review.start([candidate("new")], matchCount: 1, preview: { _ in self.signal }, isCurrent: { _ in true })
    await review.completedReview()
    gate.open()
    for _ in 0..<10 { await Task.yield() }
    XCTAssertEqual(review.snapshot?.recommendations.ids, ["new"])
    XCTAssertTrue(review.showing)
    XCTAssertFalse(review.reviewing)
  }

  func testLatePreparationCannotReplaceACompletedSuccessor() async {
    for cancelled in [false, true] {
      let review = FindBestShotsReview()
      let gate = PickPreviewGate()
      var requestCurrent = true
      let preparation = Task {
        await gate.wait()
        review.start([candidate("old")], matchCount: 1, preview: { _ in self.signal },
          isCurrent: { _ in true }, valid: { requestCurrent })
      }
      while !gate.entered { await Task.yield() }
      if cancelled { preparation.cancel() } else { requestCurrent = false }
      review.start([candidate("new")], matchCount: 1, preview: { _ in self.signal }, isCurrent: { _ in true })
      await review.completedReview()
      gate.open()
      await preparation.value
      XCTAssertEqual(review.snapshot?.recommendations.ids, ["new"])
      XCTAssertTrue(review.showing)
      XCTAssertFalse(review.reviewing)
    }
  }

  func testSavedPreviewReviewRejectsOutsidePathsAndReplacedCachedBytes() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let media = root.appendingPathComponent("Media")
    try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
    let fixture = try XCTUnwrap(Bundle(for: type(of: self)).url(forResource: "neutral-a", withExtension: "png"))
    let url = media.appendingPathComponent("cached-preview.png")
    let image = try XCTUnwrap(UIImage(contentsOfFile: fixture.path))
    let preview = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { _ in
      image.draw(in: CGRect(x: 0, y: 0, width: 64, height: 64))
    }
    try XCTUnwrap(preview.jpegData(compressionQuality: 0.8)).write(to: url)
    let source = try XCTUnwrap(FindBestShotsCachedPreview(url: url, root: root))
    XCTAssertTrue(source.isCurrent)
    let measured = try await source.signals()
    XCTAssertNotNil(measured)
    XCTAssertNil(FindBestShotsCachedPreview(url: fixture, root: root))
    let link = media.appendingPathComponent("linked-preview.jpg")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: url)
    XCTAssertNil(FindBestShotsCachedPreview(url: link, root: root))
    let alias = root.appendingPathComponent("root-alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: root)
    XCTAssertNotNil(FindBestShotsCachedPreview(url: alias.appendingPathComponent("Media/cached-preview.png"), root: alias))
    try FileManager.default.removeItem(at: url)
    try Data([0]).write(to: url)
    XCTAssertFalse(source.isCurrent)
    do { _ = try await source.signals(); XCTFail("A replaced preview must revoke its source snapshot") }
    catch { XCTAssertTrue(error is CancellationError) }
  }
}

@MainActor private final class PickPreviewGate {
  var entered = false
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async { entered = true; await withCheckedContinuation { continuation = $0 } }
  func open() { continuation?.resume(); continuation = nil }
}
