import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import fixture from "../fixtures/contact-sync-v1.json";
import accounts from "../fixtures/accounts.json";
import {mergeContacts, validateContacts, type ContactConflict} from "../packages/contracts/src/contacts.js";
import type {AccountContactsV1, AccountContactsUpdateV1, SignedPayloadV1} from "../packages/contracts/src/models.js";
import {validateWire} from "../packages/contracts/src/validate.js";
import {ready, unb64, unwrapKey, verifyPayload} from "../packages/crypto/src/index.js";

test("native and browser use the same frozen contact conformance vectors", async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL("../apps/ios/FotoroTests/contact-sync-v1.json", import.meta.url), "utf8")), fixture);
});

for (const vector of fixture.mergeCases) test("contact merge: " + vector.name, () => {
  const result = mergeContacts(vector.base as AccountContactsV1, vector.local as AccountContactsV1, vector.remote as AccountContactsV1, vector.unresolved as ContactConflict[]);
  assert.deepEqual(result.value, vector.expected);
  assert.deepEqual(result.conflicts, vector.conflicts);
});
test("private contacts reject wrong owner, duplicate identities, unbound cards and ambiguous tombstones", () => {
  const book = fixture.mergeCases[0].remote, entry = book.entries[0];
  const invalid = [
    {...book, ownerAccountId: accounts.accounts[1].accountId},
    {...book, entries: [entry, entry]},
    {...book, entries: [{...entry, accountId: accounts.accounts[0].accountId}]},
    {...book, entries: [{...entry, card: accounts.accounts[0]}]},
    {...book, entries: [{...entry, card: null}]},
    {...book, entries: [{...entry, card: undefined}]},
    {...book, entries: [{...entry, name: "😀".repeat(41)}]},
    {...book, entries: [{...entry, extra: true}]},
    {...book, entries: [{...entry, card: {...entry.card!, boxPublicKey: "_".repeat(43)}}]},
    {...book, entries: Array(501).fill(entry)},
    {...book, version: 2}, {...book, extra: true},
  ];
  for (const value of invalid) assert.throws(() => validateContacts(value, book.ownerAccountId));
  validateContacts({...book, entries: [{...entry, card: null, name: ""}]}, book.ownerAccountId);
});
test("contact update envelope is bounded and cannot smuggle plaintext identities", () => {
  const update = {version: 1, revision: 1, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(22)}};
  validateWire("AccountContactsUpdateV1", update);
  for (const value of [{...update, revision: 0}, {...update, revision: 1.2}, {...update, revision: 2147483648},
    {...update, entries: []}, {...update, encrypted: {...update.encrypted, ciphertext: "A".repeat(262145)}}])
    assert.throws(() => validateWire("AccountContactsUpdateV1", value));
  validateWire("AccountContactsReplyV1", {version: 1, contacts: null});
  assert.throws(() => validateWire("AccountContactsReplyV1", {version: 1}));
});
test("the cross-client fixture verifies and decrypts using only the owner's keys", async () => {
  await ready;
  const vector = fixture.crypto;
  const signed = validateWire<SignedPayloadV1>("SignedPayloadV1", vector.signed);
  assert.equal(signed.kind, "account-contacts");
  assert.equal(signed.accountId, fixture.ownerAccountId);
  const body = verifyPayload(signed, unb64(accounts.accounts[0].signingPublicKey));
  try {
    const update = validateWire<AccountContactsUpdateV1>("AccountContactsUpdateV1", JSON.parse(new TextDecoder().decode(body)));
    assert.deepEqual(update, vector.update);
    const plain = unwrapKey(update.encrypted, unb64(accounts.testSecrets[0].vaultKey));
    try {assert.deepEqual(validateContacts(JSON.parse(new TextDecoder().decode(plain)), fixture.ownerAccountId), vector.book);}
    finally {plain.fill(0);}
    assert.throws(() => unwrapKey(update.encrypted, unb64(accounts.testSecrets[1].vaultKey)));
    assert.throws(() => verifyPayload(signed, unb64(accounts.accounts[1].signingPublicKey)));
    assert.throws(() => verifyPayload({...signed, kind: "photo-annotations"}, unb64(accounts.accounts[0].signingPublicKey)));
  } finally {body.fill(0);}
});
