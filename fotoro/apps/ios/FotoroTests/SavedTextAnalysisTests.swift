import XCTest
@testable import Fotoro

final class SavedTextAnalysisTests: XCTestCase {
  @MainActor func testAdmissionAndRecognitionAreBoundedTo25WithoutScanningTheCatalog() async {
    let analysis = SavedTextAnalysis<Int>()
    var requested: [Int] = [], recognized: [Int] = [], saved: [Int] = []
    analysis.start(current: { true }, load: { cursor, limit in
      requested.append(limit)
      return SavedTextPage(sources: Array(0..<30), nextCursor: "25", hasMore: true)
    }, state: { _ in .missing }, recognize: { source in
      recognized.append(source); return SavedTextRecognition(text: "fixture", confidence: 0.9)
    }, commit: { source, _ in saved.append(source); return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(requested, [25]); XCTAssertEqual(recognized, Array(0..<25))
    XCTAssertEqual(saved, Array(0..<25)); XCTAssertEqual(analysis.checked, 25)
    XCTAssertTrue(analysis.hasMore); XCTAssertEqual(analysis.phase, .finished)
  }
  @MainActor func testCompletedEmptyOCRAndUnavailablePreviewsDoNotRunRecognition() async {
    let analysis = SavedTextAnalysis<Int>()
    var recognized: [Int] = []
    analysis.start(current: { true }, load: { _, _ in .init(sources: [0, 1, 2], nextCursor: "2", hasMore: false) },
      state: { $0 == 0 ? .checked : $0 == 1 ? .unavailable : .missing }, recognize: {
        recognized.append($0); return .init(text: "", confidence: 0)
      }, commit: { _, value in XCTAssertEqual(value.text, ""); return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(recognized, [2]); XCTAssertEqual(analysis.existing, 1)
    XCTAssertEqual(analysis.unavailable, 1); XCTAssertEqual(analysis.checked, 1)
    XCTAssertEqual(analysis.processed, 3)
  }
  @MainActor func testWithdrawalDuringRecognitionRejectsLateResultAndRemainingSources() async {
    let analysis = SavedTextAnalysis<Int>()
    var current = true, commits = 0, recognitionCalls = 0
    analysis.start(current: { current }, load: { _, _ in .init(sources: [0, 1], nextCursor: "1", hasMore: false) },
      state: { _ in .missing }, recognize: { _ in
        recognitionCalls += 1; current = false; return .init(text: "fixture", confidence: 1)
      }, commit: { _, _ in commits += 1; return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(commits, 0); XCTAssertEqual(analysis.checked, 0)
    XCTAssertEqual(recognitionCalls, 1); XCTAssertEqual(analysis.phase, .stopped)
  }
  @MainActor func testConcurrentOCRIsPreservedAndCurrentSuppliedEditsAreUsedAtCommit() async {
    let analysis = SavedTextAnalysis<Int>()
    var completed = false, caption = "before", durableCaption = "", commits = 0
    analysis.start(current: { true }, load: { _, _ in .init(sources: [0, 1], nextCursor: "1", hasMore: false) },
      state: { source in source == 0 && completed ? .checked : .missing }, recognize: { source in
        if source == 0 { completed = true }
        caption = "edited during recognition"
        return .init(text: "fixture", confidence: 1)
      }, commit: { _, _ in commits += 1; durableCaption = caption; return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(commits, 1); XCTAssertEqual(durableCaption, "edited during recognition")
    XCTAssertEqual(analysis.existing, 1); XCTAssertEqual(analysis.checked, 1)
  }
  @MainActor func testStopRejectsLateWorkAndRetainsCompletedProgressUntilExplicitRetry() async {
    let analysis = SavedTextAnalysis<Int>()
    var commits: [Int] = []
    let page: SavedTextAnalysis<Int>.Load = { _, _ in .init(sources: [0, 1, 2], nextCursor: "2", hasMore: false) }
    analysis.start(current: { true }, load: page, state: { _ in .missing }, recognize: { source in
      if source == 1 { analysis.stop() }
      return .init(text: "fixture", confidence: 1)
    }, commit: { source, _ in commits.append(source); return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(commits, [0]); XCTAssertEqual(analysis.checked, 1); XCTAssertEqual(analysis.phase, .stopped)
    analysis.start(current: { true }, load: page, state: { commits.contains($0) ? .checked : .missing },
      recognize: { _ in .init(text: "fixture", confidence: 1) },
      commit: { source, _ in commits.append(source); return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(commits, [0, 1, 2]); XCTAssertEqual(analysis.checked, 2); XCTAssertEqual(analysis.existing, 1)
  }
  @MainActor func testFailureIsVisibleRetryUsesSamePageAndNextUsesBoundedContinuation() async {
    let analysis = SavedTextAnalysis<Int>()
    var cursors: [String?] = [], fail = true
    let load: SavedTextAnalysis<Int>.Load = { cursor, _ in
      cursors.append(cursor); return .init(sources: [0], nextCursor: "next", hasMore: true)
    }
    let recognize: SavedTextAnalysis<Int>.Recognize = { _ in
      if fail { throw URLError(.cannotDecodeContentData) }; return .init(text: "fixture", confidence: 1)
    }
    analysis.start(current: { true }, load: load, state: { _ in .missing }, recognize: recognize, commit: { _, _ in true })
    await analysis.waitUntilSettled(); XCTAssertEqual(analysis.failed, 1)
    fail = false
    analysis.start(current: { true }, load: load, state: { _ in .missing }, recognize: recognize, commit: { _, _ in true })
    await analysis.waitUntilSettled(); XCTAssertEqual(analysis.checked, 1)
    analysis.start(nextBatch: true, current: { true }, load: load, state: { _ in .missing }, recognize: recognize, commit: { _, _ in true })
    await analysis.waitUntilSettled(); XCTAssertEqual(cursors, [nil, nil, "next"])
  }
  @MainActor func testChangedOriginalStopsBeforeRecognitionOrCommit() async {
    let analysis = SavedTextAnalysis<Int>()
    var calls = 0
    analysis.start(current: { true }, load: { _, _ in .init(sources: [0, 1], nextCursor: "1", hasMore: false) },
      state: { _ in throw CancellationError() }, recognize: { _ in
        calls += 1; return .init(text: "fixture", confidence: 1)
      }, commit: { _, _ in XCTFail("Withdrawn original committed"); return true })
    await analysis.waitUntilSettled()
    XCTAssertEqual(calls, 0); XCTAssertEqual(analysis.phase, .stopped)
  }
  @MainActor func testResetDrainsCancelledRecognitionBeforeAllowingAnotherExplicitBatch() async {
    let analysis = SavedTextAnalysis<Int>()
    var calls = 0
    let entered = expectation(description: "Recognition held")
    var release: CheckedContinuation<Void, Never>?
    let load: SavedTextAnalysis<Int>.Load = { _, _ in .init(sources: [0], nextCursor: nil, hasMore: false) }
    analysis.start(current: { true }, load: load, state: { _ in .missing }, recognize: { _ in
      calls += 1
      await withCheckedContinuation { release = $0; entered.fulfill() }
      return .init(text: "fixture", confidence: 1)
    }, commit: { _, _ in XCTFail("Reset work committed"); return true })
    await fulfillment(of: [entered], timeout: 3)
    analysis.reset()
    analysis.start(current: { true }, load: load, state: { _ in .missing }, recognize: { _ in
      XCTFail("Recognition overlapped cancelled work"); return .init(text: "fixture", confidence: 1)
    }, commit: { _, _ in true })
    release?.resume(); await analysis.waitUntilSettled()
    XCTAssertEqual(calls, 1); XCTAssertFalse(analysis.running)
    XCTAssertEqual(analysis.phase, .idle); XCTAssertEqual(analysis.checked, 0)
  }

  @MainActor func testUnreadablePageIsAVisibleFailureWithoutInventingAPhotoAttempt() async {
    let analysis = SavedTextAnalysis<Int>()
    analysis.start(current: { true }, load: { _, _ in throw URLError(.cannotDecodeContentData) },
      state: { _ in XCTFail("Unread page reached state check"); return .missing }, recognize: { _ in
        XCTFail("Unread page reached recognition"); return .init(text: "fixture", confidence: 1)
      }, commit: { _, _ in XCTFail("Unread page committed"); return true })
    await analysis.waitUntilSettled()
    XCTAssertTrue(analysis.pageFailed); XCTAssertEqual(analysis.processed, 0)
    XCTAssertEqual(analysis.failed, 0); XCTAssertFalse(analysis.running)
  }

  func testProductionDraftBuilderPreservesOwnerEditsAndExactFrozenRetryPayload() throws {
    let frozen = SignedPayloadV1(kind: "photo-annotations", accountId: "fixture-owner", body: "frozen-body", signature: "frozen-signature")
    let oldDraft = WrappedKeyV1(nonce: "old-nonce", ciphertext: "old-draft")
    let base = WrappedKeyV1(nonce: "base-nonce", ciphertext: "base-draft")
    let state = AnnotationState(accountId: "fixture-owner", photoId: "fixture-photo", originalSha256: "fixture-digest",
      revision: 8, accepted: frozen, draft: oldDraft, editId: "frozen-edit", pending: frozen,
      pendingEditId: "frozen-edit", base: base)
    let current = PhotoAnnotationsV1(photoId: "fixture-photo", originalSha256: "fixture-digest", labels: ["fixture label"],
      caption: "current owner caption", keywords: ["fixture keyword"], facts: ["fixture fact"], favorite: true)
    let result = try XCTUnwrap(SavedTextAnnotationDraft.fillingMissingOCR(.init(text: "fixture text", confidence: 0.9),
      current: current, state: state, editId: "new-edit", wrap: { value in
        WrappedKeyV1(nonce: "fixture-nonce", ciphertext: try JSONEncoder().encode(value).base64EncodedString())
      }))
    var expected = current
    expected.ocr = .init(text: "fixture text", confidence: 0.9, processor: "vision-text-v1")
    XCTAssertEqual(result.value, expected)
    XCTAssertEqual(result.state.pending, frozen); XCTAssertEqual(result.state.pendingEditId, "frozen-edit")
    XCTAssertEqual(result.state.accepted, frozen); XCTAssertEqual(result.state.revision, 8)
    XCTAssertEqual(result.state.base, base); XCTAssertEqual(result.state.editId, "new-edit")
    let bytes = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(result.state.draft).ciphertext))
    XCTAssertEqual(try JSONDecoder().decode(PhotoAnnotationsV1.self, from: bytes), expected)
    XCTAssertEqual(state.draft, oldDraft); XCTAssertEqual(current.ocr, nil)
  }
  func testProductionDraftBuilderNeverReplacesConcurrentOCRIncludingEmptyCompletion() throws {
    for text in ["", "concurrent fixture text"] {
      var current = PhotoAnnotationsV1(photoId: "fixture-photo", originalSha256: "fixture-digest")
      current.ocr = .init(text: text, confidence: 0, processor: "other-known-check")
      let state = AnnotationState(accountId: "fixture-owner", photoId: current.photoId, originalSha256: current.originalSha256)
      let result = try SavedTextAnnotationDraft.fillingMissingOCR(.init(text: "late fixture text", confidence: 1),
        current: current, state: state, editId: "late-edit", wrap: { _ in
          XCTFail("Existing OCR must not be encrypted or replaced"); return .init(nonce: "", ciphertext: "")
        })
      XCTAssertNil(result)
      XCTAssertEqual(current.ocr?.text, text); XCTAssertNil(state.draft)
    }
  }
  func testProductionDraftBuilderSeedsBaselineAndDoesNotMutateStateWhenWrappingFails() throws {
    let state = AnnotationState(accountId: "fixture-owner", photoId: "fixture-photo", originalSha256: "fixture-digest")
    let current = PhotoAnnotationsV1(photoId: state.photoId, originalSha256: state.originalSha256, labels: ["owner"])
    let built = try XCTUnwrap(SavedTextAnnotationDraft.fillingMissingOCR(.init(text: "", confidence: 0),
      current: current, state: state, editId: "new-edit", wrap: { value in
        .init(nonce: "fixture", ciphertext: value.ocr == nil ? "baseline" : "checked-empty")
      }))
    XCTAssertEqual(built.state.base?.ciphertext, "baseline")
    XCTAssertEqual(built.state.draft?.ciphertext, "checked-empty")
    XCTAssertThrowsError(try SavedTextAnnotationDraft.fillingMissingOCR(.init(text: "fixture", confidence: 1),
      current: current, state: state, editId: "failed-edit", wrap: { _ in throw URLError(.cannotDecodeContentData) }))
    XCTAssertNil(state.draft); XCTAssertNil(state.base); XCTAssertNil(state.editId)
  }

  func testProductionPreviewOCRMediaPolicyAdmitsStillImagesAndLivePhotoButRejectsMotionAndUnknownTypes() {
    for mediaType in ["image/jpeg", "image/png", "image/heic", "application/vnd.fotoro.live-photo"] {
      XCTAssertTrue(SavedTextMedia.permitsPreviewOCR(mediaType), mediaType)
    }
    for mediaType in ["video/mp4", "video/quicktime", "video/future", "image/future", "image/heif",
      "application/octet-stream", "application/vnd.fotoro.future", "", "IMAGE/JPEG"] {
      XCTAssertFalse(SavedTextMedia.permitsPreviewOCR(mediaType), mediaType)
    }
  }

}
