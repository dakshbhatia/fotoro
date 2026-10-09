export class ApiError extends Error {
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly status?: number;
  constructor(
    readonly code: string,
    readonly retryable = false,
    requestId?: unknown,
    retryAfter?: unknown,
    status?: number,
  ) {
    super(code);
    if (typeof requestId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestId))
      this.requestId = requestId;
    if (typeof retryAfter === "string" && /^\d{1,6}$/.test(retryAfter)) this.retryAfterSeconds = Number(retryAfter);
    if (Number.isInteger(status) && status! >= 100 && status! <= 599) this.status = status;
  }
}

export function accountLimitMessage(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "STORAGE_QUOTA_EXCEEDED") return "Fotoro storage is full. Contact support to continue saving.";
  if (error.message !== "AUTH_RATE_LIMITED" && error.message !== "HTTP_429") return undefined;
  const seconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  if (!seconds) return "Too many attempts. Wait a little, then Retry.";
  const count = seconds < 60 ? seconds : Math.ceil(seconds / 60), unit = seconds < 60 ? "second" : "minute";
  return `Too many attempts. Retry in ${count} ${unit}${count === 1 ? "" : "s"}.`;
}
