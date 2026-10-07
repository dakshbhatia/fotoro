import ImageIO
import XCTest
@testable import Fotoro

final class SemanticSearchTests: XCTestCase {
  private func vector(_ dimension: Int, value: Float = 1) -> [Float] {
    var result = [Float](repeating: 0, count: 512); result[dimension] = value; return result
  }
  @MainActor func testConsumerResultsUsesSemanticExecutorAndRejectsItsCancelledLateResult() async throws {
    let index = try SearchIndex()
    let record = SearchRecord(id: "permitted-scene")
    let queryVector = vector(0)
    try index.replacePermitted([record])
    try index.applySemantic(queryVector, photoID: record.id, revision: record.revision)
    let probe = ConsumerSemanticExecutorProbe()
    let store = LocalSearchStore(index: index, queryExecutor: { index, query, scope, accepted, previous, generation in
      await probe.record(query)
      if query == "delayed scene" { await probe.suspend() }
      let lexical = try index.search(query, scope: scope, acceptedMeaningID: accepted, previous: previous, generation: generation)
      return try index.addingSemantic(queryVector, to: lexical)
    })
    let hits = try await store.consumerResults("birthday cake")
    XCTAssertEqual(hits.map(\.id), [record.id], "Consumer Photos search must reuse semantic ranking, rather than rerun only lexical search")
    XCTAssertEqual(hits.first?.reason, "Visual similarity")
    let firstCalls = await probe.calls
    XCTAssertEqual(firstCalls, ["birthday cake"])
    let delayed = Task { try await store.consumerResults("delayed scene") }
    for _ in 0..<200 {
      if await probe.isSuspended { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    let suspended = await probe.isSuspended
    XCTAssertTrue(suspended, "The consumer query must reach the injected executor")
    delayed.cancel()
    await probe.resume()
    do { _ = try await delayed.value; XCTFail("A cancelled semantic query must not publish a late hit") }
    catch is CancellationError {} catch { XCTFail("Unexpected cancellation error: \(error)") }
  }
  func testTokenizerMatchesCLIPAndBoundsLongUnicodeQueries() throws {
    let tokenizer = try CLIPTokenizer()
    XCTAssertEqual(Array(try tokenizer.encode("a photo of a dog").prefix(7)), [49406, 320, 1125, 539, 320, 1929, 49407])
    let long = try tokenizer.encode(String(repeating: "birthday 🎂 café dog ", count: 1000))
    XCTAssertEqual(long.count, 77)
    XCTAssertEqual(long.first, 49406); XCTAssertEqual(long.last, 49407)
    XCTAssertTrue(long.allSatisfy { (0..<49408).contains($0) })
    XCTAssertEqual(try tokenizer.encode(" DOG  "), try tokenizer.encode("dog"))
  }
  func testVectorsPersistOnlyForTheExactPermittedSourceRevision() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    var record = SearchRecord(id: "scene")
    record.revision = "original-v1"
    let index = try SearchIndex(root: root)
    try index.setWorkGeneration(10)
    XCTAssertTrue(try index.replacePermitted([record], generation: 10))
    XCTAssertFalse(try index.applySemantic(vector(0), photoID: record.id, revision: "old", generation: 10))
    XCTAssertFalse(try index.applySemantic(vector(0), photoID: record.id, revision: record.revision, generation: 9))
    XCTAssertTrue(try index.applySemantic(vector(0, value: 3), photoID: record.id, revision: record.revision, generation: 10))
    XCTAssertTrue(try SearchIndex(root: root).pendingSemanticRecords().isEmpty)
    var base = try index.search("birthday cake")
    base = try index.addingSemantic(vector(0), to: base)
    XCTAssertEqual(base.results.map(\.id), [record.id])
    XCTAssertEqual(base.results.first?.reason, "Visual similarity")
    record.revision = "edited-v2"
    try index.replacePermitted([record])
    XCTAssertEqual(try index.pendingSemanticRecords().map(\.id), [record.id])
    XCTAssertTrue(try index.addingSemantic(vector(0), to: index.search("cake")).results.isEmpty)
    try index.replacePermitted([])
    XCTAssertTrue(try index.pendingSemanticRecords().isEmpty)
  }
  func testSemanticResultsKeepDateScopeAndExplicitEvidenceAheadOfSimilarity() throws {
    let index = try SearchIndex()
    let date = try XCTUnwrap(Wire.parseDate("2026-10-01T12:00:00Z"))
    var exact = SearchRecord(id: "label"); exact.labels = ["cake"]; exact.capturedAt = date
    var visual = SearchRecord(id: "visual"); visual.capturedAt = date
    var older = SearchRecord(id: "older"); older.capturedAt = date.addingTimeInterval(-86400 * 40)
    try index.replacePermitted([exact, visual, older])
    for record in [exact, visual, older] { try index.applySemantic(vector(0), photoID: record.id, revision: record.revision) }
    let result = try index.addingSemantic(vector(0), to: index.search("cake on 2026-10-01"))
    XCTAssertEqual(result.results.map(\.id), ["label", "visual"])
    XCTAssertFalse(result.results.contains { $0.id == "older" })
    XCTAssertNil(SemanticVector.normalized(Array(repeating: .nan, count: 512)))
    XCTAssertNil(SemanticVector.values(Data(repeating: 0, count: 8)))
  }
  func testPinnedCoreMLModelRecognizesPublicFireworksFixture() async throws {
    let processor = PhotoSemanticProcessor.shared
    try await processor.prepare()
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "semantic-fireworks", withExtension: "jpg"))
    let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
    let image = try XCTUnwrap(CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 512,
      kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary))
    let embedded = try await processor.image(SearchPreview(image: image))
    let fireworksVector = try await processor.textIfReady("fireworks over a city at night")
    let dogVector = try await processor.textIfReady("a dog on a beach")
    let cakeVector = try await processor.textIfReady("birthday cake")
    let fireworks = try XCTUnwrap(fireworksVector)
    let dog = try XCTUnwrap(dogVector)
    let cake = try XCTUnwrap(cakeVector)
    XCTAssertEqual(embedded.count, 512)
    let correct = SemanticVector.similarity(embedded, fireworks)
    XCTAssertGreaterThanOrEqual(correct, 0.20)
    XCTAssertGreaterThan(correct, SemanticVector.similarity(embedded, dog))
    XCTAssertGreaterThan(correct, SemanticVector.similarity(embedded, cake))
  }
}

private actor ConsumerSemanticExecutorProbe {
  private(set) var calls: [String] = []
  private var pending: CheckedContinuation<Void, Never>?
  private var released = false
  var isSuspended: Bool { pending != nil }
  func record(_ query: String) { calls.append(query) }
  func suspend() async {
    if released { return }
    await withCheckedContinuation { pending = $0 }
  }
  func resume() { released = true; pending?.resume(); pending = nil }
}
