import { validateWire } from "@fotoro/contracts/validate";
let fixtureAccount: string | undefined;
export const fixtureMode =
  import.meta.env?.DEV === true &&
  import.meta.env?.VITE_FOTORO_FIXTURES === "1" &&
  typeof location !== "undefined" &&
  ["localhost", "127.0.0.1"].includes(location.hostname) &&
  location.port === "4310";
export const base = "";
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
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  schema?: string,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(base + path, {
    method,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(fixtureMode && fixtureAccount
        ? { "x-fotoro-fixture-account": fixtureAccount }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const e = await response
      .json()
      .catch(() => ({ code: `HTTP_${response.status}` }));
    throw new ApiError(e.code, e.retryable);
  }
  const result = await response.json();
  return schema ? (validateWire(schema as never, result) as T) : result;
}
export async function fetchCipher(objectId: string) {
  const r = await fetch(base + "/v1/objects/" + objectId, {
    credentials: "include",
    headers:
      fixtureMode && fixtureAccount
        ? { "x-fotoro-fixture-account": fixtureAccount }
        : {},
  });
  if (!r.ok) {
    const e = await r.json();
    throw new ApiError(e.code);
  }
  return new Uint8Array(await r.arrayBuffer());
}
