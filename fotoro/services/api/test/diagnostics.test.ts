import {it, expect, vi} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";

it("unexpected failures emit a support-correlated record without raw request or error secrets", async () => {
  const emitted = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(new Request("https://fotoro.cloud/private-photo-name?cap=PRIVATE_CAPABILITY", {
      headers: {authorization: "Bearer PRIVATE_AUTH"},
    }), {...env, ASSETS: {fetch: async () => {throw new Error("PRIVATE_PHOTO_TEXT PRIVATE_KEY");}}} as any);
    expect(response.status).toBe(500);
    const body = await response.json() as {requestId: string};
    const records = emitted.mock.calls.flatMap(call => call.filter(value => typeof value === "string").map(value => {
      try {return JSON.parse(value);} catch {return null;}
    })).filter(Boolean);
    expect(records).toEqual([{event: "api.error", requestId: body.requestId, method: "GET", status: 500, code: "INTERNAL_ERROR"}]);
    expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(emitted.mock.calls)).not.toMatch(/PRIVATE_|private-photo-name|authorization|cap=/);
  } finally {emitted.mockRestore();}
});
