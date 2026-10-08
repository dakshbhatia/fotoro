import {it, expect, vi} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";

it("unexpected failures emit a support-correlated record without raw request or error secrets", async () => {
  const emitted = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(new Request("https://fotoro.cloud/v1/vault?cap=PRIVATE_CAPABILITY", {
      headers: {authorization: "Bearer PRIVATE_AUTH"},
    }), {...env, DB: {prepare: () => {throw new Error("PRIVATE_PHOTO_TEXT PRIVATE_KEY");}}} as any);
    expect(response.status).toBe(500);
    const body = await response.json() as {requestId: string};
    const records = emitted.mock.calls.flatMap(call => call.filter(value => typeof value === "string").map(value => {
      try {return JSON.parse(value);} catch {return null;}
    })).filter(Boolean);
    expect(records).toEqual([{event: "api.error", requestId: body.requestId, method: "GET", status: 500, code: "INTERNAL_ERROR", area: "account", phase: "request", errorClass: "unexpected", outcome: "server_error", elapsedMS: expect.any(Number)}]);
    expect(response.headers.get("X-Request-Id")).toBe(body.requestId);
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(emitted.mock.calls)).not.toMatch(/PRIVATE_|private-photo-name|authorization|cap=/);
  } finally {emitted.mockRestore();}
});

it.each([
  ["/v1/albums/PRIVATE_ALBUM/photos", "albums", "request"],
  ["/v1/changes?cursor=PRIVATE_CURSOR", "catalog", "request"],
  ["/v1/uploads/PRIVATE_UPLOAD/commit", "sync", "upload.commit"],
  ["/v1/background/uploads/PRIVATE_UPLOAD/staging?cap=PRIVATE_CAPABILITY", "sync", "upload.staging"],
  ["/v1/objects/PRIVATE_PHOTO", "media", "request"],
  ["/v1/PRIVATE_ROUTE", "other", "request"],
])("categorizes %s failures without logging identifiers or query data", async (path, area, phase) => {
  const emitted = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await app.fetch(new Request(`https://fotoro.cloud${path}`, {
      headers: {"x-fotoro-fixture-account": "PRIVATE_ACCOUNT", authorization: "Bearer PRIVATE_AUTH"},
    }), env as any);
    expect(response.status).toBe(401);
    const body = await response.json() as {requestId: string};
    expect(emitted.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([{
      event: "api.error", requestId: body.requestId, method: "GET", status: 401,
      code: "UNAUTHENTICATED", area, phase, errorClass: "auth", outcome: "client_error", elapsedMS: expect.any(Number),
    }]);
    expect(JSON.stringify(emitted.mock.calls)).not.toMatch(/PRIVATE_|cursor=|cap=|authorization/);
  } finally {emitted.mockRestore();}
});
