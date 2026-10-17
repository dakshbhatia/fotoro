import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

// This qualifies production pure naming/area policies and the view's collision
// loop. It does not exercise SwiftUI, annotations, geocoding or device gestures.
if (process.platform !== "darwin") throw new Error("Photo context host tests require macOS and Xcode.");
const read = path => readFileSync(new URL(`../apps/ios/Fotoro/Library/${path}`, import.meta.url), "utf8");
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Production context declaration boundary changed: ${start}`);
  return source.slice(a, b);
};
const policy = read("PhotoLocations.swift");
const validName = between(policy, "  static func validName(", "  static func name(");
const suggestedName = between(policy, "  static func suggestedName(", "\nenum PhotoOrganizationError:");
const location = between(policy, "struct PhotoLocationV1:", "  var coordinates:") + "}\n";
const areaName = between(read("PhotoPlacesView.swift"), "  static func keepingAreaName(", "  static func ordered(");
const collision = between(read("PhotoMetadataSections.swift"), "        let ext = (proposed as NSString).pathExtension", "        entries.append(Entry(photo:");
const batchSource = read("PhotoMetadataSections.swift");
const reservationSelection = between(batchSource, "    let selected = excludedIDs ??", ", revision = services.consumerCatalogGeneration");
const reservationFilter = between(batchSource, "      for photo in page where ", " {\n        reserved.insert").trim().replace("for photo in page where ", "");
if (!batchSource.includes("reservedNames(excluding: Set(entries.map(\\.id)))")) throw new Error("Undo must reserve photos outside its actual mutation plan.");
const root = mkdtempSync(join(tmpdir(), "fotoro-photo-context-host-"));
try {
  const source = join(root, "main.swift"), binary = join(root, "photo-context-host");
  writeFileSync(source, `import Foundation
// Analysis is already qualified upstream; this stub supplies optional reviewed
// text/scene to the actual production filename composition method.
struct PhotoNameAnalysis { var text: String?; var scene: String? }
${location}
enum PhotoOrganizationFacts {
${validName}
${suggestedName}
enum PhotoOrganizationError: Error { case invalid }
enum PhotoPlacesPolicy {
${areaName}
}
func key(_ value: String) -> String { value.precomposedStringWithCanonicalMapping.lowercased() }
func collisionName(_ proposed: String, used: inout Set<String>) throws -> String {
${collision}
return name
}
struct ReservationPhoto { let id: String }
struct ReservationPresentation { let photos: [ReservationPhoto] }
func reserves(_ photo: ReservationPhoto, presentation: ReservationPresentation, excludedIDs: Set<String>?) -> Bool {
${reservationSelection}
return ${reservationFilter}
}
var checks = 0
@MainActor func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
  checks += 1
  guard condition() else { fatalError(message) }
}
let reservationPresentation = ReservationPresentation(photos: [ReservationPhoto(id: "completed"), ReservationPhoto(id: "no-op"), ReservationPhoto(id: "unapplied")])
expect(reserves(ReservationPhoto(id: "no-op"), presentation: reservationPresentation, excludedIDs: ["completed"]), "Undo must reserve selected no-op photo names")
expect(reserves(ReservationPhoto(id: "unapplied"), presentation: reservationPresentation, excludedIDs: ["completed"]), "Undo must reserve selected unapplied photo names")
expect(!reserves(ReservationPhoto(id: "completed"), presentation: reservationPresentation, excludedIDs: ["completed"]), "Undo retains reviewed duplicates within its mutation plan")
expect(!reserves(ReservationPhoto(id: "no-op"), presentation: reservationPresentation, excludedIDs: nil), "Preview still excludes its whole selected plan")
let digest = String(repeating: "ab", count: 32)
func name(_ date: Date? = nil, _ labels: [String] = [], _ analysis: PhotoNameAnalysis? = nil) -> String {
  PhotoOrganizationFacts.suggestedName(original: "Singapore Holiday.JPG", digest: digest, capturedAt: date,
    labels: labels, place: nil, screenshot: false, analysis: analysis)
}
expect(name() == "Singapore Holiday.JPG", "No evidence must retain exact original")
expect(name(nil, ["", "!!!"]) == "Singapore Holiday.JPG", "Empty context must not manufacture a name")
expect(name(Date(timeIntervalSince1970: .infinity)) == "Singapore Holiday.JPG", "Invalid date is not evidence")
expect(name(Date(timeIntervalSince1970: 0)) == "1970-01-01_ababababab.jpg", "Verified date keeps identity suffix")
expect(name(nil, ["Holiday"]) == "Holiday_ababababab.jpg", "Supplied labels retain suffix")
expect(name(nil, [], PhotoNameAnalysis(text: "Coffee", scene: nil)) == "Coffee_ababababab.jpg", "Current text contributes context")
expect(name(nil, [], PhotoNameAnalysis(text: nil, scene: "dog")) == "dog_ababababab.jpg", "Current scene contributes context")
var reserved: Set<String> = [key("IMG.JPG"), key("IMG_2.JPG")]
let third = try collisionName("IMG.JPG", used: &reserved)
expect(third == "IMG_3.JPG", "Reserved names collide case insensitively")
let fourth = try collisionName("IMG.JPG", used: &reserved)
expect(fourth == "IMG_4.JPG", "Planned names reserve their result")
var unicodeReserved: Set<String> = [key("Café.jpg")]
let unicode = try collisionName("Cafe\u{301}.jpg", used: &unicodeReserved)
expect(unicode.hasSuffix("_2.jpg"), "Canonically equivalent Unicode names collide")
let long = name(nil, [String(repeating: "東京", count: 150)])
var longReserved: Set<String> = [key(long)]
let bounded = try collisionName(long, used: &longReserved)
expect(PhotoOrganizationFacts.validName(bounded), "Collision suffix must retain filesystem bounds")
for provenance in ["photos", "exif", "google-timeline"] {
  let original = PhotoLocationV1(latitude: 40.7, longitude: -74, source: provenance, accuracyMeters: 15)
  let kept = PhotoPlacesPolicy.keepingAreaName("  New York  ", location: original)
  expect(kept?.name == "Near New York", "Area name must remain qualified")
  expect(kept?.latitude == original.latitude && kept?.longitude == original.longitude, "Area name must preserve GPS")
  expect(kept?.source == original.source && kept?.accuracyMeters == original.accuracyMeters, "Area name must preserve source and accuracy")
  expect(PhotoPlacesPolicy.keepingAreaName("Other", location: kept!) == nil, "Reviewed names must not be replaced")
  expect(original.name == nil, "Policy must not mutate original input")
}
let original = PhotoLocationV1(latitude: 40.7, longitude: -74, source: "photos")
for invalid in ["", "   ", "New\\nYork", String(repeating: "x", count: 196)] {
  expect(PhotoPlacesPolicy.keepingAreaName(invalid, location: original) == nil, "Unsafe area name rejected")
}
let invalidGPS = PhotoLocationV1(latitude: .nan, longitude: -74, source: "photos")
expect(PhotoPlacesPolicy.keepingAreaName("New York", location: invalidGPS) == nil, "Area labels cannot repair invalid GPS")
print("\\(checks) production photo context host assertions passed")
`);
  const compiled = spawnSync("xcrun", ["swiftc", "-swift-version", "6", source, "-o", binary], {stdio: "inherit", timeout: 60_000});
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) throw new Error("Photo context host test compilation failed.");
  const result = spawnSync(binary, [], {stdio: "inherit", timeout: 60_000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {rmSync(root, {recursive: true, force: true});}
