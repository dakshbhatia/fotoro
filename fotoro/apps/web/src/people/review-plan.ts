import {validatedPeopleAssignments} from "@fotoro/contracts/people";
import type {LocalPhoto} from "../local/resources";
import {peopleReviewPhotos} from "./filter";
import {peopleSourceCurrent} from "./groups";

export function peopleReviewPlan(photos: readonly LocalPhoto[], options: {
  eligibleIDs?: ReadonlySet<string>; selectedOnly?: boolean; selectedIDs?: ReadonlySet<string>;
  scanned?: ReadonlyMap<string, LocalPhoto>; attempted?: ReadonlyMap<string, LocalPhoto>; reassess?: boolean;
}) {
  const eligible = peopleReviewPhotos(photos, options.selectedOnly, options.selectedIDs, options.eligibleIDs);
  const pending: LocalPhoto[] = [], reused: LocalPhoto[] = [];
  for (const photo of eligible) {
    const previous = options.scanned?.get(photo.id);
    if ((previous && peopleSourceCurrent(previous, photo)) || (!options.reassess && validatedPeopleAssignments(photo.facts, photo.digest!).length)) reused.push(photo);
    else pending.push(photo);
  }
  const retried = (photo: LocalPhoto) => {const previous = options.attempted?.get(photo.id); return previous && peopleSourceCurrent(previous, photo) ? 1 : 0;};
  pending.sort((left, right) => retried(left) - retried(right));
  const batch = pending.slice(0, 500);
  return {eligible, pending, reused, batch, remaining: pending.length - batch.length};
}
