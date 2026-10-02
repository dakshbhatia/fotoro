import test from "node:test";
import assert from "node:assert/strict";
import {OriginalShareAttempt, type ShareEnvironment} from "../src/library/system-share";

test("overlapping Share clicks open one native sheet immediately and cancellation allows retry", async () => {
  const file = new File(["untouched original"], "photo.png", {type: "image/png"});
  const attempt = new OriginalShareAttempt();
  let calls = 0, cancel!: (error: Error) => void;
  const environment: ShareEnvironment = {
    canShare: () => true,
    share: data => {
      calls++; assert.equal(data.files![0], file);
      return new Promise<void>((_, reject) => {cancel = reject;});
    },
    download: () => assert.fail("Native cancellation must not download"),
  };
  const first = attempt.run(file, () => true, environment);
  assert.equal(calls, 1, "The click must invoke Web Share before an asynchronous wait");
  assert.equal(attempt.pending, true);
  assert.equal(await attempt.run(file, () => true, environment), "busy");
  assert.equal(calls, 1);
  cancel(new DOMException("Cancelled", "AbortError"));
  assert.equal(await first, "cancelled"); assert.equal(attempt.pending, false);
  const retry = attempt.run(file, () => true, environment);
  assert.equal(calls, 2); cancel(new DOMException("Cancelled", "AbortError"));
  assert.equal(await retry, "cancelled");
});
test("a failed share releases the click guard without replacing or downloading the original", async () => {
  const file = new File(["original"], "photo.png"), attempt = new OriginalShareAttempt();
  const environment: ShareEnvironment = {canShare: () => true, share: async () => {throw new Error("Share failed");}, download: () => assert.fail("Failure must retain an explicit download choice")};
  await assert.rejects(attempt.run(file, () => true, environment), /Share failed/);
  assert.equal(attempt.pending, false);
  assert.equal(await attempt.run(file, () => true, {...environment, share: async () => {}}), "shared");
});
test("unsupported sharing downloads the same original once; a locked source cannot export", async () => {
  const file = new File(["original"], "photo.png"), attempt = new OriginalShareAttempt();
  let downloads = 0;
  const environment: ShareEnvironment = {canShare: () => false, download: original => {assert.equal(original, file); downloads++;}};
  assert.equal(await attempt.run(file, () => true, environment), "downloaded");
  assert.equal(downloads, 1);
  await assert.rejects(attempt.run(file, () => false, environment), /SOURCE_UNAVAILABLE/);
  assert.equal(downloads, 1); assert.equal(attempt.pending, false);
});
