import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { reserveUpload, putStaging, commitUpload } from "../src/storage";
import { b64 } from "../src/errors";
const actor = {
  accountId: "00000000-0000-4000-8000-000000000001",
  deviceId: "00000000-0000-4000-8000-000000000002",
};
describe("private upload", () => {
  it("promotes verified bytes once, denies unrelated actor and ignores staging replay", async () => {
    const bytes = new TextEncoder().encode("private ciphertext");
    const input = {
      version: 1 as const,
      binding: {
        version: 1 as const,
        photoId: crypto.randomUUID(),
        representationId: crypto.randomUUID(),
        kind: "original" as const,
      },
      operationId: crypto.randomUUID(),
      ciphertextBytes: bytes.length,
      ciphertextSha256: b64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ),
    };
    const r = await reserveUpload(
      env as any,
      actor,
      input,
      "http://localhost:8787",
    );
    await expect(
      commitUpload(
        env as any,
        { ...actor, accountId: crypto.randomUUID() },
        r.uploadId,
      ),
    ).rejects.toThrow("FORBIDDEN");
    await putStaging(
      env as any,
      actor,
      r.uploadId,
      new URL(r.stagingUrl).searchParams.get("cap")!,
      new Request(r.stagingUrl, { method: "PUT", body: bytes }),
    );
    const committed = await commitUpload(env as any, actor, r.uploadId);
    expect(await commitUpload(env as any, actor, r.uploadId)).toEqual(
      committed,
    );
    await expect(
      putStaging(
        env as any,
        actor,
        r.uploadId,
        new URL(r.stagingUrl).searchParams.get("cap")!,
        new Request(r.stagingUrl, { method: "PUT", body: bytes }),
      ),
    ).rejects.toThrow();
    expect(
      await (await env.BUCKET.get("final/" + committed.objectId))!.text(),
    ).toBe("private ciphertext");
  });
});

import { reconcileUpload, cleanupUpload } from "../src/storage";
import { json } from "../src/errors";
it("reconciles before/after R2 promotion and ambiguous D1 completion without overwrites", async () => {
  const bytes = new TextEncoder().encode("crash-safe-ciphertext"),
    i = {
      version: 1 as const,
      binding: {
        version: 1 as const,
        photoId: crypto.randomUUID(),
        representationId: crypto.randomUUID(),
        kind: "original" as const,
      },
      operationId: crypto.randomUUID(),
      ciphertextBytes: bytes.length,
      ciphertextSha256: b64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ),
    };
  const r = await reserveUpload(env as any, actor, i, "http://localhost");
  expect(await reconcileUpload(env as any, r.uploadId)).toBeNull();
  await putStaging(
    env as any,
    actor,
    r.uploadId,
    new URL(r.stagingUrl).searchParams.get("cap")!,
    new Request(r.stagingUrl, { method: "PUT", body: bytes }),
  );
  const row = await env.DB.prepare("SELECT object_id FROM uploads WHERE id=?")
    .bind(r.uploadId)
    .first<any>();
  await env.BUCKET.put("final/" + row.object_id, bytes, {
    customMetadata: {
      uploadId: r.uploadId,
      digest: i.ciphertextSha256,
      binding: json(i.binding),
    },
  });
  const c = await reconcileUpload(env as any, r.uploadId);
  expect(c?.objectId).toBe(row.object_id);
  await env.BUCKET.put(
    "staging/" +
      r.uploadId +
      "/" +
      new URL(r.stagingUrl).searchParams.get("cap"),
    new TextEncoder().encode("replayed different bytes"),
  );
  expect(await commitUpload(env as any, actor, r.uploadId)).toEqual(c);
  expect(await (await env.BUCKET.get("final/" + row.object_id))!.text()).toBe(
    "crash-safe-ciphertext",
  );
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?")
    .bind(r.uploadId)
    .run();
  expect(await cleanupUpload(env as any, r.uploadId)).toBe(true);
  expect(await (await env.BUCKET.get("final/" + row.object_id))!.text()).toBe(
    "crash-safe-ciphertext",
  );
  expect(await reserveUpload(env as any, actor, i, "http://localhost")).toEqual(
    { ...r, expiresAt: new Date(0).toISOString() },
  );
  await expect(
    reserveUpload(
      env as any,
      actor,
      { ...i, ciphertextBytes: i.ciphertextBytes + 1 },
      "http://localhost",
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
});
it("rejects staging replacement between upload and promotion", async () => {
  const bytes = new TextEncoder().encode("verified bytes"),
    i = {
      version: 1 as const,
      binding: {
        version: 1 as const,
        photoId: crypto.randomUUID(),
        representationId: crypto.randomUUID(),
        kind: "original" as const,
      },
      operationId: crypto.randomUUID(),
      ciphertextBytes: bytes.length,
      ciphertextSha256: b64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      ),
    };
  const r = await reserveUpload(env as any, actor, i, "http://localhost");
  await putStaging(
    env as any,
    actor,
    r.uploadId,
    new URL(r.stagingUrl).searchParams.get("cap")!,
    new Request(r.stagingUrl, { method: "PUT", body: bytes }),
  );
  await env.BUCKET.put(
    "staging/" +
      r.uploadId +
      "/" +
      new URL(r.stagingUrl).searchParams.get("cap"),
    new TextEncoder().encode("wrong bytes"),
  );
  await expect(commitUpload(env as any, actor, r.uploadId)).rejects.toThrow(
    "UPLOAD_INCOMPLETE",
  );
});
