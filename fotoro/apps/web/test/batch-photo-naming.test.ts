import test from "node:test";
import {canRestorePhotoNames} from "../src/library/batch-photo-naming";
import assert from "node:assert/strict";
import {planPhotoNames, validPhotoName, withPhotoOrganization, photoName} from "@fotoro/contracts/organization";

test("batch naming is selected-only, order independent and resolves reserved/case collisions", () => {
  const sources = [{id: "b", filename: "IMG.JPG"}, {id: "a", filename: "IMG.JPG"}];
  const plan = planPhotoNames(sources, ["IMG.JPG", "IMG_2.JPG"]);
  assert.deepEqual(plan.map(entry => [entry.id, entry.name]), [["a", "IMG_3.JPG"], ["b", "IMG_4.JPG"]]);
  assert.deepEqual(planPhotoNames([...sources].reverse(), ["IMG.JPG", "IMG_2.JPG"]), plan);
  assert.equal(sources[0].filename, "IMG.JPG");
  assert.throws(() => planPhotoNames([sources[0], sources[0]]));
});
test("batch names preserve extension, digest evidence and Unicode limits across suffix collisions", () => {
  const source = {id: "a", filename: "original.PNG", digest: "a".repeat(64), location: {name: "東京".repeat(150)}};
  const initial = planPhotoNames([source])[0];
  const plan = planPhotoNames([source], [initial.name]);
  assert.equal(validPhotoName(plan[0].name), true);
  assert.match(plan[0].name, /_2\.png$/);
  assert.equal(plan[0].digest, source.digest);
});
test("batch preview and name-only undo preserve original names and unrelated facts", () => {
  const source = {id: "a", filename: "IMG.JPG", facts: ["Exact words", "fotoro.name.v1:Reviewed.jpg"]};
  const entry = planPhotoNames([source])[0];
  assert.equal(entry.previousName, "Reviewed.jpg");
  const applied = withPhotoOrganization(source, {name: entry.name});
  const intervening = withPhotoOrganization(applied, {screenshot: true});
  const undone = withPhotoOrganization(intervening, {name: entry.previousName});
  assert.equal(photoName(undone, source.filename), "Reviewed.jpg");
  assert.ok(undone.facts.includes("Exact words"));
  assert.ok(undone.facts.includes("fotoro.screenshot.v1:true"));
  assert.equal(undone.filename, source.filename);
  assert.equal(planPhotoNames([{id: "new", filename: "Original.jpg"}])[0].previousName, null);
});


test("Undo rejects newly reserved prior names, including un-restored selected photos", () => {
  const sources = [{id: "a", filename: "first.jpg", facts: ["fotoro.name.v1:Original.jpg"]}, {id: "b", filename: "second.jpg", facts: ["fotoro.name.v1:Other.jpg"]}];
  const plan = planPhotoNames(sources);
  const applied = sources.map((source, index) => withPhotoOrganization(source, {name: plan[index].name}));
  assert.equal(canRestorePhotoNames(plan, applied, []), true);
  assert.equal(canRestorePhotoNames(plan, applied, ["ORIGINAL.JPG"]), false);
  const outsider = withPhotoOrganization({id: "c", filename: "third.jpg"}, {name: "Original.jpg"});
  assert.equal(canRestorePhotoNames(plan, [...applied, outsider], []), false);
  assert.equal(canRestorePhotoNames(plan.slice(0, 1), [applied[0], withPhotoOrganization(applied[1], {name: "Original.jpg"})], []), false);
});

test("Undo restores duplicate original filenames despite external reservations", () => {
  const sources = [{id: "a", filename: "Café.jpg"}, {id: "b", filename: "Café.jpg"}];
  const plan = planPhotoNames(sources);
  assert.equal(canRestorePhotoNames(plan, sources, []), true);
  assert.equal(canRestorePhotoNames(plan, sources, ["Cafe\u0301.jpg"]), true);
});
