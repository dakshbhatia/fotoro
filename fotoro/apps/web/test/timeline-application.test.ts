import test from "node:test";
import assert from "node:assert/strict";
import {applyTimelineTargets, remainingTimelineCandidates, type TimelineApplicationTarget} from "../src/local/timeline-application";
import type {TimelineCandidate} from "../src/local/google-timeline";

interface Local {id: string; location?: TimelineCandidate["location"]}
interface Saved {manifest: {photoId: string}}
const candidate = (photoID: string): TimelineCandidate => ({photoID, location: {latitude: 40.75, longitude: -73.98, source: "google-timeline"}, basis: "visit", capturedAt: "2025-07-07T18:00:00.000Z", evidenceStart: "2025-07-07T17:30:00.000Z", evidenceEnd: "2025-07-07T18:30:00.000Z"});
const target = (id: string, local?: Local, savedID?: string): TimelineApplicationTarget<Local, Saved> => ({candidate: candidate(id), local, saved: savedID ? {manifest: {photoId: savedID}} : undefined});
const keepLocal = (updates: readonly {photo: Local; location: TimelineCandidate["location"]}[]) => {for (const {photo, location} of updates) photo.location = location;};

test("a failed Saved queue leaves its matching local photo unchanged and retryable", async () => {
  const local: Local = {id: "local-a"};
  const result = await applyTimelineTargets([target(local.id, local, "saved-a")], {current: () => true, localCurrent: () => true, savedCurrent: () => true, queueSaved: async () => ({updatedPhotoIDs: []}), applyLocal: keepLocal});
  assert.equal(local.location, undefined);
  assert.deepEqual(result, {applied: 0, failed: 1, needsSave: false, localOnlyCount: 0, appliedPhotoIDs: [], retryPhotoIDs: ["local-a"]});
});

test("partial Saved successes and local-only updates each count the photo once", async () => {
  const linked: Local = {id: "linked"}, localOnly: Local = {id: "local-only"};
  const result = await applyTimelineTargets([target(linked.id, linked, "saved-a"), target("saved:b", undefined, "saved-b"), target(localOnly.id, localOnly)], {
    current: () => true, localCurrent: () => true, savedCurrent: () => true,
    queueSaved: async () => {
      assert.equal(linked.location, undefined); assert.equal(localOnly.location, undefined);
      return {updatedPhotoIDs: ["saved-a", "saved-a", "outside-this-batch"]};
    }, applyLocal: keepLocal,
  });
  assert.deepEqual(result, {applied: 2, failed: 1, needsSave: true, localOnlyCount: 1, appliedPhotoIDs: ["linked", "local-only"], retryPhotoIDs: ["saved:b"]});
  assert.equal(linked.location?.source, "google-timeline"); assert.equal(localOnly.location?.source, "google-timeline");
});

test("a local-only result requires saving the photo, not saving queued photo changes", async () => {
  const local: Local = {id: "local"};
  const result = await applyTimelineTargets([target(local.id, local)], {current: () => true, localCurrent: () => true, savedCurrent: () => true, applyLocal: keepLocal});
  assert.equal(result.applied, 1); assert.equal(result.needsSave, false); assert.equal(result.localOnlyCount, 1);
  assert.equal(local.location?.source, "google-timeline");
});

test("a context revoked during the Saved queue cannot update local originals", async () => {
  const local: Local = {id: "local"}; let current = true;
  await assert.rejects(applyTimelineTargets([target(local.id, local, "saved")], {current: () => current, localCurrent: () => true, savedCurrent: () => true, queueSaved: async () => {current = false; return {updatedPhotoIDs: ["saved"]};}, applyLocal: keepLocal}), /Photos changed/);
  assert.equal(local.location, undefined);
});

test("a confirmed Saved result cannot copy into a replaced local source", async () => {
  const oldLocal: Local = {id: "local"}; let sourceCurrent = true;
  const result = await applyTimelineTargets([target(oldLocal.id, oldLocal, "saved")], {current: () => true, localCurrent: () => sourceCurrent, savedCurrent: () => true, queueSaved: async () => {sourceCurrent = false; return {updatedPhotoIDs: ["saved"]};}, applyLocal: keepLocal});
  assert.equal(oldLocal.location, undefined); assert.equal(result.applied, 1); assert.equal(result.needsSave, true);
});

test("a changed Saved source does not project its acknowledged estimate into a local photo", async () => {
  const local: Local = {id: "local"}; let sourceCurrent = true;
  const result = await applyTimelineTargets([target(local.id, local, "saved")], {current: () => true, localCurrent: () => true, savedCurrent: () => sourceCurrent, queueSaved: async () => {sourceCurrent = false; return {updatedPhotoIDs: ["saved"]};}, applyLocal: keepLocal});
  assert.equal(local.location, undefined); assert.equal(result.applied, 1); assert.equal(result.needsSave, true);
});

test("a queue error retains eligible Saved retries while still applying local-only matches", async () => {
  const linked: Local = {id: "linked"}, localOnly: Local = {id: "local"};
  const result = await applyTimelineTargets([target(linked.id, linked, "saved"), target(localOnly.id, localOnly)], {current: () => true, localCurrent: () => true, savedCurrent: () => true, queueSaved: async () => {throw new Error("disk unavailable");}, applyLocal: keepLocal});
  assert.equal(linked.location, undefined); assert.equal(localOnly.location?.source, "google-timeline");
  assert.deepEqual(result, {applied: 1, failed: 1, needsSave: false, localOnlyCount: 1, appliedPhotoIDs: ["local"], retryPhotoIDs: ["linked"]});
});

test("an unavailable or stale local-only source is never counted as applied", async () => {
  const local: Local = {id: "local"};
  const result = await applyTimelineTargets([target(local.id, local)], {current: () => true, localCurrent: () => false, savedCurrent: () => true, applyLocal: keepLocal});
  assert.deepEqual(result, {applied: 0, failed: 1, needsSave: false, localOnlyCount: 0, appliedPhotoIDs: [], retryPhotoIDs: []});
  assert.equal(local.location, undefined);
});

test("remaining proposals survive a partial projection and exclude successful photo aliases", () => {
  const proposals = [candidate("local:a"), candidate("saved:b")];
  assert.deepEqual(remainingTimelineCandidates(proposals, {applied: 1, failed: 1, appliedPhotoIDs: ["local:a"], retryPhotoIDs: ["saved:b"]}).map(value => value.photoID), ["saved:b"]);
  assert.deepEqual(remainingTimelineCandidates(proposals, {applied: 1, failed: 1, updatedPhotoIDs: ["local:a"]}).map(value => value.photoID), ["saved:b"]);
  assert.deepEqual(remainingTimelineCandidates(proposals, {applied: 2, failed: 0}), []);
});
