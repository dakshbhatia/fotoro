import test from "node:test";
import assert from "node:assert/strict";
import {prepareChosenOriginals} from "../src/local/LocalTrial";
import {OriginalShareAttempt, savedOriginalSelectionCurrent} from "../src/library/system-share";
import type {LocalPhoto} from "../src/local/resources";
import type {Photo} from "../src/library/catalog";

const localPhoto = (id: string): LocalPhoto => ({id, digest: id, filename: id + ".png", date: "2026-10-01", dateSource: "selected", file: new File([id], id + ".png")});
const savedPhoto = (id: string): Photo => ({manifest: {photoId: id, ownerAccountId: "owner", representations: []},
  metadata: {filename: id + ".png", mediaType: "image/png", originalSha256: id}, metadataKey: new Uint8Array(32)} as unknown as Photo);

test("one mixed Share contains the exact local original and every verified saved resource", async () => {
  const local = localPhoto("local"), saved = savedPhoto("live"), bytes = new Uint8Array([1, 2, 3]);
  const still = new File(["still"], "live.heic"), motion = new File(["motion"], "live.mov");
  const files = await prepareChosenOriginals([local], [saved], new AbortController().signal, () => true, async (photo, kind) => {
    assert.equal(photo, saved); assert.equal(kind, "original"); return bytes;
  }, () => [still, motion]);
  assert.deepEqual(files, [local.file, still, motion]); assert.equal(files[0], local.file);
  assert.deepEqual(bytes, new Uint8Array(3));
  let dispatched = false;
  const pending = new OriginalShareAttempt().runFiles(files, () => true, {canShare: () => true, share: async data => {
    dispatched = true; assert.deepEqual(data.files, [local.file, still, motion]);
  }, download: () => assert.fail("Sharing cannot split the chosen set into downloads")});
  assert.equal(dispatched, true); assert.equal(await pending, "shared");
});

test("saved-only and local-only batches preserve their exact originals", async () => {
  const local = localPhoto("local"), saved = savedPhoto("saved"), original = new File(["saved original"], "saved.png");
  assert.deepEqual(await prepareChosenOriginals([], [saved], new AbortController().signal, () => true, async () => new Uint8Array([1]), () => [original]), [original]);
  assert.deepEqual(await prepareChosenOriginals([local], [], new AbortController().signal, () => true, async () => assert.fail("No saved source to read")), [local.file]);
});

test("retained previews and revoked local sources cannot enter a mixed batch", async () => {
  for (const local of [{...localPhoto("local"), file: undefined, preview: new Blob(["preview"])}, {...localPhoto("local"), current: () => false}]) {
    await assert.rejects(prepareChosenOriginals([local], [savedPhoto("saved")], new AbortController().signal, () => true,
      async () => assert.fail("An incomplete local selection must stop before reading saved originals")), {name: "AbortError"});
  }
});

test("delayed mixed preparation rechecks selection, account, local and saved source withdrawal before publication", async () => {
  for (const change of ["selection", "account", "saved source", "local source", "abort"]) {
    const local = localPhoto("local"), saved = [savedPhoto("a"), savedPhoto("b")], selected = new Set(["a", "b"]), controller = new AbortController();
    let account = "owner", catalog = saved, localCurrent = true, reads = 0, extractions = 0, resolve!: (bytes: Uint8Array) => void;
    const delayed = new Promise<Uint8Array>(done => {resolve = done;});
    const current = () => localCurrent && savedOriginalSelectionCurrent(saved, catalog, selected, account);
    const pending = prepareChosenOriginals([local], saved, controller.signal, current, async () => {reads++; return delayed;}, () => {extractions++; return [new File(["saved"], "saved.png")];});
    const rejected = assert.rejects(pending, {name: "AbortError"});
    if (change === "selection") selected.delete("b");
    if (change === "account") account = "other";
    if (change === "saved source") catalog = [savedPhoto("replacement"), saved[1]];
    if (change === "local source") localCurrent = false;
    if (change === "abort") controller.abort();
    const bytes = new Uint8Array([1, 2, 3]); resolve(bytes); await rejected;
    assert.equal(reads, 1, change); assert.equal(extractions, 0, change); assert.deepEqual(bytes, new Uint8Array(3));
  }
});
