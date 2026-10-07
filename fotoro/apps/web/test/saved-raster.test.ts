import test from "node:test";
import assert from "node:assert/strict";
import {leaseSavedRaster, savedRasterSource} from "../src/library/saved-raster";
import {readViewerPreview} from "../src/library/viewer-preview";
import type {Photo} from "../src/library/catalog";

const photo = (kinds = ["thumbnail", "preview", "original"]) => ({manifest: {ownerAccountId: "owner", photoId: "photo",
  representations: kinds.map(kind => ({binding: {kind, representationId: kind}, objectId: kind, ciphertextSha256: kind + "-digest"}))},
  metadata: {originalSha256: "original"}} as Photo);
test("absent derivatives never read an original during thumbnail or viewer browsing", async () => {
  let reads = 0;const read = async () => {reads++; return new Uint8Array([1]);};
  await assert.rejects(leaseSavedRaster(photo(["original"]), "thumbnail", new AbortController().signal, () => true, read), /preview unavailable/);
  await assert.rejects(readViewerPreview(photo(["original"]), new AbortController().signal, () => true, read), /preview unavailable/);
  assert.equal(reads, 0);
});
test("a missing thumbnail may use only an available preview and releases its mounted URL on abort", async () => {
  const controller = new AbortController(), bytes = new Uint8Array([1, 2, 3]), revoked: string[] = [];
  let displayed: Uint8Array | undefined;
  const url = await leaseSavedRaster(photo(["preview", "original"]), "thumbnail", controller.signal, () => true,
    async (_photo, kind, signal) => {assert.equal(kind, "preview"); assert.equal(signal, controller.signal);return bytes;},
    (_key, source, type, decodedBytes) => {displayed = new Uint8Array(source);assert.equal(type, "image/jpeg");assert.equal(decodedBytes,1600 * 1600 * 4);return "blob:mounted";},
    value => revoked.push(value));
  assert.equal(url,"blob:mounted");assert.deepEqual(displayed,new Uint8Array([1,2,3]));assert.deepEqual(bytes,new Uint8Array(3));
  assert.deepEqual(revoked,[]);controller.abort();controller.abort();assert.deepEqual(revoked,["blob:mounted"]);
});
test("withdrawn scope or cancellation wipes late bytes without publishing a URL",async()=>{
  for(const abort of [false,true]){
    const controller=new AbortController(),bytes=new Uint8Array([9]);let available=true,created=0;
    assert.equal(await leaseSavedRaster(photo(),"thumbnail",controller.signal,()=>available,
      async()=>{if(abort)controller.abort();else available=false;return bytes;},()=>{created++;return "blob:late";}),undefined);
    assert.equal(created,0);assert.deepEqual(bytes,new Uint8Array(1));
  }
});
test("saved raster identity survives annotation changes while fencing representation and received access",()=>{
  const source=photo(),key=savedRasterSource(source,"thumbnail");
  assert.equal(savedRasterSource({...source,annotations:{labels:["reviewed"]} as Photo["annotations"]},"thumbnail"),key);
  assert.notEqual(savedRasterSource({...source,grantId:"received"},"thumbnail"),key);
  assert.notEqual(savedRasterSource({...source,metadata:{...source.metadata,originalSha256:"replacement"}},"thumbnail"),key);
  assert.notEqual(savedRasterSource(photo(["preview","original"]),"thumbnail"),key);
});
