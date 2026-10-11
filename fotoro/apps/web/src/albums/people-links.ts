import type {AccountCardV1, AccountPeopleLinksV1, TripPersonLinkV1} from "@fotoro/contracts";
import {sameContactCard} from "@fotoro/contracts/contacts";
import type {Photo} from "../library/catalog";
import {albumPersonKey, albumReviewedPeople, type AlbumSharedFacts} from "./search";
export interface TripPeopleScope {accountId: string; origin: string; albumId: string; ownerCard: AccountCardV1; cards: readonly AccountCardV1[]; current: () => boolean;}
export const linkedPersonKey = (id: string) => "linked:" + id;
export interface LinkedTripPerson {id: string; name: string; aliases: string[]; link: TripPersonLinkV1;}
export function tripPeopleLinks(book: AccountPeopleLinksV1 | undefined, photos: readonly Photo[], facts: AlbumSharedFacts, scope: TripPeopleScope): LinkedTripPerson[] {
  if (!scope.current() || book?.ownerAccountId !== scope.accountId) return [];
  const reviewed = new Set(albumReviewedPeople(photos, facts, scope.current).map(person => person.id));
  const links = (book?.links ?? []).filter(link => !link.deleted && link.origin === scope.origin && link.albumId === scope.albumId && sameContactCard(link.ownerCard, scope.ownerCard));
  const ownership = new Map<string, number>();
  for (const link of links) for (const alias of link.aliases) {
    if (!scope.cards.some(card => sameContactCard(card, alias.card))) continue;
    const key = albumPersonKey(alias.card.accountId, alias.name); ownership.set(key, (ownership.get(key) ?? 0) + 1);
  }
  const result = links.map(link => ({id: linkedPersonKey(link.id), name: link.name, link,
    aliases: link.aliases.filter(alias => scope.cards.some(card => sameContactCard(card, alias.card)))
      .map(alias => albumPersonKey(alias.card.accountId, alias.name)).filter(key => reviewed.has(key) && ownership.get(key) === 1)})).filter(person => person.aliases.length);
  return scope.current() ? result : [];
}
