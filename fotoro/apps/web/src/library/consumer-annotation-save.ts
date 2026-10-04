import {flushAnnotations} from "../exchange/annotations";
import {sameVault} from "../vault/scope";
import type {UnlockedVault} from "../vault/vault";
import {cachedSync} from "../exchange/sync";

export async function saveQueuedAnnotations(session: UnlockedVault, current = () => sameVault(session)) {
  if (!current()) throw new Error("VAULT_LOCKED");
  await flushAnnotations(session);
  if (!current()) throw new Error("VAULT_LOCKED");
  const result = await cachedSync(session);
  if (!current()) throw new Error("VAULT_LOCKED");
  return result;
}
