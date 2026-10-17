import {photoName, type PhotoNamePlanEntry, type PhotoNamePlanSource} from "@fotoro/contracts/organization";

// Preexisting duplicate names within the reviewed Undo are allowed; new conflicts are not.
export function canRestorePhotoNames(plan: readonly PhotoNamePlanEntry[], sources: readonly PhotoNamePlanSource[], reservedNames: readonly string[]) {
  const key = (name: string) => name.normalize("NFC").toLowerCase();
  const restoringIDs = new Set(plan.map(entry => entry.id));
  const reserved = new Set(reservedNames.map(key));
  for (const source of sources) {
    if (!restoringIDs.has(source.id)) reserved.add(key(photoName(source, source.filename)));
  }
  return plan.every(entry => !reserved.has(key(entry.previousName ?? entry.original)));
}
