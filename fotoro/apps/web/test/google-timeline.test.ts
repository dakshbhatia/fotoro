import test from "node:test";
import assert from "node:assert/strict";
import {parseGoogleTimeline, parseGoogleTimelineFile, previewGoogleTimeline, MAX_TIMELINE_BYTES, type TimelinePhoto} from "../src/local/google-timeline";

// Synthetic coordinates and dates in the observed export shapes; no personal history.
// Shape references: kurupted/google-maps-timeline-viewer/sample_data/Local_format/iOS,
// hossain-khan/kgeo-device-timeline/lib/src/test/resources/test-data.json, and
// CarlosBergillos/LocationHistoryFormat/schemas/Records.schema.json.
const photo = (id = "missing", date = "2025-07-07T18:00:00Z"): TimelinePhoto =>
  ({id, date, dateSource: "exif", captureVerified: true, captureTimezoneVerified: true});
const iosVisit = (startTime = "2025-07-07T13:30:00-04:00", endTime = "2025-07-07T14:30:00-04:00", placeLocation = "geo:40.75,-73.98") =>
  ({startTime, endTime, visit: {topCandidate: {placeLocation, name: "Synthetic park", probability: "0.95"}, probability: "0.95"}});
const records = (locations: unknown[]) => JSON.stringify({locations});
const point = (timestamp = "2025-07-07T18:00:00Z", latitudeE7 = 407500000, longitudeE7 = -739800000, accuracy: unknown = 20) =>
  ({timestamp, latitudeE7, longitudeE7, accuracy});

test("iOS visits match absolute EXIF clocks as proposals without modifying photos or source bytes", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify([iosVisit()])), original = bytes.slice();
  const sourcePhoto = photo(), before = structuredClone(sourcePhoto);
  const data = await parseGoogleTimelineFile(new Blob([bytes]));
  assert.equal(data.format, "device-ios");
  assert.deepEqual(data.summary, {entryCount: 1, pointCount: 0, visitCount: 1, skippedCount: 0, duplicateCount: 0});
  const preview = previewGoogleTimeline([sourcePhoto], data);
  assert.deepEqual(preview.candidates, [{photoID: "missing", location: {latitude: 40.75, longitude: -73.98, source: "google-timeline", name: "Synthetic park"}, basis: "visit", capturedAt: "2025-07-07T18:00:00.000Z", evidenceStart: "2025-07-07T17:30:00.000Z", evidenceEnd: "2025-07-07T18:30:00.000Z"}]);
  assert.deepEqual(sourcePhoto, before); assert.deepEqual(bytes, original);
});

test("existing GPS and unverified capture clocks cannot receive Timeline suggestions", () => {
  const data = parseGoogleTimeline(JSON.stringify([iosVisit()]));
  const preview = previewGoogleTimeline([
    {...photo("exif"), location: {latitude: 0, longitude: 0, source: "exif"}},
    {...photo("photos"), location: {latitude: 1, longitude: 2, source: "photos"}},
    {...photo("prior"), location: {latitude: 1, longitude: 2, source: "google-timeline"}},
    {...photo("local"), captureTimezoneVerified: undefined},
    {...photo("legacy"), captureVerified: undefined},
    {...photo("imported"), dateSource: "imported"},
    {...photo("unzoned"), date: "2025-07-07T18:00:00"},
    {...photo("photos-no-gps"), dateSource: "photos", captureVerified: undefined, captureTimezoneVerified: undefined},
  ], data);
  assert.deepEqual(preview.candidates.map(candidate => candidate.photoID), ["photos-no-gps"]);
  assert.equal(preview.summary.existingLocationCount, 3);
  assert.equal(preview.summary.unverifiedTimestampCount, 4);
});

test("precise points match within five minutes, never interpolate or invent missing accuracy", () => {
  const data = parseGoogleTimeline(records([
    point("2025-07-07T18:00:00Z"),
    point("2025-07-07T19:00:00Z", 407500000, -739800000, 101),
    {timestamp: "2025-07-07T20:00:00Z", latitudeE7: 407500000, longitudeE7: -739800000},
    point("2025-07-07T21:00:00Z"), point("2025-07-07T22:00:00Z"),
  ]));
  const preview = previewGoogleTimeline([
    photo("edge", "2025-07-07T18:05:00Z"), photo("past-edge", "2025-07-07T18:05:00.001Z"),
    photo("imprecise", "2025-07-07T19:00:00Z"), photo("unknown", "2025-07-07T20:00:00Z"),
    photo("gap", "2025-07-07T21:30:00Z"),
  ], data);
  assert.deepEqual(preview.candidates.map(candidate => candidate.photoID), ["edge"]);
  assert.deepEqual(preview.candidates[0].location, {latitude: 40.75, longitude: -73.98, source: "google-timeline", accuracyMeters: 20});
  assert.equal(preview.summary.unmatchedCount, 4);
});

test("overlapping visits and conflicting accurate points skip ambiguous photos", () => {
  const overlap = parseGoogleTimeline(JSON.stringify([iosVisit(), iosVisit("2025-07-07T17:45:00Z", "2025-07-07T18:15:00Z", "geo:41,-74")]));
  assert.equal(previewGoogleTimeline([photo()], overlap).summary.ambiguousCount, 1);
  const conflict = parseGoogleTimeline(records([point("2025-07-07T17:59:00Z"), point("2025-07-07T18:01:00Z", 410000000, -740000000)]));
  assert.equal(previewGoogleTimeline([photo()], conflict).candidates.length, 0);
  assert.equal(previewGoogleTimeline([photo()], conflict).summary.ambiguousCount, 1);
  const contradiction = parseGoogleTimeline(JSON.stringify({semanticSegments: [{...iosVisit(), visit: {topCandidate: {placeLocation: {latLng: "40.75°, -73.98°"}}}}], rawSignals: [{position: {LatLng: "41°, -74°", timestamp: "2025-07-07T18:00:00Z", accuracyMeters: 10}}]}));
  assert.equal(previewGoogleTimeline([photo()], contradiction).summary.ambiguousCount, 1);
});

test("equivalent timezone offsets and duplicated exports produce deterministic candidates", () => {
  const first = point("2025-07-07T14:00:00-04:00"), duplicate = point("2025-07-07T18:00:00Z");
  const data = parseGoogleTimeline(records([first, duplicate]));
  assert.equal(data.summary.pointCount, 1); assert.equal(data.summary.duplicateCount, 1);
  const forward = previewGoogleTimeline([photo()], data);
  const reverse = previewGoogleTimeline([photo()], parseGoogleTimeline(records([duplicate, first])));
  assert.deepEqual(forward, reverse);
  const visits = parseGoogleTimeline(JSON.stringify([iosVisit(), iosVisit()]));
  assert.equal(visits.summary.duplicateCount, 1);
  assert.equal(previewGoogleTimeline([photo()], visits).candidates.length, 1);
});

test("device semantic segments parse visits, paths and accurate raw positions without semantic labels", () => {
  const data = parseGoogleTimeline(JSON.stringify({semanticSegments: [{
    startTime: "2025-07-07T17:30:00Z", endTime: "2025-07-07T18:30:00Z",
    visit: {topCandidate: {semanticType: "INFERRED_WORK", placeLocation: {latLng: "40.75°, -73.98°"}}},
    timelinePath: [{point: "40.75°, -73.98°", time: "2025-07-07T18:00:00Z"}],
  }], rawSignals: [{position: {LatLng: "40.75°, -73.98°", timestamp: "2025-07-07T18:00:00Z", accuracyMeters: 8}}]}));
  assert.equal(data.format, "device-semantic-segments");
  assert.equal(data.summary.pointCount, 2); assert.equal(data.summary.visitCount, 1);
  assert.equal(data.visits[0].name, undefined);
  assert.equal(previewGoogleTimeline([photo()], data).candidates[0].basis, "visit");
});

test("iOS minute offsets and legacy Takeout visits and timestamps normalize supported versions", () => {
  const ios = parseGoogleTimeline(JSON.stringify([{startTime: "2025-07-07T14:00:00-04:00", endTime: "2025-07-07T14:10:00-04:00", timelinePath: [{point: "geo:40.75,-73.98", durationMinutesOffsetFromStartTime: "5"}]}]));
  assert.equal(ios.points[0].at, "2025-07-07T18:05:00.000Z");
  assert.equal(previewGoogleTimeline([photo("unknown", "2025-07-07T18:05:00Z")], ios).candidates.length, 0);
  const legacy = parseGoogleTimeline(JSON.stringify({timelineObjects: [{placeVisit: {
    location: {latitudeE7: 407500000, longitudeE7: -739800000, name: "Synthetic park"},
    duration: {startTimestamp: "2025-07-07T17:30:00Z", endTimestamp: "2025-07-07T18:30:00Z"},
  }}, {activitySegment: {}}]}));
  assert.equal(legacy.format, "takeout-timeline-objects"); assert.equal(legacy.visits[0].latitude, 40.75);
  assert.equal(previewGoogleTimeline([photo()], legacy).candidates.length, 1);
  const milliseconds = parseGoogleTimeline(records([{latitudeE7: 407500000, longitudeE7: -739800000, timestampMs: "1751911200000", accuracy: 10}]));
  assert.equal(milliseconds.points[0].at, "2025-07-07T18:00:00.000Z");
});

test("invalid coordinates, clocks, accuracy, intervals and offsets never become evidence", () => {
  const invalid = parseGoogleTimeline(records([
    point("2025-02-30T18:00:00Z"), point("2025-07-07T18:00:00"), point(undefined, 910000000),
    point(undefined, 407500000, -1810000000), point(undefined, 407500000.5),
    point(undefined, 407500000, -739800000, -1), point(undefined, 407500000, -739800000, "20"),
    {...point(), timestampMs: "1751911200001"},
  ]));
  assert.equal(invalid.points.length, 0); assert.equal(invalid.summary.skippedCount, 8);
  const invalidVisits = parseGoogleTimeline(JSON.stringify([
    iosVisit("2025-07-07T18:00:00Z", "2025-07-07T18:00:00Z"),
    iosVisit("2025-07-07T18:00:00Z", "2025-07-07T17:00:00Z"),
    iosVisit("2025-07-07T18:00:00Z", "2026-07-07T18:00:00Z"),
    iosVisit(undefined, undefined, "geo:NaN,-73.98"),
    {startTime: "2025-07-07T18:00:00Z", endTime: "2025-07-07T18:10:00Z", timelinePath: [{point: "geo:40.75,-73.98", durationMinutesOffsetFromStartTime: "11"}]},
  ]));
  assert.equal(invalidVisits.visits.length, 0); assert.equal(invalidVisits.points.length, 0);
});

test("malformed and unsupported JSON, nonfinite values, prototype keys and deep nesting reject safely", () => {
  for (const value of ["{", "null", "{}", '{"semanticSegments":{}}', '{"locations":[],"timelineObjects":[]}', '{"locations":[{"__proto__":{"polluted":true}}]}', '{"locations":[],"constructor":{}}', '{"locations":[],"x":1e999}', '{"locations":[],"x":' + "[".repeat(70) + "0" + "]".repeat(70) + "}"])
    assert.throws(() => parseGoogleTimeline(value), Error);
  assert.throws(() => parseGoogleTimeline(new Uint8Array([0xff, 0xfe])), Error);
  assert.equal(({} as {polluted?: boolean}).polluted, undefined);
});

test("byte and total entry bounds reject before exposing a partial preview", async () => {
  let read = false;
  const oversized = {size: MAX_TIMELINE_BYTES + 1, arrayBuffer: async () => {read = true; return new ArrayBuffer(0);}} as Blob;
  await assert.rejects(parseGoogleTimelineFile(oversized), /20/); assert.equal(read, false);
  assert.throws(() => parseGoogleTimeline(" ".repeat(MAX_TIMELINE_BYTES + 1)), /20/);
  assert.throws(() => parseGoogleTimeline(JSON.stringify({locations: Array.from({length: 100001}, () => null)})), /100,000/);
  assert.throws(() => parseGoogleTimeline(JSON.stringify({semanticSegments: [{startTime: "2025-07-07T18:00:00Z", endTime: "2025-07-07T19:00:00Z", timelinePath: Array.from({length: 100000}, () => null)}]})), /100,000/);
});

test("visit boundaries do not create an overlapping match", () => {
  const data = parseGoogleTimeline(JSON.stringify([iosVisit("2025-07-07T17:00:00Z", "2025-07-07T18:00:00Z"), iosVisit("2025-07-07T18:00:00Z", "2025-07-07T19:00:00Z", "geo:41,-74")]));
  const preview = previewGoogleTimeline([photo()], data);
  assert.equal(preview.candidates.length, 1); assert.equal(preview.candidates[0].location.latitude, 41);
});

test("explicit negative zero and zero coordinates deduplicate independently of file order", () => {
  const fromNegative = parseGoogleTimeline('[{"startTime":"2025-07-07T17:00:00Z","endTime":"2025-07-07T19:00:00Z","visit":{"topCandidate":{"placeLocation":"geo:-0,-0"}}},{"startTime":"2025-07-07T17:00:00Z","endTime":"2025-07-07T19:00:00Z","visit":{"topCandidate":{"placeLocation":"geo:0,0"}}}]');
  const fromPositive = parseGoogleTimeline('[{"startTime":"2025-07-07T17:00:00Z","endTime":"2025-07-07T19:00:00Z","visit":{"topCandidate":{"placeLocation":"geo:0,0"}}}]');
  assert.deepEqual(previewGoogleTimeline([photo()], fromNegative), previewGoogleTimeline([photo()], fromPositive));
});

test("unknown RFC offsets and contradictory path clocks are rejected while leap days qualify", () => {
  const data = parseGoogleTimeline(records([point("2025-07-07T18:00:00-00:00"), point("2025-07-07T24:00:00Z"), point("2024-02-29T12:00:00Z")]));
  assert.equal(data.summary.pointCount, 1); assert.equal(data.summary.skippedCount, 2);
  assert.equal(previewGoogleTimeline([photo("leap", "2024-02-29T13:00:00+01:00")], data).candidates.length, 1);
  const contradiction = parseGoogleTimeline(JSON.stringify([{startTime: "2025-07-07T18:00:00Z", endTime: "2025-07-07T18:10:00Z", timelinePath: [
    {point: "geo:40.75,-73.98", time: "2025-07-07T18:05:00Z", durationMinutesOffsetFromStartTime: "6"},
    {point: "geo:40.75,-73.98", time: "wrong", durationMinutesOffsetFromStartTime: "5"},
    {point: "geo:40.75,-73.98", durationMinutesOffsetFromStartTime: "-1"},
  ]}]));
  assert.equal(contradiction.summary.pointCount, 0); assert.equal(contradiction.summary.skippedCount, 3);
});

test("dense precise trails select real point evidence for every eligible photo", () => {
  const locations = Array.from({length: 5_000}, (_, index) => point(`2025-07-07T18:${String(Math.floor(index / 1000)).padStart(2, "0")}:${String(Math.floor(index % 1000 / 20)).padStart(2, "0")}.${String(index % 20 * 50).padStart(3, "0")}Z`));
  const preview = previewGoogleTimeline(Array.from({length: 500}, (_, index) => photo(String(index), "2025-07-07T18:02:00Z")), parseGoogleTimeline(records(locations)));
  assert.equal(preview.summary.candidateCount, 500);
  assert.equal(preview.summary.ambiguousCount, 0);
  assert.ok(preview.candidates.every(candidate => candidate.evidenceStart === "2025-07-07T18:02:00.000Z" && candidate.location.latitude === 40.75));
});

test("nearest point ties prefer measured accuracy and never fabricate a center", () => {
  const data = parseGoogleTimeline(records([point("2025-07-07T17:59:00Z", 407500000, -739800000, 20), point("2025-07-07T18:01:00Z", 407500100, -739800100, 5)]));
  const candidate = previewGoogleTimeline([photo()], data).candidates[0];
  assert.deepEqual(candidate.location, {latitude: 40.75001, longitude: -73.98001, source: "google-timeline", accuracyMeters: 5});
  assert.equal(candidate.evidenceStart, "2025-07-07T18:01:00.000Z");
});

test("duplicate photo identities cannot propose two conflicting writes", () => {
  const preview = previewGoogleTimeline([photo(), photo()], parseGoogleTimeline(JSON.stringify([iosVisit()])));
  assert.equal(preview.candidates.length, 0); assert.equal(preview.summary.ambiguousCount, 2);
});

test("present device visit probabilities must be valid and at least one half", () => {
  const values: unknown[] = [-1, 2, "NaN", "0.2", null];
  const invalid = values.map(probability => ({...iosVisit(), visit: {probability, topCandidate: {placeLocation: "geo:40.75,-73.98", probability: "0.95"}}}));
  invalid.push({...iosVisit(), visit: {probability: 0.95, topCandidate: {placeLocation: "geo:40.75,-73.98", probability: "0.2"}}});
  const data = parseGoogleTimeline(JSON.stringify(invalid));
  assert.equal(data.summary.visitCount, 0); assert.equal(data.summary.skippedCount, 6);
  const acceptable = parseGoogleTimeline(JSON.stringify([{...iosVisit(), visit: {probability: "0.5", topCandidate: {placeLocation: "geo:40.75,-73.98", probability: 0.5}}}]));
  assert.equal(previewGoogleTimeline([photo()], acceptable).candidates.length, 1);
});
