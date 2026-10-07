import {ApiError} from "./api-errors";
import { validateWire } from "@fotoro/contracts/validate";
import {requireVault, lockVault, vaultGeneration, type UnlockedVault} from "../vault/vault";
let fixtureAccount: string | undefined;
export const fixtureMode =
  import.meta.env?.DEV === true &&
  import.meta.env?.VITE_FOTORO_FIXTURES === "1" &&
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.port === "4310";
export const base = "";
export const isPublicDemoAccount = (id: string) =>
  [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ].includes(id);
export function resolveUploadURL(
  staging: string,
  pageOrigin: string,
  developmentOrigin?: string,
) {
  const url = new URL(staging, pageOrigin);
  if (url.origin === pageOrigin) return url;
  const page = new URL(pageOrigin);
  const upstream = developmentOrigin ? new URL(developmentOrigin) : undefined;
  if (
    upstream &&
    [page, upstream].every(
      (u) =>
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname),
    ) &&
    url.origin === upstream.origin
  ) {
    return new URL(url.pathname + url.search, pageOrigin);
  }
  throw new Error("UNTRUSTED_UPLOAD_URL");
}
export function setFixtureAccount(id?: string) {
  fixtureAccount = id;
}
export {ApiError, accountLimitMessage} from "./api-errors";
export class ApiTransportError extends Error {
  constructor(cause: TypeError) {super(cause.message, {cause}); this.name = "ApiTransportError";}
}
interface RequestSession {vault: UnlockedVault; generation: number; origin?: string;}
function requestSession(path: string): RequestSession | undefined {
  // Password verification runs after local unlock and must handle its own rejection.
  if (path.startsWith("/v1/auth/")) return;
  try {return {vault: requireVault(), generation: vaultGeneration(), origin: typeof location === "undefined" ? undefined : location.origin};} catch {return;}
}
async function responseError(response: Response, session?: RequestSession, signal?: AbortSignal) {
  const error = await response.json().catch(() => null);
  signal?.throwIfAborted();
  if (response.status === 401 && session && session.generation === vaultGeneration() &&
      session.origin === (typeof location === "undefined" ? undefined : location.origin)) {
    try {if (requireVault() === session.vault) lockVault("expired");} catch {}
  }
  return new ApiError(
    typeof error?.code === "string" ? error.code : `HTTP_${response.status}`,
    error?.retryable === true,
    error?.requestId,
    response.headers.get("Retry-After"),
  );
}
export async function api<T>(
  path: string,
  body?: unknown,
  schema?: string,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const session = requestSession(path);
  const response = await fetch(base + path, {
    method,
    signal,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? {"x-fotoro-account-id": session.vault.accountId} : {}),
      ...(fixtureMode && fixtureAccount
        ? { "x-fotoro-fixture-account": fixtureAccount }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(error => {
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw new ApiTransportError(error);
    throw error;
  });
  signal?.throwIfAborted();
  if (!response.ok) {
    throw await responseError(response, session, signal);
  }
  const result = await response.json();
  signal?.throwIfAborted();
  return schema ? (validateWire(schema as never, result) as T) : result;
}
export async function fetchCipher(objectId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const session = requestSession("/v1/objects/" + objectId);
  const r = await fetch(base + "/v1/objects/" + objectId, {
    signal,
    credentials: "include",
    headers: {
      ...(session ? {"x-fotoro-account-id": session.vault.accountId} : {}),
      ...(fixtureMode && fixtureAccount ? {"x-fotoro-fixture-account": fixtureAccount} : {}),
    },
  });
  signal?.throwIfAborted();
  if (!r.ok) {
    throw await responseError(r, session, signal);
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  signal?.throwIfAborted();
  return bytes;
}
