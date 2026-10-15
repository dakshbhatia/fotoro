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
test("local stage sampling is bounded while failures, counts and account mismatches remain inspectable", async () => {
  clearDiagnostics();
  await diagnose("search", async context => {
    for (let index = 0; index < 10000; index++) await context.stage("transfer", async () => index);
    await assert.rejects(context.stage("analysis", async () => {throw new Error("private query");}));
    context.items(10000); context.incomplete("unavailable");
  }, "prepare");
  assert.equal(entries().length, 15);
  assert.equal(entries().at(-2)?.step, "analysis"); assert.equal(entries().at(-2)?.outcome, "failed");
  assert.equal(entries().at(-1)?.count, 10000);
  assert.equal(exportDiagnostics().includes("private"), false);
  assert.equal(diagnosticReason(new Error("INVITATION_RECIPIENT_MISMATCH")), "account_changed");
  clearDiagnostics();
});

type History = typeof import("../src/diagnostics");
let reload = 0;
class DiagnosticStorage {
  values = new Map<string, string>();
  writes = 0;
  denied: "get" | "set" | "all" | undefined;
  getItem(key: string) {if (this.denied === "get" || this.denied === "all") throw new DOMException("Denied", "SecurityError"); return this.values.get(key) ?? null;}
  setItem(key: string, value: string) {if (this.denied === "set" || this.denied === "all") throw new DOMException("Full", "QuotaExceededError"); this.writes++; this.values.set(key, value);}
  removeItem(key: string) {if (this.denied === "all") throw new DOMException("Denied", "SecurityError"); this.values.delete(key);}
}
async function retained(run: (scope: {storage: DiagnosticStorage; windowTarget: EventTarget; fresh: () => Promise<History>}) => Promise<void>) {
  const previous = ["sessionStorage", "window"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const storage = new DiagnosticStorage(), windowTarget = new EventTarget(), histories: History[] = [];
  Object.defineProperty(globalThis, "sessionStorage", {configurable: true, value: storage});
  Object.defineProperty(globalThis, "window", {configurable: true, value: windowTarget});
  const fresh = async () => {
    const history: History = await import(`../src/diagnostics.ts?reload=${++reload}`);
    histories.push(history); return history;
  };
  try {await run({storage, windowTarget, fresh});}
  finally {
    for (const history of histories) history.clearDiagnostics();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}
const historyEntries = (history: History) => JSON.parse(history.exportDiagnostics()).events as Array<Record<string, any>>;
const storageKey = "fotoro:diagnostics:v1";

test("tab diagnostics survive reload and batch storage writes until a lifecycle flush", () => retained(async ({storage, windowTarget, fresh}) => {
  const history = await fresh();
  for (let index = 0; index < 30; index++) {
    const context = new history.DiagnosticContext("catalog", "refresh"); context.start(); context.items(index); context.finish();
  }
  const before = historyEntries(history);
  assert.equal(storage.writes, 0, "A progress burst must not synchronously rewrite storage per event");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(storage.writes, 1, "The bounded write window persists steady foreground work");
  new history.DiagnosticContext("metadata").finish();
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(storage.writes, 2, "Leaving flushes the newest pending event before reload");
  const reloaded = await fresh();
  assert.notEqual(reloaded.DiagnosticContext, history.DiagnosticContext, "A fresh module simulates a new page lifetime");
  assert.deepEqual(historyEntries(reloaded).slice(0, before.length), before);
  assert.equal(historyEntries(reloaded).length, before.length + 1);
}));

test("restored diagnostic history revalidates every field and bounds retained entries", () => retained(async ({storage, windowTarget, fresh}) => {
  const safe = {operation: "search", step: "analysis", outcome: "failed", reason: "unavailable", traceId: crypto.randomUUID(), elapsedMs: 9e20,
    count: 9e20, status: 1000, requestId: "private filename", action: "private query", payload: {password: "secret value"}};
  storage.values.set(storageKey, JSON.stringify({version: 1, client: "web", private: "secret value", events: [
    ...Array.from({length: 200}, () => safe), {...safe, operation: "private query"}, {...safe, traceId: "secret value"},
  ]}));
  const history = await fresh(), restored = historyEntries(history);
  assert.equal(restored.length, diagnosticEventLimit - 2);
  assert.ok(restored.every(event => event.elapsedMs === 86_400_000 && event.count === 1_000_000 && event.status === 599));
  for (let index = 0; index < 200; index++) new history.DiagnosticContext("metadata").finish();
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(historyEntries(history).length, diagnosticEventLimit);
  for (const value of [history.exportDiagnostics(), storage.values.get(storageKey)!]) {
    assert.doesNotMatch(value, /private|secret|password|payload/);
    assert.ok(value.length < 64 * 1024);
  }
}));

test("corrupt, oversized and unavailable storage leaves diagnostics usable in memory", () => retained(async ({storage, windowTarget, fresh}) => {
  for (const value of ["not json", JSON.stringify({version: 2, client: "web", events: []}), JSON.stringify({version: 1, client: "web", events: "secret"}), "x".repeat(64 * 1024 + 1)]) {
    storage.values.set(storageKey, value);
    const history = await fresh();
    assert.deepEqual(historyEntries(history), []);
    assert.equal(storage.values.has(storageKey), false);
  }
  for (const denial of ["get", "set", "all"] as const) {
    storage.denied = denial;
    const history = await fresh();
    const context = new history.DiagnosticContext("search"); context.start(); context.finish();
    assert.equal(historyEntries(history).length, 2);
    windowTarget.dispatchEvent(new Event("pagehide"));
    assert.doesNotThrow(() => history.clearDiagnostics());
    assert.deepEqual(historyEntries(history), []);
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  Object.defineProperty(globalThis, "sessionStorage", {configurable: true, get() {throw new DOMException("Denied", "SecurityError");}});
  const denied = await fresh(); new denied.DiagnosticContext("search").finish();
  assert.equal(historyEntries(denied).length, 1);
  assert.doesNotThrow(() => denied.clearDiagnostics());
  Object.defineProperty(globalThis, "sessionStorage", descriptor);
}));

test("explicit clear erases retained events and fences late work from the old history", () => retained(async ({storage, windowTarget, fresh}) => {
  const history = await fresh(), context = new history.DiagnosticContext("search");
  context.start(); windowTarget.dispatchEvent(new Event("pagehide"));
  let release!: () => void;
  const pending = context.stage("analysis", () => new Promise<void>(resolve => {release = resolve;}));
  history.clearDiagnostics();
  assert.equal(storage.values.has(storageKey), false);
  release(); await pending; context.request("request", "failed", "network", 10); context.finish();
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(historyEntries(history), []);
  assert.deepEqual(historyEntries(await fresh()), []);
  new history.DiagnosticContext("metadata").finish();
  assert.equal(historyEntries(history).length, 1, "New work can be inspected after clear");
}));

test("manual lock used by sign-out clears retained history while expiry and unlock keep troubleshooting", () => retained(async ({storage, windowTarget, fresh}) => {
  const history = await fresh(), context = new history.DiagnosticContext("auth", "password"); context.start();
  const lock = (reason: string) => windowTarget.dispatchEvent(Object.assign(new Event("fotoro-lock"), {detail: {reason}}));
  lock("expired"); lock("unlock");
  assert.equal(historyEntries(history).length, 1);
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(storage.values.has(storageKey), true);
  lock("manual"); context.finish();
  assert.deepEqual(historyEntries(history), []);
  assert.equal(storage.values.has(storageKey), false);
  assert.deepEqual(historyEntries(await fresh()), []);
}));
