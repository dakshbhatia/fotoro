import type { PendingImport } from "./journal";
import { pendingImports, resumePendingImports } from "./journal";
import { cachedCatalog, syncCatalog } from "../library/catalog";
import { requireVault, encryptPrivate, decryptPrivate } from "../vault/vault";
import type { UnlockedVault } from "../vault/vault";
import type { WrappedKeyV1 } from "@fotoro/contracts";
import { assertVault } from "../vault/scope";
import { get, put } from "./cache";
import { flushAnnotations, pendingAnnotations } from "./annotations";
export function syncStatus(
  imports: Pick<PendingImport, "state">[],
  lastSuccessfulSync: string | null,
  skipped = 0,
  local = 0,
) {
  const synced = imports.filter((item) => item.state === "committed").length;
  const failed = imports.filter((item) => item.state === "failed").length;
  const pending = imports.length - synced - failed;
  return {
    synced,
    failed,
    pending,
    skipped,
    label: failed
      ? `${failed} failed`
      : pending
        ? `${pending} pending`
        : skipped
          ? `${skipped} skipped`
          : local
            ? `${local} local photos not synced`
            : lastSuccessfulSync
              ? "Synced"
              : "Not synced yet",
  };
}
export class ScopedFlight<T> {
  private flights = new WeakMap<object, Promise<T>>();
  run(scope: object, task: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(scope);
    if (existing) return existing;
    const operation = Promise.resolve().then(task);
    this.flights.set(scope, operation);
    void operation
      .finally(() => {
        if (this.flights.get(scope) === operation) this.flights.delete(scope);
      })
      .catch(() => undefined);
    return operation;
  }
}
export { sameVault, assertVault } from "../vault/scope";
export async function lastSync(session = requireVault()) {
  const value = await get<WrappedKeyV1>(
    "settings",
    session.accountId + ":last-checked",
  );
  assertVault(session);
  return value ? decryptPrivate<string>(value) : null;
}
const flight = new ScopedFlight<Awaited<ReturnType<typeof performSync>>>();
const controllers = new WeakMap<UnlockedVault, AbortController>();
export function pauseSync(session = requireVault()) {
  controllers.get(session)?.abort();
}
export async function skippedImports(session = requireVault()) {
  const wrapped = await get<WrappedKeyV1>(
    "settings",
    session.accountId + ":skipped-sources",
  );
  assertVault(session);
  return wrapped
    ? Object.keys(decryptPrivate<Record<string, string>>(wrapped)).length
    : 0;
}
export async function recordSkipped(
  session: UnlockedVault,
  file: File,
  error: unknown,
) {
  const key = session.accountId + ":skipped-sources";
  const wrapped = await get<WrappedKeyV1>("settings", key);
  assertVault(session);
  const sources = wrapped
    ? decryptPrivate<Record<string, string>>(wrapped)
    : {};
  sources[JSON.stringify([file.name, file.size, file.lastModified])] =
    error instanceof Error ? error.message : "SOURCE_UNAVAILABLE";
  assertVault(session);
  await put("settings", key, encryptPrivate(sources));
  assertVault(session);
}
export async function clearSkipped(session: UnlockedVault, file: File) {
  const key = session.accountId + ":skipped-sources";
  const wrapped = await get<WrappedKeyV1>("settings", key);
  assertVault(session);
  if (!wrapped) return;
  const sources = decryptPrivate<Record<string, string>>(wrapped);
  delete sources[JSON.stringify([file.name, file.size, file.lastModified])];
  assertVault(session);
  await put("settings", key, encryptPrivate(sources));
  assertVault(session);
}
async function performSync(session: UnlockedVault, signal: AbortSignal) {
  assertVault(session);
  await resumePendingImports(signal);
  assertVault(session);
  signal.throwIfAborted();
  await syncCatalog(signal);
  assertVault(session);
  signal.throwIfAborted();
  await flushAnnotations(session, signal);
  assertVault(session);
  signal.throwIfAborted();
  const annotations = await pendingAnnotations(session);
  assertVault(session);
  const pending = await pendingImports();
  assertVault(session);
  let lastSuccessfulSync = await lastSync(session);
  {
    lastSuccessfulSync = new Date().toISOString();
    assertVault(session);
    await put(
      "settings",
      session.accountId + ":last-checked",
      encryptPrivate(lastSuccessfulSync),
    );
    assertVault(session);
  }
  const photos = await cachedCatalog();
  assertVault(session);
  const skipped = await skippedImports(session);
  assertVault(session);
  return { photos, pending, annotations, lastSuccessfulSync, skipped };
}
export function refreshSync(session = requireVault()) {
  return flight.run(session, () => {
    const controller = new AbortController();
    controllers.set(session, controller);
    return performSync(session, controller.signal).finally(() => {
      if (controllers.get(session) === controller) controllers.delete(session);
    });
  });
}
export function readableSyncError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (
    error instanceof Error &&
    ["AbortError", "NotAllowedError"].includes(error.name)
  )
    return "Paused or cancelled. Your originals have not changed.";
  if (code === "PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED")
    return "Public test accounts cannot sync your private files. Use a real account.";
  if (/ANNOTATION|VERSION_CONFLICT/.test(code))
    return "Your labels or text could not sync. Your pending edits are saved here; open Sync photos to retry or review them.";
  if (code === "VAULT_LOCKED")
    return "Your library is locked. Sign in to continue.";
  if (/UNAUTHENTICATED|FORBIDDEN/.test(code))
    return "Sign in again to continue syncing.";
  if (/SUPPORTED_ORIGINALS|SOURCE_FORMAT/.test(code))
    return "Browser sync supports JPEG and PNG originals. HEIC photos synced from iPhone can be viewed here.";
  if (/50_MIB/.test(code)) return "Choose photos smaller than 50 MB.";
  if (/STAGING_MISSING/.test(code))
    return "Choose the original file again to finish syncing.";
  if (/SOURCE_MISMATCH/.test(code))
    return "That file does not match the original. Choose the same photo.";
  if (/GRANT_INACTIVE/.test(code))
    return "Access to these shared photos has ended.";
  if (
    /INVALID_RECOVERY|wrong secret|ciphertext cannot|invalid ciphertext/i.test(
      code,
    )
  )
    return "That recovery code could not unlock your library. Check the complete code.";
  if (/NotAllowedError|cancelled|canceled|not completed/i.test(code))
    return "Sign-in was cancelled. Your photos have not changed.";
  if (/REAL_AUTH_REQUIRED/.test(code))
    return "Passkey setup is unavailable on this local test service.";
  if (/DIGEST|CIPHERTEXT|AUTHENTICATION/.test(code))
    return "This photo could not be verified. It has not been marked as synced.";
  if (/PRF_UNAVAILABLE|AUTHENTICATED_USE_RECOVERY/.test(code))
    return "Use your saved recovery code to unlock photos on this device.";
  return "Sync could not finish. Your originals are unchanged. Try again when online.";
}
