import test from "node:test";
import assert from "node:assert/strict";
import {parseDiagnostics, summarizeDiagnostics} from "./diagnostics.mjs";

const traceId = "1522ba48-0ee4-4040-b0da-7202dc00388e";
const requestId = "324244ec-8ead-4866-afee-3b7742ed7b46";
test("joins client action and server request while preserving a failed decode after HTTP success", () => {
  const client = {version: 1, client: "web", events: [
    {operation: "sync", step: "action", outcome: "started", traceId},
    {operation: "sync", step: "decode", outcome: "failed", reason: "decode", status: 200, requestId, traceId},
    {operation: "sync", step: "action", outcome: "failed", reason: "decode", elapsedMs: 45, traceId},
  ]};
  const server = {logs: [{message: [JSON.stringify({event: "api.request", outcome: "success", area: "catalog", phase: "request", status: 200, elapsedMS: 14, requestId, traceId})]}]};
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify(client) + "\n" + JSON.stringify(server, null, 2)));
  assert.equal(report.events, 4);
  assert.equal(report.requestLinks.matched, 1);
  assert.equal(report.flows[0].result, "failed");
  assert.equal(report.flows[0].reason, "decode");
  assert.equal(report.flows[0].elapsedMS, 45);
});
test("rejects private values in known fields and drops envelope/request details", () => {
  const secret = "private-family-name-and-capability";
  const data = {event: "api.error", operation: secret, phase: secret, area: secret, errorClass: secret,
    outcome: "failed", reason: secret, requestId: secret, traceId, status: 500, elapsedMS: Infinity, completed: -1,
    url: secret, code: secret, message: secret, headers: {Authorization: secret}};
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify({logs: [{message: [JSON.stringify(data)]}], event: {request: {url: secret}}})));
  const output = JSON.stringify(report);
  assert.ok(!output.includes(secret));
  assert.equal(report.events, 1);
  assert.equal(report.flows[0].failures[0].status, 500);
});
test("handles older native logs and truncated windows without inventing success or a stuck action", () => {
  const old = {phase: "api", outcome: "failed", endpoint: "upload", status: 409, build: "40"};
  const start = {phase: "sync", operation: "sync", step: "action", outcome: "started", traceId};
  const events = parseDiagnostics(JSON.stringify(old) + "\n" + JSON.stringify(start) + '\n{"phase":"sync","outcome":"completed"');
  const report = summarizeDiagnostics(events);
  assert.equal(report.events, 2);
  assert.equal(report.flows[0].result, "no_terminal_in_window");
  assert.match(report.limitation, /does not prove a stuck action/);
  assert.throws(() => parseDiagnostics(" ".repeat(8 * 1024 * 1024 + 1)), /INPUT_TOO_LARGE/);
});
test("reads colored CLI envelopes and retains only closed action names", () => {
  const events = parseDiagnostics('\u001b[33mConnected\u001b[0m\n' + JSON.stringify({operation: "auth", action: "passkey", step: "action", outcome: "succeeded", traceId}));
  assert.equal(summarizeDiagnostics(events).flows[0].action, "passkey");
  assert.equal(summarizeDiagnostics([{operation: "auth", action: "a private password", step: "action", outcome: "succeeded", traceId}]).flows[0].action, undefined);
});
test("malformed server records cannot synthesize successful requests", () => {
  assert.deepEqual(parseDiagnostics(JSON.stringify([
    {event: "api.request"}, {event: "api.request", status: "not-a-status"},
    {event: "api.request", status: 500}, {event: "api.error", status: 200},
  ])), []);
});
test("preserves inactive versus background interruption through safe native trace summaries", () => {
  for (const reason of ["inactive", "background"]) {
    const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([
      {phase: "sync", operation: "sync", step: "action", outcome: "started", traceId},
      {phase: "sync", operation: "sync", step: "action", outcome: "cancelled", reason, traceId, elapsedMS: 30},
    ])));
    assert.equal(report.flows[0].result, "cancelled");
    assert.equal(report.flows[0].reason, reason);
    assert.equal(report.flows[0].elapsedMS, 30);
  }
});
test("retains distinct unfinished source reasons and finite processed Picks counters without private fields", () => {
  for (const reason of ["pendingTransfers", "unpreparedSources", "skippedSources"]) {
    const [event] = parseDiagnostics(JSON.stringify({phase: "sync", outcome: "changed", state: "needsAttention", step: "transfer", reason,
      completed: 3, pending: 0, filename: "private-photo.jpg", photoId: "private-source"}));
    assert.equal(event.reason, reason);
    assert.equal(event.completed, 3);
    assert.equal(event.pending, 0);
    assert.ok(!JSON.stringify(event).includes("private-"));
  }
  const events = parseDiagnostics(JSON.stringify([
    {phase: "picks", outcome: "completed", completed: 3, pending: 0},
    {phase: "picks", outcome: "cancelled", completed: 2, pending: 498},
    {phase: "picks", outcome: "cancelled", completed: -1, pending: "private-photo"},
    {phase: "picks", outcome: "cancelled", completed: 1_000_001, pending: 1.5},
  ]));
  assert.deepEqual(events.slice(0, 2).map(({completed, pending}) => ({completed, pending})), [{completed: 3, pending: 0}, {completed: 2, pending: 498}]);
  for (const event of events.slice(2)) {
    assert.equal(event.completed, undefined);
    assert.equal(event.pending, undefined);
  }
});
test("retains closed native stages, parent correlation, counts and only relative report time", () => {
  const parentTraceId = "69224569-9dde-4c86-82c9-dcce1c56a375";
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([
    {phase: "picks", operation: "picks", step: "action", outcome: "started", traceId, parentTraceId,
      currentStep: "prepare", build: "62", accountState: "unlocked", timestamp: 1_791_592_307.7},
    {phase: "picks", operation: "picks", step: "prepare", outcome: "changed", traceId, parentTraceId,
      currentStep: "prepare", completed: 4, pending: 496, cacheHits: 2, unavailable: 1, skipped: 1, timestamp: 1_791_592_312.7},
  ])));
  const flow = report.flows[0];
  assert.equal(flow.operation, "picks");
  assert.equal(flow.parentTraceId, parentTraceId);
  assert.equal(flow.build, "62");
  assert.equal(flow.activeStep, "prepare");
  assert.equal(flow.activeObservedMS, 5000);
  assert.deepEqual(flow.counters, {completed: 4, pending: 496, cacheHits: 2, unavailable: 1, skipped: 1});
  assert.equal(flow.stages.at(-1).relativeMS, 5000);
  assert.ok(!JSON.stringify(report).includes("1791592307"));
});
test("reports unmatched preparation after successful API decode rather than a live request", () => {
  const event = (step, outcome, timestamp) => ({phase: "sync", operation: "sync", step, outcome, traceId, timestamp});
  const events = [event("action", "started", 100),
    {...event("request", "started", 100.1), phase: "api", endpoint: "catalog", method: "GET"},
    {...event("decode", "completed", 100.2), phase: "api", endpoint: "catalog", method: "GET", status: 200},
    event("scan", "started", 100.3), event("scan", "completed", 100.4),
    event("prepare", "started", 100.5), {...event("transfer", "changed", 106), state: "preparing"}];
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify(events)));
  assert.equal(report.flows[0].activeStep, "prepare");
  assert.equal(report.flows[0].activeObservedMS, 5500);
  assert.equal(report.flows[0].stages[1].endpoint, "catalog");
  assert.equal(report.flows[0].stages[1].method, "GET");
  events.push({...event("action", "cancelled", 107), reason: "background"});
  const cancelled = summarizeDiagnostics(parseDiagnostics(JSON.stringify(events))).flows[0];
  assert.equal(cancelled.activeStep, undefined);
  assert.equal(cancelled.reason, "background");
});
test("sanitizes stage additions, timestamps, build values and aggregate scalar bounds", () => {
  const secret = "private-file-and-source";
  const [safe] = parseDiagnostics(JSON.stringify({phase: "picks", outcome: "changed", traceId,
    parentTraceId: secret, currentStep: secret, endpoint: secret, method: secret, accountState: secret,
    build: secret, cacheHits: -1, unavailable: 1_000_001, skipped: 1.5, timestamp: -1,
    filename: secret, sourceId: secret, message: secret}));
  assert.ok(!JSON.stringify(safe).includes(secret));
  for (const key of ["parentTraceId", "currentStep", "endpoint", "method", "accountState", "build", "cacheHits", "unavailable", "skipped", "timestamp"]) assert.equal(safe[key], undefined);
  const [valid] = parseDiagnostics(JSON.stringify({phase: "api", outcome: "changed", endpoint: "upload", method: "POST",
    accountState: "locked", build: "62.1", reason: "recoveryProbe", cacheHits: 0, unavailable: 1_000_000, skipped: 3}));
  assert.equal(valid.clientPhase, "api");
  assert.equal(valid.accountState, "locked");
  assert.equal(valid.build, "62.1");
  assert.equal(valid.reason, "recoveryProbe");
  assert.equal(valid.unavailable, 1_000_000);
  assert.equal(summarizeDiagnostics([valid]).counts[0].count, 1);
});
test("older untraced Picks retain processed counts with a coverage caveat", () => {
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([
    {phase: "picks", outcome: "cancelled", completed: 4, pending: 496, elapsedMS: 7038},
    {phase: "picks", outcome: "cancelled", completed: 6, pending: 494, elapsedMS: 1411},
  ])));
  assert.equal(report.untracedPicks.events, 2);
  assert.deepEqual(report.untracedPicks.latest[1], {outcome: "cancelled", completed: 6, pending: 494, elapsedMS: 1411});
  assert.match(report.untracedPicks.limitation, /cannot be assigned to a sync or upload backlog/);
  assert.equal(report.flows.length, 0);
});
test("bounded and truncated stage windows never synthesize completion", () => {
  const started = {operation: "sync", phase: "sync", step: "action", outcome: "started", traceId};
  const stage = {operation: "sync", phase: "sync", step: "prepare", outcome: "started", traceId, timestamp: 100};
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify(started) + "\n" + JSON.stringify(stage) + '\n{"operation":"sync","step":"prepare","outcome":"completed"'));
  assert.equal(report.flows[0].activeStep, "prepare");
  assert.equal(report.flows[0].result, "no_terminal_in_window");
  assert.match(report.limitation, /bounded\/truncated/);
  const bounded = parseDiagnostics(JSON.stringify(Array.from({length: 4100}, () => stage)));
  assert.equal(bounded.length, 4096);
  const many = summarizeDiagnostics(bounded);
  assert.equal(many.events, 4096);
  assert.ok(many.flows[0].stages.length <= 16);
  const [hugeTime] = parseDiagnostics(JSON.stringify({...stage, timestamp: 4_102_444_801}));
  assert.equal(hugeTime.timestamp, undefined);
});
test("mixed build windows retain current flow timings beyond a day", () => {
  const newerTrace = "69224569-9dde-4c86-82c9-dcce1c56a375";
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([
    {phase: "sync", outcome: "started", step: "action", traceId, build: "50", timestamp: 100},
    {phase: "sync", outcome: "completed", step: "action", traceId, build: "50", timestamp: 101},
    {phase: "sync", outcome: "started", step: "action", traceId: newerTrace, build: "60", timestamp: 100_000},
    {phase: "sync", outcome: "started", step: "prepare", traceId: newerTrace, build: "60", timestamp: 100_001},
    {phase: "sync", outcome: "changed", step: "transfer", traceId: newerTrace, build: "60", timestamp: 100_006},
  ])));
  assert.deepEqual(report.buildWindows, [{build: "50", events: 2, observedMS: 1000}, {build: "60", events: 3, observedMS: 6000}]);
  assert.equal(report.flows[1].stages.at(-1).relativeMS, 6000);
  assert.equal(report.flows[1].timingBasis, "trace_window_start");
  assert.equal(report.flows[1].activeObservedMS, 5000);
});
test("completed current stages never stay active after unrelated nonterminal events", () => {
  const report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([
    {phase: "sync", outcome: "started", step: "action", traceId},
    {phase: "sync", outcome: "started", step: "prepare", currentStep: "prepare", traceId},
    {phase: "sync", outcome: "completed", step: "prepare", currentStep: "prepare", traceId},
    {phase: "sync", outcome: "changed", step: "transfer", traceId},
  ])));
  assert.equal(report.flows[0].activeStep, undefined);
  assert.equal(report.flows[0].result, "no_terminal_in_window");
});
test("settlement stages identify the exact pre-API wait and close on recovery", () => {
  for (const step of ["settlePrevious", "settleBackup", "settleJournal"]) {
    const started = {phase: "sync", operation: "sync", step: "action", outcome: "started", traceId, timestamp: 100};
    const waiting = {phase: "sync", operation: "sync", step, currentStep: step, outcome: "started", traceId, timestamp: 101};
    let report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([started, waiting])));
    assert.equal(report.flows[0].activeStep, step);
    assert.equal(report.flows[0].stages.at(-1).currentStep, step);
    assert.equal(report.flows[0].result, "no_terminal_in_window");
    const recovered = {...waiting, outcome: "failed", reason: "retryRequired", timestamp: 102};
    report = summarizeDiagnostics(parseDiagnostics(JSON.stringify([started, waiting, recovered,
      {phase: "sync", operation: "sync", step: "transfer", outcome: "changed", traceId, timestamp: 103}])));
    assert.equal(report.flows[0].activeStep, undefined, "A recovered failure cannot remain a live wait");
    assert.equal(report.flows[0].failures.at(-1).step, step);
    assert.equal(report.flows[0].failures.at(-1).reason, "retryRequired");
    assert.equal(report.flows[0].stages.at(-1).relativeMS, 3000);
  }
});
