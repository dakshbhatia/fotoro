import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import type {OwnedAlbumDetails} from "../src/albums/details";
import {albumDetailsSelection} from "../src/albums/detail-selection";
import {AlbumNameChoices} from "../src/albums/AlbumNameChoices";
const source: OwnedAlbumDetails = {photoId: "photo", ownerAccountId: "owner", originalSha256: "digest", people: ["Mum", "Dad", "Grandma"],
  location: {latitude: 1.25, longitude: 103.8, source: "photos", name: "Public Grove", accuracyMeters: 10}, current: () => true};
const facts = (value: Partial<AlbumPhotoFactsContentV1> = {}): AlbumPhotoFactsContentV1 => ({version: 1, albumId: "album", definitionSignature: "signature",
  photoId: source.photoId, ownerAccountId: source.ownerAccountId, originalSha256: source.originalSha256, revision: 2, people: ["Mum", "Dad"], location: {...source.location!}, ...value});

test("editing shared details retains already shared family names and exact location without selecting new reviewed names", () => {
  const selected = albumDetailsSelection(source, facts());
  assert.deepEqual(selected.people, ["Mum", "Dad"]); assert.equal(selected.location, true); assert.equal(selected.unavailable, 0);
  const markup = renderToStaticMarkup(createElement(AlbumNameChoices, {names: source.people, selected: selected.people, onChange() {}}));
  assert.equal((markup.match(/checked=""/g) ?? []).length, 2);
  assert.match(markup, /checked=""[^>]*\/>Mum/); assert.match(markup, /checked=""[^>]*\/>Dad/);
  assert.doesNotMatch(markup, /checked=""[^>]*\/>Grandma/);
  const fresh = albumDetailsSelection(source);
  assert.deepEqual(fresh, {people: [], location: false, unavailable: 0, existing: false});
});

test("removed or renamed family labels and every changed location field remain opt-in with removal feedback", () => {
  const renamed = albumDetailsSelection({...source, people: ["Mom", "Dad", "Grandma"]}, facts());
  assert.deepEqual(renamed.people, ["Dad"]); assert.equal(renamed.unavailable, 1);
  for (const location of [undefined, {...source.location!, latitude: 1.3}, {...source.location!, longitude: 103.9},
    {...source.location!, source: "exif" as const}, {...source.location!, name: "New place"}, {...source.location!, accuracyMeters: 20}]) {
    const changed = albumDetailsSelection({...source, location}, facts());
    assert.equal(changed.location, false); assert.equal(changed.unavailable, 1);
  }
  const notShared = albumDetailsSelection(source, facts({people: [], location: undefined}));
  assert.deepEqual(notShared, {people: [], location: false, unavailable: 0, existing: false});
});

test("stale sources or another contributor/copy/original cannot supply editor defaults", () => {
  assert.throws(() => albumDetailsSelection({...source, current: () => false}, facts()), /SELECTION_CHANGED/);
  for (const value of [{ownerAccountId: "other"}, {photoId: "other-copy"}, {originalSha256: "replacement"}]) {
    assert.throws(() => albumDetailsSelection(source, facts(value)), /BINDING_MISMATCH/);
  }
});
