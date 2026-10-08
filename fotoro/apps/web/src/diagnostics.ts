// Ephemeral troubleshooting data. Never accept free-form event labels or payloads.
export const diagnosticOperations = ["auth", "sync", "catalog", "share", "album", "media", "request"] as const;
export const diagnosticSteps = ["action", "request", "decode", "transfer"] as const;
export const diagnosticOutcomes = ["started", "succeeded", "failed", "cancelled"] as const;
export const diagnosticReasons = ["none", "cancelled", "network", "http", "decode", "invalid_wire", "locked", "account_changed", "source_changed", "quota", "unavailable", "verification", "unknown"] as const;
export const diagnosticActions = ["passkey", "password", "enrollment", "refresh", "save", "create", "accept", "end", "add", "receive", "contribute", "prepare"] as const;
export type DiagnosticOperation = typeof diagnosticOperations[number];
export type DiagnosticReason = typeof diagnosticReasons[number];
export type DiagnosticAction = typeof diagnosticActions[number];
type Step = typeof diagnosticSteps[number];
type Outcome = typeof diagnosticOutcomes[number];
export interface DiagnosticEvent {
  operation: DiagnosticOperation; step: Step; outcome: Outcome; reason: DiagnosticReason;
  traceId: string; requestId?: string; elapsedMs: number; count?: number; status?: number;
  action?: DiagnosticAction;
}
const events: DiagnosticEvent[] = [];
export const diagnosticEventLimit = 128;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function diagnosticUUID(value: unknown): string | undefined {
  return typeof value === "string" && uuid.test(value.toLowerCase()) ? value.toLowerCase() : undefined;
}
const bounded = (value: unknown, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : undefined;
const clock = () => performance.now();
function record(event: DiagnosticEvent) {
  if (!diagnosticOperations.includes(event.operation) || !diagnosticSteps.includes(event.step) || !diagnosticOutcomes.includes(event.outcome)
    || !diagnosticReasons.includes(event.reason) || !diagnosticUUID(event.traceId)) return;
  const elapsedMs = bounded(event.elapsedMs, 86_400_000) ?? 0, count = bounded(event.count, 1_000_000);
  const status = bounded(event.status, 599), requestId = diagnosticUUID(event.requestId);
  // Reconstruct rather than spread: excess properties must never enter an export.
  events.push({operation: event.operation, step: event.step, outcome: event.outcome, reason: event.reason, traceId: event.traceId,
    elapsedMs, ...(event.action && diagnosticActions.includes(event.action) ? {action: event.action} : {}),
    ...(requestId ? {requestId} : {}), ...(count === undefined ? {} : {count}), ...(status && status >= 100 ? {status} : {})});
  if (events.length > diagnosticEventLimit) events.splice(0, events.length - diagnosticEventLimit);
}
export function diagnosticReason(error: unknown): DiagnosticReason {
  if (!(error instanceof Error)) return "unknown";
  if (["AbortError", "NotAllowedError"].includes(error.name)) return "cancelled";
  if (error instanceof TypeError || error.name === "ApiTransportError") return "network";
  // Exact categories only; the original error text is never retained.
  if ((error as Error & {code?: unknown}).code === "INVALID_WIRE") return "invalid_wire";
  if (error instanceof SyntaxError) return "decode";
  const code = error.message;
  if (code === "VAULT_LOCKED") return "locked";
  if (["ACCOUNT_MISMATCH", "PASSWORD_ACCOUNT_MISMATCH"].includes(code)) return "account_changed";
  if (["ALBUM_SELECTION_CHANGED", "SOURCE_MISMATCH", "PHOTO_SOURCE_CHANGED"].includes(code)) return "source_changed";
  if (["STORAGE_QUOTA_EXCEEDED", "PHOTO_LIMIT", "ALBUM_LIMIT", "AUTH_RATE_LIMITED"].includes(code)) return "quota";
  if (["PRF_UNAVAILABLE", "PRF_UNAVAILABLE_USE_RECOVERY", "NO_ACCOUNT_PASSKEY", "PREVIEW_UNAVAILABLE", "SOURCE_UNAVAILABLE", "STAGING_MISSING_RESELECT_ORIGINAL"].includes(code)) return "unavailable";
  if (["CIPHERTEXT_MISMATCH", "ORIGINAL_DIGEST_MISMATCH", "CATALOG_BINDING_MISMATCH", "ALBUM_BINDING_MISMATCH"].includes(code)) return "verification";
  return "unknown";
}
export class DiagnosticContext {
  readonly traceId = crypto.randomUUID();
  private started = clock();
  private requests = 0;
  private lastRequestId?: string;
  private lastReason: DiagnosticReason = "none";
  private completionReason: DiagnosticReason = "none";
  constructor(readonly operation: DiagnosticOperation, readonly action?: DiagnosticAction) {}
  start() {record({operation: this.operation, action: this.action, traceId: this.traceId, step: "action", outcome: "started", reason: "none", elapsedMs: 0});}
  incomplete(reason: DiagnosticReason) {this.completionReason = reason;}
  request(step: Step, outcome: Outcome, reason: DiagnosticReason, elapsedMs: number, requestId?: string | null, status?: number) {
    this.requests++;
    this.lastRequestId = diagnosticUUID(requestId);
    this.lastReason = reason;
    // Batch success details are bounded; failures remain visible and terminal count covers the batch.
    if (outcome === "succeeded" && (this.requests > 12 || !this.action && ["media", "album"].includes(this.operation))) return;
    record({operation: this.operation, action: this.action, traceId: this.traceId, step, outcome, reason, elapsedMs, requestId: this.lastRequestId, status});
  }
  finish(error?: unknown, failed = false) {
    failed ||= this.completionReason !== "none";
    const classified = this.completionReason !== "none" ? this.completionReason : failed ? diagnosticReason(error) : "none";
    const reason = failed && classified === "unknown" && this.lastReason !== "none" ? this.lastReason : classified;
    record({operation: this.operation, action: this.action, traceId: this.traceId, step: "action", outcome: reason === "cancelled" ? "cancelled" : failed ? "failed" : "succeeded",
      reason, elapsedMs: clock() - this.started, count: this.requests, requestId: this.lastRequestId});
  }
}
export async function diagnose<T>(operation: DiagnosticOperation, task: (context: DiagnosticContext) => Promise<T>, action?: DiagnosticAction): Promise<T> {
  const context = new DiagnosticContext(operation, action); context.start();
  try {const result = await task(context); context.finish(); return result;}
  catch (error) {context.finish(error, true); throw error;}
}
export function exportDiagnostics() {return JSON.stringify({version: 1, client: "web", events: events.map(event => ({...event}))}, null, 2);}
export function clearDiagnostics() {events.length = 0;}
