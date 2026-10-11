import type {AlbumPhotoFactsContentV1} from "@fotoro/contracts/album-photo-facts";
import type {Photo} from "../library/catalog";
import {normalizeSearch} from "../local/search";
import {parseNaturalDateQuery} from "../local/natural-date";
import type {PeopleFilter, ReviewedPerson} from "../people/filter";
export type AlbumSharedFacts = ReadonlyMap<string, AlbumPhotoFactsContentV1>;
export const albumPersonKey = (owner: string, name: string) => JSON.stringify([owner, name]);
export function sharedAlbumDetails(photo: Photo, facts?: AlbumSharedFacts) {
  const value = facts?.get(photo.manifest.photoId);
  return value?.photoId === photo.manifest.photoId && value.ownerAccountId === photo.manifest.ownerAccountId && value.originalSha256 === photo.metadata.originalSha256 ? value : undefined;
}
export function albumReviewedPeople(photos: readonly Photo[], facts: AlbumSharedFacts, current: () => boolean): ReviewedPerson[] {
  if (!current()) return [];
  const values = new Map<string, ReviewedPerson>();
  for (const photo of photos) for (const name of sharedAlbumDetails(photo, facts)?.people ?? []) {
    const id = albumPersonKey(photo.manifest.ownerAccountId, name), person = values.get(id);
    if (person) person.photoCount++; else values.set(id, {id, names: [name], photoCount: 1});
  }
  return current() ? [...values.values()].sort((a, b) => a.names[0].localeCompare(b.names[0]) || a.id.localeCompare(b.id)) : [];
}
function day(value: string, after = false) {
  if (!/^\d{4}-\d\d-\d\d$/.test(value)) return;
  const [year, month, date] = value.split("-").map(Number), start = new Date(year, month - 1, date);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== date) return;
  if (after) start.setDate(start.getDate() + 1);
  return start.getTime();
}
// Only explicitly shared, authenticated details enter album search; private annotations never do.
export function searchAlbumPhotos(photos: Photo[], query: string, current: () => boolean, now = Date.now(), options: {
  facts?: AlbumSharedFacts; people?: PeopleFilter; from?: string; through?: string; linkedPeople?: readonly {id: string; name: string; aliases: readonly string[]}[];
} = {}) {
  if (!current()) return [];
  const dateQuery = parseNaturalDateQuery(query, {now});
  const tokens = (dateQuery.text.match(/[\p{L}\p{N}]+/gu) ?? []).map(normalizeSearch);
  const from = day(options.from ?? ""), until = day(options.through ?? "", true), selected = [...(options.people?.ids ?? [])];
  const linkedByAlias = new Map<string, {id: string; name: string}[]>();
  for (const person of options.linkedPeople ?? []) {
    const linked = {id: person.id, name: person.name};
    for (const alias of person.aliases) {
      const matches = linkedByAlias.get(alias);
      if (matches) matches.push(linked); else linkedByAlias.set(alias, [linked]);
    }
  }
  const eligible = photos.filter(photo => {
    const details = sharedAlbumDetails(photo, options.facts), assigned = new Set((details?.people ?? []).map(name => albumPersonKey(photo.manifest.ownerAccountId, name)));
    const linked = new Set<{id: string; name: string}>();
    for (const alias of assigned) for (const person of linkedByAlias.get(alias) ?? []) linked.add(person);
    for (const person of linked) assigned.add(person.id);
    if (selected.length && !(options.people?.mode === "everyone" ? selected.every(id => assigned.has(id)) : selected.some(id => assigned.has(id)))) return false;
    if (from !== undefined || until !== undefined || dateQuery.phrase !== undefined) {
      const date = Date.parse(photo.metadata.sourceDate);
      if (!["exif", "photos"].includes(photo.metadata.dateSource) || !Number.isFinite(date)
        || from !== undefined && date < from || until !== undefined && date >= until
        || dateQuery.from !== undefined && date < dateQuery.from || dateQuery.until !== undefined && date >= dateQuery.until) return false;
    }
    if (!tokens.length) return !normalizeSearch(query) || dateQuery.phrase !== undefined;
    // Every term must be supported by this copy's own shared fields; never combine copies or private annotations.
    const fields = [photo.metadata.filename, ...(details?.people ?? []), ...Array.from(linked, person => person.name), details?.location?.name ?? "", ...(details?.location ? ["GPS"] : [])];
    const words = fields.flatMap(field => normalizeSearch(field).match(/[\p{L}\p{N}]+/gu) ?? []);
    return tokens.every((token, index) => words.some(word => word === token || index === tokens.length - 1 && !/^\d+$/.test(token) && word.startsWith(token)));
  });
  return current() ? eligible : [];
}
