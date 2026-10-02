import { expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { b64 } from "../src/errors";
import { actors, http, seed } from "./helpers";

async function reservation() {
  await seed();
  const bytes = new TextEncoder().encode("private test ciphertext");
  const input = {
    version: 1,
    operationId: crypto.randomUUID(),
    binding: { version: 1, photoId: crypto.randomUUID(), representationId: crypto.randomUUID(), kind: "original" },
    ciphertextBytes: bytes.length,
    ciphertextSha256: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))),
  };
  const reserved = await (await http(0, "/v1/uploads/reserve", "POST", input)).json() as any;
  const url = new URL(reserved.stagingUrl);
  url.pathname = `/v1/background/uploads/${reserved.uploadId}/staging`;
  return { bytes, reserved, url };
}

async function stillReserved(id: string) {
  const row = await env.DB.prepare("SELECT state FROM uploads WHERE id=?").bind(id).first<{ state: string }>();
  expect(row?.state).toBe("reserved");
  expect(await env.DB.prepare("SELECT 1 FROM objects WHERE upload_id=?").bind(id).first()).toBeNull();
}

it.each([
  { name: "short", delta: -1, status: 422, code: "DIGEST_MISMATCH" },
  { name: "oversized", delta: 1, status: 413, code: "TOO_LARGE" },
])("$name streamed ciphertext fails with a truthful size error and leaves the reservation retryable", async ({ delta, status, code }) => {
  const { bytes, reserved, url } = await reservation();
  const changed = new Uint8Array(bytes.length + delta);
  changed.set(bytes.subarray(0, changed.length));
  const response = await app.fetch(new Request(url, { method: "PUT", body: changed }), env as any);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code, retryable: false });
  await stillReserved(reserved.uploadId);
  expect((await app.fetch(new Request(url, { method: "PUT", body: bytes }), env as any)).status).toBe(200);
  expect((await http(0, `/v1/uploads/${reserved.uploadId}/commit`, "POST")).status).toBe(200);
});

it("an interrupted request body is retryable without being mislabeled as a size or storage error", async () => {
  const { bytes, reserved, url } = await reservation();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(new DOMException("PRIVATE_CLIENT_ABORT", "AbortError"));
      else { sent = true; controller.enqueue(bytes.subarray(0, 3)); }
    },
  }, { highWaterMark: 0 });
  const response = await app.fetch(new Request(url, { method: "PUT", body }), env as any);
  expect(response.status).toBe(408);
  expect(await response.json()).toMatchObject({ code: "UPLOAD_INCOMPLETE", retryable: true });
  await stillReserved(reserved.uploadId);
  expect((await app.fetch(new Request(url, { method: "PUT", body: bytes }), env as any)).status).toBe(200);
});

it.each(["rejection", "throw"])("an early storage write %s cancels its body and emits only bounded support diagnostics", async mode => {
  const { bytes, reserved, url } = await reservation();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(bytes); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const emitted = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await app.fetch(new Request(url, { method: "PUT", body }), {
      ...env,
      BUCKET: { put: () => {
        const error = new Error("PRIVATE_STORAGE_FAILURE PRIVATE_CAPABILITY");
        if (mode === "throw") throw error;
        return Promise.reject(error);
      } },
    } as any);
    expect(response.status).toBe(500);
    const error = await response.json() as any;
    expect(error).toMatchObject({ code: "INTERNAL_ERROR", retryable: true });
    expect(cancelled).toBe(true);
    await stillReserved(reserved.uploadId);
    const records = emitted.mock.calls.map(call => JSON.parse(String(call[0])));
    expect(records).toEqual([{
      event: "api.error", requestId: error.requestId, method: "PUT", status: 500, code: "INTERNAL_ERROR",
      phase: "upload.staging", errorClass: "storage",
    }]);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|cap=|staging\/|authorization/);
    expect(JSON.stringify(records)).not.toContain(actors[0].accountId);
    expect(JSON.stringify(records)).not.toContain(reserved.uploadId);
    expect((await app.fetch(new Request(url, { method: "PUT", body: bytes }), env as any)).status).toBe(200);
  } finally {
    emitted.mockRestore();
  }
});

it("storage failure while promoting leaves verified uploaded bytes available for an exact commit retry", async () => {
  const { bytes, reserved, url } = await reservation();
  expect((await app.fetch(new Request(url, { method: "PUT", body: bytes }), env as any)).status).toBe(200);
  const emitted = vi.spyOn(console, "error").mockImplementation(() => {});
  const bucket = new Proxy(env.BUCKET, {
    get(target, key) {
      if (key === "put") return async () => { throw new Error("PRIVATE_PROMOTION_FAILURE"); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const response = await app.fetch(new Request(`http://localhost:8787/v1/uploads/${reserved.uploadId}/commit`, {
      method: "POST", headers: { authorization: "Bearer public-test-0", origin: "http://localhost:4310" },
    }), { ...env, BUCKET: bucket } as any);
    expect(response.status).toBe(500);
    const error = await response.json() as any;
    expect(error).toMatchObject({ code: "INTERNAL_ERROR", retryable: true });
    const row = await env.DB.prepare("SELECT state FROM uploads WHERE id=?").bind(reserved.uploadId).first<{ state: string }>();
    expect(row?.state).toBe("uploaded");
    expect(emitted.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([{
      event: "api.error", requestId: error.requestId, method: "POST", status: 500, code: "INTERNAL_ERROR",
      phase: "upload.commit", errorClass: "storage",
    }]);
    expect((await http(0, `/v1/uploads/${reserved.uploadId}/commit`, "POST")).status).toBe(200);
  } finally {
    emitted.mockRestore();
  }
});
