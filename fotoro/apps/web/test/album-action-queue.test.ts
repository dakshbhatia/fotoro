import test from "node:test";
import assert from "node:assert/strict";
import {AlbumActionQueue, bindAlbumAction} from "../src/albums/action-queue";
const deferred = () => {let resolve!: () => void; const promise = new Promise<void>(done => {resolve = done;}); return {promise, resolve};};

test("a foreground action queues behind a poll without being dropped or overlapped", async () => {
  const held = deferred(), started = deferred(), events: string[] = [], busy: boolean[] = [];
  const queue = new AlbumActionQueue(() => true, value => busy.push(value));
  const poll = queue.run(async () => {events.push("poll"); started.resolve(); await held.promise; events.push("poll done");}, true);
  await started.promise; assert.deepEqual(busy, []);
  const foreground = queue.run(async () => {events.push("download");});
  await queue.run(async () => {events.push("duplicate poll");}, true);
  assert.deepEqual(events, ["poll"]); assert.deepEqual(busy, [true]);
  held.resolve(); await Promise.all([poll, foreground]);
  assert.deepEqual(events, ["poll", "poll done", "download"]); assert.deepEqual(busy, [true, false]);
});

test("queued actions cannot run after the account/scope changes and failures do not block later actions", async () => {
  const held = deferred(), started = deferred(), busy: boolean[] = []; let current = true, ran = false;
  const queue = new AlbumActionQueue(() => current, value => busy.push(value));
  const poll = queue.run(async () => {started.resolve(); await held.promise; throw new Error("network");}, true);
  const rejected = assert.rejects(poll, /network/); await started.promise;
  const foreground = queue.run(async () => {ran = true;});
  current = false; held.resolve(); await rejected; await foreground;
  assert.equal(ran, false); assert.deepEqual(busy, [true, false]);
  current = true; await queue.run(async () => {ran = true;}); assert.equal(ran, true);
});

test("a failed background poll releases the queued foreground click without overlapping work", async () => {
  const held = deferred(), started = deferred(), events: string[] = [], busy: boolean[] = [];
  const queue = new AlbumActionQueue(() => true, value => busy.push(value));
  const poll = queue.run(async () => {events.push("poll"); started.resolve(); await held.promise; throw new Error("offline");}, true);
  const rejected = assert.rejects(poll, /offline/); await started.promise;
  const click = queue.run(async () => {events.push("clicked");});
  assert.deepEqual(events, ["poll"]); assert.deepEqual(busy, [true]);
  held.resolve(); await rejected; await click;
  assert.deepEqual(events, ["poll", "clicked"]); assert.deepEqual(busy, [true, false]);
});


test("a queued action cannot copy or mutate a different trip, while same-source refresh keeps the intent", async () => {
  for (const switched of [true, false]) {
    const held = deferred(), started = deferred();
    const original = {id: "trip"}; let source = original, ran = false, notice = false;
    const queue = new AlbumActionQueue(() => true, () => {});
    const poll = queue.run(async () => {started.resolve(); await held.promise; if (switched) source = {id: "other"};}, true);
    await started.promise;
    const intent = bindAlbumAction(() => source, async () => {ran = true;}, () => {notice = true;});
    const click = queue.run(intent); held.resolve(); await Promise.all([poll, click]);
    assert.equal(ran, !switched); assert.equal(notice, switched);
  }
});

test("explicit panel close quietly cancels a queued source-bound action without a retry notice", async () => {
  const held = deferred(), started = deferred(); let open = true, source: object | null = {}, ran = false, notice = false;
  const queue = new AlbumActionQueue(() => open, () => {});
  const poll = queue.run(async () => {started.resolve(); await held.promise;}, true);
  await started.promise;
  const click = queue.run(bindAlbumAction(() => source, async () => {ran = true;}, () => {notice = true;}));
  open = false; source = null; held.resolve(); await Promise.all([poll, click]);
  assert.equal(ran, false); assert.equal(notice, false);
});
