import {ApiError, type Actor, type Env, fail} from "./errors";

export const DEFAULT_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export function positiveLimit(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(result)) fail("INTERNAL_ERROR", 500);
  return result;
}
export const storageLimit = (env: Env) => positiveLimit(env.ACCOUNT_STORAGE_LIMIT_BYTES, DEFAULT_STORAGE_LIMIT_BYTES);

// Only leases whose staging write has never started are refundable by expiry.
export const expireStorage = (env: Env, accountId: string, now: number) => env.DB.prepare(
  "DELETE FROM upload_storage_claims WHERE account_id=? AND state='reserved' AND expires<=?",
).bind(accountId, now);

export async function accountStorage(env: Env, actor: Actor) {
  const results = await env.DB.batch([
    expireStorage(env, actor.accountId, Date.now()),
    env.DB.prepare("SELECT reserved_bytes,stored_bytes FROM account_storage WHERE account_id=?").bind(actor.accountId),
  ]);
  const usage = results[1].results[0] as {reserved_bytes: number; stored_bytes: number} | undefined;
  const limitBytes = storageLimit(env), reservedBytes = usage?.reserved_bytes ?? 0, storedBytes = usage?.stored_bytes ?? 0;
  return {version: 1, limitBytes, reservedBytes, storedBytes, availableBytes: Math.max(0, limitBytes - reservedBytes - storedBytes)};
}

// The edge supplies CF-Connecting-IP. Store only a per-window hash, never raw addresses.
export async function throttleAuth(env: Env, request: Request, enrollment = false, accountId?: string) {
  if (env.AUTH_MODE !== "production") return;
  const address = request.headers.get("cf-connecting-ip");
  if (!address || address.length > 64) fail("AUTH_THROTTLE_UNAVAILABLE", 503);
  const now = Date.now(), window = Math.floor(now / 60000), expires = (window + 1) * 60000;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fotoro-auth-v1|${window}|${address}`)));
  const key = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  const buckets: [string, number][] = [["ip:" + key, positiveLimit(env.AUTH_REQUESTS_PER_MINUTE, 30)]];
  if (enrollment) buckets.push(["enroll:" + key, positiveLimit(env.ENROLLMENTS_PER_MINUTE, 6)]);
  if (accountId) {
    const accountHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fotoro-auth-account-v1|${window}|${accountId}`)));
    buckets.push(["account:" + Array.from(accountHash, byte => byte.toString(16).padStart(2, "0")).join(""), positiveLimit(env.AUTH_REQUESTS_PER_MINUTE, 30)]);
  }
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE expires<=?").bind(now),
    ...buckets.map(([bucket, limit]) => env.DB.prepare(
      "INSERT INTO auth_rate_limits(key,expires,attempts) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=auth_rate_limits.attempts+1 WHERE auth_rate_limits.attempts<? RETURNING attempts",
    ).bind(bucket, expires, limit)),
  ]);
  if (result.slice(1).some(value => !value.results.length))
    throw new ApiError("AUTH_RATE_LIMITED", 429, undefined, Math.max(1, Math.ceil((expires - now) / 1000)));
}
