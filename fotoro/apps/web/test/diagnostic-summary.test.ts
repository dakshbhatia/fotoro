import test from "node:test";
import assert from "node:assert/strict";
import {summarizeDiagnostics} from "../src/diagnostics";

const event = (patch: Record<string, unknown>) => ({operation: "search", step: "action", outcome: "succeeded", reason: "none", traceId: crypto.randomUUID(), elapsedMs: 10, ...patch});
test("performance summary separates logical action latency, failures and cancellation", () => {
  const summary = summarizeDiagnostics([
    ...[10, 20, 30, 40, 100].map(elapsedMs => event({elapsedMs})),
    event({step: "request", elapsedMs: 99999}), event({outcome: "started"}),
    event({outcome: "failed", reason: "network", elapsedMs: 10000}),
    event({outcome: "cancelled", reason: "cancelled"}),
  ]);
  assert.deepEqual(summary, [{operation: "search", succeeded: 5, failed: 1, cancelled: 1, p50Ms: 30, p95Ms: 100, reasons: {network: 1, cancelled: 1}}]);
});
test("summary sanitizes inputs and exposes no trace, query, identity or arbitrary reason", () => {
  const summary = summarizeDiagnostics([event({query: "private", latitude: 12, filename: "secret.jpg"}), event({operation: "private"}), event({reason: "private"}), event({traceId: "secret"})]);
  assert.deepEqual(summary, [{operation: "search", succeeded: 1, failed: 0, cancelled: 0, p50Ms: 10, p95Ms: 10, reasons: {}}]);
  assert.ok(!JSON.stringify(summary).includes("private"));
});
test("failure-only samples have no invented latency and empty samples remain empty", () => {
  assert.deepEqual(summarizeDiagnostics([]), []);
  assert.deepEqual(summarizeDiagnostics([event({operation: "sync", outcome: "failed", reason: "locked"})]), [{operation: "sync", succeeded: 0, failed: 1, cancelled: 0, reasons: {locked: 1}}]);
});
