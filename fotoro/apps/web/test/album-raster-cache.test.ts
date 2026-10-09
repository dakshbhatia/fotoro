import test from "node:test";
import assert from "node:assert/strict";
import {AlbumRasterCache} from "../src/albums/raster-cache";
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};

test("concurrent/revisited derivatives share decoding and each view owns its URL", async () => {
  const revoked: string[] = []; let created = 0, reads = 0;
  const cache = new AlbumRasterCache(8, () => "url:" + ++created, url => revoked.push(url));
  const waiting = deferred<Uint8Array>();
  const read = () => {reads++; return waiting.promise;};
  const first = cache.load("source", 4, () => true, read), second = cache.load("source", 4, () => true, read);
  const plain = new Uint8Array([1, 2, 3]); waiting.resolve(plain);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(reads, 1); assert.ok(plain.every(value => value === 0));
  const c = await cache.load("source", 4, () => true, read); assert.equal(c, a); assert.equal(reads, 1);
  const left = new AbortController(), right = new AbortController();
  assert.equal(cache.lease("source", a, left.signal, () => true), "url:1");
  assert.equal(cache.lease("source", b, right.signal, () => true), "url:2");
  left.abort(); assert.deepEqual(revoked, ["url:1"]);
  cache.clear(); assert.deepEqual(revoked, ["url:1", "url:2"]);
  right.abort(); assert.equal(revoked.length, 2);
});

test("cache eviction counts bytes and keeps active leases intact, changed revisions revoke their leases", async () => {
  const revoked: string[] = []; let created = 0, reads = 0;
  const cache = new AlbumRasterCache(8, () => "url:" + ++created, url => revoked.push(url));
  const read = async () => {reads++; return new Uint8Array(5);};
  const first = await cache.load("v1", 4, () => true, read);
  cache.lease("v1", first, new AbortController().signal, () => true);
  await cache.load("other", 4, () => true, read); assert.equal(reads, 2); assert.deepEqual(revoked, []);
  await cache.load("v1", 4, () => true, read); assert.equal(reads, 3, "two five-byte blobs exceed eight-byte budget");
  cache.retain(new Set(["other"])); assert.deepEqual(revoked, ["url:1"]);
  await cache.load("v2", 4, () => true, read); assert.equal(reads, 4);
  cache.clear();
});

test("dispose/revision replacement fences pending plaintext and cannot repopulate a cleared cache", async () => {
  for (const clear of [true, false]) {
    const cache = new AlbumRasterCache(8), waiting = deferred<Uint8Array>();
    const pending = cache.load("v1", 4, () => true, () => waiting.promise);
    const rejected = assert.rejects(pending, {name: "AbortError"});
    if (clear) cache.clear(); else cache.retain(new Set(["v2"]));
    const plain = new Uint8Array([1, 2]); waiting.resolve(plain); await rejected;
    assert.ok(plain.every(value => value === 0));
    let reads = 0;
    await cache.load("v1", 4, () => true, async () => {reads++; return new Uint8Array([3]);});
    assert.equal(reads, 1); cache.clear();
  }
});
