import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import frozenAnnotationSchema from "./fixtures/pre-location-annotations.schema.json";
import {validateWire} from "../packages/contracts/src/validate";
import * as locations from "../packages/contracts/src/location";
const location = {latitude: 41.9028, longitude: 12.4964, source: "exif" as const, name: "Rome", accuracyMeters: 10};

test("typed locations use existing encrypted facts accepted by the frozen old annotation reader", () => {
  const original = {version: 1, photoId: "a1672cf8-cc9b-44a5-9992-5508a40b36bc", originalSha256: "A".repeat(43), facts: ["My exact words"]};
  const value = locations.withAnnotationLocation(original, location);
  assert.deepEqual(value.facts, ["My exact words", 'fotoro.location.v1:{"latitude":41.9028,"longitude":12.4964,"source":"exif","accuracyMeters":10}', "fotoro.place.v1:Rome"]);
  assert.deepEqual(locations.annotationLocation(value), location);
  assert.deepEqual(original.facts, ["My exact words"]);
  assert.equal(validateWire("PhotoAnnotationsV1", value), value);
  const ajv = new Ajv(); addFormats(ajv);
  assert.equal(ajv.compile(frozenAnnotationSchema)(value), true);
  assert.equal(Object.hasOwn(value, "location"), false);
});

test("location facts reject corrupt coordinates, extra keys, duplicate markers and ambiguous names", () => {
  const coordinate = 'fotoro.location.v1:{"latitude":41.9028,"longitude":12.4964,"source":"exif"}';
  for (const facts of [[coordinate, coordinate], [coordinate, "fotoro.place.v1:Rome", "fotoro.place.v1:Paris"],
    ["fotoro.location.v1:{"], ["fotoro.place.v1:Rome"], [coordinate, "fotoro.location.v1:{}"],
    [coordinate, "fotoro.place.v1:" + "x".repeat(201)]]) assert.equal(locations.annotationLocation({facts}), undefined);
  for (const bad of [{...location, latitude: 90.1}, {...location, longitude: -180.1}, {...location, latitude: NaN},
    {...location, longitude: Infinity}, {...location, accuracyMeters: -1}, {...location, accuracyMeters: 100001},
    {...location, accuracyMeters: Infinity}, {...location, name: "x".repeat(201)}, {...location, source: "guessed"}, {...location, extra: true}])
    assert.throws(() => locations.withAnnotationLocation({}, bad as any));
  assert.equal(locations.annotationLocation({facts: ['fotoro.location.v1:{"latitude":0,"longitude":0,"source":"exif","name":"untrusted"}']}), undefined);
});

test("escaped duplicate coordinate keys remain valid old-wire facts but never become a typed location", () => {
  const ajv = new Ajv(); addFormats(ajv);
  const oldReader = ajv.compile(frozenAnnotationSchema);
  for (const raw of [
    String.raw`{"latitude":0,"\u006catitude":1,"longitude":0,"source":"exif"}`,
    String.raw`{"latitude":0,"longitude":0,"source":"exif","\u0073ource":"photos"}`,
    String.raw`{"latitude":0,"longitude":0,"source":"exif","accuracyMeters":10,"accuracy\u004deters":20}`,
  ]) {
    const value = {version: 1, photoId: "a1672cf8-cc9b-44a5-9992-5508a40b36bc", originalSha256: "A".repeat(43), facts: ["My exact words", locations.LOCATION_FACT_PREFIX + raw]};
    assert.equal(oldReader(value), true);
    assert.equal(validateWire("PhotoAnnotationsV1", value), value);
    assert.equal(locations.annotationLocation(value), undefined);
    assert.equal(value.facts[0], "My exact words");
  }
  const escaped = String.raw`{"\u006catitude":1,"\u006congitude":2,"\u0073ource":"ex\u0069f"}`;
  assert.deepEqual(locations.annotationLocation({facts: [locations.LOCATION_FACT_PREFIX + escaped]}), {latitude: 1, longitude: 2, source: "exif"});
});

test("location changes and removal preserve supplied facts and reject capacity overflow", () => {
  const userFacts = ["first", "second", "A note about fotoro.location.v1: stays mine", "fotoro.location.v2:future", "FOTORO.place.v1:my text"];
  const original = {favorite: true, facts: [userFacts[0], "fotoro.location.v1:malformed", ...userFacts.slice(1), "fotoro.place.v1:old"]};
  const before = structuredClone(original);
  assert.deepEqual(locations.withAnnotationLocation(original, undefined), {favorite: true, facts: userFacts});
  assert.deepEqual(locations.annotationLocation(locations.withAnnotationLocation(original, {...location, source: "google-timeline"})), {...location, source: "google-timeline"});
  assert.deepEqual(locations.withAnnotationLocation(original, location).facts?.slice(0, userFacts.length), userFacts);
  assert.deepEqual(original, before);
  const full = {facts: Array(63).fill("user fact")}, unchanged = structuredClone(full);
  assert.throws(() => locations.withAnnotationLocation(full, location), /capacity|64/i);
  assert.deepEqual(full, unchanged);
  assert.equal(locations.withAnnotationLocation({facts: Array(62).fill("user fact")}, location).facts?.length, 64);
  for (const source of ["exif", "photos", "google-timeline"] as const) assert.equal(locations.annotationLocation(locations.withAnnotationLocation({}, {...location, source}))?.source, source);
});
