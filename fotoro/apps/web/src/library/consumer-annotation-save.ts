import {flushAnnotations} from "../exchange/annotations";
import {sameVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";
import {cachedSync} from "../exchange/sync";
import type {CatalogBrowse} from "./catalog";

export async function saveQueuedAnnotations(session: UnlockedVault, current = () => sameVault(session), browse?: CatalogBrowse) {
  if (!current()) throw new Error("VAULT_LOCKED");
  await flushAnnotations(session);
  if (!current()) throw new Error("VAULT_LOCKED");
  const result = await cachedSync(session, undefined, browse);
  try {
    if (!current()) throw new Error("VAULT_LOCKED");
    // Conflict review and bounded retries can leave work queued without a transport error.
    if (result.annotations.length) throw new Error("ANNOTATION_SAVE_INCOMPLETE");
    return result;
  } catch (error) {
    for (const photo of result.photos) photo.metadataKey.fill(0);
    throw error;
  }
}
