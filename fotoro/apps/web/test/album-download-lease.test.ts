import test from "node:test";
import assert from "node:assert/strict";
import type {TripDownload} from "../src/albums/download";

test("a published trip file retains its backing output until explicit completion", async () => {
  const {TripDownloadLease} = await import("../src/albums/download-lease");
  let disposed = 0, revoked = 0, started = 0;
  const result: TripDownload = {file: new File(["disk backed ZIP"], "trip.zip"), photos: 1, duplicates: 0, resources: 1, dispose: async () => {disposed++;}};
  const lease = new TripDownloadLease(result, {createURL: () => "blob:trip", revokeURL: () => {revoked++;}, download: () => {started++;}});
  assert.ok(lease, "published trip downloads need an explicit lifetime lease");
  lease.publish(() => true); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, 1); assert.equal(disposed, 0); assert.equal(revoked, 0);
  await lease.dispose(); await lease.dispose();
  assert.equal(disposed, 1); assert.equal(revoked, 1);
});

test("lifecycle cancellation releases a published lease once and stale publication never starts a download", async () => {
  const {TripDownloadLease} = await import("../src/albums/download-lease");
  let disposed = 0, revoked = 0, started = 0, current = true;
  const result: TripDownload = {file: new File(["ZIP"], "trip.zip"), photos: 1, duplicates: 0, resources: 1, dispose: async () => {disposed++;}};
  const lease = new TripDownloadLease(result, {createURL: () => {current = false; return "blob:trip";}, revokeURL: () => {revoked++;}, download: () => {started++;}});
  assert.throws(() => lease.publish(() => current), {name: "AbortError"});
  assert.equal(started, 0); assert.equal(revoked, 1); await lease.dispose(); assert.equal(disposed, 1);
  assert.throws(() => lease.publish(() => true), {name: "AbortError"});
});
