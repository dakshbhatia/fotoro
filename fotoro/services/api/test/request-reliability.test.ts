import { expect, it } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { http, photo, seed, signed } from "./helpers";

it("malformed device completion bodies return a client error", async () => {
  await seed();
  for (const body of [null, false, "completion", [], { version: 1 }]) {
    const response = await http(0, `/v1/devices/enroll/${crypto.randomUUID()}/complete`, "POST", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_WIRE", retryable: false });
  }
});

it("concurrent identical photo commits succeed once and changed retries conflict", async () => {
  await seed();
  const { m, s } = await photo(0);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM retention WHERE photo_id=?").bind(m.photoId),
    env.DB.prepare("DELETE FROM photos WHERE id=?").bind(m.photoId),
    env.DB.prepare("DELETE FROM changes WHERE entity_id=?").bind(m.photoId),
  ]);
  const responses = await Promise.all(Array.from({ length: 6 }, () => http(0, "/v1/photos", "POST", s)));
  expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
  for (const response of responses) expect(await response.json()).toEqual(m);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE entity_id=?").bind(m.photoId).first<{ n: number }>();
  expect(count?.n).toBe(1);
  const changed = await signed(0, "photo-manifest", {
    ...m,
    ownerWrappedMetadataKey: { ...m.ownerWrappedMetadataKey, ciphertext: "B".repeat(64) },
  });
  expect((await http(0, "/v1/photos", "POST", changed)).status).toBe(409);
});

it("auth JSON requests are bounded even without a content-length header", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, client: "web" }) + " ".repeat(2 * 1024 * 1024));
  let cancelled = false;
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.close();
      else { sent = true; controller.enqueue(bytes); }
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = await app.fetch(new Request("http://localhost:8787/v1/auth/register/options", {
    method: "POST",
    headers: { origin: "http://localhost:4310", "content-type": "application/json" },
    body,
  }), env as any);
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(await response.json()).toMatchObject({ code: "TOO_LARGE", retryable: false });
});

it("declared oversized JSON is rejected before reading its stream", async () => {
  let read = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { read = true; controller.close(); },
  }, { highWaterMark: 0 });
  const response = await app.fetch(new Request("http://localhost:8787/v1/auth/login/options", {
    method: "POST",
    headers: { origin: "http://localhost:4310", "content-type": "application/json", "content-length": String(3 * 1024 * 1024) },
    body,
  }), env as any);
  expect(response.status).toBe(413);
  expect(read).toBe(false);
});
