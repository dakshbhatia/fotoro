import {flushAnnotations} from "../exchange/annotations";
import {sameVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";
import {cachedSync} from "../exchange/sync";
import type {CatalogBrowse} from "./catalog";

export async function saveQueuedAnnotations(session: UnlockedVault, current = () => sameVault(session), browse?: CatalogBrowse, selection?: {photoIds: readonly string[]; signal: AbortSignal}) {
  if (!current()) throw new Error("VAULT_LOCKED");
  await flushAnnotations(session, selection?.signal, undefined, selection ? {photoIds: selection.photoIds, current} : undefined);
  if (!current()) throw new Error("VAULT_LOCKED");
  const result = await cachedSync(session, undefined, browse);
  try {
    if (!current()) throw new Error("VAULT_LOCKED");
    // Conflict review and bounded retries can leave work queued without a transport error.
    if (result.annotations.some(edit => !selection || selection.photoIds.includes(edit.photoId))) throw new Error("ANNOTATION_SAVE_INCOMPLETE");
    return result;
  } catch (error) {
    for (const photo of result.photos) photo.metadataKey.fill(0);
    throw error;
  }
}
