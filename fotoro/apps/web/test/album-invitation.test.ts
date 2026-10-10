import test from "node:test";
import assert from "node:assert/strict";
import {copyAlbumInvitation} from "../src/albums/invitation";

test("trip invitation can still be copied manually when the clipboard is absent or denied", async () => {
  const link = "https://fotoro.cloud/#album=public-invitation";
  assert.equal(await copyAlbumInvitation(link, () => true), "manual");
  assert.equal(await copyAlbumInvitation(link, () => true, {writeText: async () => {throw new DOMException("Permission denied", "NotAllowedError");}}), "manual");
  let copied = "";
  assert.equal(await copyAlbumInvitation(link, () => true, {writeText: async value => {copied = value;}}), "copied");
  assert.equal(copied, link);
});

test("a closed or replaced trip cannot copy or publish a late clipboard result", async () => {
  await copyAlbumInvitation("public-link", () => false, {writeText: async () => assert.fail("Closed trip must not invoke clipboard")});
  for (const denied of [false, true]) {
    let current = true;
    const result = await copyAlbumInvitation("public-link", () => current, {writeText: async () => {current = false; if (denied) throw new Error("denied");}});
    assert.equal(result, undefined);
  }
});
