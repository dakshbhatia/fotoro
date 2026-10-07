import test from "node:test";
import assert from "node:assert/strict";
import {CLOUD_PREVIEW_BYTES, cloudCapabilities, observeCloudPhoto, parseCloudObservation, prepareCloudPreview} from "../src/intelligence/cloud-photo";
const expectedAccountId = "00000000-0000-4000-8000-000000000001";
const binding = {photoId: "photo_1", sourceRevision: "digest_1"};
const result = () => ({version: 1, ...binding, processor: "gemini-3.8-flash", observedAt: "2026-10-06T12:00:00Z", observations: {objects: ["dog"], scene: [], visibleText: "", uncertainty: []}});
test("rejects stale results, invented personal copy and out-of-bounds output", () => {
  assert.deepEqual(parseCloudObservation(result(), binding), result());
  for (const invalid of [{...result(), photoId: "other"}, {...result(), sourceRevision: "other"}, {...result(), processor: "other-model"},
    {...result(), observations: {...result().observations, caption: "invented"}},
    {...result(), observations: {...result().observations, scene: new Array(7).fill("beach")}}]) {
    assert.throws(() => parseCloudObservation(invalid, binding), /CLOUD_RESULT_INVALID/);
  }
});
test("never requests pixels without literal per-photo consent, and rejects oversize payload", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {calls++; throw new Error("not expected");};
  try {
    await assert.rejects(observeCloudPhoto({apiBase: "https://test.invalid", expectedAccountId}, binding, new Blob(["preview"], {type: "image/jpeg"}), "gemini-3.8-flash", "yes" as any), /CLOUD_CONSENT_REQUIRED/);
    await assert.rejects(observeCloudPhoto({apiBase: "https://test.invalid", expectedAccountId}, binding, new Blob([new Uint8Array(CLOUD_PREVIEW_BYTES+1)], {type: "image/jpeg"}), "gemini-3.8-flash", "send-this-preview-to-google"), /CLOUD_PREVIEW_INVALID/);
    assert.equal(calls, 0);
  } finally {globalThis.fetch = previous;}
});
test("sends only request fields even when component props contain credentials and callbacks", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://test.invalid/v1/intelligence/observe");
    const wire = JSON.parse(options!.body as string);
    assert.deepEqual(Object.keys(wire).sort(), ["consent", "expectedAccountId", "model", "photoId", "preview", "sourceRevision", "version"]);
    assert.equal(wire.expectedAccountId, expectedAccountId);
    assert.equal(wire.preview.base64, btoa("preview"));
    assert.equal(options!.credentials, "include");
    assert.deepEqual(options!.headers, {"Content-Type": "application/json", Authorization: "Bearer opaque"});
    return new Response(JSON.stringify(result()));
  };
  try {
    const props = {...binding, apiBase: "https://test.invalid", expectedAccountId, token: "opaque", getPreview: () => undefined};
    assert.deepEqual(await observeCloudPhoto(props, props, new Blob(["preview"], {type: "image/jpeg"}), "gemini-3.8-flash", "send-this-preview-to-google"), result());
  } finally {globalThis.fetch = previous;}
});
test("disabled or unauthenticated capabilities remain unavailable", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async url => {assert.equal(url, "/v1/intelligence/capabilities?expectedAccountId=" + expectedAccountId); return new Response(JSON.stringify({version:1, enabled:false}));};
    assert.equal(await cloudCapabilities({apiBase: "", expectedAccountId}), false);
    globalThis.fetch = async () => new Response("", {status:401});
    assert.equal(await cloudCapabilities({apiBase: "", expectedAccountId}), false);
    globalThis.fetch = async () => new Response("", {status:403});
    assert.equal(await cloudCapabilities({apiBase: "", expectedAccountId}), false);
  } finally {globalThis.fetch = previous;}
});

test("oversized or unsupported source previews fail before the browser decoder runs", async () => {
  const previous = globalThis.createImageBitmap;
  let decodes = 0;
  globalThis.createImageBitmap = (async () => {decodes++; throw new Error("must not decode");}) as typeof createImageBitmap;
  try {
    const hugeHeader = new Uint8Array([255,216,255,192,0,11,8,0,8,127,255,1,1,17,0,255,217]);
    await assert.rejects(prepareCloudPreview(new Blob([hugeHeader],{type:"image/jpeg"})),/CLOUD_PREVIEW_INVALID/);
    await assert.rejects(prepareCloudPreview(new Blob([hugeHeader],{type:"image/png"})),/CLOUD_PREVIEW_INVALID/);
    assert.equal(decodes,0);
  } finally {globalThis.createImageBitmap = previous;}
});
