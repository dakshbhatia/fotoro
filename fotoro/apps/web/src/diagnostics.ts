// Bounded troubleshooting data retained in this tab. Never accept free-form labels or payloads.
export const diagnosticOperations = ["auth", "sync", "catalog", "share", "album", "media", "request", "search", "metadata"] as const;
export const diagnosticSteps = ["action", "request", "decode", "transfer", "scan", "prepare", "analysis"] as const;
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
const storageKey = "fotoro:diagnostics:v1", storageByteLimit = 64 * 1024;
let restored = false, historyGeneration = 0, persistTimer: ReturnType<typeof setTimeout> | undefined;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function diagnosticUUID(value: unknown): string | undefined {
  return typeof value === "string" && uuid.test(value.toLowerCase()) ? value.toLowerCase() : undefined;
}
const bounded = (value: unknown, maximum: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.round(value))) : undefined;
const clock = () => performance.now();
function sanitizedEvent(value: unknown): DiagnosticEvent | undefined {
  if (!value || typeof value !== "object") return;
  const event = value as DiagnosticEvent;
  if (!diagnosticOperations.includes(event.operation) || !diagnosticSteps.includes(event.step) || !diagnosticOutcomes.includes(event.outcome)
    || !diagnosticReasons.includes(event.reason) || !diagnosticUUID(event.traceId)) return;
  const elapsedMs = bounded(event.elapsedMs, 86_400_000) ?? 0, count = bounded(event.count, 1_000_000);
  const status = bounded(event.status, 599), requestId = diagnosticUUID(event.requestId);
  // Reconstruct rather than spread: excess properties must never enter an export.
  return {operation: event.operation, step: event.step, outcome: event.outcome, reason: event.reason, traceId: diagnosticUUID(event.traceId)!,
    elapsedMs, ...(event.action && diagnosticActions.includes(event.action) ? {action: event.action} : {}),
    ...(requestId ? {requestId} : {}), ...(count === undefined ? {} : {count}), ...(status && status >= 100 ? {status} : {})};
}
function storage() {try {return globalThis.sessionStorage;} catch {return undefined;}}
function retainedJSON() {return JSON.stringify({version: 1, client: "web", events});}
function removeRetained() {
  const target = storage();
  try {target?.removeItem(storageKey);}
  catch {try {target?.setItem(storageKey, JSON.stringify({version: 1, client: "web", events: []}));} catch {}}
}
function restore() {
  if (restored) return;
  restored = true;
  const target = storage();
  try {
    const raw = target?.getItem(storageKey);
    if (!raw) return;
    if (raw.length > storageByteLimit) throw new Error("INVALID_DIAGNOSTICS");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("INVALID_DIAGNOSTICS");
    const envelope = parsed as {version?: unknown; client?: unknown; events?: unknown};
    if (envelope.version !== 1 || envelope.client !== "web" || !Array.isArray(envelope.events))
      throw new Error("INVALID_DIAGNOSTICS");
    const candidates = envelope.events.slice(-diagnosticEventLimit);
    events.push(...candidates.map(sanitizedEvent).filter((value): value is DiagnosticEvent => !!value));
    // Rewrite only reconstructed fields; injected/free-form values never remain retained.
    const safe = retainedJSON();
    if (raw !== safe) target?.setItem(storageKey, safe);
  } catch {removeRetained();}
}
function persist() {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  if (!restored) return;
  try {storage()?.setItem(storageKey, retainedJSON());} catch {}
}
function record(event: DiagnosticEvent, generation: number) {
  if (generation !== historyGeneration) return;
  restore();
  const safe = sanitizedEvent(event);
  if (!safe) return;
  events.push(safe);
  if (events.length > diagnosticEventLimit) events.splice(0, events.length - diagnosticEventLimit);
  // Batch frequent progress events rather than synchronously rewriting storage per event.
  if (persistTimer === undefined && storage()) persistTimer = setTimeout(persist, 250);
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
  if (["ACCOUNT_MISMATCH", "PASSWORD_ACCOUNT_MISMATCH", "INVITATION_RECIPIENT_MISMATCH", "SHARE_OWN_ACCOUNT"].includes(code)) return "account_changed";
  if (["ALBUM_SELECTION_CHANGED", "SOURCE_MISMATCH", "PHOTO_SOURCE_CHANGED"].includes(code)) return "source_changed";
  if (["STORAGE_QUOTA_EXCEEDED", "PHOTO_LIMIT", "ALBUM_LIMIT", "AUTH_RATE_LIMITED"].includes(code)) return "quota";
  if (["PRF_UNAVAILABLE", "PRF_UNAVAILABLE_USE_RECOVERY", "NO_ACCOUNT_PASSKEY", "PREVIEW_UNAVAILABLE", "SOURCE_UNAVAILABLE", "STAGING_MISSING_RESELECT_ORIGINAL"].includes(code)) return "unavailable";
  if (["CIPHERTEXT_MISMATCH", "ORIGINAL_DIGEST_MISMATCH", "CATALOG_BINDING_MISMATCH", "ALBUM_BINDING_MISMATCH", "CONTACT_OWNER_MISMATCH", "CONTACT_BINDING_MISMATCH", "CONTACT_REVISION_MISMATCH", "CONTACT_RECEIPT_MISMATCH", "CONTACT_REVIEW_CHANGED"].includes(code)) return "verification";
  return "unknown";
}
export class DiagnosticContext {
  readonly traceId = crypto.randomUUID();
  private generation = historyGeneration;
  private started = clock();
  private requests = 0;
  private lastRequestId?: string;
  private lastReason: DiagnosticReason = "none";
  private completionReason: DiagnosticReason = "none";
  private stages = 0;
  private itemCount?: number;
  constructor(readonly operation: DiagnosticOperation, readonly action?: DiagnosticAction) {}
  start() {record({operation: this.operation, action: this.action, traceId: this.traceId, step: "action", outcome: "started", reason: "none", elapsedMs: 0}, this.generation);}
  incomplete(reason: DiagnosticReason) {this.completionReason = reason;}
  items(count: number) {this.itemCount = bounded(count, 1_000_000);}
  // Local stages show where work is waiting without retaining its inputs or outputs.
  async stage<T>(step: Step, task: () => Promise<T>): Promise<T> {
    const started = clock(), detailed = ++this.stages <= 6;
    const event = (outcome: Outcome, reason: DiagnosticReason) => record({operation: this.operation, action: this.action,
      traceId: this.traceId, step, outcome, reason, elapsedMs: clock() - started}, this.generation);
    if (detailed) event("started", "none");
    try {const result = await task(); if (detailed) event("succeeded", "none"); return result;}
    catch (error) {const reason = diagnosticReason(error); event(reason === "cancelled" ? "cancelled" : "failed", reason); throw error;}
  }
  request(step: Step, outcome: Outcome, reason: DiagnosticReason, elapsedMs: number, requestId?: string | null, status?: number) {
    this.requests++;
    this.lastRequestId = diagnosticUUID(requestId);
    this.lastReason = reason;
    // Batch success details are bounded; failures remain visible and terminal count covers the batch.
    if (outcome === "succeeded" && (this.requests > 12 || !this.action && ["media", "album"].includes(this.operation))) return;
    record({operation: this.operation, action: this.action, traceId: this.traceId, step, outcome, reason, elapsedMs, requestId: this.lastRequestId, status}, this.generation);
  }
  finish(error?: unknown, failed = false) {
    failed ||= this.completionReason !== "none";
    const classified = this.completionReason !== "none" ? this.completionReason : failed ? diagnosticReason(error) : "none";
    const reason = failed && classified === "unknown" && this.lastReason !== "none" ? this.lastReason : classified;
    record({operation: this.operation, action: this.action, traceId: this.traceId, step: "action", outcome: reason === "cancelled" ? "cancelled" : failed ? "failed" : "succeeded",
      reason, elapsedMs: clock() - this.started, count: this.itemCount ?? this.requests, requestId: this.lastRequestId}, this.generation);
  }
}
export async function diagnose<T>(operation: DiagnosticOperation, task: (context: DiagnosticContext) => Promise<T>, action?: DiagnosticAction): Promise<T> {
  const context = new DiagnosticContext(operation, action); context.start();
  try {const result = await task(context); context.finish(); return result;}
  catch (error) {context.finish(error, true); throw error;}
}
export function exportDiagnostics() {restore(); return JSON.stringify({version: 1, client: "web", events: events.map(event => ({...event}))}, null, 2);}
export interface DiagnosticSummary {
  operation: DiagnosticOperation; succeeded: number; failed: number; cancelled: number;
  p50Ms?: number; p95Ms?: number; reasons: Partial<Record<DiagnosticReason, number>>;
}
// Percentiles cover retained successful logical actions, never request/stage timings.
export function summarizeDiagnostics(input: readonly unknown[]): DiagnosticSummary[] {
  const groups = new Map<DiagnosticOperation, {summary: DiagnosticSummary; times: number[]}>();
  for (const value of input) {
    const event = sanitizedEvent(value);
    if (!event || event.step !== "action" || event.outcome === "started") continue;
    let group = groups.get(event.operation);
    if (!group) {group = {summary: {operation: event.operation, succeeded: 0, failed: 0, cancelled: 0, reasons: {}}, times: []}; groups.set(event.operation, group);}
    group.summary[event.outcome]++;
    if (event.outcome === "succeeded") group.times.push(event.elapsedMs);
    else group.summary.reasons[event.reason] = (group.summary.reasons[event.reason] ?? 0) + 1;
  }
  return diagnosticOperations.flatMap(operation => {
    const group = groups.get(operation); if (!group) return [];
    group.times.sort((a, b) => a - b);
    const percentile = (fraction: number) => group.times[Math.max(0, Math.ceil(group.times.length * fraction) - 1)];
    return [{...group.summary, ...(group.times.length ? {p50Ms: percentile(.5), p95Ms: percentile(.95)} : {})}];
  });
}
export function diagnosticSummary() {restore(); return summarizeDiagnostics(events);}
export function clearDiagnostics() {
  historyGeneration++; restored = true; events.length = 0;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  removeRetained();
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persist);
  window.addEventListener("fotoro-lock", event => {
    if ((event as CustomEvent<{reason?: unknown}>).detail?.reason === "manual") clearDiagnostics();
  });
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {if (document.visibilityState === "hidden") persist();});
}
