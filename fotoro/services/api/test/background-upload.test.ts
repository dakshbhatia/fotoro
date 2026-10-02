import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { seed, http } from "./helpers";
import { b64 } from "../src/errors";

async function reservation() {
  await seed();
  const bytes = new TextEncoder().encode("public test ciphertext, never a plaintext original");
  const input = {version:1,operationId:crypto.randomUUID(),binding:{version:1,photoId:crypto.randomUUID(),representationId:crypto.randomUUID(),kind:"original"},ciphertextBytes:bytes.length,ciphertextSha256:b64(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)))};
  const response = await http(0, "/v1/uploads/reserve", "POST", input);
  expect(response.status).toBe(200);
  const reserved = await response.json() as any;
  const url = new URL(reserved.stagingUrl);
  url.pathname = `/v1/background/uploads/${reserved.uploadId}/staging`;
  return {url,reserved,bytes};
}
const upload = (url: URL, bytes: Uint8Array, headers?: Record<string,string>) => app.fetch(new Request(url,{method:"PUT",headers,body:bytes}),env as any);

it("background capability writes exactly one encrypted staging object without account credentials or redirects", async () => {
  const {url,reserved,bytes} = await reservation();
  const wrong = new URL(url); wrong.searchParams.set("cap", "A".repeat(43));
  expect((await upload(wrong,bytes)).status).toBe(403);
  const other = new URL(url); other.pathname = `/v1/background/uploads/${crypto.randomUUID()}/staging`;
  expect((await upload(other,bytes)).status).toBe(403);
  const deniedOrigin = await upload(url, bytes, {origin:"https://untrusted.example"});
  expect(deniedOrigin.status).toBe(403);
  const result = await upload(url,bytes);
  expect(result.status).toBe(200);
  expect(result.headers.get("location")).toBeNull();
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await upload(url,bytes)).status).toBe(403);
  expect((await app.fetch(new Request(url), env as any)).status).toBe(401);
  expect((await app.fetch(new Request(`http://localhost:8787/v1/uploads/${reserved.uploadId}/commit`,{method:"POST",headers:{origin:"http://localhost:4310"}}),env as any)).status).toBe(401);
  expect((await http(0,`/v1/uploads/${reserved.uploadId}/commit`,"POST")).status).toBe(200);
});

it("expired/renewed capabilities and length mismatch cannot upload or bypass commit digest checks", async () => {
  const {url,reserved,bytes} = await reservation();
  expect((await upload(url,bytes,{"content-length":String(bytes.length+1)})).status).toBe(422);
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(reserved.uploadId).run();
  expect((await upload(url,bytes)).status).toBe(403);
  await env.DB.prepare("UPDATE uploads SET expires=? WHERE id=?").bind(Date.now()+10000,reserved.uploadId).run();
  const changed = bytes.slice(); changed[0] ^= 1;
  expect((await upload(url,changed)).status).toBe(200);
  const committed = await http(0,`/v1/uploads/${reserved.uploadId}/commit`,"POST");
  expect(committed.status).toBe(422);
  expect(await env.DB.prepare("SELECT 1 FROM objects WHERE upload_id=?").bind(reserved.uploadId).first()).toBeNull();
});
