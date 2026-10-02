import test from "node:test";
import assert from "node:assert/strict";
import {mergeConsumerSearchPhotos as merge} from "../src/library/consumer-search";

test("combined canvas keeps local objects and source order when saved originals overlap", () => {
  const a = {id: "a", source: "local"}, b = {id: "b", source: "local"};
  const duplicate = {id: "a", source: "saved"}, c = {id: "c", source: "saved"};
  const sameSavedID = {id: "c", source: "another saved record"};
  const local = [a, b], saved = [duplicate, c, sameSavedID];
  const result = merge(local, saved);
  assert.deepEqual(result, [a, b, c, sameSavedID]);
  assert.equal(result[0], a);
  assert.equal(result[2], c);
  assert.deepEqual(local, [a, b]);
  assert.deepEqual(saved, [duplicate, c, sameSavedID]);
  assert.deepEqual(merge([], saved), saved);
  assert.deepEqual(merge(local, []), local);
});

test("combining large local and saved libraries uses a linear identity-read budget", () => {
  const count = 2000;
  let identityReads = 0;
  const records = (prefix: string) => Array.from({length: count}, (_, index) => ({
    get id() {identityReads++; return prefix + index;},
  }));
  const result = merge(records("local:"), records("saved:"));
  assert.equal(result.length, count * 2);
  assert.ok(identityReads <= count * 4, `${identityReads} identity reads exceed the linear budget`);
});
