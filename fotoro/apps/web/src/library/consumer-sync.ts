export type ConsumerSyncState = "notStarted" | "preparing" | "uploading" | "checking" | "upToDate" | "paused" | "offline" | "needsAttention";
export type ConsumerSyncAction = "start" | "continue" | "retry" | "signIn" | "openSettings" | "review" | "none";
export interface ConsumerSyncSummary {
  state: ConsumerSyncState;
  completedPhotos?: number;
  totalPhotos?: number;
  skippedPhotos: number;
  lastCheckedAt?: string;
  detail?: string;
  action: ConsumerSyncAction;
}
export interface ConsumerSyncFacts {
  unlocked: boolean; paused: boolean; online: boolean; preparing: boolean; busy: boolean; needsAttention: boolean;
  committedPhotos: number; queuedPhotos: number; failedPhotos: number; skippedPhotos: number;
  pendingEdits: number; conflictingEdits: number; localPhotos: number; lastCheckedAt: string | null;
}
export const syncStateLabel: Record<ConsumerSyncState, string> = {
  notStarted: "Save photos", preparing: "Preparing photos…", uploading: "Saving photos…", checking: "Checking photos…",
  upToDate: "Photos saved", paused: "Saving paused", offline: "Offline", needsAttention: "Needs attention",
};
export function deriveConsumerSyncSummary(facts: ConsumerSyncFacts): ConsumerSyncSummary {
  if (!facts.unlocked) return {state: "notStarted", skippedPhotos: 0, action: "signIn"};
  const details = [
    `${facts.committedPhotos} ${facts.committedPhotos === 1 ? "photo" : "photos"} saved`,
    facts.queuedPhotos ? `${facts.queuedPhotos} waiting` : "",
    facts.failedPhotos ? `${facts.failedPhotos} need another try` : "",
    facts.skippedPhotos ? `${facts.skippedPhotos} skipped` : "",
    facts.pendingEdits ? `${facts.pendingEdits} photo edits waiting` : "",
    facts.conflictingEdits ? `${facts.conflictingEdits} photo edits to review` : "",
    facts.localPhotos ? `${facts.localPhotos} selected to Save` : "",
  ].filter(Boolean).join(" · ");
  const base = {completedPhotos: facts.committedPhotos, skippedPhotos: facts.skippedPhotos, lastCheckedAt: facts.lastCheckedAt ?? undefined, detail: details};
  if (facts.paused) return {...base, state: "paused", action: "continue"};
  if (!facts.online) return {...base, state: "offline", action: "retry"};
  if (facts.needsAttention || facts.failedPhotos || facts.conflictingEdits) return {...base, state: "needsAttention", action: facts.conflictingEdits ? "review" : "retry"};
  if (facts.preparing) return {...base, state: "preparing", action: "none"};
  if (facts.queuedPhotos) return {...base, state: facts.busy ? "uploading" : "paused", action: facts.busy ? "none" : "continue"};
  if (facts.busy) return {...base, state: "checking", action: "none"};
  if (facts.pendingEdits || facts.skippedPhotos) return {...base, state: "needsAttention", action: facts.skippedPhotos ? "review" : "retry"};
  if (facts.localPhotos) return {...base, state: "notStarted", action: "start"};
  return {...base, state: facts.lastCheckedAt ? "upToDate" : "notStarted", action: facts.lastCheckedAt ? "none" : "start"};
}
