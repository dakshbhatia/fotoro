import type {AccountContactV1, AccountContactsV1} from "./models.js";
import {validateWire} from "./validate.js";
import {validatePublicAccountCard} from "./share-links.js";

export type ContactConflictField = "card" | "name" | "deleted";
export interface ContactConflict {accountId: string; fields: ContactConflictField[];}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function validateContacts(value: unknown, ownerAccountId: string): AccountContactsV1 {
  const book = validateWire<AccountContactsV1>("AccountContactsV1", value);
  if (!uuid.test(ownerAccountId) || book.ownerAccountId !== ownerAccountId) throw new Error("CONTACT_OWNER_MISMATCH");
  const ids = new Set<string>();
  for (const entry of book.entries) {
    if (!uuid.test(entry.accountId) || entry.accountId === ownerAccountId || ids.has(entry.accountId) || entry.name.length > 80)
      throw new Error("CONTACT_BINDING_MISMATCH");
    ids.add(entry.accountId);
    if (entry.card === null) {
      if (entry.name !== "") throw new Error("CONTACT_BINDING_MISMATCH");
    } else if (validatePublicAccountCard(entry.card).accountId !== entry.accountId) throw new Error("CONTACT_BINDING_MISMATCH");
  }
  return book;
}
export function sameContactCard(a: AccountContactV1["card"] | undefined, b: AccountContactV1["card"] | undefined) {
  return a === b || !!a && !!b && a.accountId === b.accountId && a.boxPublicKey === b.boxPublicKey && a.signingPublicKey === b.signingPublicKey && a.version === b.version;
}
const sameEntry = (a: AccountContactV1 | undefined, b: AccountContactV1 | undefined) => a === b || !!a && !!b && a.accountId === b.accountId && sameContactCard(a.card, b.card) && a.name === b.name;

// Remote trust was approved on another unlocked device. New identities restore
// automatically; changing a key already trusted here always needs local review.
export function mergeContacts(base: AccountContactsV1, local: AccountContactsV1, remote: AccountContactsV1,
  unresolved: readonly ContactConflict[] = []): {value: AccountContactsV1; conflicts: ContactConflict[]} {
  const owner = local.ownerAccountId;
  for (const book of [base, local, remote]) validateContacts(book, owner);
  const indexed = [base, local, remote].map(book => new Map(book.entries.map(entry => [entry.accountId, entry])));
  const ids = [...new Set([...indexed[0].keys(), ...indexed[1].keys(), ...indexed[2].keys()])].sort();
  const entries: AccountContactV1[] = [], conflicts: ContactConflict[] = [];
  for (const accountId of ids) {
    const [before, mine, theirs] = indexed.map(book => book.get(accountId));
    const fields = new Set<ContactConflictField>();
    let value: AccountContactV1 | undefined;
    if (!mine) value = theirs ?? before;
    else if (!theirs) value = mine; // Missing is never a deletion; retain explicit tombstones.
    else if (mine.card === null || theirs.card === null) {
      if (sameEntry(mine, theirs)) value = mine;
      else if (sameEntry(mine, before)) value = theirs;
      else if (sameEntry(theirs, before)) value = mine;
      else {value = mine; fields.add("deleted");}
    } else {
      const card = mine.card;
      if (!sameContactCard(mine.card, theirs.card) && !sameContactCard(theirs.card, before?.card)) fields.add("card");
      let name = mine.name;
      if (mine.name === before?.name) name = theirs.name;
      else if (theirs.name !== before?.name && theirs.name !== mine.name) fields.add("name");
      value = {accountId, card, name};
    }
    // Rebasing after a download must not turn an unresolved name/deletion
    // conflict into an automatic overwrite on the next foreground refresh.
    for (const field of unresolved.find(item => item.accountId === accountId)?.fields ?? []) {
      const different = field === "name" ? mine?.name !== theirs?.name
        : field === "card" ? !sameContactCard(mine?.card, theirs?.card) : !sameEntry(mine, theirs);
      if (different) {
        fields.add(field);
        if (field === "name" && value?.card && mine?.card) value = {...value, name: mine.name};
        else if (field === "card" && value?.card && mine?.card) value = {...value, card: mine.card};
        else value = mine;
      }
    }
    if (value) entries.push(value);
    if (fields.size) conflicts.push({accountId, fields: [...fields].sort()});
  }
  const value: AccountContactsV1 = {version: 1, ownerAccountId: owner, entries};
  validateContacts(value, owner);
  return {value, conflicts};
}
