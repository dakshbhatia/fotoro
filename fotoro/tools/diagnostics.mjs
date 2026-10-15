import {readFile, stat} from "node:fs/promises";
import {pathToFileURL} from "node:url";

// Treat exports and Wrangler envelopes as untrusted. Nothing outside these
// closed fields reaches the report, including parser errors and input paths.
const values = {
  operation: "app api auth sync share albums album search metadata people consent picks catalog media request".split(" "),
  step: "action request response decode credential unlock catalog verify persist transfer annotation scan prepare analysis export settlePrevious settleBackup settleJournal snapshot".split(" "),
  analysisStage: ["ocr", "visual", "semantic"],
  analysisActivity: "notReady inactive interacting waitingForIdle running retryScheduled idle".split(" "),
  analysisWindow: ["allPhotos", "tenDays"],
  coverageScope: ["catalog", "automaticWindow"],
  action: "passkey password enrollment refresh save create accept end add receive contribute prepare".split(" "),
  outcome: "started completed succeeded failed cancelled changed".split(" "),
  reason: "none cancelled contextChanged inactive background recoveryProbe network http decode validation unknown signedOut locked permissionRequired paused offline retryRequired waiting pendingTransfers unpreparedSources skippedSources pendingAnnotations sourceUnavailable current invalid_wire account_changed source_changed quota unavailable verification".split(" "),
  state: "notStarted preparing uploading checking upToDate paused offline needsAttention".split(" "),
  area: "auth account sync catalog albums sharing media intelligence other".split(" "),
  phase: "request upload.staging upload.commit".split(" "),
  clientPhase: "app api auth sync share consent picks albums search metadata people".split(" "),
  endpoint: "auth account catalog upload annotations exchange albums device other".split(" "),
  method: "GET POST PUT DELETE PATCH OPTIONS HEAD OTHER".split(" "),
  accountState: "signedOut locked recoveryRequired unlocked demo".split(" "),
  errorClass: "unexpected invalid_body body_limit client_abort storage integrity state auth".split(" "),
};
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : undefined;
const integer = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
const pick = (key, value) => values[key].includes(value) ? value : undefined;
const scalarCounts = ["attempted", "completed", "pending", "count", "cacheHits", "unavailable", "skipped", "total", "failedCount", "deferred", "modelDeferred"];
const timestamp = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4_102_444_800 ? value : undefined;
const maximumBytes = 8 * 1024 * 1024;
const maximumEvents = 4096;

export function sanitizeEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const server = value.event === "api.request" || value.event === "api.error";
  const status = integer(value.status, 599, 100);
  if (server && (status === undefined || (value.event === "api.error") !== (status >= 400))) return;
  const operation = server ? "api" : pick("operation", value.operation ?? value.phase);
  const outcome = server ? value.event === "api.error" || value.status >= 400 ? "failed" : "completed" : pick("outcome", value.outcome);
  if (!operation || !outcome) return;
  const event = {source: server ? "server" : "client", operation, outcome};
  for (const key of ["step", "action", "reason", "state", "area", "errorClass", "endpoint", "method", "accountState", "analysisStage", "analysisActivity", "analysisWindow", "coverageScope"]) {
    const v = pick(key, value[key]); if (v !== undefined) event[key] = v;
  }
  const current = pick("step", value.currentStep); if (current) event.currentStep = current;
  const clientPhase = pick("clientPhase", value.clientPhase ?? value.phase);
  if (!server && clientPhase) event.clientPhase = clientPhase;
  if (typeof value.build === "string" && /^[0-9]+(?:\.[0-9]+)*$/.test(value.build) && value.build.length <= 16) event.build = value.build;
  const time = timestamp(value.timestamp); if (time !== undefined) event.timestamp = time;
  const last = pick("step", value.lastCompletedStep); if (last) event.lastCompletedStep = last;
  if (server) { const phase = pick("phase", value.phase); if (phase) event.phase = phase; }
  for (const key of ["traceId", "parentTraceId", "requestId"]) { const id = uuid(value[key]); if (id) event[key] = id; }
  for (const key of scalarCounts) {
    const n = integer(value[key], 1_000_000); if (n !== undefined) event[key] = n;
  }
  const elapsed = integer(value.elapsedMS ?? value.elapsedMs, 86_400_000);
  if (elapsed !== undefined) event.elapsedMS = elapsed;
  const retry = integer(value.nextRetryMS, 86_400_000);
  if (retry !== undefined) event.nextRetryMS = retry;
  const checkedAge = integer(value.lastCheckedAgeMS, 31_536_000_000);
  if (checkedAge !== undefined) event.lastCheckedAgeMS = checkedAge;
  for (const key of ["lastAttemptAgeMS", "lastCompleteAgeMS", "analysisRunAgeMS"]) {
    const age = integer(value[key], 31_536_000_000); if (age !== undefined) event[key] = age;
  }
  if (status !== undefined) event.status = status;
  return event;
}

// Accept JSON arrays/exports, JSONL and concatenated pretty Wrangler JSON.
// Balanced scanning avoids trying to repair a truncated record into a success.
export function parseDiagnostics(text) {
  if (Buffer.byteLength(text) > maximumBytes) throw new Error("INPUT_TOO_LARGE");
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const events = [];
  function accept(value) {
    if (events.length >= maximumEvents) return;
    if (Array.isArray(value)) { for (const v of value) accept(v); return; }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.events)) { for (const v of value.events) accept(v); return; }
    if (Array.isArray(value.logs)) {
      for (const log of value.logs) for (const message of Array.isArray(log?.message) ? log.message : []) {
        if (typeof message !== "string" || message.length > 65_536) continue;
        try { const event = sanitizeEvent(JSON.parse(message)); if (event && events.length < maximumEvents) events.push(event); } catch {}
      }
      return;
    }
    const event = sanitizeEvent(value); if (event) events.push(event);
  }
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (start < 0) { if (c === "{" || c === "[") { start = i; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) { try { accept(JSON.parse(text.slice(start, i + 1))); } catch {} start = -1; }
    }
  }
  return events;
}

export function summarizeDiagnostics(events, {now = Date.now() / 1000} = {}) {
  // Revalidate callers too; no raw input object can enter the final report.
  const safe = events.slice(0, maximumEvents).map(e => sanitizeEvent(e.source === "server" ? {...e, event: e.outcome === "failed" ? "api.error" : "api.request"} : e)).filter(Boolean);
  const groups = new Map(), counts = new Map();
  const clientRequests = new Set(), serverRequests = new Set();
  const relative = (event, firstTime) => {
    if (firstTime === undefined || event.timestamp === undefined) return undefined;
    const value = Math.round((event.timestamp - firstTime) * 1000);
    return integer(value, 86_400_000);
  };
  const detail = (event, firstTime) => {
    const {timestamp: omitted, ...result} = event;
    const relativeMS = relative(event, firstTime); if (relativeMS !== undefined) result.relativeMS = relativeMS;
    return result;
  };
  const counters = event => Object.fromEntries(scalarCounts.filter(k => event[k] !== undefined).map(k => [k, event[k]]));
  for (const event of safe) {
    const key = `${event.source}/${event.operation}/${event.outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (event.requestId) (event.source === "server" ? serverRequests : clientRequests).add(event.requestId);
    if (!event.traceId || event.step === "snapshot") continue;
    const trace = groups.get(event.traceId) ?? [];
    trace.push(event); groups.set(event.traceId, trace);
  }
  const flows = [...groups].slice(-32).map(([traceId, trace]) => {
    const timed = trace.map(e => e.timestamp).filter(t => t !== undefined);
    const firstTime = timed.length ? Math.min(...timed) : undefined;
    const actions = trace.filter(e => e.source === "client" && e.step === "action");
    const terminal = actions.filter(e => ["completed", "succeeded", "failed", "cancelled"].includes(e.outcome)).at(-1);
    const latest = trace.at(-1), action = terminal ?? actions.at(-1);
    const stageOnly = !actions.length && trace.some(e => e.source === "client" && e.step && !["action", "request", "response", "decode"].includes(e.step));
    const last = terminal?.lastCompletedStep ?? [...trace].reverse().find(e => e.lastCompletedStep)?.lastCompletedStep;
    const flow = {
      traceId, operation: action?.operation ?? trace.find(e => e.source === "client")?.operation ?? "api",
      result: terminal?.outcome ?? (actions.length ? "no_terminal_in_window" : stageOnly ? "stage_events_only" : "requests_only"),
      events: trace.length,
      requests: new Set(trace.map(e => e.requestId).filter(Boolean)).size,
      failures: trace.filter(e => e.outcome === "failed").slice(-5).map(e => detail(e, firstTime)),
    };
    if (last) flow.lastCompletedStep = last;
    if (action?.action) flow.action = action.action;
    if (terminal?.reason) flow.reason = terminal.reason;
    if (terminal?.elapsedMS !== undefined) flow.elapsedMS = terminal.elapsedMS;
    const state = [...trace].reverse().find(e => e.state)?.state; if (state) flow.state = state;
    const accountState = [...trace].reverse().find(e => e.accountState)?.accountState; if (accountState) flow.accountState = accountState;
    const parent = trace.find(e => e.parentTraceId)?.parentTraceId; if (parent) flow.parentTraceId = parent;
    const build = [...trace].reverse().find(e => e.build)?.build; if (build) flow.build = build;
    const latestCounters = [...trace].reverse().find(e => scalarCounts.some(k => e[k] !== undefined));
    if (latestCounters) flow.counters = counters(latestCounters);
    const open = new Map();
    for (const event of trace) {
      if (!event.step || event.step === "action" || event.source !== "client") continue;
      if (event.outcome === "started") open.set(event.step, event);
      else if (["completed", "succeeded", "failed", "cancelled"].includes(event.outcome)) {
        open.delete(event.step);
        if (event.clientPhase === "api" && ["response", "decode"].includes(event.step)) open.delete("request");
      }
    }
    // Completed-stage snapshots are history, not evidence of a live stage.
    const currentEvent = [...trace].reverse().find(e => e.currentStep && ["started", "changed"].includes(e.outcome));
    const currentIndex = currentEvent ? trace.indexOf(currentEvent) : -1;
    const current = currentEvent && !trace.slice(currentIndex + 1).some(e => e.step === currentEvent.currentStep && ["completed", "succeeded", "failed", "cancelled"].includes(e.outcome)) ? currentEvent.currentStep : undefined;
    const active = [...open.values()].at(-1);
    if (!terminal && (current || active)) {
      flow.activeStep = current ?? active.step;
      const start = current ? open.get(current) ?? trace.find(e => e.currentStep === current) : active;
      if (start?.timestamp !== undefined && latest.timestamp !== undefined) {
        const observedMS = integer(Math.round((latest.timestamp - start.timestamp) * 1000), 86_400_000);
        if (observedMS !== undefined) flow.activeObservedMS = observedMS;
      }
    }
    // Retain a short ordered stage history; absolute timestamps never reach the report.
    if (firstTime !== undefined) flow.timingBasis = "trace_window_start";
    flow.stages = trace.filter(e => e.source === "client" && e.step).slice(-16).map(e => {
      const stage = {step: e.step, outcome: e.outcome};
      for (const key of ["currentStep", "clientPhase", "reason", "endpoint", "method", "elapsedMS", "status"]) if (e[key] !== undefined) stage[key] = e[key];
      const relativeMS = relative(e, firstTime); if (relativeMS !== undefined) stage.relativeMS = relativeMS;
      return stage;
    });
    return flow;
  });
  const untracedPicks = safe.filter(e => e.operation === "picks" && !e.traceId);
  const builds = new Map();
  for (const event of safe) {
    const key = event.build ?? "unknown";
    const window = builds.get(key) ?? {build: key, events: 0, times: []};
    window.events++; if (event.timestamp !== undefined) window.times.push(event.timestamp);
    builds.set(key, window);
  }
  const buildWindows = [...builds.values()].slice(-32).map(({build, events, times}) => {
    const window = {build, events};
    if (times.length) {
      const observedMS = integer(Math.round((Math.max(...times) - Math.min(...times)) * 1000), 86_400_000);
      if (observedMS !== undefined) window.observedMS = observedMS;
    }
    return window;
  });
  // Never mix coverage from a prior export with a newer unavailable snapshot.
  const snapshot = safe.findLast(e => e.source === "client" && e.operation === "search" && e.step === "snapshot");
  let indexSnapshot;
  if (snapshot) {
    const rows = snapshot.traceId ? safe.filter(e => e.source === "client" && e.operation === "search" && e.step === "snapshot" && e.traceId === snapshot.traceId) : [snapshot];
    const stage = e => {
      const result = {stage: e.analysisStage, ...counters(e)};
      for (const key of ["nextRetryMS", "lastAttemptAgeMS", "lastCompleteAgeMS"]) if (e[key] !== undefined) result[key] = e[key];
      return result;
    };
    indexSnapshot = {scope: "permitted_local_photos", activity: snapshot.analysisActivity ?? "unknown",
      coverage: rows.filter(e => e.analysisStage && e.coverageScope !== "automaticWindow").map(stage)};
    if (snapshot.analysisWindow) indexSnapshot.analysisWindow = snapshot.analysisWindow;
    const windowRows = rows.filter(e => e.analysisStage && e.coverageScope === "automaticWindow");
    if (windowRows.length) indexSnapshot.automaticWindowCoverage = windowRows.map(stage);
    if (snapshot.analysisRunAgeMS !== undefined) indexSnapshot.analysisRunAgeMS = snapshot.analysisRunAgeMS;
    const activeCoverage = windowRows.length ? windowRows : rows.filter(e => e.analysisStage);
    const unfinished = activeCoverage.some(e => e.total !== undefined && e.completed !== undefined && e.total > e.completed);
    const attemptAges = rows.map(e => e.lastAttemptAgeMS).filter(age => age !== undefined);
    indexSnapshot.progressSignal = snapshot.analysisActivity === undefined || snapshot.analysisActivity === "notReady" ? "unknown"
      : snapshot.analysisActivity !== "running" ? "not_running"
      : snapshot.analysisRunAgeMS === undefined ? "unknown"
      : snapshot.analysisRunAgeMS < 60_000 ? "starting"
      : !unfinished ? "unknown"
      : attemptAges.some(age => age < 60_000) ? "recent_checkpoint" : "no_recent_checkpoint";
    if (snapshot.build) indexSnapshot.build = snapshot.build;
    if (snapshot.reason) indexSnapshot.reason = snapshot.reason;
    const age = snapshot.timestamp === undefined ? undefined : integer(Math.round((now - snapshot.timestamp) * 1000), Number.MAX_SAFE_INTEGER);
    if (age !== undefined) indexSnapshot.ageMS = age;
    indexSnapshot.limitation = "Coverage was captured for this export, not live monitoring. Pending excludes failed/unavailable; deferred overlaps unfinished states. OCR complete includes photos with no recognized text. Automatic-window coverage is separate from the whole catalog. Attempt/completion ages describe the last durable commit for this stage in this index; older indexes may have unknown ages. no_recent_checkpoint means an active unfinished run has lasted at least 60 seconds without a recent durable attempt; a long preview/model/inference wait can explain it, so it is a diagnostic signal, not a proven stall or retry instruction. Saved/web coverage is separate. Idle does not mean complete.";
  }
  const sync = safe.findLast(e => e.source === "client" && e.operation === "sync" && e.step === "snapshot");
  let syncSnapshot;
  if (sync) {
    syncSnapshot = {basis: "cached_ui_projection", state: sync.state ?? "unknown", ...counters(sync),
      limitation: "This is the UI's last derived sync summary. Exporting does not refresh the server, verify originals or establish second-device visibility. Missing lastCheckedAgeMS means freshness is unknown."};
    for (const key of ["accountState", "reason", "build", "lastCheckedAgeMS"]) if (sync[key] !== undefined) syncSnapshot[key] = sync[key];
    const age = sync.timestamp === undefined ? undefined : integer(Math.round((now - sync.timestamp) * 1000), Number.MAX_SAFE_INTEGER);
    if (age !== undefined) syncSnapshot.ageMS = age;
  }
  return {
    version: 2, events: safe.length,
    counts: [...counts].map(([kind, count]) => ({kind, count})),
    requestLinks: {client: clientRequests.size, server: serverRequests.size,
      matched: [...clientRequests].filter(id => serverRequests.has(id)).length},
    flows, buildWindows,
    ...(indexSnapshot ? {indexSnapshot} : {}),
    ...(syncSnapshot ? {syncSnapshot} : {}),
    ...(safe.some(e => e.accountState) ? {latestAccountState: [...safe].reverse().find(e => e.accountState).accountState} : {}),
    untracedPicks: {events: untracedPicks.length, latest: untracedPicks.slice(-5).map(e => ({outcome: e.outcome, ...counters(e), ...(e.elapsedMS === undefined ? {} : {elapsedMS: e.elapsedMS})})),
      limitation: "Older untraced Picks counts describe processed preview candidates; they cannot be assigned to a sync or upload backlog."},
    limitation: "A missing terminal, stage completion or request match can mean a bounded/truncated window. It does not prove a stuck action or lost data. Active duration covers observed events only.",
  };
}

async function main(args) {
  const json = args.includes("--json"), files = args.filter(arg => arg !== "--json");
  if (!files.length || files.length > 16) throw new Error("USAGE");
  const events = [];
  for (const file of files) {
    if ((await stat(file)).size > maximumBytes) throw new Error("INPUT_TOO_LARGE");
    events.push(...parseDiagnostics(await readFile(file, "utf8")));
    if (events.length > maximumEvents) throw new Error("TOO_MANY_EVENTS");
  }
  const summary = summarizeDiagnostics(events);
  if (json) { console.log(JSON.stringify(summary, null, 2)); return; }
  console.log(`${summary.events} safe events; ${summary.requestLinks.matched} client/server request links.`);
  for (const count of summary.counts) console.log(`${count.kind}: ${count.count}`);
  for (const flow of summary.flows) console.log(`${flow.operation}${flow.action ? "/" + flow.action : ""}: ${flow.result}${flow.activeStep ? "; active " + flow.activeStep : ""}${flow.lastCompletedStep ? "; last completed " + flow.lastCompletedStep : ""}${flow.reason ? "; " + flow.reason : ""}${flow.elapsedMS !== undefined ? "; " + flow.elapsedMS + "ms" : ""} [${flow.traceId}]`);
  if (summary.indexSnapshot) {
    console.log(`Local index snapshot: ${summary.indexSnapshot.activity}; build ${summary.indexSnapshot.build ?? "unknown"}; age ${summary.indexSnapshot.ageMS === undefined ? "unknown" : summary.indexSnapshot.ageMS + "ms"}${summary.indexSnapshot.reason ? "; " + summary.indexSnapshot.reason : ""}.`);
    for (const stage of summary.indexSnapshot.coverage) console.log(`${stage.stage}: ${JSON.stringify(stage)}`);
    if (summary.indexSnapshot.analysisWindow) console.log(`Automatic analysis window: ${summary.indexSnapshot.analysisWindow}`);
    for (const stage of summary.indexSnapshot.automaticWindowCoverage ?? []) console.log(`Automatic window ${stage.stage}: ${JSON.stringify(stage)}`);
    console.log(summary.indexSnapshot.limitation);
  }
  if (summary.syncSnapshot) console.log(`Cached sync snapshot: ${JSON.stringify(summary.syncSnapshot)}`);
  if (summary.untracedPicks.events) console.log(`Older untraced Picks: ${summary.untracedPicks.events} events; ${JSON.stringify(summary.untracedPicks.latest)}. ${summary.untracedPicks.limitation}`);
  console.log(summary.limitation);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { console.error("Diagnostics could not be read. Use: node tools/diagnostics.mjs [--json] EXPORT [SERVER_LOG ...]. Each input must be at most 8 MiB."); process.exitCode = 1; });
}
