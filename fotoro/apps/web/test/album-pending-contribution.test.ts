import test from "node:test";
import assert from "node:assert/strict";
import type {Photo} from "../src/library/catalog";
import {PendingAlbumContribution} from "../src/albums/pending-contribution";
import {savedOriginalSelectionCurrent} from "../src/library/system-share";
const photo = () => ({manifest: {photoId: "saved-id"}, metadata: {filename: "chosen.jpg"}, metadataKey: new Uint8Array([1, 2, 3])} as Photo);

test("failed add preserves the exact Saved snapshot; retry never reimports or follows later source mutation", async () => {
  const original = photo(), choice = new PendingAlbumContribution([original], () => true);
  let captured: readonly Photo[] = [];
  await assert.rejects(choice.add(async selected => {captured = selected; throw new TypeError("offline");}), /offline/);
  original.metadata.filename = "later-name.jpg";
  assert.equal(await choice.add(async selected => {
    assert.equal(selected, captured); assert.equal(selected[0].metadata.filename, "chosen.jpg"); return 1;
  }), 1);
  assert.ok(captured[0].metadataKey.every(byte => byte === 0));
  assert.deepEqual([...original.metadataKey], [1, 2, 3], "Releasing the choice preserves the Saved catalog source key");
});

test("close, replacement, vault or source withdrawal prevents retries and wipes copied keys", async () => {
  for (const duringRequest of [false, true]) {
    const original = photo(); let admitted = true, captured: readonly Photo[] = [];
    const choice = new PendingAlbumContribution([original], () => admitted);
    await assert.rejects(choice.add(async selected => {captured = selected; throw new Error("offline");}));
    if (!duringRequest) admitted = false;
    await assert.rejects(choice.add(async () => {
      assert.ok(duringRequest, "Withdrawn choice cannot begin another add"); admitted = false; return 1;
    }), {name: "AbortError"});
    assert.equal(choice.current, false); assert.ok(captured[0].metadataKey.every(byte => byte === 0));
    admitted = true;
    await assert.rejects(choice.add(async () => assert.fail("An invalidated choice cannot revive")), {name: "AbortError"});
    assert.deepEqual([...original.metadataKey], [1, 2, 3]);
  }
});

test("explicit cancellation after a failed add releases the choice and blocks a queued retry", async () => {
  const choice = new PendingAlbumContribution([photo()], () => true);
  let captured: readonly Photo[] = [];
  await assert.rejects(choice.add(async selected => {captured = selected; throw new Error("offline");}));
  choice.cancel();
  assert.ok(captured[0].metadataKey.every(byte => byte === 0));
  await assert.rejects(choice.add(async () => assert.fail()), {name: "AbortError"});
});

test("an already-Saved source changed after failed addition cannot be replaced under the retained choice", async () => {
  const original = {...photo(), manifest: {photoId: "saved-id", ownerAccountId: "owner"}} as Photo;
  let catalog: Photo[] = [original], captured: readonly Photo[] = [];
  const choice = new PendingAlbumContribution([original], selected =>
    savedOriginalSelectionCurrent(selected, catalog, new Set(["saved-id"]), "owner"));
  await assert.rejects(choice.add(async selected => {captured = selected; throw new Error("offline");}));
  catalog = [{...original, metadata: {...original.metadata, filename: "replaced.jpg"}}];
  await assert.rejects(choice.add(async () => assert.fail("Changed source must not reach add")), {name: "AbortError"});
  assert.ok(captured[0].metadataKey.every(byte => byte === 0));
  catalog = [original]; assert.equal(choice.current, false, "Replacing the catalog again cannot revive a discarded private choice");
});
