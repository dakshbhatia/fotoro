import {DiagnosticContext, diagnosticReason, type DiagnosticOperation} from "../diagnostics";
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
    response.headers.get("X-Request-Id") ?? error?.requestId,
    response.headers.get("Retry-After"),
  );
}
function requestOperation(path: string): DiagnosticOperation {
  if (path.startsWith("/v1/auth/") || path.startsWith("/v1/vault")) return "auth";
  if (path.startsWith("/v1/uploads/") || path === "/v1/photos") return "sync";
  if (path.startsWith("/v1/albums")) return "album";
  if (path.startsWith("/v1/changes")) return "catalog";
  if (path.startsWith("/v1/grants") || path.startsWith("/v1/contacts")) return "share";
  if (path.startsWith("/v1/objects/")) return "media";
  return "request";
}
async function tracedResponse<T>(context: DiagnosticContext, step: "request" | "transfer", send: () => Promise<Response>,
  read: (response: Response, phase: (next: "decode" | "invalid_wire") => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const started = performance.now(); let response: Response | undefined, phase: "request" | "decode" | "invalid_wire" = "request";
  try {
    signal?.throwIfAborted(); response = await send();
    signal?.throwIfAborted();
    const result = await read(response, next => {phase = next;});
    signal?.throwIfAborted();
    context.request(step, "succeeded", "none", performance.now() - started, response.headers.get("X-Request-Id"), response.status);
    return result;
  } catch (error) {
    const classified = signal?.aborted ? "cancelled" : diagnosticReason(error);
    const reason = classified === "cancelled" ? classified : response && !response.ok ? "http" : phase !== "request" ? phase : classified;
    context.request(phase === "request" ? step : "decode", reason === "cancelled" ? "cancelled" : "failed", reason,
      performance.now() - started, response?.headers.get("X-Request-Id"), response?.status);
    throw error;
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  schema?: string,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
  diagnostic?: DiagnosticContext,
): Promise<T> {
  const context = diagnostic ?? new DiagnosticContext(requestOperation(path));
  const session = requestSession(path);
  return tracedResponse(context, "request", () => fetch(base + path, {
    method, signal, credentials: "include",
    headers: {
      "X-Fotoro-Trace-Id": context.traceId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? {"x-fotoro-account-id": session.vault.accountId} : {}),
      ...(fixtureMode && fixtureAccount ? { "x-fotoro-fixture-account": fixtureAccount } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(error => {
    signal?.throwIfAborted();
    if (error instanceof TypeError) throw new ApiTransportError(error);
    throw error;
  }), async (response, phase) => {
    if (!response.ok) throw await responseError(response, session, signal);
    phase("decode");
    const result = await response.json();
    signal?.throwIfAborted();
    if (!schema) return result;
    phase("invalid_wire");
    return validateWire(schema as never, result) as T;
  }, signal);
}
export function scopedApi(context: DiagnosticContext): typeof api {
  return <T>(path: string, body?: unknown, schema?: string, method?: string, signal?: AbortSignal) => api<T>(path, body, schema, method, signal, context);
}
export async function fetchCipher(objectId: string, signal?: AbortSignal, diagnostic?: DiagnosticContext) {
  const context = diagnostic ?? new DiagnosticContext("media");
  const session = requestSession("/v1/objects/" + objectId);
  return tracedResponse(context, "transfer", () => fetch(base + "/v1/objects/" + objectId, {
    signal, credentials: "include",
    headers: {
      "X-Fotoro-Trace-Id": context.traceId,
      ...(session ? {"x-fotoro-account-id": session.vault.accountId} : {}),
      ...(fixtureMode && fixtureAccount ? {"x-fotoro-fixture-account": fixtureAccount} : {}),
    },
  }), async response => {
    if (!response.ok) throw await responseError(response, session, signal);
    return new Uint8Array(await response.arrayBuffer());
  }, signal);
}
export async function uploadCipher(url: URL, options: RequestInit, diagnostic?: DiagnosticContext) {
  const context = diagnostic ?? new DiagnosticContext("sync");
  return tracedResponse(context, "transfer", () => fetch(url, {...options, headers: {...Object.fromEntries(new Headers(options.headers)), "X-Fotoro-Trace-Id": context.traceId}}), async response => {
    if (!response.ok) throw new Error("UPLOAD_FAILED");
    return response;
  }, options.signal ?? undefined);
}
