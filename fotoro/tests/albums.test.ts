import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {sodium, ready, b64, utf8} from "../packages/crypto/src/common.js";
import {wrapKey} from "../packages/crypto/src/envelopes.js";
import {signPayload} from "../packages/crypto/src/signatures.js";
import {makeAlbumDefinition, openAlbumDefinition, verifyAlbumDefinition, makeAlbumPhoto, openAlbumPhoto, makeAlbumAction, verifyAlbumAction} from "../packages/crypto/src/albums.js";
import {ALBUM_DEFINITION_KIND, ALBUM_PHOTO_KIND, ALBUM_ACCEPT_KIND, readAlbumSignedBody, validateAlbumDefinition, validateAlbumPhoto, validateAlbumAppend, validateCreateAlbum, validateAlbumDetail, validateAlbumTitle, validateAlbumInbox, validateAlbumAppendResult, validateAlbumActionRequest} from "../packages/contracts/src/albums.js";
import {createAlbumLink, parseAlbumLink} from "../packages/contracts/src/albums-links.js";
import type {PhotoManifestV1} from "../packages/contracts/src/models.js";
import publicAccounts from "../fixtures/accounts.json";
await ready;
function account(seed: number) {
  const signing = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(seed)), box = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(seed + 40));
  return {card: {version: 1 as const, accountId: randomUUID(), boxPublicKey: b64(box.publicKey), signingPublicKey: b64(signing.publicKey)}, signingSecretKey: signing.privateKey, boxSecretKey: box.privateKey};
}
const owner = account(1), member = account(2), third = account(3), outsider = account(4), albumId = randomUUID();
const input = {albumId, title: "Family travel 🧭", createdAt: "2026-10-07T12:00:00.000Z", ownerCard: owner.card, members: [owner.card, member.card, third.card], signingSecretKey: owner.signingSecretKey};
const made = makeAlbumDefinition(input);
const opened = (person = member, signed = made.signed) => openAlbumDefinition({signed, trustedOwner: owner.card, recipientCard: person.card, recipientSecretKey: person.boxSecretKey, expectedAlbumId: albumId});
function photo(person = member) {
  const metadataKey = sodium.randombytes_buf(32), photoId = randomUUID();
  const representation = (kind: "original" | "metadata") => ({binding: {version: 1 as const, photoId, representationId: randomUUID(), kind}, objectId: randomUUID(), header: b64(new Uint8Array(24)), ciphertextBytes: 100, ciphertextSha256: b64(new Uint8Array(32))});
  const manifest: PhotoManifestV1 = {version: 1, photoId, ownerAccountId: person.card.accountId, representations: [representation("original")], metadataRepresentation: representation("metadata"), ownerWrappedMetadataKey: wrapKey(metadataKey, sodium.randombytes_buf(32))};
  const signed = signPayload("photo-manifest", person.card.accountId, utf8(manifest), person.signingSecretKey);
  const originalSignedBytes = JSON.stringify(signed), originalManifestBytes = JSON.stringify(manifest);
  const entry = makeAlbumPhoto({definition: made.definition, manifest: signed, metadataKey, albumKey: made.albumKey, signingSecretKey: person.signingSecretKey});
  assert.equal(JSON.stringify(signed), originalSignedBytes); assert.equal(JSON.stringify(manifest), originalManifestBytes);
  return {manifest, signed, entry, metadataKey};
}
test("three invited members open the same random album key and encrypted title", () => {
  for (const person of [owner, member, third]) {const value = opened(person); assert.deepEqual(value.albumKey, made.albumKey); assert.equal(value.title, input.title); value.albumKey.fill(0);}
  assert.equal(JSON.stringify(made.signed).includes(input.title), false);
  assert.equal(new TextDecoder().decode(Buffer.from(made.signed.body, "base64url")).includes(input.title), false);
  assert.notDeepEqual(makeAlbumDefinition(input).albumKey, made.albumKey);
  assert.equal(validateCreateAlbum({version: 1, definition: made.signed}).definition, made.signed);
});
test("opening definition rejects wrong account, album, trusted owner, secret and pinned member identity", () => {
  assert.throws(() => opened(outsider));
  const base = {signed: made.signed, trustedOwner: owner.card, recipientCard: member.card, recipientSecretKey: member.boxSecretKey, expectedAlbumId: albumId};
  assert.throws(() => openAlbumDefinition({...base, expectedAlbumId: randomUUID()}));
  assert.throws(() => openAlbumDefinition({...base, trustedOwner: outsider.card}));
  assert.throws(() => openAlbumDefinition({...base, recipientSecretKey: third.boxSecretKey}));
  assert.throws(() => openAlbumDefinition({...base, recipientCard: {...member.card, signingPublicKey: third.card.signingPublicKey}}));
  assert.throws(() => openAlbumDefinition({...base, trustedMembers: [{...third.card, boxPublicKey: outsider.card.boxPublicKey}]}));
});
test("definition signature covers entire roster, title and sealed keys", () => {
  for (const altered of [{...made.definition, albumId: randomUUID()}, {...made.definition, encryptedTitle: wrapKey(utf8("Other title"), made.albumKey)}, {...made.definition, members: made.definition.members.map((value, i) => i === 1 ? {...value, sealedAlbumKey: made.definition.members[2].sealedAlbumKey} : value)}]) {
    assert.throws(() => verifyAlbumDefinition({...made.signed, body: b64(utf8(altered))}, owner.card));
  }
  const swapped = {...made.definition, members: made.definition.members.map((value, i) => i === 1 ? {...value, sealedAlbumKey: made.definition.members[2].sealedAlbumKey} : value)};
  assert.throws(() => opened(member, signPayload(ALBUM_DEFINITION_KIND, owner.card.accountId, utf8(swapped), owner.signingSecretKey)));
});
test("roster and wire boundaries reject duplicate identity, missing owner, extras and malformed encodings", () => {
  assert.throws(() => validateAlbumDefinition({...made.definition, members: [...made.definition.members, made.definition.members[1]]}));
  assert.throws(() => validateAlbumDefinition({...made.definition, members: made.definition.members.slice(1)}));
  assert.throws(() => validateAlbumDefinition({...made.definition, members: [...made.definition.members, {...made.definition.members[1], card: {...member.card, accountId: randomUUID()}}]}));
  assert.throws(() => validateAlbumDefinition({...made.definition, caption: "private"}));
  assert.throws(() => validateAlbumDefinition({...made.definition, encryptedTitle: {...made.definition.encryptedTitle, nonce: made.definition.encryptedTitle.nonce + "="}}));
  assert.throws(() => validateAlbumDefinition({...made.definition, createdAt: "2026-02-31T12:00:00.000Z"}));
  assert.throws(() => validateAlbumDefinition({...made.definition, members: [...made.definition.members, ...Array.from({length: 10}, (_, i) => {const person = account(i + 10); return {card: person.card, sealedAlbumKey: made.definition.members[0].sealedAlbumKey};})]}));
});
test("title bound counts Unicode and rejects controls and lone surrogates", () => {
  assert.equal(validateAlbumTitle("🧭".repeat(80)), "🧭".repeat(80));
  for (const value of ["", "  ", "🧭".repeat(81), "title\nsecret", "bad\ud800"]) assert.throws(() => validateAlbumTitle(value));
  const maximum = makeAlbumDefinition({...input, title: "🧭".repeat(80)});
  assert.equal(opened(member, maximum.signed).title, "🧭".repeat(80));
});
test("each of three members contributes owned originals that all members can decrypt", () => {
  for (const contributor of [owner, member, third]) {
    const source = photo(contributor);
    assert.deepEqual(validateAlbumAppend({version: 1, operationId: randomUUID(), entries: [source.entry], manifests: [source.signed]}).manifests, [source.signed]);
    for (const recipient of [owner, member, third]) assert.deepEqual(openAlbumPhoto({definition: made.definition, entry: source.entry, manifest: source.signed, albumKey: opened(recipient).albumKey}), source.metadataKey);
  }
});
test("photo keys cannot be opened under another album, photo, owner, signer or key", () => {
  const source = photo(), other = photo();
  const base = {definition: made.definition, entry: source.entry, manifest: source.signed, albumKey: made.albumKey};
  assert.throws(() => openAlbumPhoto({...base, albumKey: sodium.randombytes_buf(32)}));
  assert.throws(() => openAlbumPhoto({...base, definition: {...made.definition, albumId: randomUUID()}}));
  assert.throws(() => openAlbumPhoto({...base, manifest: other.signed}));
  assert.throws(() => openAlbumPhoto({...base, entry: {...source.entry, accountId: third.card.accountId}}));
  assert.throws(() => makeAlbumPhoto({definition: made.definition, manifest: source.signed, metadataKey: source.metadataKey, albumKey: made.albumKey, signingSecretKey: third.signingSecretKey}));
  const body = readAlbumSignedBody(source.entry, ALBUM_PHOTO_KIND, validateAlbumPhoto);
  assert.throws(() => openAlbumPhoto({...base, entry: {...source.entry, body: b64(utf8({...body, photoId: other.manifest.photoId}))}}));
  const forged = signPayload("photo-manifest", outsider.card.accountId, utf8({...source.manifest, ownerAccountId: outsider.card.accountId}), outsider.signingSecretKey);
  assert.throws(() => openAlbumPhoto({...base, manifest: forged}));
});
test("append rejects duplicate, mixed album, empty, mismatched and oversized batches", () => {
  const source = photo(), other = photo();
  const request = {version: 1, operationId: randomUUID(), entries: [source.entry], manifests: [source.signed]};
  assert.throws(() => validateAlbumAppend({...request, entries: [], manifests: []}));
  assert.throws(() => validateAlbumAppend({...request, entries: [source.entry, source.entry], manifests: [source.signed, source.signed]}));
  assert.throws(() => validateAlbumAppend({...request, manifests: [other.signed]}));
  assert.throws(() => validateAlbumAppend({...request, manifests: [{...source.signed, kind: "private-annotation"}]}), {code: "INVALID_WIRE"});
  assert.throws(() => validateAlbumAppend({...request, entries: Array(101).fill(source.entry), manifests: Array(101).fill(source.signed)}));
  const foreign = makeAlbumPhoto({definition: {...made.definition, albumId: randomUUID()}, manifest: other.signed, metadataKey: other.metadataKey, albumKey: made.albumKey, signingSecretKey: member.signingSecretKey});
  assert.throws(() => validateAlbumAppend({...request, entries: [source.entry, foreign], manifests: [source.signed, other.signed]}));
});
test("acceptance and ending access bind exact definition and only owner ends", () => {
  const base = {signedDefinition: made.signed, trustedOwner: owner.card};
  const accepted = makeAlbumAction({...base, memberCard: member.card, signingSecretKey: member.signingSecretKey, action: "accept"});
  assert.equal(verifyAlbumAction({...base, signed: accepted, action: "accept"}).definitionSignature, made.signed.signature);
  assert.throws(() => verifyAlbumAction({...base, signed: accepted, action: "end"}));
  assert.throws(() => makeAlbumAction({...base, memberCard: member.card, signingSecretKey: member.signingSecretKey, action: "end"}));
  const ended = makeAlbumAction({...base, memberCard: owner.card, signingSecretKey: owner.signingSecretKey, action: "end"});
  assert.equal(verifyAlbumAction({...base, signed: ended, action: "end"}).albumId, albumId);
  assert.throws(() => verifyAlbumAction({...base, signedDefinition: makeAlbumDefinition(input).signed, signed: accepted, action: "accept"}));
});
test("detail pages reject inactive membership and mismatched album entries", () => {
  const source = photo(), detail = {version: 1, definition: made.signed, membership: "accepted", endedAt: null, photoCount: 1, entries: [source.entry], manifests: [source.signed], nextCursor: null, hasMore: false};
  assert.equal(validateAlbumDetail(detail).photoCount, 1);
  for (const update of [{membership: "invited"}, {endedAt: input.createdAt}, {photoCount: 1001}, {nextCursor: "1", hasMore: false}, {hasMore: true}, {photoCount: 0}]) assert.throws(() => validateAlbumDetail({...detail, ...update}));
});
test("strict album invitation carries only public identity and exact album binding", () => {
  const link = createAlbumLink(albumId, owner.card), parsed = parseAlbumLink(link);
  assert.deepEqual(parsed, {albumId, ownerCard: owner.card, version: 1});
  assert.equal(link.includes(b64(made.albumKey)), false);
  for (const value of [link + "&album=other", link.replace("/#", "/path#"), link.replace("fotoro.cloud", "evil.test"), link.replace("https:", "http:"), link + "=", link.replace("/#album=", "/?x=1#album=")]) assert.throws(() => parseAlbumLink(value));
  const prefix = "https://fotoro.cloud/#album=";
  const duplicate = '{"albumId":"' + albumId + '","ownerCard":' + JSON.stringify(parsed.ownerCard) + ',"version":1,"version":1}';
  assert.throws(() => parseAlbumLink(prefix + b64(new TextEncoder().encode(duplicate))));
  assert.throws(() => parseAlbumLink(prefix + b64(utf8({...parsed, metadataKey: "private"}))));
  const local = createAlbumLink(albumId, owner.card, "http://localhost:4310");
  assert.equal(parseAlbumLink(local, "http://localhost:4310").albumId, albumId);
});
test("signed body rejects duplicate JSON keys and noncanonical encodings before parsing", () => {
  const duplicate = JSON.stringify(made.definition).replace('"version":1', '"version":1,"version":1');
  const signed = signPayload(ALBUM_DEFINITION_KIND, owner.card.accountId, new TextEncoder().encode(duplicate), owner.signingSecretKey);
  assert.throws(() => verifyAlbumDefinition(signed, owner.card));
  assert.throws(() => readAlbumSignedBody({...made.signed, body: made.signed.body + "="}, ALBUM_DEFINITION_KIND, validateAlbumDefinition));
});
test("legacy originals retain valid whitespace and escaped JSON without re-signing their bytes", () => {
  const source = photo(), raw = JSON.stringify(source.manifest, null, 2).replace('"version": 1', '"\\u0076ersion": 1');
  const signed = signPayload("photo-manifest", member.card.accountId, new TextEncoder().encode(raw), member.signingSecretKey);
  const entry = makeAlbumPhoto({definition: made.definition, manifest: signed, metadataKey: source.metadataKey, albumKey: made.albumKey, signingSecretKey: member.signingSecretKey});
  const request = validateAlbumAppend({version: 1, operationId: randomUUID(), entries: [entry], manifests: [signed]});
  assert.equal(request.manifests[0], signed);
  assert.equal(new TextDecoder().decode(Buffer.from(signed.body, "base64url")), raw);
  assert.deepEqual(openAlbumPhoto({definition: made.definition, entry, manifest: signed, albumKey: made.albumKey}), source.metadataKey);
  const definition = signPayload(ALBUM_DEFINITION_KIND, owner.card.accountId, new TextEncoder().encode(JSON.stringify(made.definition, null, 2)), owner.signingSecretKey);
  assert.throws(() => verifyAlbumDefinition(definition, owner.card));
});
test("legacy original JSON still rejects nested, escaped duplicate keys and private fields", () => {
  const source = photo(), compact = JSON.stringify(source.manifest);
  const malformed = [compact.replace('"version":1', '"version":1,"\\u0076ersion":1'), compact.replace('"kind":"original"', '"kind":"original","\\u006bind":"original"'), JSON.stringify({...source.manifest, caption: "private"}, null, 2)];
  for (const raw of malformed) {
    const signed = signPayload("photo-manifest", member.card.accountId, new TextEncoder().encode(raw), member.signingSecretKey);
    assert.throws(() => validateAlbumAppend({version: 1, operationId: randomUUID(), entries: [source.entry], manifests: [signed]}));
    assert.throws(() => makeAlbumPhoto({definition: made.definition, manifest: signed, metadataKey: source.metadataKey, albumKey: made.albumKey, signingSecretKey: member.signingSecretKey}));
  }
});
test("sorted-key native signatures and frozen public invitation vector interoperate", () => {
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const native = signPayload(ALBUM_DEFINITION_KIND, owner.card.accountId, utf8(ordered(made.definition)), owner.signingSecretKey);
  assert.equal(opened(member, native).title, input.title);
  const link = "https://fotoro.cloud/#album=eyJhbGJ1bUlkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwib3duZXJDYXJkIjp7ImFjY291bnRJZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImJveFB1YmxpY0tleSI6Ikd4dFkzVkRxRkxZTm9YdDVETkFuVk5sd3licTRaT3V6d1BNQmItVWRQMWMiLCJzaWduaW5nUHVibGljS2V5IjoiN1Vrb3hpalJ3c2JxNlFNNGtGbVZZU2xaSnpwY1lfazJOc0ZHRkt5SE45RSIsInZlcnNpb24iOjF9LCJ2ZXJzaW9uIjoxfQ";
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(createAlbumLink(id, {...publicAccounts.accounts[0], version: 1}), link);
  assert.deepEqual(parseAlbumLink(link), {albumId: id, ownerCard: publicAccounts.accounts[0], version: 1});
});
test("inbox, action wrappers and append receipts enforce bounded exact wire fields", () => {
  const overview = {definition: made.signed, membership: "invited", endedAt: null, photoCount: 0};
  assert.equal(validateAlbumInbox({version: 1, albums: [overview]}).albums.length, 1);
  assert.throws(() => validateAlbumInbox({version: 1, albums: [overview, overview]}));
  assert.throws(() => validateAlbumInbox({version: 1, albums: Array(101).fill(overview)}));
  const action = makeAlbumAction({signedDefinition: made.signed, trustedOwner: owner.card, memberCard: member.card, signingSecretKey: member.signingSecretKey, action: "accept"});
  assert.equal(validateAlbumActionRequest({version: 1, action}, ALBUM_ACCEPT_KIND).action, action);
  assert.throws(() => validateAlbumActionRequest({version: 1, action, accountId: member.card.accountId}, ALBUM_ACCEPT_KIND));
  const receipt = {version: 1, albumId, operationId: randomUUID(), added: 1, photoCount: 101};
  assert.equal(validateAlbumAppendResult(receipt).photoCount, 101);
  for (const update of [{added: -1}, {added: 101}, {photoCount: 1001}, {added: 2, photoCount: 1}, {added: 0.5}, {title: "private"}]) assert.throws(() => validateAlbumAppendResult({...receipt, ...update}));
});
