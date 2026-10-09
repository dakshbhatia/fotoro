import test from "node:test";
import assert from "node:assert/strict";
import {saveTripFiles, tripSavedSources} from "../src/albums/import";
import type {Photo} from "../src/library/catalog";
import type {PendingImport} from "../src/exchange/journal";
const file = (name: string) => new File([name], name, {type: "image/jpeg"});
const photo = (id: string) => ({manifest: {photoId: id}} as Photo);
function harness() {
  const staged: string[] = [], a = photo("a"), b = photo("b"), other = photo("other");
  let current = true, pending = false, drains = 0;
  const controller = new AbortController();
  return {staged, controller, setCurrent: (value: boolean) => {current = value;}, setPending: (value: boolean) => {pending = value;}, drains: () => drains, a, b,
    options: {signal: controller.signal, current: () => current,
      stage: async (file: File) => {staged.push(file.name); return file.name;},
      drain: async () => {drains++;}, unresolved: async () => pending,
      load: async (ids: readonly string[]) => {assert.deepEqual(ids, staged); return [other, b, a];},
    },
  };
}
test("device contribution saves only chosen files and returns their exact Saved objects in choice order", async () => {
  const h = harness();
  assert.deepEqual(await saveTripFiles([file("a"), file("b")], h.options), [h.a, h.b]);
  assert.deepEqual(h.staged, ["a", "b"]); assert.equal(h.drains(), 3);
});
test("empty and over100 choices stage nothing and do not start saving", async () => {
  for (const files of [[], Array.from({length: 101}, () => file("a"))]) {
    const h = harness(); await assert.rejects(saveTripFiles(files, h.options), /TRIP_CHOOSE_1_TO_100_FILES/);
    assert.equal(h.staged.length, 0); assert.equal(h.drains(), 0);
  }
});
test("unresolved prior saves stop the device contribution before staging or loading", async () => {
  const h = harness(); h.setPending(true);
  await assert.rejects(saveTripFiles([file("a")], {...h.options, load: async () => assert.fail("must not load")}), /TRIP_SAVE_INCOMPLETE/);
  assert.deepEqual(h.staged, []);
});
test("scope cancellation during saving cannot load or contribute originals", async () => {
  const h = harness();
  await assert.rejects(saveTripFiles([file("a"), file("b")], {...h.options,
    stage: async file => {h.setCurrent(false); return file.name;},
    load: async () => assert.fail("must not load"),
  }), /Trip closed|VAULT_LOCKED/);
});
test("failed source and missing Saved source never return a partial contribution", async () => {
  const h = harness();
  await assert.rejects(saveTripFiles([file("a")], {...h.options, stage: async () => {throw new Error("SOURCE_FORMAT_MISMATCH");}, load: async () => assert.fail("must not load")}), /SOURCE_FORMAT_MISMATCH/);
  await assert.rejects(saveTripFiles([file("a")], {...h.options, load: async () => []}), /TRIP_SAVE_INCOMPLETE/);
});

test("reused Saved ids and exact duplicate device originals contribute once", async () => {
  const h = harness(), a = {...h.a, metadata: {originalSha256: "same"}} as Photo, b = {...h.b, metadata: {originalSha256: "same"}} as Photo;
  assert.deepEqual(await saveTripFiles([file("a"), file("b")], {...h.options, load: async () => [a, b]}), [a]);
  assert.deepEqual(await saveTripFiles([file("a"), file("a")], {...h.options, load: async () => [a]}), [a]);
});

test("selected uploads hydrate exact committed manifests without requiring the whole browse catalog", () => {
  const source = (id: string): PendingImport => ({photoId: id, state: "committed", sourceDigest: "x".repeat(43),
    manifest: {photoId: id, ownerAccountId: "owner"}} as PendingImport);
  const chosen = source("chosen"), unrelated = {...source("other"), state: "failed" as const};
  assert.deepEqual(tripSavedSources(["chosen", "chosen"], "owner", [unrelated, chosen]), [
    {photoId: "chosen", ownerAccountId: "owner", originalSha256: chosen.sourceDigest, manifest: chosen.manifest},
  ]);
  for (const pending of [[], [{...chosen, state: "queued"}], [{...chosen, sourceDigest: "wrong"}],
    [{...chosen, manifest: {...chosen.manifest!, ownerAccountId: "another"}}],
    [{...chosen, manifest: {...chosen.manifest!, photoId: "replaced"}}]]) {
    assert.throws(() => tripSavedSources(["chosen"], "owner", pending as PendingImport[]), /TRIP_SAVE_INCOMPLETE/);
  }
});
