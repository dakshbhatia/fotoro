import {isPeopleFact, validatedPeopleAssignments, type PeopleAssignment} from "@fotoro/contracts/people";
import type {OwnedPhotoSnapshot} from "../library/consumer-search";
import type {Photo} from "../library/catalog";
const ordered = (items: readonly PeopleAssignment[]) => JSON.stringify([...items].sort((a, b) => a.box.join(",").localeCompare(b.box.join(","))).map(item => [item.personId, item.name, item.box]));
// An encrypted write can finish before React publishes the new owned snapshot.
// Acknowledgement requires the same vault and the actual projected name edits.
export function peopleEditsVisible(snapshot: OwnedPhotoSnapshot | null, token: object,
  updates: readonly {photo: Photo; assignments: PeopleAssignment[]}[]): boolean {
  if (!snapshot?.current() || snapshot.token !== token) return false;
  return updates.every(update => {
    const photo = snapshot.photos.find(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId
      && photo.manifest.photoId === update.photo.manifest.photoId && photo.metadata.originalSha256 === update.photo.metadata.originalSha256);
    if (!photo) return false;
    const facts = photo.annotations?.facts;
    if (!update.assignments.length) return !facts?.some(isPeopleFact);
    return ordered(validatedPeopleAssignments(facts, photo.metadata.originalSha256)) === ordered(update.assignments);
  });
}
