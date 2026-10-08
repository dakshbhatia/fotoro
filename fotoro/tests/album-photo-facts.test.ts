import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {ready, sodium, b64, utf8, unb64} from "../packages/crypto/src/common.js";
import {signPayload} from "../packages/crypto/src/signatures.js";
import {wrapKey, unwrapKey} from "../packages/crypto/src/envelopes.js";
import {makeAlbumDefinition, makeAlbumPhoto, openAlbumDefinition} from "../packages/crypto/src/albums.js";
import {makeAlbumPhotoFacts, openAlbumPhotoFacts} from "../packages/crypto/src/album-photo-facts.js";
import {ALBUM_FACTS_KIND, readAlbumPhotoFacts, validateAlbumPhotoFacts, validateAlbumPhotoFactsContent, validateAlbumPhotoFactsReply, validateAlbumPhotoFactsPage} from "../packages/contracts/src/album-photo-facts.js";
await ready;
const person = (seed: number) => {
  const signing = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(seed)), box = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(seed + 40));
  return {card: {version: 1 as const, accountId: randomUUID(), boxPublicKey: b64(box.publicKey), signingPublicKey: b64(signing.publicKey)}, signingSecretKey: signing.privateKey, boxSecretKey: box.privateKey};
};
const owner = person(1), contributor = person(2), reader = person(3);
function fixture() {
  const made = makeAlbumDefinition({albumId: randomUUID(), title: "Public fixture", createdAt: "2026-10-08T12:00:00.000Z", ownerCard: owner.card, members: [owner.card, contributor.card, reader.card], signingSecretKey: owner.signingSecretKey});
  const photoId = randomUUID(), metadataKey = sodium.randombytes_buf(32);
  const rep = {binding: {version: 1 as const, photoId, representationId: randomUUID(), kind: "metadata" as const}, objectId: randomUUID(), header: b64(new Uint8Array(24)), ciphertextBytes: 100, ciphertextSha256: b64(new Uint8Array(32))};
  const manifest = signPayload("photo-manifest", contributor.card.accountId, utf8({version: 1, photoId, ownerAccountId: contributor.card.accountId, representations: [{...rep, binding: {...rep.binding, representationId: randomUUID(), kind: "original"}, objectId: randomUUID()}], metadataRepresentation: rep, ownerWrappedMetadataKey: wrapKey(metadataKey, sodium.randombytes_buf(32))}), contributor.signingSecretKey);
  const entry = makeAlbumPhoto({definition: made.definition, manifest, metadataKey, albumKey: made.albumKey, signingSecretKey: contributor.signingSecretKey});
  const source = {signedDefinition: made.signed, trustedOwner: owner.card, entry, manifest, originalSha256: b64(new Uint8Array(32)), albumKey: made.albumKey};
  const signed = makeAlbumPhotoFacts({...source, revision: 1, people: ["Public reviewed name"], location: {latitude: 1.3, longitude: 103.8, source: "photos"}, signingSecretKey: contributor.signingSecretKey});
  return {made, source, signed};
}
test("chosen names/location are encrypted for all three members without rewriting originals or leaking digest", () => {
  const {made, source, signed} = fixture(), original = JSON.stringify([source.entry, source.manifest]);
  const outer = readAlbumPhotoFacts(signed);
  assert.equal(JSON.stringify(outer).includes("Public reviewed name"), false);
  assert.equal(Object.hasOwn(outer, "originalSha256"), false);
  for (const member of [owner, contributor, reader]) {
    const opened = openAlbumDefinition({signed: made.signed, trustedOwner: owner.card, recipientCard: member.card, recipientSecretKey: member.boxSecretKey, expectedAlbumId: made.definition.albumId});
    const content = openAlbumPhotoFacts({...source, albumKey: opened.albumKey, signed});
    assert.deepEqual(content.people, ["Public reviewed name"]); assert.equal(content.location?.latitude, 1.3);
    opened.albumKey.fill(0);
  }
  assert.equal(JSON.stringify([source.entry, source.manifest]), original);
  assert.equal(validateAlbumPhotoFactsReply({version: 1, facts: signed}).facts, signed);
});
test("album facts reject wrong contributor, album definition, photo, original digest, key and altered signature", () => {
  const a = fixture(), b = fixture();
  for (const altered of [{signedDefinition: b.source.signedDefinition}, {entry: b.source.entry, manifest: b.source.manifest}, {originalSha256: b64(new Uint8Array(32).fill(1))}, {albumKey: sodium.randombytes_buf(32)}, {signed: {...a.signed, signature: b.signed.signature}}]) assert.throws(() => openAlbumPhotoFacts({...a.source, signed: a.signed, ...altered}));
  assert.throws(() => makeAlbumPhotoFacts({...a.source, revision: 1, people: [], signingSecretKey: owner.signingSecretKey}));
  const outer = readAlbumPhotoFacts(a.signed);
  for (const delta of [{photoId: randomUUID()}, {ownerAccountId: owner.card.accountId}, {definitionSignature: b.made.signed.signature}, {revision: 2}]) {
    const signed = signPayload(ALBUM_FACTS_KIND, contributor.card.accountId, utf8({...outer, ...delta}), contributor.signingSecretKey);
    assert.throws(() => openAlbumPhotoFacts({...a.source, signed}));
  }
});
test("encrypted inner context and duplicate keys cannot be transplanted even with a valid contributor signature", () => {
  const {source, signed} = fixture(), outer = readAlbumPhotoFacts(signed), plain = unwrapKey(outer.encrypted, source.albumKey), content = JSON.parse(new TextDecoder().decode(plain)); plain.fill(0);
  const encode = (raw: Uint8Array) => signPayload(ALBUM_FACTS_KIND, contributor.card.accountId, utf8({...outer, encrypted: wrapKey(raw, source.albumKey)}), contributor.signingSecretKey);
  for (const change of [{albumId: randomUUID()}, {photoId: randomUUID()}, {ownerAccountId: owner.card.accountId}, {definitionSignature: b64(new Uint8Array(64))}, {revision: 2}, {originalSha256: b64(new Uint8Array(32).fill(2))}]) assert.throws(() => openAlbumPhotoFacts({...source, signed: encode(utf8({...content, ...change}))}));
  const duplicate = JSON.stringify(content).replace('"people":', '"people":["Unreviewed"],"people":');
  assert.throws(() => openAlbumPhotoFacts({...source, signed: encode(new TextEncoder().encode(duplicate))}));
});
test("empty facts clear chosen publication; strict bounds reject private fields, malformed names/location and ciphertext", () => {
  const {source, signed} = fixture(), clear = makeAlbumPhotoFacts({...source, revision: 2, people: [], signingSecretKey: contributor.signingSecretKey});
  assert.deepEqual(openAlbumPhotoFacts({...source, signed: clear}).people, []);
  assert.equal(Object.hasOwn(openAlbumPhotoFacts({...source, signed: clear}), "location"), false);
  const content = openAlbumPhotoFacts({...source, signed});
  for (const value of [{...content, ocr: "private"}, {...content, people: Array.from({length: 13}, (_, n) => String(n))}, {...content, people: [" "]}, {...content, people: ["same", "same"]}, {...content, people: ["a".repeat(81)]}, {...content, people: ["a\n"]}, {...content, location: {...content.location, latitude: 91}}, {...content, location: null}]) assert.throws(() => validateAlbumPhotoFactsContent(value));
  assert.equal(validateAlbumPhotoFactsContent({...content, people: ["🧭".repeat(80)]}).people[0].length, 160);
  const outer = readAlbumPhotoFacts(signed);
  assert.throws(() => validateAlbumPhotoFacts({...outer, encrypted: {...outer.encrypted, ciphertext: b64(new Uint8Array(8193))}}));
  assert.throws(() => validateAlbumPhotoFacts({...outer, definitionSignature: outer.definitionSignature + "="}));
  assert.throws(() => validateAlbumPhotoFactsPage({version: 1, facts: [signed, signed], hasMore: false, nextCursor: null}));
  assert.throws(() => validateAlbumPhotoFactsPage({version: 1, facts: [], hasMore: true, nextCursor: "1"}));
});
