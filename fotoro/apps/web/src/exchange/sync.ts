import {diagnose, type DiagnosticContext} from "../diagnostics";
import type { PendingImport } from "./journal";
import { pendingImports, resumePendingImports } from "./journal";
import { cachedCatalogSnapshot, syncCatalog, type CatalogBrowse } from "../library/catalog";
import { requireVault, encryptPrivate, decryptPrivate } from "../vault/vault";
import type { UnlockedVault } from "../vault/vault";
import type { WrappedKeyV1 } from "@fotoro/contracts";
import { assertVault } from "../vault/scope";
import { get, put } from "./cache";
import { flushAnnotations, pendingAnnotations } from "./annotations";
import {accountLimitMessage} from "./api-errors";
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
  private flights = new WeakMap<object, Map<string | undefined, Promise<T>>>();
  run(scope: object, task: () => Promise<T>, window?: string): Promise<T> {
    let scoped = this.flights.get(scope);
    const existing = scoped?.get(window);
    if (existing) return existing;
    if (!scoped) {scoped = new Map(); this.flights.set(scope, scoped);}
    const flights = scoped;
    const operation = Promise.resolve().then(task);
    flights.set(window, operation);
    void operation
      .finally(() => {
        if (flights.get(window) === operation) flights.delete(window);
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
const saveFlight = new ScopedFlight<Awaited<ReturnType<typeof performSave>>>();
const operations = new WeakMap<UnlockedVault, Promise<unknown>>();
const controllers = new WeakMap<UnlockedVault, AbortController>();
function serializeSync<T>(session: UnlockedVault, task: () => Promise<T>) {
  const next = (operations.get(session) ?? Promise.resolve()).catch(() => undefined).then(() => {
    assertVault(session);
    return task();
  });
  operations.set(session, next);
  void next.finally(() => {if (operations.get(session) === next) operations.delete(session);}).catch(() => undefined);
  return next;
}
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
export async function cachedSync(session = requireVault(), diagnostic?: DiagnosticContext, browse?: CatalogBrowse) {
  const check = () => {assertVault(session); browse?.signal?.throwIfAborted(); if (browse?.current?.() === false) throw new DOMException("Catalog read withdrawn", "AbortError");};
  check();
  const {photos, coverage} = await cachedCatalogSnapshot(diagnostic, browse);
  try {
    check();
    const pending = await pendingImports();
    check();
    const annotations = await pendingAnnotations(session);
    check();
    const lastSuccessfulSync = await lastSync(session);
    check();
    const skipped = await skippedImports(session);
    check();
    return { photos, coverage, pending, annotations, lastSuccessfulSync, skipped };
  } catch (error) {for (const photo of photos) photo.metadataKey.fill(0); throw error;}
}
async function performRefresh(session: UnlockedVault, signal?: AbortSignal, diagnostic?: DiagnosticContext, browse?: CatalogBrowse) {
  assertVault(session);
  const feed = await syncCatalog(signal, diagnostic, browse ? 4 : Infinity, browse?.current);
  assertVault(session);
  signal?.throwIfAborted();
  if (!feed.hasMore) {
    const lastSuccessfulSync = new Date().toISOString();
    await put("settings", session.accountId + ":last-checked", encryptPrivate(lastSuccessfulSync));
  }
  assertVault(session);
  const result = await cachedSync(session, diagnostic, browse);
  try {
    assertVault(session); signal?.throwIfAborted();
    if (browse?.current?.() === false) throw new DOMException("Catalog read withdrawn", "AbortError");
    return result;
  } catch (error) {for (const photo of result.photos) photo.metadataKey.fill(0); throw error;}
}
async function performSave(session: UnlockedVault, signal: AbortSignal, diagnostic?: DiagnosticContext) {
  assertVault(session);
  signal.throwIfAborted();
  await resumePendingImports(signal, diagnostic);
  assertVault(session);
  signal.throwIfAborted();
  await syncCatalog(signal, diagnostic);
  assertVault(session);
  signal.throwIfAborted();
  await flushAnnotations(session, signal, diagnostic);
  assertVault(session);
  signal.throwIfAborted();
  const lastSuccessfulSync = new Date().toISOString();
  await put("settings", session.accountId + ":last-checked", encryptPrivate(lastSuccessfulSync));
  assertVault(session);
  const result = await cachedSync(session, diagnostic);
  assertVault(session); signal.throwIfAborted();
  if (result.pending.some(item => item.state !== "committed") || result.annotations.length) diagnostic?.incomplete("unavailable");
  return result;
}
// Viewing the account can read saved photos, but never drains locally queued uploads or edits.
export async function refreshSync(session = requireVault(), browse?: CatalogBrowse) {
  const window = browse ? {...browse, retainPhotoIds: [...(browse.retainPhotoIds ?? [])]} : undefined;
  const origin = typeof location === "undefined" ? undefined : location.origin;
  // Foreground events are coalesced by their UI owner. Reads share the serialized
  // catalog cursor, not cancellation scopes or mutable hydrated metadata keys.
  const controller = new AbortController();
  const abort = () => controller.abort();
  const visibility = () => {if (document.visibilityState !== "visible") abort();};
  const current = () => !controller.signal.aborted && (window?.current?.() ?? true)
    && (typeof document === "undefined" || document.visibilityState === "visible")
    && (origin === undefined || location.origin === origin);
  const check = () => {assertVault(session); controller.signal.throwIfAborted(); if (!current()) throw new DOMException("Catalog read withdrawn", "AbortError");};
  window?.signal?.addEventListener("abort", abort, {once: true});
  if (window?.signal?.aborted) abort();
  if (typeof globalThis.window !== "undefined") {globalThis.window.addEventListener?.("fotoro-lock", abort); globalThis.window.addEventListener?.("pagehide", abort);}
  if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", visibility);
  let result: Awaited<ReturnType<typeof performRefresh>> | undefined;
  try {
    do {
      check();
      if (result) {for (const photo of result.photos) photo.metadataKey.fill(0); result = undefined;}
      // Each bounded slice uses the same owner; queued saves can run between continuations.
      result = await serializeSync(session, () => {check(); return diagnose("catalog", context => performRefresh(session, controller.signal, context, {...window, limit: window?.limit ?? Number.MAX_SAFE_INTEGER, signal: controller.signal, current}), "refresh");});
      check();
      if (result.coverage.hasMoreChanges !== true) return result;
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (current());
    check(); throw new DOMException("Catalog read withdrawn", "AbortError");
  } catch (error) {for (const photo of result?.photos ?? []) photo.metadataKey.fill(0); throw error;}
  finally {
    window?.signal?.removeEventListener("abort", abort);
    if (typeof globalThis.window !== "undefined") {globalThis.window.removeEventListener?.("fotoro-lock", abort); globalThis.window.removeEventListener?.("pagehide", abort);}
    if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", visibility);
  }
}
export function saveChosenImports(session: UnlockedVault, photoIds: readonly string[], signal?: AbortSignal, current?: () => boolean) {
  const chosen = [...photoIds];
  return serializeSync(session, async () => {
    signal?.throwIfAborted();
    if (current?.() === false) throw new DOMException("Import choice withdrawn", "AbortError");
    await resumePendingImports(signal, undefined, chosen, current);
    assertVault(session);
    signal?.throwIfAborted();
    if (current?.() === false) throw new DOMException("Import choice withdrawn", "AbortError");
  });
}
export function saveSync(session = requireVault(), signal?: AbortSignal, diagnostic?: DiagnosticContext) {
  signal?.throwIfAborted();
  return saveFlight.run(session, () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) controller.abort();
    controllers.set(session, controller);
    return serializeSync(session, () => diagnostic ? performSave(session, controller.signal, diagnostic)
      : diagnose("sync", context => performSave(session, controller.signal, context), "save")).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (controllers.get(session) === controller) controllers.delete(session);
    });
  });
}
export function readableSyncError(error: unknown) {
  const limit = accountLimitMessage(error);
  if (limit) return limit;
  const code = error instanceof Error ? error.message : "";
  if (
    error instanceof Error &&
    ["AbortError", "NotAllowedError"].includes(error.name)
  )
    return "Paused or cancelled. Your originals have not changed.";
  if (code === "PUBLIC_TEST_ACCOUNT_UPLOAD_DISABLED")
    return "Public test accounts cannot Save your private files. Use a real account.";
  if (/ANNOTATION|VERSION_CONFLICT/.test(code))
    return "Your labels or text could not Save. Your pending edits are kept here; open Settings to retry or review them.";
  if (code === "CACHE_UPDATE_REQUIRES_RELOAD")
    return "Close other Fotoro tabs, then try again here.";
  if (code === "VAULT_LOCKED")
    return "Your library is locked. Sign in to continue.";
  if (/UNAUTHENTICATED|FORBIDDEN/.test(code))
    return "Open Fotoro again to continue saving.";
  if (code === "HEIC_NATIVE_DECODE_UNAVAILABLE")
    return "This browser cannot open that HEIC photo. Try Safari or a JPEG copy.";
  if (code === "SOURCE_DIMENSIONS_UNAVAILABLE")
    return "This photo's dimensions could not be verified. Choose a JPEG or PNG copy.";
  if (/SUPPORTED_ORIGINALS|SOURCE_FORMAT/.test(code))
    return "Choose a JPEG, PNG or supported HEIC photo.";
  if (/50_MIB/.test(code)) return "Choose photos smaller than 50 MB.";
  if (/STAGING_MISSING/.test(code))
    return "Choose the original file again to finish saving.";
  if (/SOURCE_MISMATCH/.test(code))
    return "That file does not match the original. Choose the same photo.";
  if (/GRANT_INACTIVE/.test(code))
    return "Access to these shared photos has ended.";
  if (
    /FOTORO_PASSWORD_NOT_FOUND|INVALID_FOTORO_PASSWORD|INVALID_RECOVERY|wrong secret|ciphertext cannot|invalid ciphertext/i.test(
      code,
    )
  )
    return "That Fotoro password could not unlock your library. Check the complete password.";
  if (/PASSWORD_ACCOUNT_MISMATCH/.test(code))
    return "That account could not be verified. Try signing in again.";
  if (/NO_ACCOUNT_PASSKEY/.test(code))
    return "Use your Fotoro password, then add a passkey in Settings.";
  if (/ACCOUNT_SETUP_NOT_STARTED/.test(code))
    return "Create an account to get your Fotoro password.";
  if (/PASSWORD_COPY_UNAVAILABLE/.test(code))
    return "Select your password to copy it, or choose Save password.";
  if (/NotAllowedError|cancelled|canceled|not completed/i.test(code))
    return "Sign-in was cancelled. Your photos have not changed.";
  if (/REAL_AUTH_REQUIRED/.test(code))
    return "Account setup is unavailable on this local test service.";
  if (/DIGEST|CIPHERTEXT|AUTHENTICATION/.test(code))
    return "This photo could not be verified. It has not been marked as saved.";
  if (/PRF_UNAVAILABLE|AUTHENTICATED_USE_RECOVERY/.test(code))
    return "Enter your Fotoro password to unlock photos on this device.";
  return "Save could not finish. Your originals are unchanged. Try again when online.";
}
