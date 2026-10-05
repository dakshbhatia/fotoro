import {test} from "node:test";
import assert from "node:assert/strict";
import {currentTimelineCandidates, groupPhotoPlaces, placeMapURL, validPlace} from "../src/local/places";
import type {TimelineCandidate} from "../src/local/google-timeline";
import type {SearchPhoto} from "../src/local/search";

const photo = (id: string, date: string, latitude = 40.7, longitude = -74): SearchPhoto => ({
  id, filename: `${id}.jpg`, date, dateSource: "photos", location: {latitude, longitude, source: "photos"},
});
test("Places groups neighboring photo stops in capture order, preserving returns to a place", () => {
  const a = photo("a", "2026-01-12T12:00:00Z"), b = photo("b", "2026-01-12T12:05:00Z", 40.7001),
    c = photo("c", "2026-01-12T13:00:00Z", 40.8), d = photo("d", "2026-01-12T14:00:00Z");
  const groups = groupPhotoPlaces([d, b, c, a]);
  assert.deepEqual(groups[0].visits.map(visit => visit.photos.map(value => value.id)), [["a", "b"], ["c"], ["d"]]);
});
test("Places excludes revoked snapshots, duplicate ids and malformed coordinates", () => {
  const current = photo("a", "2026-01-12T12:00:00Z"), revoked = {...photo("b", current.date), current: () => false};
  assert.deepEqual(groupPhotoPlaces([current, current, revoked, photo("nan", current.date, NaN), photo("range", current.date, 91)])
    .flatMap(day => day.visits.flatMap(visit => visit.photos.map(value => value.id))), ["a"]);
});
test("selected import clocks do not invent a travel date and remote days remain separate", () => {
  const selected = {...photo("selected", "2026-01-13T12:00:00Z"), dateSource: "selected" as const};
  const days = groupPhotoPlaces([selected, photo("old", "2026-01-11T12:00:00Z"), photo("new", "2026-01-12T12:00:00Z")]);
  assert.deepEqual(days.map(day => day.visits[0].photos[0].id), ["new", "old", "selected"]);
  assert.equal(days[2].date, undefined);
});
test("a long gap or inferred source starts another stop; nearby dateline coordinates stay near", () => {
  const a = photo("a", "2026-01-12T12:00:00Z", 0, 179.9995), b = photo("b", "2026-01-12T12:01:00Z", 0, -179.9995),
    c = photo("c", "2026-01-12T15:00:00Z", 0, -179.9995);
  const inferred = {...photo("d", "2026-01-12T15:01:00Z", 0, -179.9995), location: {...c.location!, source: "google-timeline" as const}};
  assert.deepEqual(groupPhotoPlaces([a, b, c, inferred])[0].visits.map(visit => visit.photos.length), [2, 1, 1]);
});
test("Maps receives only the requested valid coordinate, with no photo or account data", () => {
  const location = photo("a", "2026-01-12T12:00:00Z").location!;
  const url = new URL(placeMapURL(location)!);
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.searchParams.get("query"), "40.7,-74");
  assert.deepEqual([...url.searchParams.keys()], ["api", "query"]);
  assert.equal(validPlace({...location, accuracyMeters: -1}), false);
  assert.equal(placeMapURL({...location, longitude: Infinity}), undefined);
});
test("Timeline confirmation rechecks current capture proof, account snapshots and existing GPS", () => {
  const date = "2026-01-12T12:00:00Z";
  const location = {latitude: 40.7, longitude: -74, source: "google-timeline" as const};
  const candidate = (photoID: string): TimelineCandidate => ({photoID, location, basis: "point", capturedAt: date, evidenceStart: date, evidenceEnd: date});
  const source = (id: string): SearchPhoto => ({id, filename: `${id}.jpg`, date, dateSource: "photos"});
  const candidates = ["current", "revoked", "located", "changed", "unverified", "offset", "selected", "missing", "malformed"].map(candidate);
  let unlocked = true;
  const sources = [source("current"), {...source("revoked"), current: () => unlocked}, photo("located", date),
    {...source("changed"), date: "2026-01-12T12:01:00Z"}, {...source("unverified"), dateSource: "exif" as const, captureVerified: true as const},
    {...source("offset"), date: "2026-01-12T07:00:00-05:00", dateSource: "exif" as const, captureVerified: true as const, captureTimezoneVerified: true as const},
    {...source("selected"), dateSource: "selected" as const}, source("malformed")];
  unlocked = false;
  candidates.at(-1)!.location = {...location, latitude: 91};
  assert.deepEqual(currentTimelineCandidates([...candidates, candidate("current")], sources).map(value => value.photoID), ["current", "offset"]);
});
