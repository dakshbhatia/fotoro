import test from "node:test";
import assert from "node:assert/strict";
import {DiagnosticContext, clearDiagnostics, diagnose, diagnosticEventLimit, diagnosticReason, exportDiagnostics} from "../src/diagnostics";
import {api, fetchCipher, scopedApi, uploadCipher, ApiError} from "../src/exchange/api";

const entries = () => JSON.parse(exportDiagnostics()).events as Array<Record<string, any>>;
const response = (value: unknown, requestId = crypto.randomUUID(), status = 200) => new Response(JSON.stringify(value), {status, headers: {"X-Request-Id": requestId}});
async function mocked(run: () => Promise<void>) {
  const previous = globalThis.fetch; clearDiagnostics();
  try {await run();} finally {globalThis.fetch = previous; clearDiagnostics();}
}
test("concurrent logical actions carry independent explicit trace IDs through delayed API replies", () => mocked(async () => {
  const pending: Array<{traceId: string; resolve: (response: Response) => void}> = [];
  globalThis.fetch = async (_path, init) => new Promise(resolve => {
    pending.push({traceId: new Headers(init?.headers).get("X-Fotoro-Trace-Id")!, resolve});
  });
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const first = diagnose("auth", async context => {const request = scopedApi(context); await request("/v1/auth/login/options", {private: "secret"}); await request("/v1/vault");}, "passkey");
  const second = diagnose("album", context => scopedApi(context)("/v1/albums/private-album-id"));
  assert.equal(pending.length, 2); assert.notEqual(pending[0].traceId, pending[1].traceId);
  const authTrace = pending[0].traceId, albumTrace = pending[1].traceId;
  pending[1].resolve(response({}, secondId)); await second;
  pending[0].resolve(response({}, firstId));
  while (pending.length < 3) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending[2].traceId, authTrace); pending[2].resolve(response({})); await first;
  const events = entries();
  assert.equal(events.find(event => event.requestId === firstId)?.traceId, authTrace);
  assert.equal(events.find(event => event.requestId === firstId)?.action, "passkey");
  assert.equal(events.find(event => event.requestId === secondId)?.traceId, albumTrace);
  assert.deepEqual(events.filter(event => event.step === "action" && event.outcome === "succeeded").map(event => [event.operation, event.count]), [["album", 1], ["auth", 2]]);
}));
test("all HTTP replies consume header request IDs, errors prefer sanitized header over body IDs", () => mocked(async () => {
  const id = crypto.randomUUID();
  globalThis.fetch = async () => response({code: "FORBIDDEN", requestId: "secret body"}, id, 403);
  await assert.rejects(api("/v1/photos/private-id?cap=secret"), error => error instanceof ApiError && error.requestId === id);
  assert.equal(entries()[0].requestId, id); assert.equal(entries()[0].reason, "http"); assert.equal(entries()[0].status, 403);
  globalThis.fetch = async () => response({}, "https://private.example/#password");
  await api("/v1/vault"); assert.equal(entries().at(-1)?.requestId, undefined);
}));
test("malformed JSON and invalid wire responses never record successful request terminals", () => mocked(async () => {
  const jsonId = crypto.randomUUID(), wireId = crypto.randomUUID();
  globalThis.fetch = async () => new Response("private filename invalid json", {headers: {"X-Request-Id": jsonId}});
  await assert.rejects(diagnose("auth", context => scopedApi(context)("/v1/auth/login/verify")));
  assert.equal(entries().find(event => event.requestId === jsonId && event.step === "decode")?.reason, "decode");
  globalThis.fetch = async () => response({version: 1, leaked: "private query"}, wireId);
  await assert.rejects(diagnose("auth", context => scopedApi(context)("/v1/auth/login/verify", undefined, "SessionV1")));
  assert.equal(entries().find(event => event.requestId === wireId && event.step === "decode")?.reason, "invalid_wire");
  assert.equal(entries().some(event => event.outcome === "succeeded"), false);
  assert.equal(exportDiagnostics().includes("private"), false);
}));
test("network and late-aborted responses terminate with safe categories while preserving reply correlation", () => mocked(async () => {
  globalThis.fetch = async () => {throw new TypeError("https://private.example?token=secret GPS=40,-74");};
  await assert.rejects(diagnose("catalog", context => scopedApi(context)("/v1/changes")));
  assert.equal(entries().find(event => event.step === "request")?.reason, "network");
  const controller = new AbortController(), id = crypto.randomUUID();
  globalThis.fetch = async () => {controller.abort(); return response({}, id);};
  await assert.rejects(diagnose("sync", context => scopedApi(context)("/v1/photos", {}, undefined, "POST", controller.signal)), {name: "AbortError"});
  assert.equal(entries().find(event => event.requestId === id && event.step === "request")?.outcome, "cancelled");
  assert.equal(entries().at(-1)?.outcome, "cancelled");
  assert.equal(exportDiagnostics().includes("secret"), false);
}));
test("cipher downloads and upload replies send the same explicit trace and retain server request IDs", () => mocked(async () => {
  const context = new DiagnosticContext("sync"), ids = [crypto.randomUUID(), crypto.randomUUID()];
  let calls = 0;
  globalThis.fetch = async (_path, options) => {
    assert.equal(new Headers(options?.headers).get("X-Fotoro-Trace-Id"), context.traceId);
    return new Response(new Uint8Array([1, 2, 3]), {headers: {"X-Request-Id": ids[calls++]}});
  };
  assert.deepEqual(await fetchCipher("private-photo-id", undefined, context), new Uint8Array([1, 2, 3]));
  await uploadCipher(new URL("https://fotoro.invalid/private-upload?cap=secret"), {method: "PUT", body: new Uint8Array([1])}, context);
  assert.deepEqual(entries().map(event => event.requestId), ids);
  assert.ok(entries().every(event => event.step === "transfer" && event.traceId === context.traceId));
  assert.equal(exportDiagnostics().includes("private"), false);
}));
test("ring and batch summaries stay bounded, reconstruct fields and reject arbitrary labels", async () => {
  clearDiagnostics();
  const context = new DiagnosticContext("sync");
  for (let i = 0; i < 500; i++) context.request("request", "succeeded", "none", i, crypto.randomUUID());
  context.finish();
  assert.equal(entries().length, 13); assert.equal(entries().at(-1)?.count, 500);
  for (let i = 0; i < 200; i++) {
    const malicious = new DiagnosticContext("private account name" as any);
    malicious.request("request", "failed", "unknown", -Infinity, "not-an-id");
    const safe = new DiagnosticContext("request");
    safe.request("decode", "failed", "unknown", 9e20, "not-an-id", 1000);
  }
  const exported = JSON.parse(exportDiagnostics());
  assert.equal(exported.events.length, diagnosticEventLimit); assert.equal(exportDiagnostics().includes("private account"), false);
  for (const event of exported.events) {
    assert.equal(event.elapsedMs, 86_400_000); assert.equal(event.status, 599); assert.equal(event.requestId, undefined);
    assert.ok(Object.keys(event).every(key => ["operation", "step", "outcome", "reason", "traceId", "requestId", "elapsedMs", "count", "status"].includes(key)));
  }
  clearDiagnostics(); assert.equal(entries().length, 0);
});
test("incomplete and cancelled resolved workflows do not claim successful completion", async () => {
  clearDiagnostics();
  assert.equal(await diagnose("sync", async context => {context.incomplete("unavailable"); return "kept pending";}, "save"), "kept pending");
  assert.deepEqual(entries().at(-1)?.outcome, "failed");
  assert.deepEqual(entries().at(-1)?.action, "save");
  await diagnose("share", async context => {context.incomplete("cancelled");}, "prepare");
  assert.equal(entries().at(-1)?.outcome, "cancelled");
  const malicious = new DiagnosticContext("auth", "private person name" as any); malicious.start(); malicious.finish();
  assert.equal(exportDiagnostics().includes("private person"), false);
  clearDiagnostics();
});
test("background media/access successes stay quiet while failures and explicit album actions remain visible", () => {
  clearDiagnostics();
  for (const operation of ["media", "album"] as const) {
    const context = new DiagnosticContext(operation);
    for (let index = 0; index < 200; index++) context.request("request", "succeeded", "none", 1, crypto.randomUUID(), 200);
    context.request("request", "failed", "http", 1, crypto.randomUUID(), 403);
  }
  assert.equal(entries().length, 2);
  assert.ok(entries().every(event => event.outcome === "failed"));
  const action = new DiagnosticContext("album", "refresh");
  action.start(); action.request("request", "succeeded", "none", 1, crypto.randomUUID(), 200); action.finish();
  assert.equal(entries().at(-1)?.count, 1);
  assert.equal(entries().at(-1)?.action, "refresh");
  assert.equal(diagnosticReason(new Error("PRF_UNAVAILABLE_USE_RECOVERY")), "unavailable");
  assert.equal(diagnosticReason(new Error("NO_ACCOUNT_PASSKEY")), "unavailable");
  clearDiagnostics();
});
