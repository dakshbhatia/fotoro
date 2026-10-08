import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import frozenAnnotationSchema from "./fixtures/pre-location-annotations.schema.json";
import {validateWire} from "../packages/contracts/src/validate";
import {annotationCaptureMetadata, CAPTURE_METADATA_PREFIX as prefix, captureMetadataRows, captureMetadataSearchText, isCaptureMetadataFact, validatedCaptureMetadataItem} from "../packages/contracts/src/capture-metadata";
const hash = "A".repeat(43), source = prefix + "source:" + hash;
const fact = (k: string, p: string, v: string) => prefix + "item:" + JSON.stringify({k, p, v});
const annotation = (facts: string[]) => ({version: 1, photoId: "a1672cf8-cc9b-44a5-9992-5508a40b36bc", originalSha256: hash, facts});
// Native Wire.encode sorts the three item keys and writes values as strings.
const nativeFacts = [source,
  'fotoro.capture.v1:item:{"k":"width","p":"photos","v":"4032"}',
  'fotoro.capture.v1:item:{"k":"height","p":"photos","v":"3024"}',
  'fotoro.capture.v1:item:{"k":"subtypes","p":"photos","v":"hdr,livePhoto"}',
  'fotoro.capture.v1:item:{"k":"cameraModel","p":"original","v":"Public Camera"}',
  'fotoro.capture.v1:item:{"k":"exposureSeconds","p":"original","v":"0.125"}',
];
test("native capture vectors stay in frozen old annotation wire and retain user and other reserved facts", () => {
  const value = annotation(["My exact words", "fotoro:person:v1:opaque", "fotoro.location.v1:opaque", ...nativeFacts]);
  const before = structuredClone(value), ajv = new Ajv(); addFormats(ajv);
  assert.equal(ajv.compile(frozenAnnotationSchema)(value), true);
  assert.equal(validateWire("PhotoAnnotationsV1", value), value);
  const result = annotationCaptureMetadata(value, hash)!;
  assert.equal(result.items.length, 5);
  assert.equal(result.items[3].v, "Public Camera");
  assert.deepEqual(value, before);
  const sharedVector = [source, 'fotoro.capture.v1:item:{"k":"cameraModel","p":"original","v":"iPhone 18 Pro"}'];
  assert.equal(annotationCaptureMetadata({facts: sharedVector}, hash)?.items[0].v, "iPhone 18 Pro");
  assert.throws(() => validateWire("PhotoAnnotationsV1", {...value, captureMetadata: result}));
  const unicode = annotation([source, fact("cameraModel", "original", "📷".repeat(80))]);
  assert.equal(ajv.compile(frozenAnnotationSchema)(unicode), true);
  assert.equal(annotationCaptureMetadata(unicode, hash)?.items[0].v, "📷".repeat(80));
});
test("capture evidence rejects absent, wrong or duplicate source and repeated provenance fields", () => {
  for (const facts of [[nativeFacts[1]], [source], [source, source, nativeFacts[1]],
    [source, nativeFacts[1], nativeFacts[1]], [source, prefix + "extra:{}"],
    [source, fact("cameraModel", "photos", "Camera")], [source, fact("gpsLatitude", "original", "0")],
    [source, fact("peopleCount", "photos", "4")], [source, prefix + "item:{"],
    [source, prefix + 'item:{"k":"width","p":"photos","v":4032}'],
    [source, prefix + 'item:{"k":"width","p":"photos","v":"4032","extra":"x"}'],
    [source, prefix + String.raw`item:{"k":"width","\u006b":"height","v":"4032"}`]]) {
    assert.equal(annotationCaptureMetadata({facts}, hash), undefined);
  }
  assert.equal(annotationCaptureMetadata({facts: nativeFacts}, "B".repeat(43)), undefined);
  assert.equal(annotationCaptureMetadata({facts: [prefix + "source:" + "B".repeat(43), nativeFacts[1]]}, "B".repeat(43)), undefined);
  const legacy = "ab".repeat(32);
  assert.equal(annotationCaptureMetadata({facts: [prefix + "source:" + legacy, nativeFacts[1]]}, legacy)?.originalSha256, legacy);
  assert.equal(annotationCaptureMetadata({...annotation(nativeFacts), originalSha256: "B".repeat(43)}, hash), undefined);
  assert.equal(annotationCaptureMetadata({facts: [...Array(60).fill("user"), ...nativeFacts]}, hash), undefined);
  assert.equal(annotationCaptureMetadata({facts: [source, "x".repeat(241), nativeFacts[1]]}, hash), undefined);
  assert.equal(annotationCaptureMetadata({facts: [source, fact("width", "photos", "100"), fact("width", "original", "200")]}, hash)?.items.length, 2);
  const quoted = 'Camera "k": label';
  assert.equal(annotationCaptureMetadata({facts: [source, fact("cameraModel", "original", quoted)]}, hash)?.items[0].v, quoted);
});
test("capture value validation enforces provenance, calendar dates, numeric bounds and sorted enum lists", () => {
  const good = [
    ["createdAt", "photos", "2026-10-07T12:34:56.789Z"], ["addedAt", "photos", "2026-10-07T12:34:56.000Z"],
    ["duration", "photos", "0"], ["subtypes", "photos", "hdr,livePhoto"], ["sourceTypes", "photos", "cloudShared,userLibrary"],
    ["burstSelection", "photos", "autoPick,userPick"], ["hasAdjustments", "photos", "false"],
    ["width", "original", "1000000"], ["contentType", "original", "public.heic"], ["iso", "original", "10000000"],
    ["aperture", "original", "128"], ["exposureSeconds", "original", "0.001"], ["focalLength", "original", "100000"],
    ["orientation", "original", "8"], ["originalDateTime", "original", "2024:02:29 23:59:59"], ["offsetTimeOriginal", "original", "-23:59"],
  ];
  for (const [k, p, v] of good) assert.ok(validatedCaptureMetadataItem({k, p, v}), [k, p, v].join(" "));
  const bad = [
    ["width", "photos", "0"], ["width", "photos", "1000001"], ["width", "photos", "1.5"], ["duration", "photos", "1e3"],
    ["duration", "photos", "Infinity"], ["duration", "photos", "1000000001"], ["subtypes", "photos", "livePhoto,hdr"],
    ["subtypes", "photos", "hdr,hdr"], ["subtypes", "photos", "unknown"], ["burst", "photos", "1"],
    ["createdAt", "photos", "2026-02-30T00:00:00.000Z"], ["createdAt", "photos", "2026-10-07T12:34:56Z"],
    ["createdAt", "original", "2026-10-07T12:34:56.000Z"], ["cameraModel", "original", " camera "],
    ["cameraMake", "original", "x".repeat(121)], ["lensModel", "original", "bad\nline"], ["iso", "original", "0"],
    ["aperture", "original", "0"], ["exposureSeconds", "original", "86401"], ["orientation", "original", "9"],
    ["originalDateTime", "original", "2026:02:29 00:00:00"], ["offsetTimeOriginal", "original", "+24:00"],
    ["toString", "photos", "bad"], ["width", "photos", "0".repeat(121) + "1"], ["cameraModel", "original", "Camera\u0085Name"],
  ];
  for (const [k, p, v] of bad) assert.equal(validatedCaptureMetadataItem({k, p, v}), undefined, [k, p, v].join(" "));
});
test("capture formatter exposes clean units and provenances without creating GPS or People evidence", () => {
  const result = annotationCaptureMetadata({facts: nativeFacts}, hash)!;
  assert.deepEqual(captureMetadataRows(result).map(row => [row.label, row.value, row.provenance]), [
    ["Width", "4032 px", "photos"], ["Height", "3024 px", "photos"], ["Media features", "HDR, Live Photo", "photos"],
    ["Camera", "Public Camera", "original"], ["Exposure", "0.125 s", "original"],
  ]);
  assert.deepEqual(captureMetadataSearchText({facts: nativeFacts}, hash), ["HDR", "Live Photo", "Public Camera"]);
  const dated = annotationCaptureMetadata({facts: [source, fact("createdAt", "photos", "2026-10-07T12:34:56.000Z"), fact("contentType", "original", "public.heic"), fact("originalDateTime", "original", "2026:10:07 12:34:56")]}, hash)!;
  assert.deepEqual(captureMetadataRows(dated).map(row => row.value), ["2026-10-07 12:34:56.000 UTC", "HEIC", "2026:10:07 12:34:56"]);
  assert.deepEqual(captureMetadataSearchText({facts: nativeFacts}, "B".repeat(43)), []);
  assert.ok(isCaptureMetadataFact("fotoro.capture.v2:opaque"));
  assert.equal(isCaptureMetadataFact("My note about fotoro.capture.v1: stays mine"), false);
  assert.equal(annotationCaptureMetadata({facts: ["fotoro.capture.v2:opaque"]}, hash), undefined);
});
