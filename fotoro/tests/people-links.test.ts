import {test} from "node:test";
import assert from "node:assert/strict";
import accounts from "../fixtures/accounts.json";
import type {AccountPeopleLinksV1, TripPersonLinkV1} from "../packages/contracts/src/models.js";
import {validateWire} from "../packages/contracts/src/validate.js";
const owner = accounts.accounts[0].accountId;
const link: TripPersonLinkV1 = {id: "11111111-1111-4111-8111-111111111111", origin: "https://fotoro.cloud", albumId: "22222222-2222-4222-8222-222222222222",
  ownerCard: {...accounts.accounts[1], version: 1}, name: "Mom", aliases: [{card: {...accounts.accounts[1], version: 1}, name: "Mom"}, {card: {...accounts.accounts[0], version: 1}, name: "Mum"}], deleted: false};
const book: AccountPeopleLinksV1 = {version: 1, ownerAccountId: owner, links: [link]};
test("private People links have exact bounded encrypted envelopes and explicit source identities", () => {
  assert.doesNotThrow(() => validateWire("AccountPeopleLinksV1", book));
  assert.throws(() => validateWire("AccountPeopleLinksV1", {...book, links: [{...link, aliases: [link.aliases[0]]}]}));
  const update = {version: 1, revision: 1, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(22)}};
  validateWire("AccountPeopleLinksUpdateV1", update);
  validateWire("AccountPeopleLinksReplyV1", {version: 1, peopleLinks: null});
  for (const value of [{...update, revision: 0}, {...update, revision: 2147483648}, {...update, revision: 1.2}, {...update, links: []},
    {...update, encrypted: {...update.encrypted, ciphertext: "A".repeat(262145)}}])
    assert.throws(() => validateWire("AccountPeopleLinksUpdateV1", value));
});

test("People links reject malformed cards, noncanonical scope and overlapping live source aliases", async () => {
  const {validatePeopleLinks} = await import("../packages/contracts/src/people-links.js");
  const another = {...link, id: "33333333-3333-4333-8333-333333333333", name: "Dad"};
  for (const value of [{...book, ownerAccountId: accounts.accounts[1].accountId}, {...book, links: [link, link]},
    {...book, links: [link, another]}, {...book, links: [{...link, origin: "https://fotoro.cloud/"}]},
    {...book, links: [{...link, origin: "https://person:secret@fotoro.cloud"}]}, {...book, links: [{...link, origin: "file:///tmp"}]},
    {...book, links: [{...link, id: link.id.toUpperCase().replace("11111111", "ABCDEFAB")}]},
    {...book, links: [{...link, ownerCard: {...link.ownerCard, boxPublicKey: "_".repeat(43)}}]},
    {...book, links: [{...link, aliases: [link.aliases[0]]}]}, {...book, links: [{...link, aliases: [link.aliases[0], link.aliases[0]]}]},
    {...book, links: [{...link, name: " "}]}, {...book, links: [{...link, name: "😀".repeat(41)}]},
    {...book, links: [{...link, aliases: Array(33).fill(link.aliases[0])}]}, {...book, links: Array(257).fill(link)},
    {...book, links: [{...link, extra: true}]}]) assert.throws(() => validatePeopleLinks(value, owner));
  validatePeopleLinks({...book, links: [link, {...another, deleted: true}]}, owner);
  validatePeopleLinks({...book, links: [link, {...another, albumId: "44444444-4444-4444-8444-444444444444"}]}, owner);
  validatePeopleLinks({...book, links: [{...link, deleted: true, aliases: []}]}, owner);
});

test("whole-book merge converges canonical order, preserves tombstones, and keeps concurrent conflict sticky", async () => {
  const {mergePeopleLinks} = await import("../packages/contracts/src/people-links.js");
  const base = book, local = {...book, links: [{...link, name: "Mother"}]}, remote = {...book, links: [{...link, deleted: true}]};
  assert.deepEqual(mergePeopleLinks(base, base, remote).value, remote);
  assert.deepEqual(mergePeopleLinks(base, local, base).value, local);
  const conflict = mergePeopleLinks(base, local, remote);
  assert.deepEqual(conflict.value, local); assert.deepEqual(conflict.conflicts, [{field: "links"}]);
  const refreshed = mergePeopleLinks(remote, local, remote, conflict.conflicts);
  assert.deepEqual(refreshed.value, local); assert.deepEqual(refreshed.conflicts, [{field: "links"}]);
  assert.deepEqual(mergePeopleLinks(remote, local, local, conflict.conflicts).conflicts, []);
  assert.deepEqual(mergePeopleLinks(base, {...book, links: [{...link, aliases: [...link.aliases].reverse()}]}, base).conflicts, []);
});
