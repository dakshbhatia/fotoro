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
