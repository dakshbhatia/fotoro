import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64, unwrapKey, decryptMedia} from "@fotoro/crypto";
import {heicDimensions, boundedPhotoBitmap, PHOTO_HEADER_BYTES, photoFormat} from "../src/media/photo-source";
import {localPhoto, LocalResources, LOCAL_RASTER_BUDGET} from "../src/local/resources";
import {stageImport, validateSource} from "../src/exchange/journal";
import {configureVault, unlockVault, lockVault, requireVault} from "../src/vault/vault";
import {clearAccount, all, get} from "../src/exchange/cache";
import {collect, source} from "../src/library/catalog";
import {gridHeicWithExif, HEIC_CAPTURE_CLOCK} from "./fixtures/heic-exif";
import {captureGroup} from "../src/local/capture-groups";
import {PhotoSearchIndex} from "../src/local/search";

const heic = new Uint8Array(readFileSync(new URL("../../../fixtures/media/singapore.heic", import.meta.url)));
const jpeg = new Uint8Array(readFileSync(new URL("../../../fixtures/media/thumbnail.jpg", import.meta.url)));
const owner = "55555555-5555-4555-8555-555555555555", other = "66666666-6666-4666-8666-666666666666";
const file = (type = "image/heic") => new File([heic], "public-fixture.HEIC", {type});
async function open(accountId = owner) {
  await ready; const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
let cryptoHandler: ((event: any) => Promise<void>) | undefined;
async function browserMocks() {
  const keys = ["createImageBitmap", "document", "Worker", "self"], descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const sizes: {width: number; height: number}[] = [];
  let closed = 0, workers = 0, latest: any;
  const workerGlobal: any = {onmessage: cryptoHandler, postMessage: (data: unknown) => {if (!latest.terminated) latest.onmessage({data});}};
  Object.defineProperty(globalThis, "self", {configurable: true, writable: true, value: workerGlobal});
  if (!cryptoHandler) {await import("../src/exchange/crypto.worker"); cryptoHandler = workerGlobal.onmessage;}
  Object.defineProperty(globalThis, "createImageBitmap", {configurable: true, writable: true, value: async (_source: Blob, options: ImageBitmapOptions) => {
    sizes.push({width: options.resizeWidth!, height: options.resizeHeight!});
    return {width: options.resizeWidth, height: options.resizeHeight, close() {closed++;}};
  }});
  Object.defineProperty(globalThis, "document", {configurable: true, writable: true, value: {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage() {}}), toBlob: (callback: (value: Blob) => void) => callback(new Blob([jpeg], {type: "image/jpeg"}))})}});
  Object.defineProperty(globalThis, "Worker", {configurable: true, writable: true, value: class {
    terminated = false; onmessage: any; onerror: any;
    constructor() {workers++; latest = this;}
    postMessage(data: unknown) {void cryptoHandler!({data: structuredClone(data)}).catch(error => this.onerror?.(error));}
    terminate() {this.terminated = true;}
  }});
  return {sizes, get closed() {return closed;}, get workers() {return workers;}, restore() {for (const [key, descriptor] of descriptors) {if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);}}};
}

test("HEIC dimensions follow the primary grid rather than a tile or thumbnail property", () => {
  assert.deepEqual(heicDimensions(heic.subarray(0, PHOTO_HEADER_BYTES), heic.length), {width: 1920, height: 1200});
  const rotated = new Uint8Array(heic); rotated[557] = 1;
  assert.deepEqual(heicDimensions(rotated), {width: 1200, height: 1920});
  const wide = new Uint8Array(heic); new DataView(wide.buffer).setUint32(541, 100_000);
  assert.equal(heicDimensions(wide), undefined);
  for (const [at, value] of [[800, 3], [800, 127], [557, 4], [798, 4], [818, 1], [431, 0xff]] as const) {
    const malformed = new Uint8Array(heic); malformed[at] = value;
    assert.equal(heicDimensions(malformed), undefined, "Malformed primary mapping/transform/grid must be rejected at " + at);
  }
  const crop = new Uint8Array(heic); crop.set(new TextEncoder().encode("clap"), 553);
  assert.equal(heicDimensions(crop), undefined);
  const foreign = new Uint8Array(heic); foreign.set(new TextEncoder().encode("avif"), 8); foreign.set(new TextEncoder().encode("avif"), 28);
  assert.equal(heicDimensions(foreign), undefined);
  assert.equal(heicDimensions(heic.subarray(0, 500), heic.length), undefined);
});
test("HEIC MIME variants and extension-only Files retain their original identity", async () => {
  const environment = await browserMocks();
  try {
    for (const type of ["image/heic", "image/heif", ""]) {
      const original = file(type), photo = await localPhoto(original);
      assert.equal(photo.file, original); assert.equal(photo.originalSize, heic.length);
      assert.equal(photo.width, 1920); assert.equal(photo.height, 1200);
      assert.equal(photo.dateSource, "selected", "HEIC capture dates are not guessed");
      assert.deepEqual(new Uint8Array(await original.arrayBuffer()), heic);
      assert.equal(photo.id, Buffer.from(await crypto.subtle.digest("SHA-256", heic)).toString("hex"));
      validateSource(original);
    }
    assert.deepEqual(environment.sizes, Array(3).fill({width: 256, height: 160})); assert.equal(environment.closed, 3);
    assert.equal(photoFormat({name: "animated.heic", type: "image/heic-sequence"}), undefined);
  } finally {environment.restore();}
});
test("a decoder that ignores requested bounds closes its bitmap and cannot populate preview cache", async () => {
  const environment = await browserMocks(); let closed = 0;
  try {
    globalThis.createImageBitmap = (async () => ({width: 1920, height: 1200, close() {closed++;}})) as any;
    await assert.rejects(boundedPhotoBitmap(file(), {width: 1920, height: 1200}, 256), /resize.*safely/);
    await assert.rejects(localPhoto(file()), /HEIC is not supported/);
    const resources = new LocalResources();
    await assert.rejects(resources.load({id: "public", file: file(), filename: "public.heic", date: "2026-10-01", dateSource: "selected", width: 1920, height: 1200}, "preview"), /HEIC is not supported/);
    assert.equal(resources.decodedBytes, 0); assert.equal(closed, 3);
  } finally {environment.restore();}
});
test("native HEIC previews remain bounded and clear releases their cache", async () => {
  const environment = await browserMocks(), resources = new LocalResources();
  try {
    const photo = await localPhoto(file()), thumbnail = await resources.load(photo, "thumbnail"), preview = await resources.load(photo, "preview");
    assert.deepEqual([thumbnail.width, thumbnail.height], [512, 320]); assert.deepEqual([preview.width, preview.height], [1600, 1000]);
    assert.equal(preview.blob.type, "image/jpeg"); assert.ok(resources.decodedBytes <= LOCAL_RASTER_BUDGET);
    assert.equal(await resources.load(photo, "preview"), preview); assert.equal(environment.closed, 3);
    resources.clear(); assert.equal(resources.decodedBytes, 0);
  } finally {resources.clear(); environment.restore();}
});
test("Clear between preview completion and the caller continuation cannot publish an old Blob URL", async () => {
  const environment = await browserMocks(), resources = new LocalResources(), oldCreate = URL.createObjectURL; let urls = 0;
  try {
    URL.createObjectURL = () => {urls++; return "blob:withdrawn-preview";};
    globalThis.document = {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage() {}}), toBlob: (callback: (value: Blob) => void) => {
      setTimeout(() => {callback(new Blob([jpeg], {type: "image/jpeg"})); queueMicrotask(() => resources.clear());}, 0);
    }})} as any;
    await assert.rejects(resources.load({id: "public", file: file(), filename: "public.heic", date: "2026-10-01", dateSource: "selected", width: 1920, height: 1200}, "preview"), /Photos were cleared/);
    assert.equal(resources.decodedBytes, 0); assert.equal(urls, 0); assert.equal(environment.closed, 1);
  } finally {URL.createObjectURL = oldCreate; resources.clear(); environment.restore();}
});
test("manual HEIC Save encrypts the exact original with canonical MIME and bounded JPEG derivatives", async () => {
  const environment = await browserMocks();
  try {
    for (const type of ["image/heic", "image/heif", ""]) {
      await clearAccount(owner); const session = await open(), original = file(type), pending = await stageImport(original);
      const metadataPart = pending.parts.find(part => part.binding.kind === "metadata")!, originalPart = pending.parts.find(part => part.binding.kind === "original")!;
      const cipher = async (part: typeof metadataPart) => (await get<Uint8Array>("staging", pending.stagingKeys[pending.parts.indexOf(part)]))!;
      const metadataKey = unwrapKey(pending.wrapped, session.vaultKey), metadataBytes = await collect(decryptMedia(source(await cipher(metadataPart)), metadataKey, metadataPart.binding));
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)), originalKey = unb64(metadata.representationKeys[originalPart.binding.representationId]);
      const restored = await collect(decryptMedia(source(await cipher(originalPart)), originalKey, originalPart.binding));
      assert.equal(metadata.mediaType, "image/heic"); assert.equal(metadata.filename, original.name); assert.equal(metadata.originalBytes, heic.length);
      assert.equal(metadata.originalSha256, pending.sourceDigest); assert.deepEqual(restored, heic);
      assert.deepEqual(new Uint8Array(await original.arrayBuffer()), heic);
      assert.notDeepEqual(await cipher(originalPart), heic);
      metadataKey.fill(0); metadataBytes.fill(0); originalKey.fill(0); restored.fill(0);
    }
    assert.equal(environment.workers, 3); assert.deepEqual(environment.sizes, Array(3).fill([{width: 256, height: 160}, {width: 1600, height: 1000}]).flat());
  } finally {environment.restore(); lockVault(); await clearAccount(owner);}
});
test("HEIC capture dates reach grouping, date search and manual Save while preserving exact originals", async () => {
  const environment = await browserMocks();
  try {
    await clearAccount(owner); const session = await open();
    const bytes = gridHeicWithExif(heic);
    const original = new File([bytes], "camera.heic", {type: "image/heic", lastModified: Date.parse("2026-10-04T12:00:00Z")});
    const photo = await localPhoto(original), expected = new Date(HEIC_CAPTURE_CLOCK.slice(0, 10).replaceAll(":", "-") + "T" + HEIC_CAPTURE_CLOCK.slice(11)).toISOString();
    assert.equal(photo.date, expected); assert.equal(photo.dateSource, "exif"); assert.equal(photo.captureVerified, true);
    assert.equal(captureGroup(photo).key, "2026-8-1");
    assert.deepEqual(new PhotoSearchIndex([photo]).search("September 2026").photoIds, [photo.id]);
    assert.deepEqual(new PhotoSearchIndex([photo]).search("October 2026").photoIds, [], "File modification/selection dates do not enter capture-date search");
    const pending = await stageImport(original), metadataPart = pending.parts.find(part => part.binding.kind === "metadata")!, originalPart = pending.parts.find(part => part.binding.kind === "original")!;
    const cipher = async (part: typeof metadataPart) => (await get<Uint8Array>("staging", pending.stagingKeys[pending.parts.indexOf(part)]))!;
    const metadataKey = unwrapKey(pending.wrapped, session.vaultKey), metadataBytes = await collect(decryptMedia(source(await cipher(metadataPart)), metadataKey, metadataPart.binding));
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)), originalKey = unb64(metadata.representationKeys[originalPart.binding.representationId]);
    const restored = await collect(decryptMedia(source(await cipher(originalPart)), originalKey, originalPart.binding));
    assert.equal(metadata.sourceDate, expected); assert.equal(metadata.dateSource, "exif"); assert.equal(metadata.mediaType, "image/heic");
    assert.equal(metadata.originalSha256, pending.sourceDigest); assert.equal(Buffer.from(unb64(pending.sourceDigest)).toString("hex"), photo.digest);
    assert.deepEqual(restored, bytes); assert.deepEqual(new Uint8Array(await original.arrayBuffer()), bytes);
    metadataKey.fill(0); metadataBytes.fill(0); originalKey.fill(0); restored.fill(0);
  } finally {environment.restore(); lockVault(); await clearAccount(owner);}
});
test("unsupported native HEIC decode and unsafe dimensions stop before encryption or durable staging", async () => {
  const environment = await browserMocks();
  try {
    await clearAccount(owner); await open(); let decodes = 0;
    globalThis.createImageBitmap = (async () => {decodes++; throw new DOMException("Unsupported codec", "InvalidStateError");}) as typeof createImageBitmap;
    await assert.rejects(stageImport(file()), /HEIC_NATIVE_DECODE_UNAVAILABLE/);
    const giant = new Uint8Array(heic); new DataView(giant.buffer).setUint32(541, 100_000);
    await assert.rejects(stageImport(new File([giant], "unsafe.heic", {type: "image/heic"})), /SOURCE_DIMENSIONS_UNAVAILABLE/);
    assert.equal(decodes, 1); assert.equal(environment.workers, 0);
    assert.equal((await all("staging")).filter(([key]) => key.startsWith(owner + ":")).length, 0);
    assert.equal((await all("journal")).filter(([key]) => key.startsWith(owner + ":")).length, 0);
  } finally {environment.restore(); lockVault(); await clearAccount(owner);}
});
test("cancel or account replacement while native preview is decoding cannot start encryption", async () => {
  const environment = await browserMocks();
  try {
    for (const change of ["cancel", "account"]) {
      await open(); const controller = new AbortController(); let began!: () => void, release!: (image: ImageBitmap) => void, closed = 0;
      const started = new Promise<void>(resolve => {began = resolve;});
      globalThis.createImageBitmap = (async () => {began(); return new Promise<ImageBitmap>(resolve => {release = resolve;});}) as typeof createImageBitmap;
      const staging = stageImport(file(), undefined, controller.signal), rejected = assert.rejects(staging, change === "cancel" ? {name: "AbortError"} : /VAULT_LOCKED/);
      await started;
      if (change === "cancel") controller.abort(); else await open(other);
      release({width: 256, height: 160, close() {closed++;}} as ImageBitmap); await rejected;
      assert.equal(closed, 1); assert.equal(environment.workers, 0); assert.equal(requireVault().accountId, change === "cancel" ? owner : other);
    }
  } finally {environment.restore(); lockVault(); await clearAccount(owner); await clearAccount(other);}
});
