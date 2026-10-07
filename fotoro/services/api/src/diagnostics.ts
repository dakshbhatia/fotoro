const methods = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"]);

export type ErrorPhase = "request" | "upload.staging" | "upload.commit";
export type ErrorClass = "unexpected" | "invalid_body" | "body_limit" | "client_abort" | "storage" | "integrity" | "state" | "auth";
export interface ErrorDiagnostic { phase: ErrorPhase; errorClass: ErrorClass }

export function diagnosticArea(path: string): string {
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
