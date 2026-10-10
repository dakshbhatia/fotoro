import Foundation
import CoreImage
import ImageIO
import Photos
import UIKit
import XCTest
@testable import Fotoro

final class PhotoPeopleTests: XCTestCase {
  func testPeopleSearchChoicesMergeSameUUIDWithoutMergingSameNamesOrSuggestedFaces() {
    let shared = Wire.id(), other = Wire.id(), suggested = Wire.id()
    let face = PhotoPeopleFace(id: Wire.id(), photoID: "local", revision: "current", groupID: shared,
      box: [0,0,100,100], vector: [], confirmed: true)
    var unconfirmed = face; unconfirmed.groupID = suggested; unconfirmed.confirmed = false
    let local = [PhotoPeopleGroup(id: shared.uppercased(), name: "Current name", faces: [face]),
      PhotoPeopleGroup(id: suggested, name: "Suggested", faces: [unconfirmed])]
    let choices = PhotoPeopleSearchChoice.merged(local: local, saved: [
      PhotoPeopleSearchChoice(id: shared, name: "Previous name"), PhotoPeopleSearchChoice(id: other, name: "Current name")])
    XCTAssertEqual(Set(choices.map(\.id)), [shared, other])
    XCTAssertEqual(choices.map(\.name), ["Current name", "Current name"])
    XCTAssertTrue(PhotoPeopleSearchChoice.canFind(PeopleSearchSelection(personIDs: [shared.uppercased(), other]), choices: choices))
    XCTAssertFalse(PhotoPeopleSearchChoice.canFind(PeopleSearchSelection(personIDs: [suggested]), choices: choices))
    XCTAssertFalse(PhotoPeopleSearchChoice.canFind(PeopleSearchSelection(), choices: choices))
  }
  func testFaceCountDistinguishesNotAnalyzedZeroAndChangedSources() throws {
    let index = try SearchIndex()
    let record = SearchRecord(id: "photo", revision: "current")
    try index.replacePermitted([record]); try index.setWorkGeneration(1); try index.setPeopleEnabled(true)
    XCTAssertNil(try index.detectedFaceCount(photoID: record.id, revision: record.revision))
    XCTAssertTrue(try index.applyPeople([], photoID: record.id, revision: record.revision, generation: 1))
    XCTAssertEqual(try index.detectedFaceCount(photoID: record.id, revision: record.revision), 0)
    XCTAssertTrue(try index.applyPeople([PhotoFaceEmbedding(box: [0,0,100,100], vector: vector())],
      photoID: record.id, revision: record.revision, generation: 1))
    XCTAssertEqual(try index.detectedFaceCount(photoID: record.id, revision: record.revision), 1)
    try index.put(SearchRecord(id: record.id, revision: "edited"))
    XCTAssertNil(try index.detectedFaceCount(photoID: record.id, revision: record.revision))
    XCTAssertNil(try index.detectedFaceCount(photoID: record.id, revision: "edited"))
    try index.setPeopleEnabled(false)
    XCTAssertNil(try index.detectedFaceCount(photoID: record.id, revision: "edited"))
  }
  func testPeopleMetadataIntakeDefaultsToThirtyDaysFiltersBeforeInferenceAndCanTargetOlderDates() throws {
    let index = try SearchIndex(), now = Date(timeIntervalSince1970: 1_800_000_000)
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let cutoff = RecentPhotosPolicy.cutoff(now: now, calendar: calendar)
    func record(_ id: String, date: Date?, name: String = "Singapore-trip.jpg") -> SearchRecord {
      var value = SearchRecord(id: id); value.capturedAt = date; value.filename = name; return value
    }
    var ocrOnly = record("ocr-only", date: now, name: "IMG.jpg"); ocrOnly.ocrStatus = .complete; ocrOnly.ocrText = "Singapore"
    var inferredOnly = record("inferred-only", date: now, name: "IMG.jpg"); inferredOnly.visualStatus = .complete
    inferredOnly.visualLabels = SearchVisualPolicy.labels([("beach", 0.99)])
    let older = record("older", date: cutoff.addingTimeInterval(-86400))
    var foreign = record("saved", date: now); foreign.scope = "saved"
    try index.replacePermitted([record("boundary", date: cutoff), record("recent", date: now), older,
      record("undated", date: nil), record("future", date: now.addingTimeInterval(1)), ocrOnly, inferredOnly])
    try index.put(foreign)
    let scope = PhotoPeopleScanScope(query: "Singapore", now: now, calendar: calendar)
    XCTAssertEqual(Set(try index.pendingPeopleRecords(scope: scope).map(\.id)), ["boundary", "recent"])
    XCTAssertTrue(try index.pendingPeopleRecords(scope: PhotoPeopleScanScope(query: "beach", now: now, calendar: calendar)).isEmpty,
      "Inference-only search evidence must not cause a broad scan before metadata matches")
    let expanded = PhotoPeopleScanScope(query: "Singapore", includesOlder: true, now: now, calendar: calendar)
    XCTAssertEqual(Set(try index.pendingPeopleRecords(scope: expanded).map(\.id)), ["boundary", "recent", "older", "undated"])
    let year = calendar.component(.year, from: older.capturedAt!)
    let month = calendar.component(.month, from: older.capturedAt!)
    let dated = PhotoPeopleScanScope(query: "Singapore \(year)-\(String(format: "%02d", month))", now: now, calendar: calendar)
    XCTAssertNotNil(dated.scope.from)
    XCTAssertTrue(try index.pendingPeopleRecords(scope: dated).contains { $0.id == "older" })
    try index.setPeopleEnabled(true); try index.setWorkGeneration(1)
    XCTAssertTrue(try index.applyPeople([], photoID: "recent", revision: "1", generation: 1))
    XCTAssertEqual(try index.pendingPeopleRecords(scope: scope).map(\.id), ["boundary"], "Completed scans are reused")
    var changed = record("recent", date: now); changed.revision = "changed"; try index.put(changed)
    XCTAssertEqual(Set(try index.pendingPeopleRecords(scope: scope).map(\.id)), ["boundary", "recent"], "Changed sources must be scanned again within the same scope")
  }
  func testPeopleMetadataIntakeDoesNotCapEligiblePhotosOrRescanReviewedOlderGroups() throws {
    let index = try SearchIndex(), now = Date()
    var records = (0..<601).map { i in
      var r = SearchRecord(id: "match-\(i)"); r.capturedAt = now; r.facts = ["Singapore"]; return r
    }
    var old = SearchRecord(id: "reviewed-old"); old.capturedAt = now.addingTimeInterval(-90 * 86400); records.append(old)
    try index.replacePermitted(records); try index.setWorkGeneration(1); try index.setPeopleEnabled(true)
    XCTAssertTrue(try index.applyPeople([PhotoFaceEmbedding(box: [0,0,100,100], vector: vector())], photoID: old.id, revision: "1", generation: 1))
    let group = try XCTUnwrap(index.peopleGroups().first)
    _ = try index.namePeopleGroup(group.id, name: "Family")
    XCTAssertEqual(try index.pendingPeopleRecords(scope: PhotoPeopleScanScope(query: "Singapore", now: now)).count, 601)
    let scope = PhotoPeopleScanScope(query: "Singapore", now: now)
    XCTAssertEqual(try index.pendingPeopleCount(scope: scope), 601)
    let first = try index.pendingPeopleRecords(scope: scope, limit: 500)
    XCTAssertEqual(first.count, 500)
    let cursor = PhotoAnalysisCursor(try XCTUnwrap(first.last))
    XCTAssertEqual(try index.pendingPeopleCount(scope: scope, after: cursor), 101)
    let next = try index.pendingPeopleRecords(scope: scope, after: cursor, limit: 500)
    XCTAssertEqual(next.count, 101)
    XCTAssertTrue(Set(first.map(\.id)).isDisjoint(with: Set(next.map(\.id))))
    let unavailable = try XCTUnwrap(first.first)
    let completed = first[1]
    XCTAssertTrue(try index.applyPeople([], photoID: completed.id, revision: completed.revision, generation: 1))
    XCTAssertEqual(try index.pendingPeopleCount(scope: scope, after: PhotoAnalysisCursor(try XCTUnwrap(next.last))), 0,
      "No unattempted photos beyond the cursor does not mean all previews succeeded")
    let retry = try index.pendingPeopleRecords(scope: scope, limit: 500)
    XCTAssertTrue(retry.contains { $0.id == unavailable.id }, "Unavailable previews are not committed as completed scans")
    XCTAssertFalse(retry.contains { $0.id == completed.id }, "A retry reuses completed zero-face scans")
    XCTAssertEqual(try index.peopleGroups().first?.name, "Family")
    XCTAssertEqual(try index.search("", scope: SearchScope(people: PeopleSearchSelection(personIDs: [group.id]))).results.map(\.id), [old.id])
  }
  private func familyRecord(_ id: String, people: [String], names: [String]? = nil, date: Date? = nil) throws -> SearchRecord {
    var record = SearchRecord(id: id)
    record.capturedAt = date; record.labels = ["beach"]; record.ocrStatus = .complete
    record.facts = try PhotoPeopleFacts.replacing([], with: people.enumerated().map { offset, person in
      PhotoPersonAssignment(p: person, n: names?[offset] ?? "Family", b: [offset*1000,0,100,100])
    })
    return record
  }
  func testFamilyAnyEveryoneUsesReviewedIDsPerPhotoWithTextDatesAndClear() throws {
    let a = UUID().uuidString.lowercased(), b = UUID().uuidString.lowercased()
    let index = try SearchIndex(), now = Date(), old = now.addingTimeInterval(-90*86400)
    var labelOnly = SearchRecord(id: "label-only"); labelOnly.labels = ["Family", "beach"]
    try index.replacePermitted([
      familyRecord("a", people: [a], names: ["Same name"], date: now),
      familyRecord("b", people: [b], names: ["Same name"], date: now),
      familyRecord("together", people: [a,b], names: ["Same name", "Same name"], date: old), labelOnly,
    ])
    let any = PeopleSearchSelection(personIDs: [a,b])
    let everyone = PeopleSearchSelection(personIDs: [a,b], match: .everyone)
    XCTAssertEqual(Set(try index.search("", scope: SearchScope(people: any)).results.map(\.id)), ["a","b","together"])
    XCTAssertEqual(try index.search("beach", scope: SearchScope(people: everyone)).results.map(\.id), ["together"])
    XCTAssertEqual(try index.search("beach", scope: SearchScope(from: old.addingTimeInterval(-1), until: now.addingTimeInterval(-1), people: any)).results.map(\.id), ["together"])
    XCTAssertTrue(try index.search("forest", scope: SearchScope(people: everyone)).results.isEmpty)
    XCTAssertTrue(try index.search("beach", scope: SearchScope(from: now.addingTimeInterval(-1), people: everyone)).results.isEmpty,
      "Everyone is same-photo membership, never the union of separate trip photos")
    XCTAssertEqual(Set(try index.search("beach", scope: SearchScope()).results.map(\.id)), ["a","b","together","label-only"])
    XCTAssertTrue(try index.search("", scope: SearchScope(people: PeopleSearchSelection(personIDs: ["invalid"]))).results.isEmpty)
  }
  func testFamilyEligibilityPrecedesDateAndSemanticLimitsAndRejectsWrongSavedSource() throws {
    let person = UUID().uuidString.lowercased(), now = Date(), index = try SearchIndex()
    var records = (0..<250).map { number in
      var record = SearchRecord(id: "new-\(number)"); record.capturedAt = now; return record
    }
    records.append(try familyRecord("older-family", people: [person], date: now.addingTimeInterval(-365*86400)))
    try index.replacePermitted(records)
    let scope = SearchScope(people: PeopleSearchSelection(personIDs: [person]))
    XCTAssertEqual(try index.search("", scope: scope).results.map(\.id), ["older-family"])
    var vector = [Float](repeating: 0, count: 512); vector[0] = 1
    for record in records { try index.applySemantic(vector, photoID: record.id, revision: record.revision) }
    XCTAssertEqual(try index.addingSemantic(vector, to: index.search("coast", scope: scope)).results.map(\.id), ["older-family"])
    let digest = String(repeating: "a", count: 43), wrong = String(repeating: "b", count: 43)
    var saved = try familyRecord("saved", people: [person]); saved.scope = "saved"; saved.revision = digest
    saved.facts = try PhotoPeopleFacts.replacing([], with: PhotoPeopleFacts.read(saved.facts), originalSha256: wrong)
    try index.put(saved)
    XCTAssertTrue(try index.search("", scope: SearchScope(source: "saved", people: scope.people)).results.isEmpty)
    saved.facts = try PhotoPeopleFacts.replacing([], with: PhotoPeopleFacts.read(saved.facts), originalSha256: digest)
    try index.put(saved)
    XCTAssertEqual(try index.search("", scope: SearchScope(source: "saved", people: scope.people)).results.map(\.id), ["saved"])
  }
  func testFamilyResultsRespectTentativeFacesCorrectionsAndSourceRevisionWithdrawal() throws {
    let index = try SearchIndex(); try index.setWorkGeneration(1)
    try index.replacePermitted([SearchRecord(id: "first"), SearchRecord(id: "suggested")])
    try index.setPeopleEnabled(true)
    let face = PhotoFaceEmbedding(box: [0,0,100,100], vector: vector())
    try index.applyPeople([face], photoID: "first", revision: "1", generation: 1)
    let person = try XCTUnwrap(index.peopleGroups().first)
    _ = try index.namePeopleGroup(person.id, name: "Family")
    try index.applyPeople([face], photoID: "suggested", revision: "1", generation: 1)
    let scope = SearchScope(people: PeopleSearchSelection(personIDs: [person.id]))
    XCTAssertEqual(try index.search("", scope: scope).results.map(\.id), ["first"])
    _ = try index.splitPeopleFace(try XCTUnwrap(person.faces.first).id, reject: true)
    XCTAssertTrue(try index.search("", scope: scope).results.isEmpty)
    try index.replacePermitted([SearchRecord(id: "first", revision: "changed")], generation: 1)
    XCTAssertTrue(try index.search("", scope: scope).results.isEmpty)
  }
  func testSelectFilteredResultsReturnsOnlyCurrentEligibleReferences() {
    let hits = [ConsumerSearchHit(photo: .device("current-family")), ConsumerSearchHit(photo: .saved("current-trip"))]
    XCTAssertEqual(ConsumerSearchBinding.selectionForResults(hits), [.device("current-family"), .saved("current-trip")])
    XCTAssertEqual(ConsumerSearchBinding.selectionForResults(hits, reviewedIDs: ["saved:current-trip"]), [.saved("current-trip")])
  }
  private func vector(_ offset: Int = 0) -> [Float] {
    var result = [Float](repeating: 0, count: 128); result[offset] = 1; return result
  }
  func testPeopleFactsRequireExactSourceBoundsCapacityAndKeepUserFacts() throws {
    let digest = String(repeating: "a", count: 43), other = String(repeating: "b", count: 43)
    let person = PhotoPersonAssignment(p: UUID().uuidString, n: "  Exact name  ", b: [100,100,2000,2000])
    let facts = try PhotoPeopleFacts.replacing(["my exact fact"], with: [person], originalSha256: digest)
    XCTAssertEqual(PhotoPeopleFacts.read(facts, originalSha256: digest), [person])
    XCTAssertTrue(PhotoPeopleFacts.read(facts, originalSha256: other).isEmpty)
    XCTAssertTrue(PhotoPeopleFacts.read(facts.filter { !$0.hasPrefix(PhotoPeopleFacts.sourcePrefix) }, originalSha256: digest).isEmpty)
    XCTAssertEqual(try PhotoPeopleFacts.replacing(facts, with: []), ["my exact fact"])
    var invalid = person; invalid.b = [9900,0,500,100]
    XCTAssertThrowsError(try PhotoPeopleFacts.replacing([], with: [invalid]))
    invalid = person; invalid.n = String(repeating: "😀", count: 81)
    XCTAssertThrowsError(try PhotoPeopleFacts.replacing([], with: [invalid]))
    XCTAssertThrowsError(try PhotoPeopleFacts.replacing(Array(repeating: "fact", count: 64), with: [person]))
    XCTAssertTrue(PhotoPeopleFacts.read(facts + [facts[1]], originalSha256: digest).isEmpty)
    let duplicate = PhotoPeopleFacts.personPrefix + "{\"p\":\""+person.p+"\",\"n\":\"first\",\"n\":\"second\",\"b\":[0,0,1,1]}"
    XCTAssertTrue(PhotoPeopleFacts.read([PhotoPeopleFacts.sourcePrefix+digest, duplicate], originalSha256: digest).isEmpty)
  }
  func testFivePointAlignmentAndVectorValidation() throws {
    let original = PhotoFaceAlignment.target.map { CGPoint(x: $0.x*2+10, y: $0.y*2+15) }
    let transform = try XCTUnwrap(PhotoFaceAlignment.transform(original))
    for (a,b) in zip(original,PhotoFaceAlignment.target) {
      let actual = a.applying(transform)
      XCTAssertEqual(actual.x,b.x,accuracy:0.001); XCTAssertEqual(actual.y,b.y,accuracy:0.001)
    }
    XCTAssertNil(PhotoFaceAlignment.transform(Array(repeating: .zero,count:5)))
    XCTAssertNil(PhotoFaceVector.normalized(Array(repeating: .nan,count:128)))
    XCTAssertNil(PhotoFaceVector.normalized(Array(repeating: 0,count:128)))
    XCTAssertEqual(PhotoFaceVector.similarity(vector(),vector()),1,accuracy:0.00001)
    XCTAssertEqual(PhotoFaceVector.similarity(vector(),vector(1)),0,accuracy:0.00001)
  }
  func testLocalOptInMatchingCorrectionsAndNamedSearchShareOneIndex() throws {
    let index = try SearchIndex()
    try index.setWorkGeneration(1)
    try index.put(SearchRecord(id: "one")); try index.put(SearchRecord(id: "two")); try index.put(SearchRecord(id: "three"))
    XCTAssertFalse(try index.peopleEnabled())
    let face = PhotoFaceEmbedding(box:[100,100,1000,1000],vector:vector())
    XCTAssertFalse(try index.applyPeople([face],photoID:"one",revision:"1",generation:1))
    try index.setPeopleEnabled(true)
    XCTAssertTrue(try index.applyPeople([face],photoID:"one",revision:"1",generation:1))
    XCTAssertTrue(try index.applyPeople([face],photoID:"two",revision:"1",generation:1))
    var groups = try index.peopleGroups(); XCTAssertEqual(groups.count,1)
    XCTAssertEqual(groups[0].faces.count,2); XCTAssertEqual(groups[0].confirmedCount,0)
    XCTAssertTrue(try index.search("Alice").results.isEmpty)
    _ = try index.namePeopleGroup(groups[0].id,name:"Alice")
    XCTAssertEqual(Set(try index.search("Alice").results.map(\.id)),["one","two"])
    XCTAssertTrue(try index.applyPeople([face],photoID:"three",revision:"1",generation:1))
    XCTAssertFalse(try index.search("Alice").results.map(\.id).contains("three"),"New inferred arrivals cannot inherit confirmed identity")
    groups = try index.peopleGroups()
    _ = try index.splitPeopleFace(try XCTUnwrap(groups[0].faces.first { $0.photoID == "two" }).id)
    groups = try index.peopleGroups(); XCTAssertEqual(groups.count,2)
    XCTAssertFalse(try index.search("Alice").results.map(\.id).contains("two"))
    let split = try XCTUnwrap(groups.first { $0.name == nil })
    _ = try index.namePeopleGroup(split.id,name:"Bob")
    XCTAssertEqual(try index.search("Bob").results.first?.id,"two")
    _ = try index.mergePeopleGroups(split.id,into:try XCTUnwrap(groups.first { $0.name == "Alice" }).id)
    XCTAssertTrue(try index.search("Bob").results.isEmpty)
    groups = try index.peopleGroups()
    _ = try index.splitPeopleFace(try XCTUnwrap(groups[0].faces.first { $0.photoID == "one" }).id,reject:true)
    XCTAssertTrue(try index.search("Alice").results.isEmpty)
    _ = try index.erasePeople()
    XCTAssertTrue(try index.peopleGroups().isEmpty); XCTAssertFalse(try index.peopleEnabled())
  }
  func testPeopleRevisionPermissionGenerationAndRestartFences() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at:root) }
    let index = try SearchIndex(root:root)
    try index.setWorkGeneration(10); try index.put(SearchRecord(id:"photo")); try index.setPeopleEnabled(true)
    let face = PhotoFaceEmbedding(box:[0,0,1000,1000],vector:vector())
    XCTAssertFalse(try index.applyPeople([face],photoID:"photo",revision:"old",generation:10))
    XCTAssertFalse(try index.applyPeople([face],photoID:"photo",revision:"1",generation:9))
    XCTAssertTrue(try index.applyPeople([face],photoID:"photo",revision:"1",generation:10))
    let group = try XCTUnwrap(index.peopleGroups().first)
    _ = try index.namePeopleGroup(group.id,name:"Exact Name")
    let reopened = try SearchIndex(root:root)
    XCTAssertTrue(try reopened.peopleEnabled()); XCTAssertEqual(try reopened.peopleGroups().first?.name,"Exact Name")
    XCTAssertTrue(try index.replacePermitted([SearchRecord(id:"photo",revision:"changed")],generation:10))
    XCTAssertTrue(try index.peopleGroups().isEmpty); XCTAssertTrue(try index.search("Exact Name").results.isEmpty)
    XCTAssertTrue(try index.replacePermitted([],generation:10))
    XCTAssertFalse(try index.applyPeople([face],photoID:"photo",revision:"changed",generation:10))
    XCTAssertTrue(try index.peopleGroups().isEmpty)
  }
  func testPinnedSFaceRuntimeProducesNormalized128DimensionalTemplate() async throws {
    let vector = try await PhotoFaceProcessor.shared.embeddingForAlignedRGB(Array(repeating:128,count:3*112*112))
    XCTAssertEqual(vector.count,128); XCTAssertTrue(vector.allSatisfy(\.isFinite))
    XCTAssertEqual(vector.reduce(Float(0)) { $0+$1*$1 },1,accuracy:0.0001)
    // This checks runtime/preprocessing compatibility; it establishes no identity accuracy.
  }
  func testPublicPortraitFacePipelinePreservesOrientationAndProducesTentativeGroups() async throws {
    let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "people-public-nasa",withExtension:"jpg"))
    let image = try XCTUnwrap(UIImage(contentsOfFile:url.path)?.cgImage)
    let faces = try await PhotoFaceProcessor.shared.analyze(SearchPreview(image:image))
    XCTAssertEqual(faces.count,1,"The public frontal portrait must exercise actual YuNet + SFace inference")
    let face = try XCTUnwrap(faces.first)
    XCTAssertTrue(face.box[1] < 5000,"The portrait face must be in the top half")
    let rotated = CIImage(cgImage:image).oriented(forExifOrientation:Int32(CGImagePropertyOrientation.left.rawValue))
    let raw = try XCTUnwrap(CIContext().createCGImage(rotated,from:rotated.extent))
    let corrected = try await PhotoFaceProcessor.shared.analyze(SearchPreview(image:raw,orientation:.right))
    XCTAssertEqual(corrected.count,1)
    let other = try XCTUnwrap(corrected.first)
    XCTAssertGreaterThan(PhotoFaceVector.similarity(face.vector,other.vector),0.99,
      "Inverse pixel rotation plus orientation must preserve the aligned crop")
    let index = try SearchIndex(); try index.setWorkGeneration(1); try index.put(SearchRecord(id:"public")); try index.setPeopleEnabled(true)
    XCTAssertTrue(try index.applyPeople(faces,photoID:"public",revision:"1",generation:1))
    XCTAssertEqual(try index.peopleGroups().first?.confirmedCount,0)
  }
  @MainActor func testSimulatorPublicPortraitPhotosPreviewNameAndCorrectFlow() async throws {
    #if targetEnvironment(simulator)
    let status = PHPhotoLibrary.authorizationStatus(for:.readWrite)
    guard RecentPhotosPolicy.canRead(status) else { throw XCTSkip("Public Simulator Photos permission is needed for this flow.") }
    let url = try XCTUnwrap(Bundle(for:Self.self).url(forResource:"people-public-nasa",withExtension:"jpg"))
    let image = try XCTUnwrap(UIImage(contentsOfFile:url.path))
    var id = ""
    try await PHPhotoLibrary.shared().performChanges {
      let request = PHAssetChangeRequest.creationRequestForAsset(from:image)
      request.creationDate = Date(timeIntervalSince1970:1_577_880_000)
      id = request.placeholderForCreatedAsset?.localIdentifier ?? ""
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("People-"+UUID().uuidString)
    let local = LocalSearchStore(root:root)
    defer { local.pause() }
    local.open(status:status)
    for _ in 0..<200 where !local.canEditLabels(id) { try await Task.sleep(for:.milliseconds(50)) }
    let record = try XCTUnwrap(local.record(id)), index = try XCTUnwrap(local.peopleIndex)
    try index.setPeopleEnabled(true)
    let applied = try await local.analyzePeople(record)
    XCTAssertTrue(applied)
    let group = try XCTUnwrap(index.peopleGroups().first { $0.faces.contains { $0.photoID == id } })
    let changed = try index.namePeopleGroup(group.id,name:"Public portrait fixture")
    XCTAssertEqual(changed.first?.id,id)
    XCTAssertEqual(try index.search("Public portrait fixture").results.first?.id,id)
    local.setPeopleSelection(PeopleSearchSelection(personIDs: [group.id]), names: [group.id:"Public portrait fixture"])
    let familyHits = try await local.consumerResults("")
    XCTAssertTrue(familyHits.contains { $0.id == id }, "People-only results must retain a current permitted Photos revision")
    let face = try XCTUnwrap(group.faces.first)
    _ = try index.splitPeopleFace(face.id,reject:true)
    XCTAssertNil(try local.consumerRecord(id), "A corrected face cannot remain an eligible family result while the next query is pending")
    XCTAssertTrue(try index.search("Public portrait fixture").results.isEmpty)
    print("Public People Photos preview, local inference, naming and rejection verified: \(id)")
    #else
    throw XCTSkip("Public fixture injection is Simulator-only.")
    #endif
  }

  func testMaximumFactsLocationHydrationKeepsExpandedSearchOverlayAndExactSource() throws {
    let index = try SearchIndex()
    try index.put(SearchRecord(id:"photo"))
    let digest = String(repeating:"a",count:43)
    var annotation = PhotoAnnotationsV1(photoId:UUID().uuidString,originalSha256:digest)
    let user = (0..<62).map { "Exact fact \($0)" }
    annotation.facts = user
    try annotation.setLocation(PhotoLocationV1(latitude:10,longitude:20,source:"photos",name:"Exact place"))
    XCTAssertEqual(annotation.facts?.count,64)
    XCTAssertTrue(try index.applyAnnotations(annotation,photoID:"photo",revision:"1",accountId:UUID().uuidString))
    XCTAssertEqual(try index.record("photo")?.facts.count,65)
    XCTAssertEqual(Array((try index.record("photo")?.facts ?? []).prefix(62)),user)
    XCTAssertEqual(annotation.facts?.count,64,"Search overlays cannot rewrite the encrypted source facts")
  }

}
