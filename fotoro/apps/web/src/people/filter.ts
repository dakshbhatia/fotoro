import {validatedPeopleAssignments} from "@fotoro/contracts/people";
import type {SearchPhoto, SearchResult} from "../local/search";

export interface PeopleFilter {ids: ReadonlySet<string>; mode: "any" | "everyone"}
export interface ReviewedPerson {id: string; names: string[]; photoCount: number}
export const emptyPeopleFilter = (): PeopleFilter => ({ids: new Set(), mode: "any"});
export function peopleReviewPhotos<T extends SearchPhoto>(photos: readonly T[], selectedOnly = false, selectedIDs?: ReadonlySet<string>): T[] {
  return photos.filter(photo => !!photo.digest && photo.current?.() !== false && (!selectedOnly || selectedIDs?.has(photo.id)));
}
export function reviewedPeople(photos: readonly SearchPhoto[]): ReviewedPerson[] {
  const people = new Map<string, {names: Set<string>; photos: Set<string>}>();
  for (const photo of photos) {
    if (photo.current?.() === false) continue;
    for (const assignment of validatedPeopleAssignments(photo.facts, photo.digest ?? "")) {
      const person = people.get(assignment.personId) ?? {names: new Set<string>(), photos: new Set<string>()};
      person.names.add(assignment.name); person.photos.add(photo.id); people.set(assignment.personId, person);
    }
  }
  return [...people].map(([id, value]) => ({id, names: [...value.names].sort(), photoCount: value.photos.size}))
    .sort((left, right) => left.names.join(" / ").localeCompare(right.names.join(" / ")) || left.id.localeCompare(right.id));
}
export function peopleMatchingPhotoIDs(photos: readonly SearchPhoto[], filter: PeopleFilter): Set<string> {
  const ids = new Set<string>(), selected = [...filter.ids];
  for (const photo of photos) {
    if (photo.current?.() === false) continue;
    const assigned = new Set(validatedPeopleAssignments(photo.facts, photo.digest ?? "").map(person => person.personId));
    if (!selected.length || (filter.mode === "everyone" ? selected.every(id => assigned.has(id)) : selected.some(id => assigned.has(id)))) ids.add(photo.id);
  }
  return ids;
}
// Filter before lexical ranking and its result cap; also constrain visual inputs.
export function peopleFilteredResult(result: SearchResult, permitted: ReadonlySet<string>): SearchResult {
  const restrict = (ids: readonly string[]) => ids.filter(id => permitted.has(id));
  const photoIds = restrict(result.photoIds);
  const meaning = result.meaning ? {...result.meaning, photoIds: restrict(result.meaning.photoIds)} : undefined;
  return {...result, photoIds, photoId: result.photoId && permitted.has(result.photoId) ? result.photoId : photoIds[0],
    meanings: result.meanings.map(meaning => ({...meaning, photoIds: restrict(meaning.photoIds)})).filter(meaning => meaning.photoIds.length),
    meaning: meaning?.photoIds.length ? meaning : undefined};
}
// An explicit Select these action replaces old picks with the current result set.
export function peopleResultSelection(photos: readonly SearchPhoto[], results: readonly SearchPhoto[], localIDs: ReadonlySet<string>) {
  const available = new Map(photos.filter(photo => photo.current?.() !== false).map(photo => [photo.id, photo]));
  const local = new Set<string>(), saved = new Set<string>();
  for (const photo of results) {
    const id = photo.id;
    if (photo.current?.() === false || !available.has(id) || available.get(id)!.digest !== photo.digest) continue;
    if (localIDs.has(id)) local.add(id);
    else if (id.startsWith("saved:")) saved.add(id.slice(6));
  }
  return {local, saved};
}
