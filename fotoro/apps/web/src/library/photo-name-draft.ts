import type {PhotoOrganizationPatch} from "@fotoro/contracts/organization";

export interface PhotoNameDraft {
  savedName: string;
  value: string;
  savedNameChanged: boolean;
}

export const createPhotoNameDraft = (savedName: string): PhotoNameDraft => ({savedName, value: savedName, savedNameChanged: false});

export function editPhotoNameDraft(draft: PhotoNameDraft, value: string): PhotoNameDraft {
  return {...draft, value, savedNameChanged: draft.savedNameChanged && value !== draft.savedName};
}

export function reconcilePhotoNameDraft(draft: PhotoNameDraft, savedName: string): PhotoNameDraft {
  if (savedName === draft.savedName) return draft;
  if (draft.value === draft.savedName || draft.value === savedName) return createPhotoNameDraft(savedName);
  return {...draft, savedName, savedNameChanged: true};
}
// The caller retains operation admission/source validation. A successful,
// explicit name operation resolves its draft; receiving remote state does not.
export async function applyPhotoOrganizationDraft(
  patch: PhotoOrganizationPatch, originalName: string,
  change: (patch: PhotoOrganizationPatch) => Promise<void>, current: () => boolean,
  publishName: (draft: PhotoNameDraft) => void,
) {
  if (!current()) return;
  await change(patch);
  if (current() && patch.name !== undefined) publishName(createPhotoNameDraft(patch.name ?? originalName));
}
