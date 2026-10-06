import Foundation
import CoreImage
import ImageIO
import Photos
import UIKit
import XCTest
@testable import Fotoro

final class PhotoPeopleTests: XCTestCase {
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
    let face = try XCTUnwrap(group.faces.first)
    _ = try index.splitPeopleFace(face.id,reject:true)
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
