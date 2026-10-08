const methods = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]);

export type ErrorPhase = "request" | "upload.staging" | "upload.commit";
export type ErrorClass = "unexpected" | "invalid_body" | "body_limit" | "client_abort" | "storage" | "integrity" | "state" | "auth";
export interface ErrorDiagnostic { phase: ErrorPhase; errorClass: ErrorClass }

export type DiagnosticArea = "auth" | "account" | "sync" | "catalog" | "albums" | "sharing" | "media" | "intelligence" | "other";

export function diagnosticArea(path: string): DiagnosticArea {
  if (/^\/v1\/auth(?:\/|$)/.test(path)) return "auth";
  if (/^\/v1\/(?:vault|credentials|devices)(?:\/|$)/.test(path)) return "account";
  if (/^\/v1\/(?:uploads|background\/uploads|storage)(?:\/|$)/.test(path)) return "sync";
  if (/^\/v1\/(?:changes|photos)(?:\/|$)/.test(path)) return "catalog";
  if (/^\/v1\/albums(?:\/|$)/.test(path)) return "albums";
  if (/^\/v1\/(?:moments|grants|saves)(?:\/|$)/.test(path)) return "sharing";
  if (/^\/v1\/objects(?:\/|$)/.test(path)) return "media";
  if (/^\/v1\/intelligence(?:\/|$)/.test(path)) return "intelligence";
  return "other";
}

export function diagnosticMethod(method: string): string {
  return methods.has(method) ? method : "OTHER";
}

export function diagnosticPhase(path: string): ErrorPhase {
  if (/^\/v1\/(?:background\/)?uploads\/[^/]+\/staging$/.test(path)) return "upload.staging";
  if (/^\/v1\/uploads\/[^/]+\/commit$/.test(path)) return "upload.commit";
  return "request";
}

export function diagnosticErrorClass(code: string, status: number): ErrorClass {
  if (code === "TOO_LARGE") return "body_limit";
  if (code === "DIGEST_MISMATCH") return "integrity";
  if (status === 401 || status === 403) return "auth";
  if (status === 409) return "state";
  return status >= 500 ? "unexpected" : "invalid_body";
}

const phases = new Set<ErrorPhase>(["request", "upload.staging", "upload.commit"]);
const errorClasses = new Set<ErrorClass>(["unexpected", "invalid_body", "body_limit", "client_abort", "storage", "integrity", "state", "auth"]);
const codes = new Set([
  "ACCOUNT_MISMATCH", "ALBUM_INACTIVE", "ALBUM_LIMIT", "AUTH_RATE_LIMITED", "AUTH_THROTTLE_UNAVAILABLE",
  "BAD_SIGNATURE", "BODY_MISMATCH", "CLOUD_ACCOUNT_MISMATCH", "CLOUD_PREVIEW_INVALID", "CLOUD_PREVIEW_METADATA",
  "CLOUD_PREVIEW_TOO_LARGE", "CLOUD_PROVIDER_UNAVAILABLE", "CLOUD_RESULT_INVALID", "CLOUD_UNAVAILABLE", "CLOUD_WORK_LIMIT",
  "DIGEST_MISMATCH", "FORBIDDEN", "GRANT_INACTIVE", "IDEMPOTENCY_CONFLICT", "INTERNAL_ERROR", "INVALID_WIRE",
  "NOT_FOUND", "ORIGIN_DENIED", "PHOTO_LIMIT", "SOURCE_MISMATCH", "STORAGE_QUOTA_EXCEEDED", "TOO_LARGE",
  "UNAUTHENTICATED", "UPLOAD_INCOMPLETE", "VERSION_CONFLICT",
]);
export interface RequestDiagnostic {
  requestId: string;
  startedAt: number;
  traceId?: string;
  failure?: {code: string; phase: ErrorPhase; errorClass: ErrorClass};
}
export function beginDiagnostic(trace: string | undefined): RequestDiagnostic {
  const traceId = trace && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(trace) ? trace : undefined;
  return {requestId: crypto.randomUUID(), startedAt: performance.now(), ...(traceId ? {traceId} : {})};
}
export function diagnosticFailure(code: string, status: number, path: string, diagnostic?: ErrorDiagnostic): NonNullable<RequestDiagnostic["failure"]> {
  return {
    code: codes.has(code) ? code : "OTHER_ERROR",
    phase: diagnostic && phases.has(diagnostic.phase) ? diagnostic.phase : diagnosticPhase(path),
    errorClass: diagnostic && errorClasses.has(diagnostic.errorClass) ? diagnostic.errorClass : diagnosticErrorClass(code, status),
  };
}
export function finalDiagnostic(request: RequestDiagnostic, method: string, path: string, status: number) {
  const failure = status >= 400 ? request.failure ?? diagnosticFailure(status === 404 ? "NOT_FOUND" : "OTHER_ERROR", status, path) : undefined;
  const elapsed = performance.now() - request.startedAt;
  return {
    event: failure ? "api.error" : "api.request",
    requestId: request.requestId,
    ...(request.traceId ? {traceId: request.traceId} : {}),
    method: diagnosticMethod(method),
    status,
    area: diagnosticArea(path),
    phase: failure?.phase ?? diagnosticPhase(path),
    outcome: status >= 500 ? "server_error" : status >= 400 ? "client_error" : "success",
    elapsedMS: Number.isFinite(elapsed) ? Math.max(0, Math.min(3_600_000, Math.round(elapsed))) : 0,
    ...(failure ? {code: failure.code, errorClass: failure.errorClass} : {}),
  };
}
