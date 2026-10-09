import test from "node:test";
import assert from "node:assert/strict";
import {chosenTripPhotos, resolveChosenTripSources, snapshotChosenTripSources} from "../src/exchange/chosen-trip";
import type {Photo} from "../src/library/catalog";
import type {LocalPhoto} from "../src/local/resources";
import type {PendingImport} from "../src/exchange/journal";

const owner = "chosen-owner", digest = "a".repeat(43), otherDigest = "b".repeat(43);
const photo = (id: string, sha = digest): Photo => ({manifest: {photoId: id, ownerAccountId: owner, version: 1}, metadata: {originalSha256: sha}} as Photo);
const local = (sha = digest): LocalPhoto => ({id: "local", digest: sha, file: new File(["image"], "same.jpg"), filename: "same.jpg", date: "2026-10-09", dateSource: "file"} as LocalPhoto);
const journal = (source: Photo): PendingImport => ({photoId: source.manifest.photoId, sourceDigest: source.metadata.originalSha256,
  state: "committed", manifest: structuredClone(source.manifest)} as PendingImport);
const options = () => ({local: [] as LocalPhoto[], saved: snapshotChosenTripSources([photo("chosen")], owner), owned: [photo("chosen")],
  pending: [] as PendingImport[], ownerAccountId: owner, current: () => true});

test("empty and over100 choices reject before returning sources", () => {
  assert.throws(() => resolveChosenTripSources({...options(), saved: []}), /TRIP_CHOOSE_1_TO_100_FILES/);
  assert.throws(() => resolveChosenTripSources({...options(), local: Array.from({length: 100}, () => local())}), /TRIP_CHOOSE_1_TO_100_FILES/);
});

test("resolves only the exact chosen subset and deduplicates photoId, preserving equal-digest Saved identities", () => {
  const a = photo("a"), b = photo("b"), unrelated = photo("unrelated", otherDigest);
  const saved = snapshotChosenTripSources([b, a, b], owner);
  const result = resolveChosenTripSources({...options(), local: [local()], saved, owned: [a, unrelated, b]});
  assert.deepEqual(result.map(value => value.photoId), ["b", "a"]);
  assert.deepEqual(result, saved);
});

test("Saved capture copies the manifest and rejects grants and other owners", () => {
  const selected = photo("chosen"), captured = snapshotChosenTripSources([selected], owner);
  selected.manifest.photoId = "changed";
  assert.equal(captured[0].photoId, "chosen"); assert.equal(captured[0].manifest.photoId, "chosen");
  assert.throws(() => snapshotChosenTripSources([{...photo("chosen"), grantId: "grant"}], owner), /TRIP_SAVE_INCOMPLETE/);
  assert.throws(() => snapshotChosenTripSources([{...photo("chosen"), manifest: {...photo("chosen").manifest, ownerAccountId: "other"}}], owner), /TRIP_SAVE_INCOMPLETE/);
});

test("current grants, wrong owners and changed captured digests/manifests fail closed", () => {
  const original = options();
  for (const owned of [[{...photo("chosen"), grantId: "grant"}], [photo("chosen", otherDigest)],
    [{...photo("chosen"), manifest: {...photo("chosen").manifest, ownerAccountId: "other"}}],
    [{...photo("chosen"), manifest: {...photo("chosen").manifest, version: 2}} as Photo]]) {
    assert.throws(() => resolveChosenTripSources({...original, owned}), /TRIP_SAVE_INCOMPLETE/);
  }
  assert.throws(() => resolveChosenTripSources({...original, ownerAccountId: "other"}), /TRIP_SAVE_INCOMPLETE/);
});

test("new commits hydrate from exact journal without loaded catalog and never match filenames", () => {
  const committed = photo("new"), unrelated = photo("other", otherDigest);
  const result = resolveChosenTripSources({...options(), local: [local()], saved: [], owned: [unrelated], pending: [journal(unrelated), journal(committed)]});
  assert.deepEqual(result, snapshotChosenTripSources([committed], owner));
  assert.throws(() => resolveChosenTripSources({...options(), local: [local()], saved: [], owned: [unrelated], pending: [journal(unrelated)]}), /TRIP_SAVE_INCOMPLETE/);
  // A formerly loaded Saved choice may also hydrate from its exact committed identity.
  assert.deepEqual(resolveChosenTripSources({...options(), owned: [], pending: [journal(photo("chosen"))]}), options().saved);
});

test("missing, unfinished, mismatched and ambiguous journal records cannot yield a partial choice", () => {
  const selected = journal(photo("new")), base = {...options(), local: [local()], saved: [], owned: []};
  const invalid = [[], [{...selected, state: "queued"}], [{...selected, sourceDigest: otherDigest}],
    [{...selected, manifest: undefined}], [{...selected, manifest: {...selected.manifest!, ownerAccountId: "other"}}],
    [{...selected, manifest: {...selected.manifest!, photoId: "replacement"}}], [selected, selected], [selected, journal(photo("another"))]];
  for (const pending of invalid) assert.throws(() => resolveChosenTripSources({...base, pending: pending as PendingImport[]}), /TRIP_SAVE_INCOMPLETE/);
  const saved = options();
  assert.throws(() => resolveChosenTripSources({...saved, owned: [], pending: [journal(photo("chosen", otherDigest))]}), /TRIP_SAVE_INCOMPLETE/);
  assert.throws(() => resolveChosenTripSources({...saved, owned: [], pending: [{...journal(photo("chosen")), manifest: {...photo("chosen").manifest, version: 2}} as PendingImport]}), /TRIP_SAVE_INCOMPLETE/);
});

test("missing files/digests and revoked local or account current checks reject the entire choice", () => {
  for (const source of [{...local(), file: undefined}, {...local(), digest: undefined}, {...local(), current: () => false}]) {
    assert.throws(() => resolveChosenTripSources({...options(), local: [source]}), /TRIP_SAVE_INCOMPLETE|Trip choice changed/);
  }
  assert.throws(() => resolveChosenTripSources({...options(), current: () => false}), /Trip choice changed/);
  let checks = 0;
  assert.throws(() => resolveChosenTripSources({...options(), local: [{...local(), current: () => ++checks === 1}]}), /Trip choice changed/);
});

test("local hexadecimal digests resolve the canonical committed original", () => {
  const canonical = Buffer.from("ab".repeat(32), "hex").toString("base64url"), selected = photo("hex", canonical);
  assert.deepEqual(resolveChosenTripSources({...options(), saved: [], local: [local("ab".repeat(32))], owned: [], pending: [journal(selected)]}), snapshotChosenTripSources([selected], owner));
});

test("hydrated selection retains exact order and objects, rejecting changed identities and revoked scope", () => {
  const a = photo("a"), b = photo("b"), sources = snapshotChosenTripSources([b, a], owner);
  assert.deepEqual(chosenTripPhotos(sources, [a, photo("other"), b], owner, () => true), [b, a]);
  for (const replacement of [photo("a", otherDigest), {...a, grantId: "grant"},
    {...a, manifest: {...a.manifest, ownerAccountId: "other"}}, {...a, manifest: {...a.manifest, version: 2}} as Photo]) {
    assert.throws(() => chosenTripPhotos(sources, [replacement, b], owner, () => true), /TRIP_SAVE_INCOMPLETE/);
  }
  assert.throws(() => chosenTripPhotos(sources, [b], owner, () => true), /TRIP_SAVE_INCOMPLETE/);
  assert.throws(() => chosenTripPhotos(sources, [a, a, b], owner, () => true), /TRIP_SAVE_INCOMPLETE/);
  assert.throws(() => chosenTripPhotos(sources, [a, b], owner, () => false), /Trip choice changed/);
  let checks = 0;
  assert.throws(() => chosenTripPhotos(sources, [a, b], owner, () => ++checks === 1), /Trip choice changed/);
});
