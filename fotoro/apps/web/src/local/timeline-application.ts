import type {TimelineCandidate} from "./google-timeline";

interface SavedIdentity {manifest: {photoId: string}}
export interface TimelineApplicationTarget<Local, Saved extends SavedIdentity> {
  candidate: TimelineCandidate;
  local?: Local;
  saved?: Saved;
}
export interface TimelineApplicationReply {
  applied: number;
  failed: number;
  needsSave?: boolean;
  localOnlyCount?: number;
  appliedPhotoIDs?: string[];
  updatedPhotoIDs?: string[];
  retryPhotoIDs?: string[];
}
export interface TimelineApplicationResult extends TimelineApplicationReply {
  needsSave: boolean;
  localOnlyCount: number;
  appliedPhotoIDs: string[];
  retryPhotoIDs: string[];
}
export function remainingTimelineCandidates(candidates: readonly TimelineCandidate[], result: TimelineApplicationReply): TimelineCandidate[] {
  if (!result.failed) return [];
  const applied = new Set(result.appliedPhotoIDs ?? result.updatedPhotoIDs ?? []);
  const retry = result.retryPhotoIDs ? new Set(result.retryPhotoIDs) : undefined;
  // A successful Saved projection invalidates the previous catalog snapshot.
  // Retain these bounded proposals; revalidate current sources on the next click.
  return candidates.filter(candidate => !applied.has(candidate.photoID) && (!retry || retry.has(candidate.photoID)));
}
// Queue acknowledgements establish Saved success. Copying the estimate to a
// matching local original additionally requires its current account/source fences.
export async function applyTimelineTargets<Local, Saved extends SavedIdentity>(targets: readonly TimelineApplicationTarget<Local, Saved>[], options: {
  current: () => boolean;
  localCurrent: (photo: Local) => boolean;
  savedCurrent: (photo: Saved, location: TimelineCandidate["location"]) => boolean;
  queueSaved?: (updates: readonly {photo: Saved; location: TimelineCandidate["location"]}[]) => Promise<{updatedPhotoIDs: string[]}>;
  applyLocal: (updates: readonly {photo: Local; location: TimelineCandidate["location"]}[]) => void;
}): Promise<TimelineApplicationResult> {
  if (!options.current()) throw new Error("Photos changed");
  const unique = [...new Map(targets.map(target => [target.candidate.photoID, target])).values()];
  const savedUpdates = new Map<string, {photo: Saved; location: TimelineCandidate["location"]}>();
  for (const {candidate, saved} of unique) if (saved && options.savedCurrent(saved, candidate.location))
    savedUpdates.set(saved.manifest.photoId, {photo: saved, location: candidate.location});
  let acknowledged = new Set<string>();
  if (savedUpdates.size && options.queueSaved) {
    try {
      const result = await options.queueSaved([...savedUpdates.values()]);
      acknowledged = new Set(result.updatedPhotoIDs.filter(id => savedUpdates.has(id)));
    } catch (error) {if (!options.current()) throw error;}
  }
  if (!options.current()) throw new Error("Photos changed");
  const appliedPhotoIDs: string[] = [], retryPhotoIDs: string[] = [], localUpdates: {photo: Local; location: TimelineCandidate["location"]}[] = [];
  let localOnlyCount = 0;
  for (const {candidate, local, saved} of unique) {
    if (saved) {
      if (acknowledged.has(saved.manifest.photoId)) {
        appliedPhotoIDs.push(candidate.photoID);
        if (local && options.savedCurrent(saved, candidate.location) && options.localCurrent(local)) localUpdates.push({photo: local, location: candidate.location});
      } else if (options.savedCurrent(saved, candidate.location)) retryPhotoIDs.push(candidate.photoID);
    } else if (local && options.localCurrent(local)) {
      appliedPhotoIDs.push(candidate.photoID); localOnlyCount++;
      localUpdates.push({photo: local, location: candidate.location});
    }
  }
  if (!options.current()) throw new Error("Photos changed");
  if (localUpdates.length) options.applyLocal(localUpdates);
  return {applied: appliedPhotoIDs.length, failed: unique.length - appliedPhotoIDs.length, needsSave: acknowledged.size > 0, localOnlyCount, appliedPhotoIDs, retryPhotoIDs};
}
