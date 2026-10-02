import { validateWire } from "@fotoro/contracts/validate";
import type { SignedPayloadV1 } from "@fotoro/contracts";
import type { ErrorDiagnostic } from "./diagnostics";
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AUTH_MODE: "local" | "production";
  ASSETS?: Fetcher;
  APPLE_APP_IDS?: string;
}
export interface Actor {
  accountId: string;
  deviceId: string;
}
export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public diagnostic?: ErrorDiagnostic,
  ) {
    super(code);
  }
  get retryable() { return this.status >= 500 || this.status === 408; }
}
export const fail = (code: string, status = 400): never => {
  throw new ApiError(code, status);
};
export const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export function b64(bytes: Uint8Array) {
  let s = "";
  for (const v of bytes) s += String.fromCharCode(v);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export const utf8 = (value: unknown) => new TextEncoder().encode(json(value));
export async function verifySigned(
  signed: SignedPayloadV1,
  key: string,
  kind: string,
  accountId: string,
) {
  validateWire("SignedPayloadV1", signed);
  if (signed.accountId !== accountId || signed.kind !== kind)
    fail("FORBIDDEN", 403);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    unb64(key),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      unb64(signed.signature),
      utf8(["fotoro-signed-v1", signed.kind, signed.accountId, signed.body]),
    ))
  )
    fail("BAD_SIGNATURE", 403);
  return unb64(signed.body);
}
export async function signedBody<T>(
  env: Env,
  actor: Actor,
  signed: SignedPayloadV1,
  kind: string,
  schema?: string,
): Promise<T> {
  const account = await env.DB.prepare(
    "SELECT card FROM accounts WHERE id=? AND EXISTS(SELECT 1 FROM devices WHERE id=? AND account_id=? AND trusted=1)",
  )
    .bind(actor.accountId, actor.deviceId, actor.accountId)
    .first<{ card: string }>();
  if (!account) fail("FORBIDDEN", 403);
  const body = JSON.parse(
    new TextDecoder().decode(
      await verifySigned(
        signed,
        JSON.parse(account!.card).signingPublicKey,
        kind,
        actor.accountId,
      ),
    ),
  );
  return schema ? validateWire<T>(schema as any, body) : body;
}
export function guard(env: Env, condition: string, args: unknown[]) {
  const id = crypto.randomUUID();
  return [
    env.DB.prepare(
      `INSERT INTO guards(id,ok) SELECT ?,CASE WHEN (${condition}) THEN 1 ELSE 0 END`,
    ).bind(id, ...args),
    env.DB.prepare("DELETE FROM guards WHERE id=?").bind(id),
  ] as const;
}
export async function batchGuard(
  env: Env,
  condition: string,
  args: unknown[],
  statements: D1PreparedStatement[],
  code = "FORBIDDEN",
) {
  const [begin, end] = guard(env, condition, args);
  try {
    return await env.DB.batch([begin, ...statements, end]);
  } catch (e) {
    if (String(e).includes("ok=1"))
      fail(code, code === "VERSION_CONFLICT" ? 409 : 403);
    throw e;
  }
}
