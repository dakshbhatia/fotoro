import test from "node:test";
import assert from "node:assert/strict";
import {AlbumActionQueue} from "../src/albums/action-queue";
import {loadAlbumSearchPages} from "../src/albums/search-loading";

test("search automatically reaches the final metadata page and uses the latest continuation after refresh", async () => {
  let page = {hasMore: true, nextCursor: "100"}, loads: string[] = [];
  const queue = new AlbumActionQueue(() => true, () => {});
  await queue.run(async () => {page = {hasMore: true, nextCursor: "refreshed-100"};});
  await loadAlbumSearchPages({queue, current: () => true, page: () => page, load: async cursor => {
    loads.push(cursor); page = loads.length === 1 ? {hasMore: true, nextCursor: "200"} : {hasMore: false, nextCursor: ""};
  }});
  assert.deepEqual(loads, ["refreshed-100", "200"]);
});

test("cleared filters keep the completed page but stop requesting more; errors never retry automatically", async () => {
  for (const fail of [false, true]) {
    let active = true, requests = 0, page = {hasMore: true, nextCursor: "100"};
    const queue = new AlbumActionQueue(() => true, () => {});
    const work = loadAlbumSearchPages({queue, current: () => active, page: () => page, load: async () => {
      requests++; if (fail) throw new Error("offline");
      page = {hasMore: true, nextCursor: "200"}; active = false;
    }});
    if (fail) await assert.rejects(work, /offline/); else await work;
    assert.equal(requests, 1);
  }
});

test("invalid or repeated continuation cannot spin a search request loop", async () => {
  for (const nextCursor of [undefined, "100"]) {
    let requests = 0;
    await assert.rejects(loadAlbumSearchPages({queue: new AlbumActionQueue(() => true, () => {}), current: () => true,
      page: () => ({hasMore: true, nextCursor}), load: async () => {requests++;}}), /ALBUM_PAGE_MISMATCH/);
    assert.equal(requests, nextCursor ? 1 : 0);
  }
});
