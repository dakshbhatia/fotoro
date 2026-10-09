import test from "node:test";
import assert from "node:assert/strict";
import {unzipSync} from "fflate";
import {ready, utf8} from "@fotoro/crypto";
import {digest, type Photo} from "../src/library/catalog";
import type {AlbumAccess} from "../src/albums/service";
await ready;
function photo(filename: string, text: string) {
  const original = new TextEncoder().encode(text);
  return {manifest: {photoId: crypto.randomUUID(), ownerAccountId: "11111111-1111-4111-8111-111111111111"}, metadata: {filename, mediaType: "image/jpeg", sourceDate: "2026-10-01T12:00:00Z", dateSource: "photos", originalBytes: original.length, originalSha256: digest(original)}, metadataKey: new Uint8Array(32), original} as unknown as Photo & {original: Uint8Array};
}
function source(pages: Photo[][]) {
  let at = 0, reads = 0, disposed = false;
  const photos = pages.flat();
  return {title: "Family Trip", current: () => !disposed,
    loadPhotoPage: async (cursor?: string) => {assert.equal(cursor, at ? String(at) : undefined); const page = pages[at++]; return {photos: page, hasMore: at < pages.length, nextCursor: at < pages.length ? String(at) : undefined, photoCount: photos.length};},
    assertAccess: async () => ({photoCount: photos.length}),
    bytes: async (value: Photo) => {reads++; return (value as Photo & {original: Uint8Array}).original.slice();},
    dispose: () => {disposed = true;}, get reads() {return reads;}, get disposed() {return disposed;},
  } as unknown as AlbumAccess & {reads: number; disposed: boolean};
}

test("Download trip traverses every page and writes one ZIP with exact-original copies removed", async () => {
  const first = photo("same.jpg", "first exact original"), duplicate = {...photo("renamed.jpg", "first exact original")}, distinct = photo("same.jpg", "different original");
  const access = source([[first], [duplicate, distinct]]);
  const result = await prepareTripDownload(access, new AbortController().signal, () => {});
  assert.ok(result, "one trip action must produce a complete verified ZIP");
  const files = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  assert.equal(Object.keys(files).length, 2); assert.equal(access.reads, 2); assert.equal(access.disposed, true);
  assert.deepEqual(Object.values(files).map(bytes => new TextDecoder().decode(bytes)), ["first exact original", "different original"]);
  assert.equal(result.duplicates, 1); await result.dispose();
});

import {prepareTripDownload, TRIP_MEMORY_LIMIT, tripFilename, type TripDownloadSink} from "../src/albums/download";
import {encodeLivePhoto} from "@fotoro/crypto";
function trackingSink(limit = TRIP_MEMORY_LIMIT) {
  const chunks: Uint8Array[] = []; let disposed = false, finished = false;
  return {limit, chunks, get disposed() {return disposed;}, get finished() {return finished;},
    write: async (chunk: Uint8Array) => {chunks.push(chunk.slice());},
    finish: async (name: string) => {finished = true; return new File(chunks, name);},
    dispose: async () => {disposed = true; chunks.length = 0;},
  } as TripDownloadSink & {chunks: Uint8Array[]; disposed: boolean; finished: boolean};
}

test("memory and ZIP32 limits reject before any original reads and discard output", async () => {
  for (const size of [TRIP_MEMORY_LIMIT, 50 * 1024 * 1024]) {
    const count = size === TRIP_MEMORY_LIMIT ? 3 : 100;
    const photos = Array.from({length: count}, (_, index) => {const value = photo("large.jpg", String(index)); value.metadata.originalBytes = 50 * 1024 * 1024; return value;});
    const access = source([photos]), sink = trackingSink();
    await assert.rejects(prepareTripDownload(access, new AbortController().signal, () => {}, async () => sink), /TRIP_(MEMORY|ZIP)_LIMIT/);
    assert.equal(access.reads, 0); assert.equal(access.disposed, true); assert.equal(sink.finished, false);
    if (count === 3) assert.equal(sink.disposed, true);
  }
});

test("incomplete paging, cursor loops and changing inventory cannot report a complete trip", async () => {
  for (const mode of ["incomplete", "cursor", "changed"]) {
    const access = source([[photo("first.jpg", "first")]]), sink = trackingSink();
    if (mode === "incomplete") access.loadPhotoPage = async () => ({photos: [], photoCount: 2, hasMore: false});
    if (mode === "cursor") access.loadPhotoPage = async () => ({photos: [photo("copy.jpg", crypto.randomUUID())], photoCount: 3, hasMore: true, nextCursor: "same"});
    if (mode === "changed") access.assertAccess = async () => ({photoCount: 2}) as any;
    await assert.rejects(prepareTripDownload(access, new AbortController().signal, () => {}, async () => sink), /TRIP_(INCOMPLETE|CHANGED)/);
    assert.equal(access.reads, 0); assert.equal(sink.finished, false); assert.equal(access.disposed, true);
  }
});

test("renamed identical Live pairs dedup while different motion and a standalone still remain complete", async () => {
  const still = new Uint8Array([1, 2, 3]), motion = new Uint8Array([4, 5, 6]);
  async function live(name: string, video: Uint8Array) {
    const original = await encodeLivePhoto({filename: name + ".HEIC", mediaType: "image/heic", bytes: still}, {filename: name + ".MOV", mediaType: "video/quicktime", bytes: video});
    const value = photo(name, "placeholder"); value.original = original; value.metadata = {...value.metadata, mediaType: "application/vnd.fotoro.live-photo", originalBytes: original.length, originalSha256: digest(original)}; return value;
  }
  const a = await live("a", motion), renamed = await live("renamed", motion), changed = await live("a", new Uint8Array([7, 8, 9])), standalone = photo("a.HEIC", "placeholder");
  standalone.original = still; standalone.metadata = {...standalone.metadata, mediaType: "image/heic", originalBytes: still.length, originalSha256: digest(still)};
  const access = source([[a, renamed, changed, standalone]]);
  const result = await prepareTripDownload(access, new AbortController().signal, () => {});
  const files = unzipSync(new Uint8Array(await result.file.arrayBuffer()));
  assert.equal(result.photos, 3); assert.equal(result.resources, 5); assert.equal(result.duplicates, 1);
  assert.deepEqual(Object.values(files).map(bytes => [...bytes]), [[1, 2, 3], [4, 5, 6], [1, 2, 3], [7, 8, 9], [1, 2, 3]]);
  await result.dispose();
});

test("cancel or lost access while writing aborts output and releases its separate album access", async () => {
  for (const mode of ["cancel", "access", "write"]) {
    const controller = new AbortController(), access = source([[photo("a.jpg", "original")]]), sink = trackingSink();
    sink.write = async () => {if (mode === "cancel") controller.abort(); else if (mode === "access") access.dispose(); else throw new Error("Disk full");};
    await assert.rejects(prepareTripDownload(access, controller.signal, () => {}, async () => sink), mode === "write" ? /Disk full/ : {name: "AbortError"});
    assert.equal(sink.disposed, true); assert.equal(sink.finished, false); assert.equal(access.disposed, true);
  }
});

test("unsafe and colliding source filenames produce unique per-photo archive paths", async () => {
  const reserved = ["CON.jpg", "prn.MOV", "AUX", "NUL.png", "COM1.HEIC", "lpt9.jpg", "CON .jpg", "CON.extra.jpg"];
  const values = [photo("../../same.jpg", "one"), photo("C:\\unsafe\\same.jpg", "two"), photo("...jpg", "three"), photo("\u0000bad\u0001:name?.jpg", "four"), ...reserved.map(name => photo(name, name))];
  const result = await prepareTripDownload(source([values]), new AbortController().signal, () => {});
  const names = Object.keys(unzipSync(new Uint8Array(await result.file.arrayBuffer())));
  assert.equal(new Set(names).size, values.length); assert.ok(names.every(name => /^\d{4}\/[^/\\\u0000-\u001f:]+$/.test(name)));
  assert.deepEqual(names.slice(4).map(name => name.slice(5)), reserved.map(name => "_" + name));
  const longReserved = tripFilename("CON." + "x".repeat(200) + ".HEIC");
  assert.ok(longReserved.startsWith("_CON.")); assert.ok(longReserved.endsWith(".HEIC")); assert.ok(new TextEncoder().encode(longReserved).length <= 200);
  assert.equal(tripFilename("COM10.jpg"), "COM10.jpg");
  assert.equal(tripFilename("../.."), "photo"); await result.dispose();
});

test("membership is rechecked after the output stream closes before a ZIP can be published", async () => {
  const access = source([[photo("a.jpg", "original")]]), sink = trackingSink(); let revoked = false;
  access.assertAccess = async () => {if (revoked) throw new Error("ALBUM_INACTIVE"); return {photoCount: 1} as any;};
  sink.finish = async name => {revoked = true; return new File(sink.chunks, name);};
  await assert.rejects(prepareTripDownload(access, new AbortController().signal, () => {}, async () => sink), /ALBUM_INACTIVE/);
  assert.equal(sink.disposed, true); assert.equal(access.disposed, true);
});

test("Live resource names are preserved together inside their photo folder", async () => {
  const packed = await encodeLivePhoto({filename: "IMG_0123.HEIC", mediaType: "image/heic", bytes: new Uint8Array([1, 2])}, {filename: "IMG_0123.MOV", mediaType: "video/quicktime", bytes: new Uint8Array([3, 4])});
  const value = photo("pair", "placeholder"); value.original = packed; value.metadata = {...value.metadata, mediaType: "application/vnd.fotoro.live-photo", originalBytes: packed.length, originalSha256: digest(packed)};
  const result = await prepareTripDownload(source([[value]]), new AbortController().signal, () => {});
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await result.file.arrayBuffer()))), ["0001/IMG_0123.HEIC", "0001/IMG_0123.MOV"]);
  await result.dispose();
});

test("OPFS orphan cleanup holds an exclusive lock and never deletes an active other-tab job", async () => {
  const {cleanupTripDownloads} = await import("../src/albums/download");
  const storage = Object.getOwnPropertyDescriptor(navigator, "storage"), locks = Object.getOwnPropertyDescriptor(navigator, "locks");
  const files = new Map<string, File>([["fotoro-trip-orphan", new File(["old plaintext"], "orphan")], ["unrelated", new File(["other"], "unrelated")]]);
  let held = false, writableChunks: Uint8Array[] = [];
  const directory = {async *keys() {yield* files.keys();}, async removeEntry(name: string) {assert.equal(held, true); files.delete(name);},
    async getFileHandle(name: string) {
      assert.equal(held, true); files.set(name, new File([], name));
      return {async createWritable() {writableChunks = []; return {async write(chunk: Uint8Array) {writableChunks.push(chunk.slice());}, async close() {files.set(name, new File(writableChunks, name));}, async abort() {writableChunks = [];}};}, async getFile() {return files.get(name)!;}};
    },
  };
  Object.defineProperty(navigator, "storage", {configurable: true, value: {getDirectory: async () => directory}});
  Object.defineProperty(navigator, "locks", {configurable: true, value: {request: async (_name: string, _options: unknown, task: (lock: object | null) => Promise<void>) => {
    if (held) return task(null);
    held = true; try {return await task({});} finally {held = false;}
  }}});
  try {
    const result = await prepareTripDownload(source([[photo("a.jpg", "original")]]), new AbortController().signal, () => {});
    assert.equal(files.has("fotoro-trip-orphan"), false); assert.equal(files.has("unrelated"), true); assert.equal(held, true);
    const names = [...files.keys()]; await cleanupTripDownloads(); assert.deepEqual([...files.keys()], names);
    assert.equal(Object.keys(unzipSync(new Uint8Array(await result.file.arrayBuffer()))).length, 1);
    await result.dispose(); assert.deepEqual([...files.keys()], ["unrelated"]);
  } finally {if (storage) Object.defineProperty(navigator, "storage", storage); else delete (navigator as any).storage; if (locks) Object.defineProperty(navigator, "locks", locks); else delete (navigator as any).locks;}
});

test("late contributions during output close reject the stale subset and clean its ZIP", async () => {
  const access = source([[photo("a.jpg", "original")]]), sink = trackingSink(); let count = 1;
  access.assertAccess = async () => ({photoCount: count}) as any;
  sink.finish = async name => {count = 2; return new File(sink.chunks, name);};
  await assert.rejects(prepareTripDownload(access, new AbortController().signal, () => {}, async () => sink), /TRIP_CHANGED/);
  assert.equal(sink.disposed, true); assert.equal(access.disposed, true);
});

test("long Live names retain extensions and case-equivalent stems remain separate", async () => {
  assert.ok(tripFilename("x".repeat(200) + ".HEIC").endsWith(".HEIC"));
  assert.ok(tripFilename("X".repeat(200) + ".MOV").endsWith(".MOV"));
  const packed = await encodeLivePhoto({filename: "A".repeat(200) + ".HEIC", mediaType: "image/heic", bytes: new Uint8Array([1, 2])}, {filename: "a".repeat(200) + ".MOV", mediaType: "video/quicktime", bytes: new Uint8Array([3, 4])});
  const value = photo("pair", "placeholder"); value.original = packed; value.metadata = {...value.metadata, mediaType: "application/vnd.fotoro.live-photo", originalBytes: packed.length, originalSha256: digest(packed)};
  const result = await prepareTripDownload(source([[value]]), new AbortController().signal, () => {});
  const names = Object.keys(unzipSync(new Uint8Array(await result.file.arrayBuffer())));
  assert.equal(new Set(names.map(name => name.normalize("NFC").toLowerCase())).size, 2);
  assert.ok(names[0].endsWith(".HEIC")); assert.ok(names[1].endsWith(".MOV")); await result.dispose();
});
