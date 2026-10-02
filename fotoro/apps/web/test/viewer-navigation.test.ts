import test from "node:test";
import assert from "node:assert/strict";
import {viewerPhotoIndex} from "../src/library/Viewer";
import type {Photo} from "../src/library/catalog";

const photo = (id: string) => ({manifest: {photoId: id}} as Photo);
test("saved viewer keeps the displayed photo through catalog insertion and reordering", () => {
  const selected = "b", original = [photo("a"), photo("b"), photo("c")], refreshed = [photo("new"), photo("c"), photo("a"), photo("b")];
  assert.equal(original[viewerPhotoIndex(original, selected)].manifest.photoId, selected);
  assert.equal(refreshed[viewerPhotoIndex(refreshed, selected)].manifest.photoId, selected);
  assert.equal(viewerPhotoIndex(refreshed, selected) + 1, 4);
});
test("removing the viewed photo uses a valid first photo instead of an out-of-range counter", () => {
  const remaining = [photo("a")];
  const index = viewerPhotoIndex(remaining, "c");
  assert.equal(index, 0); assert.equal(remaining[index].manifest.photoId, "a");
  assert.equal(viewerPhotoIndex([], "c"), 0);
});
