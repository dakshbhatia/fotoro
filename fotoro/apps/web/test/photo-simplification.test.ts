import test from "node:test";
import assert from "node:assert/strict";
import {newPhotoTag} from "../src/local/tags";
import {recentBrowseActive, inBrowseRange} from "../src/local/consumer-range";
import {PhotoSearchIndex} from "../src/local/search";
import type {LocalPhoto} from "../src/local/resources";

test("tags keep the supplied words and refuse duplicate search identities or capacity overflow", () => {
  const tags = ["BTS", "Café", "Family  trip"];
  assert.equal(newPhotoTag("  Grandma’s house  ", tags), "Grandma’s house");
  for (const value of ["bts", "CAFE", "family trip", " ", "a".repeat(121)]) assert.equal(newPhotoTag(value, tags), undefined);
  assert.equal(newPhotoTag("new", Array.from({length: 64}, (_, i) => String(i))), undefined);
  assert.deepEqual(tags, ["BTS", "Café", "Family  trip"]);
});

test("BTS and a recorded place remain findable in older available photos while recent browsing stays recent", () => {
  let permitted = true;
  const photo: LocalPhoto = {id: "older", filename: "old.jpg", date: "2018-02-03T12:00:00Z", dateSource: "exif",
    labels: ["BTS"], location: {latitude: 37.5665, longitude: 126.978, source: "exif", name: "Seoul"}, current: () => permitted};
  assert.equal(inBrowseRange(photo, recentBrowseActive(true, ""), false), false);
  for (const query of ["BTS", "Seoul", "BTS in 2018"]) {
    const available = [photo].filter(value => inBrowseRange(value, recentBrowseActive(true, query), false));
    const index = new PhotoSearchIndex(available);
    assert.deepEqual(index.search(query).photoIds, [photo.id]);
    permitted = false; assert.deepEqual(index.search(query).photoIds, []); permitted = true;
  }
  assert.equal(recentBrowseActive(true, "  "), true);
});
