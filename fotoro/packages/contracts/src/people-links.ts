import type {AccountCardV1, AccountPeopleLinksV1} from "./models.js";
import {validateWire} from "./validate.js";
import {validatePublicAccountCard} from "./share-links.js";

export interface PeopleLinksConflict {field: "links";}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const cardIdentity = (card: AccountCardV1) => [card.accountId, card.boxPublicKey, card.signingPublicKey, card.version];
export function validatePeopleLinks(value: unknown, ownerAccountId: string): AccountPeopleLinksV1 {
  const book = validateWire<AccountPeopleLinksV1>("AccountPeopleLinksV1", value);
  if (!uuid.test(ownerAccountId) || book.ownerAccountId !== ownerAccountId) throw new Error("PEOPLE_LINKS_OWNER_MISMATCH");
  const ids = new Set<string>(), sources = new Set<string>();
  for (const link of book.links) {
    if (!uuid.test(link.id) || !uuid.test(link.albumId) || ids.has(link.id) || !link.name.trim() || link.name.length > 80)
      throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
    ids.add(link.id);
    const url = new URL(link.origin);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== link.origin || url.username || url.password)
      throw new Error("PEOPLE_LINKS_SCOPE_MISMATCH");
    validatePublicAccountCard(link.ownerCard);
    if (!link.deleted && link.aliases.length < 2) throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
    for (const alias of link.aliases) {
      validatePublicAccountCard(alias.card);
      if (!alias.name.trim() || alias.name.length > 80) throw new Error("PEOPLE_LINKS_BINDING_MISMATCH");
      if (link.deleted) continue;
      const source = JSON.stringify([link.origin, link.albumId, cardIdentity(link.ownerCard), cardIdentity(alias.card), alias.name]);
      if (sources.has(source)) throw new Error("PEOPLE_LINKS_SOURCE_OVERLAP");
      sources.add(source);
    }
  }
  return book;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function canonicalPeopleLinks(book: AccountPeopleLinksV1): string {
  validatePeopleLinks(book, book.ownerAccountId);
  return JSON.stringify([book.version, book.ownerAccountId, book.links.map(link => [link.id, link.origin, link.albumId,
    cardIdentity(link.ownerCard), link.name, link.deleted,
    link.aliases.map(alias => [cardIdentity(alias.card), alias.name]).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
  ]).sort((a, b) => compare(a[0] as string, b[0] as string))]);
}
// Whole-book review avoids inferring identity from names or resurrecting a
// deleted link through a field merge. Unresolved conflicts survive rebasing.
export function mergePeopleLinks(base: AccountPeopleLinksV1, local: AccountPeopleLinksV1, remote: AccountPeopleLinksV1,
  unresolved: readonly PeopleLinksConflict[] = []): {value: AccountPeopleLinksV1; conflicts: PeopleLinksConflict[]} {
  for (const book of [base, local, remote]) validatePeopleLinks(book, local.ownerAccountId);
  const before = canonicalPeopleLinks(base), mine = canonicalPeopleLinks(local), theirs = canonicalPeopleLinks(remote);
  if (mine === theirs) return {value: local, conflicts: []};
  if (unresolved.length) return {value: local, conflicts: [{field: "links"}]};
  if (mine === before) return {value: remote, conflicts: []};
  if (theirs === before) return {value: local, conflicts: []};
  return {value: local, conflicts: [{field: "links"}]};
}
