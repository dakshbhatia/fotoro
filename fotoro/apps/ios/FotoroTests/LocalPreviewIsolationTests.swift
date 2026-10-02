import Foundation
import GRDB
import XCTest

@testable import Fotoro

final class LocalPreviewIsolationTests: XCTestCase {
  @MainActor func testDefaultStoreNamespaceDoesNotImportFullAccountRecordsOrHistory() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fullRoot = directory.appendingPathComponent("FotoroLocalSearch")
    let full = try SearchIndex(root: fullRoot)
    var privateRecord = SearchRecord(id: "same-permitted-photo", revision: "current")
    privateRecord.labels = ["Account overlay only"]
    privateRecord.syncedAccountId = "existing-full-account"
    privateRecord.beforeSync = LocalSearchFields(labels: ["Local baseline"], captions: [], keywords: [], facts: [], favorite: false, ocrText: "", ocrConfidence: 0, ocrStatus: .pending)
    try full.put(privateRecord)
    let now = Date()
    let privateMeaning = try XCTUnwrap(full.search("account overlay").meaning)
    try full.pinRepresentative(privateMeaning.id, photoID: privateRecord.id)
    try full.confirmUse(privateMeaning.id, photoID: privateRecord.id, sessionID: "full-only", now: now)

    let store = LocalSearchStore(applicationSupportDirectory: directory)
    #if FOTORO_LOCAL_PREVIEW
      let preview = try SearchIndex(root: store.root)
      XCTAssertNil(try preview.record(privateRecord.id), "Preview must not open the full index or account overlay")
      XCTAssertTrue(try preview.search("account overlay").results.isEmpty)
      XCTAssertEqual(try preview.database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchPins") }, 0)
      XCTAssertEqual(try preview.historyCount(kind: "use", meaningID: privateMeaning.id, photoID: privateRecord.id, now: now), 0)
      var local = SearchRecord(id: privateRecord.id, revision: "current")
      local.labels = ["Preview local label"]
      try preview.put(local)
      XCTAssertEqual(try preview.record(local.id)?.labels, ["Preview local label"])
      XCTAssertNil(try preview.record(local.id)?.syncedAccountId)
      XCTAssertEqual(try full.record(privateRecord.id)?.labels, ["Account overlay only"], "Preview edits cannot alter the full index")
      XCTAssertEqual(try full.database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchPins") }, 1)
      XCTAssertEqual(try full.historyCount(kind: "use", meaningID: privateMeaning.id, photoID: privateRecord.id, now: now), 1)
    #else
      let reopened = try SearchIndex(root: store.root)
      XCTAssertEqual(store.root.standardizedFileURL.path, fullRoot.standardizedFileURL.path)
      XCTAssertEqual(try reopened.record(privateRecord.id)?.labels, ["Account overlay only"], "Full target retains its existing namespace")
      XCTAssertEqual(try reopened.database.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM searchPins") }, 1)
      XCTAssertEqual(try reopened.historyCount(kind: "use", meaningID: privateMeaning.id, photoID: privateRecord.id, now: now), 1)
    #endif
  }
}
