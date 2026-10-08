import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {CaptureMetadataInfo} from "../src/library/CaptureMetadataInfo";
import {PhotoSearchIndex} from "../src/local/search";
const digest = "A".repeat(43);
const facts = ["My exact family note", "fotoro.capture.v1:source:" + digest,
  'fotoro.capture.v1:item:{"k":"cameraModel","p":"original","v":"Public Camera"}',
  'fotoro.capture.v1:item:{"k":"subtypes","p":"photos","v":"hdr,livePhoto"}',
];
test("account capture evidence has clean Info rows and source-bound search, while raw private markers stay hidden", () => {
  const markup = renderToStaticMarkup(createElement(CaptureMetadataInfo, {facts, originalSha256: digest}));
  assert.match(markup, /Camera and media/); assert.match(markup, /Public Camera/); assert.match(markup, /Original file/); assert.match(markup, /HDR, Live Photo/);
  assert.doesNotMatch(markup, /fotoro\.capture|"k"|people|GPS/);
  const current = {id: "one", digest, filename: "IMG_1234.jpg", date: "2026-10-07T00:00:00Z", dateSource: "photos" as const, facts};
  const stale = {...current, id: "two", digest: "B".repeat(43)};
  const index = new PhotoSearchIndex([current, stale]);
  for (const term of ["Public Camera", "Live Photo", "HDR"]) assert.deepEqual(index.search(term).photoIds, ["one"]);
  assert.equal(index.search("My exact family note").photoIds.length, 2);
  for (const term of ["fotoro", "capture", "source", "cameraModel", "original", "photos", digest, "GPS", "people"]) assert.deepEqual(index.search(term).photoIds, [], term);
  assert.equal(renderToStaticMarkup(createElement(CaptureMetadataInfo, {facts, originalSha256: stale.digest})), "");
});
test("malformed and future capture groups remain opaque instead of rendering or indexing their JSON", () => {
  for (const bad of [[...facts, facts[2]], ["fotoro.capture.v1:item:future hidden metadata"], ["fotoro.capture.v2:future hidden metadata"]]) {
    assert.equal(renderToStaticMarkup(createElement(CaptureMetadataInfo, {facts: bad, originalSha256: digest})), "");
    const index = new PhotoSearchIndex([{id: "one", digest, filename: "IMG_1234.jpg", date: "2026-10-07T00:00:00Z", dateSource: "photos", facts: bad}]);
    for (const term of ["Public Camera", "future", "hidden", "metadata", "fotoro"]) assert.equal(index.search(term).photoId, undefined);
  }
});
