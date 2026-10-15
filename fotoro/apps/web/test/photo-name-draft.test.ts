import test from "node:test";
import assert from "node:assert/strict";
import {applyPhotoOrganizationDraft, createPhotoNameDraft, editPhotoNameDraft, reconcilePhotoNameDraft} from "../src/library/photo-name-draft";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {PhotoOrganization} from "../src/library/PhotoOrganization";

test("a synced name update preserves an edited filename verbatim and requires a deliberate choice", () => {
  const initial = createPhotoNameDraft("IMG_0001.JPG");
  const words = "BTS at Grandma’s – 東京.JPG";
  const draft = editPhotoNameDraft(initial, words);
  const received = reconcilePhotoNameDraft(draft, "Family trip.JPG");
  assert.equal(received.value, words);
  assert.equal(received.savedName, "Family trip.JPG");
  assert.equal(received.savedNameChanged, true);
  assert.deepEqual(draft, {savedName: "IMG_0001.JPG", value: words, savedNameChanged: false});
  const receivedAgain = reconcilePhotoNameDraft(received, "Seoul.JPG");
  assert.equal(receivedAgain.value, words);
  assert.equal(receivedAgain.savedName, "Seoul.JPG");
  assert.equal(receivedAgain.savedNameChanged, true);
  assert.deepEqual(createPhotoNameDraft(receivedAgain.savedName), {savedName: "Seoul.JPG", value: "Seoul.JPG", savedNameChanged: false});
});

test("untouched names follow saved updates and a completed own rename clears the draft notice", () => {
  const initial = createPhotoNameDraft("IMG_0001.JPG");
  assert.equal(reconcilePhotoNameDraft(initial, initial.savedName), initial);
  assert.deepEqual(reconcilePhotoNameDraft(initial, "Family trip.JPG"), createPhotoNameDraft("Family trip.JPG"));
  const own = editPhotoNameDraft(initial, "My chosen name.JPG");
  assert.deepEqual(reconcilePhotoNameDraft(own, own.value), createPhotoNameDraft(own.value));
});

test("explicitly matching the current saved name resolves a preserved draft notice", () => {
  const pending = reconcilePhotoNameDraft(editPhotoNameDraft(createPhotoNameDraft("IMG.JPG"), "My draft.JPG"), "Remote.JPG");
  assert.deepEqual(editPhotoNameDraft(pending, "Remote.JPG"), {savedName: "Remote.JPG", value: "Remote.JPG", savedNameChanged: false});
});

test("the filename editor starts from the saved name and never applies it during rendering", () => {
  let writes = 0;
  const source = {filename: "IMG_0001.JPG", facts: ["fotoro.name.v1:My chosen name.JPG"]};
  const markup = renderToStaticMarkup(createElement(PhotoOrganization, {source, saved: true, onChange: async () => {writes++;}}));
  assert.match(markup, /aria-label="Photo filename"[^>]*value="My chosen name.JPG"/);
  assert.doesNotMatch(markup, /Your draft is kept|Use saved name/);
  assert.equal(writes, 0);
  assert.deepEqual(source, {filename: "IMG_0001.JPG", facts: ["fotoro.name.v1:My chosen name.JPG"]});
});

test("successful explicit Reset resolves a dirty draft only after its asynchronous change completes", async () => {
  let draft = editPhotoNameDraft(createPhotoNameDraft("Saved name.JPG"), "Unapplied draft.JPG");
  let release!: () => void;
  const request = applyPhotoOrganizationDraft({name: null}, "IMG_0001.JPG", async patch => {
    assert.deepEqual(patch, {name: null}); await new Promise<void>(resolve => {release = resolve;});
  }, () => true, value => {draft = value;});
  // Prop publication can precede completion of the local annotation write.
  draft = reconcilePhotoNameDraft(draft, "IMG_0001.JPG");
  assert.equal(draft.value, "Unapplied draft.JPG");
  release(); await request;
  assert.deepEqual(draft, createPhotoNameDraft("IMG_0001.JPG"));
});

test("successful own Apply acknowledges the submitted name while unrelated organization changes keep drafts", async () => {
  let draft = editPhotoNameDraft(createPhotoNameDraft("IMG.JPG"), "My chosen name.JPG");
  let writes = 0;
  const change = async () => {writes++;};
  await applyPhotoOrganizationDraft({screenshot: true}, "IMG.JPG", change, () => true, value => {draft = value;});
  assert.equal(draft.value, "My chosen name.JPG");
  assert.equal(draft.savedName, "IMG.JPG");
  await applyPhotoOrganizationDraft({name: draft.value}, "IMG.JPG", change, () => true, value => {draft = value;});
  assert.deepEqual(draft, createPhotoNameDraft("My chosen name.JPG"));
  assert.equal(writes, 2);
});

test("failed and withdrawn name operations cannot resolve or publish a user's draft", async () => {
  const draft = editPhotoNameDraft(createPhotoNameDraft("Saved.JPG"), "Keep my draft.JPG");
  let current = true, published = 0, writes = 0, release!: () => void;
  const publish = () => {published++;};
  await assert.rejects(applyPhotoOrganizationDraft({name: null}, "IMG.JPG", async () => {throw new Error("Photo source changed");},
    () => current, publish), /Photo source changed/);
  assert.equal(published, 0);
  const request = applyPhotoOrganizationDraft({name: null}, "IMG.JPG", async () => {
    writes++; await new Promise<void>(resolve => {release = resolve;});
  }, () => current, publish);
  current = false; release(); await request;
  await applyPhotoOrganizationDraft({name: null}, "IMG.JPG", async () => {writes++;}, () => current, publish);
  assert.equal(writes, 1); assert.equal(published, 0);
  assert.equal(draft.value, "Keep my draft.JPG");
});
