import {afterEach, it, expect, vi} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {ApiError} from "../src/errors";
import {seed, http, photo} from "./helpers";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const traceId = "a2a1d95f-c89e-4cf1-94e9-116bd028094d";
afterEach(() => vi.restoreAllMocks());
function capture() {
  const spies = ["info", "warn", "error"].map(method => vi.spyOn(console, method as "info").mockImplementation(() => {}));
  return () => spies.flatMap(spy => spy.mock.calls.map(call => JSON.parse(String(call[0]))));
}
it("preflight emits one final event and independent IDs with browser correlation headers", async () => {
  const records = capture();
  const responses = await Promise.all([0, 1].map(() => app.fetch(new Request("http://localhost:8787/v1/photos", {
    method: "OPTIONS", headers: {origin: "http://localhost:4310", "X-Fotoro-Trace-Id": traceId, "X-Request-Id": traceId},
  }), env as any)));
  expect(records()).toHaveLength(2);
  for (const response of responses) {
    expect(response.status).toBe(204);
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toMatch(uuid);
    expect(requestId).not.toBe(traceId);
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("x-fotoro-trace-id");
    expect(response.headers.get("Access-Control-Expose-Headers")?.toLowerCase()).toContain("x-request-id");
    expect(records().find(record => record.requestId === requestId)).toEqual({
      event: "api.request", requestId, traceId, method: "OPTIONS", status: 204,
      area: "catalog", phase: "request", outcome: "success", elapsedMS: expect.any(Number),
    });
  }
  expect(responses[0].headers.get("X-Request-Id")).not.toBe(responses[1].headers.get("X-Request-Id"));
});
it.each(["PRIVATE_PHOTO_TEXT", "A2A1D95F-C89E-4CF1-94E9-116BD028094D", `${traceId},${traceId}`, "a2a1d95fc89e4cf194e9116bd028094d"])("invalid trace %s is omitted rather than logged", async invalid => {
  const records = capture();
  const response = await app.fetch(new Request("http://localhost:8787/v1/vault", {headers: {"X-Fotoro-Trace-Id": invalid}}), env as any);
  expect(response.status).toBe(401);
  expect(records()).toHaveLength(1);
  expect(records()[0]).not.toHaveProperty("traceId");
  expect(JSON.stringify(records())).not.toContain(invalid);
  expect(response.headers.get("X-Request-Id")).toMatch(uuid);
});
it("origin rejection before preflight correlates its single error event and response", async () => {
  const records = capture();
  const response = await app.fetch(new Request("https://fotoro.cloud/v1/photos", {method: "OPTIONS", headers: {origin: "https://PRIVATE_ORIGIN.invalid", "X-Fotoro-Trace-Id": traceId}}), env as any);
  expect(response.status).toBe(403);
  const body = await response.json() as {requestId: string};
  expect(records()).toEqual([expect.objectContaining({requestId: body.requestId, traceId, code: "ORIGIN_DENIED", outcome: "client_error"})]);
  expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
  expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  expect(JSON.stringify(records())).not.toContain("PRIVATE_ORIGIN");
});
it("authenticated success and missing routes share final IDs with headers and error JSON", async () => {
  await seed();
  const records = capture();
  const headers = {authorization: "Bearer public-test-0", origin: "http://localhost:4310"};
  const ok = await http(0, "/v1/changes");
  expect(ok.status).toBe(200);
  expect(records()).toEqual([expect.objectContaining({event: "api.request", requestId: ok.headers.get("X-Request-Id"), status: 200, outcome: "success"})]);
  expect(ok.headers.get("Access-Control-Expose-Headers")?.toLowerCase()).toContain("x-request-id");
  const missing = await app.fetch(new Request("http://localhost:8787/v1/PRIVATE_MISSING", {headers}), env as any);
  expect(missing.status).toBe(404);
  const body = await missing.json() as {requestId: string};
  expect(records()).toHaveLength(2);
  expect(records()[1]).toMatchObject({event: "api.error", requestId: body.requestId, status: 404, code: "NOT_FOUND", outcome: "client_error"});
  expect(missing.headers.get("X-Request-Id")).toBe(body.requestId);
  expect(body.requestId).not.toBe(ok.headers.get("X-Request-Id"));
});
it("duration includes awaited handler work and raw error diagnostics cannot escape allowlists", async () => {
  const records = capture();
  const response = await app.fetch(new Request("http://localhost:8787/v1/vault?cap=PRIVATE_CAP", {headers: {authorization: "Bearer PRIVATE_AUTH", "X-Fotoro-Trace-Id": traceId}}), {
    ...env, DB: {prepare: () => ({bind: () => ({first: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new ApiError("PRIVATE_CODE", 500, {phase: "PRIVATE_PHASE", errorClass: "PRIVATE_ERROR"} as any);
    }})})},
  } as any);
  expect(response.status).toBe(500);
  const body = await response.json() as {requestId: string};
  expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({requestId: body.requestId, traceId, phase: "request", errorClass: "unexpected", code: "OTHER_ERROR"});
  expect(records()[0].elapsedMS).toBeGreaterThanOrEqual(15);
  expect(records()[0].elapsedMS).toBeLessThanOrEqual(3_600_000);
  expect(Number.isInteger(records()[0].elapsedMS)).toBe(true);
  expect(JSON.stringify(records())).not.toMatch(/PRIVATE_/);
});
it("static assets and associations do not emit API lifecycle events", async () => {
  const records = capture();
  await app.fetch(new Request("https://fotoro.cloud/assets/PRIVATE_PHOTO.jpg"), {...env, ASSETS: {fetch: async () => new Response("public fixture")}} as any);
  await app.fetch(new Request("https://fotoro.cloud/.well-known/apple-app-site-association"), env as any);
  expect(records()).toEqual([]);
});

it("binary object responses keep ciphertext intact and correlate exactly one media event", async () => {
  await seed();
  const source = await photo(0);
  const original = source.m.representations[0];
  const expected = await (await env.BUCKET.get("final/" + original.objectId))!.arrayBuffer();
  const records = capture();
  const response = await http(0, "/v1/objects/" + original.objectId);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-Request-Id")).toMatch(uuid);
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(await response.arrayBuffer()).toEqual(expected);
  expect(records()).toEqual([expect.objectContaining({event: "api.request", requestId: response.headers.get("X-Request-Id"), area: "media", outcome: "success"})]);
  expect(JSON.stringify(records())).not.toContain(original.objectId);
  expect(JSON.stringify(records())).not.toContain(source.m.ownerAccountId);
});
