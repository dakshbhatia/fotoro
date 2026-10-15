import test from "node:test";
import assert from "node:assert/strict";
import {DeferredSavedRefresh, readSavedSnapshot, subscribeSavedRefresh} from "../src/library/consumer-refresh";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("reconnect during a busy account action is retained and foreground bursts share one trailing read", async () => {
  const windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), {visibilityState: "visible"});
  let busy = true, reads = 0;
  const releases: (() => void)[] = [];
  const queue = new DeferredSavedRefresh(() => {
    if (busy) return false;
    reads++;
    return new Promise<void>(resolve => releases.push(resolve));
  }, () => documentTarget.visibilityState === "visible");
  const detach = subscribeSavedRefresh(windowTarget, documentTarget, () => queue.request());
  windowTarget.dispatchEvent(new Event("online"));
  windowTarget.dispatchEvent(new Event("focus"));
  assert.equal(reads, 0);
  busy = false; queue.flush();
  assert.equal(reads, 1, "The action owner releases the retained read without another browser event");
  for (const name of ["focus", "online", "pageshow"]) windowTarget.dispatchEvent(new Event(name));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  assert.equal(reads, 1, "No overlapping read starts");
  releases.shift()!(); await settled();
  assert.equal(reads, 2, "A burst while reading produces one fresh trailing snapshot");
  releases.shift()!(); await settled();
  assert.equal(reads, 2);
  queue.dispose(); detach();
});

test("a deferred read waits for visible access and withdrawal prevents trailing publication work", async () => {
  let visible = false, current = true, reads = 0, release!: () => void;
  const queue = new DeferredSavedRefresh(() => {
    reads++; return new Promise<void>(resolve => {release = resolve;});
  }, () => visible && current);
  queue.request(); queue.flush();
  assert.equal(reads, 0);
  visible = true; queue.flush();
  assert.equal(reads, 1);
  queue.request();
  current = false; queue.dispose();
  release(); await settled();
  queue.request(); queue.flush();
  assert.equal(reads, 1, "A finished old-account read cannot launch its retained successor");
});

test("failed reads settle without a timer retry loop and a later foreground event can recover", async () => {
  let reads = 0;
  const queue = new DeferredSavedRefresh(async () => {reads++; throw new Error("offline");}, () => true);
  queue.request(); await settled();
  assert.equal(reads, 1);
  queue.request(); await settled();
  assert.equal(reads, 2);
  queue.dispose();
});

test("a returned account snapshot wipes its unpublished metadata keys when its caller is withdrawn", async () => {
  for (const withdrawal of ["scope", "abort"] as const) {
    const controller = new AbortController(), metadataKey = new Uint8Array([1, 2, 3]);
    let current = true, release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;});
    const reading = readSavedSnapshot({signal: controller.signal, current: () => current,
      read: async () => {await held; return {photos: [{metadataKey}], coverage: "complete"};}});
    const rejected = assert.rejects(reading, {name: "AbortError"});
    if (withdrawal === "scope") current = false; else controller.abort();
    release(); await rejected;
    assert.deepEqual([...metadataKey], [0, 0, 0], withdrawal);
  }
  const metadataKey = new Uint8Array([1, 2, 3]), result = {photos: [{metadataKey}], coverage: "complete"};
  assert.equal(await readSavedSnapshot({current: () => true, read: async () => result}), result);
  assert.deepEqual([...metadataKey], [1, 2, 3], "Admitted snapshots transfer key ownership to the caller");
});
