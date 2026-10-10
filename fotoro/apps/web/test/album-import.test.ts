import test from "node:test";
import assert from "node:assert/strict";
import {saveTripFiles, tripSavedSources, TripImportChoice} from "../src/albums/import";
import type {Photo} from "../src/library/catalog";
import type {PendingImport} from "../src/exchange/journal";
const file = (name: string) => new File([name], name, {type: "image/jpeg"});
const photo = (id: string) => ({manifest: {photoId: id}, metadata: {originalSha256: id}} as Photo);
function harness() {
  const staged: string[] = [], a = photo("a"), b = photo("b"), other = photo("other");
  let current = true, pending = false, drains = 0;
  const controller = new AbortController();
  return {staged, controller, choice: (files: readonly File[]) => new TripImportChoice(files, () => current), setCurrent: (value: boolean) => {current = value;}, setPending: (value: boolean) => {pending = value;}, drains: () => drains, a, b,
    options: {signal: controller.signal, current: () => current,
      stage: async (file: File) => {staged.push(file.name); return {photoId: file.name, sourceDigest: file.name};},
      drain: async () => {drains++;}, unresolved: async () => pending,
      load: async (ids: readonly string[]) => {assert.deepEqual(ids, staged); return [other, b, a];},
    },
  };
}
test("device contribution saves only chosen files and returns their exact Saved objects in choice order", async () => {
  const h = harness();
  assert.deepEqual(await saveTripFiles(h.choice([file("a"), file("b")]), h.options), [h.a, h.b]);
  assert.deepEqual(h.staged, ["a", "b"]); assert.equal(h.drains(), 2);
});
test("empty and over100 choices stage nothing and do not start saving", async () => {
  for (const files of [[], Array.from({length: 101}, () => file("a"))]) {
    const h = harness(); await assert.rejects(async () => saveTripFiles(h.choice(files), h.options), /TRIP_CHOOSE_1_TO_100_FILES/);
    assert.equal(h.staged.length, 0); assert.equal(h.drains(), 0);
  }
});
test("an unresolved chosen save stops further staging and cannot return a partial contribution", async () => {
  const h = harness(); h.setPending(true);
  await assert.rejects(saveTripFiles(h.choice([file("a")]), {...h.options, load: async () => assert.fail("must not load")}), /TRIP_SAVE_INCOMPLETE/);
  assert.deepEqual(h.staged, ["a"]);
});
test("scope cancellation during saving cannot load or contribute originals", async () => {
  const h = harness();
  await assert.rejects(saveTripFiles(h.choice([file("a"), file("b")]), {...h.options,
    stage: async file => {h.setCurrent(false); return {photoId: file.name, sourceDigest: file.name};},
    load: async () => assert.fail("must not load"),
  }), /Trip closed|VAULT_LOCKED/);
});
test("failed source and missing Saved source never return a partial contribution", async () => {
  const h = harness();
  await assert.rejects(saveTripFiles(h.choice([file("a")]), {...h.options, stage: async () => {throw new Error("SOURCE_FORMAT_MISMATCH");}, load: async () => assert.fail("must not load")}), /SOURCE_FORMAT_MISMATCH/);
  await assert.rejects(saveTripFiles(h.choice([file("a")]), {...h.options, load: async () => []}), /TRIP_SAVE_INCOMPLETE/);
});

test("reused Saved ids and exact duplicate device originals contribute once", async () => {
  const h = harness(), a = {...h.a, metadata: {originalSha256: "same"}} as Photo, b = {...h.b, metadata: {originalSha256: "same"}} as Photo;
  assert.deepEqual(await saveTripFiles(h.choice([file("a"), file("b")]), {...h.options, stage: async file => ({photoId: file.name, sourceDigest: "same"}), load: async () => [a, b]}), [a]);
  assert.deepEqual(await saveTripFiles(h.choice([file("a"), file("a")]), {...h.options, stage: async file => ({photoId: file.name, sourceDigest: "same"}), load: async () => [a]}), [a]);
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

test("explicit save retry resumes staged originals after a partial commit without staging fresh IDs", async () => {
  const h = harness(), files = [file("a"), file("b")], choice = new TripImportChoice(files, () => true);
  const drains: string[][] = []; let failed = false, retry = false;
  const options = {...h.options,
    stage: async (chosen: File) => {assert.equal(chosen, files[h.staged.length]); return h.options.stage(chosen);},
    drain: async (ids: readonly string[]) => {drains.push([...ids]); failed = !retry && ids.includes("b");},
    unresolved: async () => failed,
  };
  await assert.rejects(saveTripFiles(choice, options), /TRIP_SAVE_INCOMPLETE/);
  assert.deepEqual(h.staged, ["a", "b"]); assert.equal(choice.current, true);
  retry = true;
  assert.deepEqual(await saveTripFiles(choice, options), [h.a, h.b]);
  assert.deepEqual(h.staged, ["a", "b"], "Previously staged or committed originals must never get fresh IDs");
  assert.deepEqual(drains, [["a"], ["b"], ["a", "b"]]);
  choice.cancel(); assert.equal(choice.count, 0); assert.deepEqual(choice.sources, []);
});

test("retry finishes the failed first original before staging the rest of the exact choice", async () => {
  const h = harness(), choice = new TripImportChoice([file("a"), file("b")], () => true);
  h.setPending(true);
  await assert.rejects(saveTripFiles(choice, h.options), /TRIP_SAVE_INCOMPLETE/);
  assert.deepEqual(h.staged, ["a"]);
  h.setPending(false);
  assert.deepEqual(await saveTripFiles(choice, h.options), [h.a, h.b]);
  assert.deepEqual(h.staged, ["a", "b"]);
});

test("abort or scope withdrawal during saving discards retained files and prevents any replay", async () => {
  for (const reason of ["abort", "withdraw"] as const) {
    const h = harness(), choice = new TripImportChoice([file("a"), file("b")], () => reason !== "withdraw" || h.options.current());
    await assert.rejects(saveTripFiles(choice, {...h.options, drain: async () => {
      if (reason === "abort") h.controller.abort(); else h.setCurrent(false);
    }}), {name: "AbortError"});
    assert.equal(choice.current, false); assert.equal(choice.count, 0); assert.deepEqual(choice.sources, []);
    h.setCurrent(true);
    await assert.rejects(saveTripFiles(choice, {...h.options, signal: new AbortController().signal, stage: async () => assert.fail("Withdrawn choice cannot stage again"), drain: async () => assert.fail("Withdrawn choice cannot drain again")}), {name: "AbortError"});
  }
});

test("changed committed original binding invalidates retained selection before it can contribute", async () => {
  const h = harness(), choice = new TripImportChoice([file("a")], () => true);
  await assert.rejects(saveTripFiles(choice, {...h.options, load: async () => [{...h.a, metadata: {originalSha256: "replacement"}} as Photo]}), /TRIP_SOURCE_CHANGED/);
  assert.equal(choice.current, false); assert.equal(choice.count, 0);
});
