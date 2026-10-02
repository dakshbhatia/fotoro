import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { actors, seed, http, photo, signed, share } from "./helpers";
import { b64 } from "../src/errors";
import cards from "../../../fixtures/accounts.json";
import {
  reserveUpload,
  putStaging,
  commitUpload,
  cleanupUpload,
} from "../src/storage";

async function grant() {
  await seed();
  const source = await photo(0);
  const moment = crypto.randomUUID();
  const g = (await (
    await http(0, `/v1/moments/${moment}/grants/options`, "POST", {
      version: 1,
      recipientAccountId: actors[1].accountId,
      role: "contributor",
      access: "temporary",
    })
  ).json()) as any;
  const envelopes = [await share(0, g, source.m.photoId)];
  expect(
    (
      await http(0, `/v1/moments/${moment}/grants`, "POST", {
        version: 1,
        grant: g,
        envelopes,
        signedPayload: await signed(0, "grant", { grant: g, envelopes }),
      })
    ).status,
  ).toBe(200);
  return { g, source, moment };
}

it("session-only wrapper PUT cannot overwrite verified recovery, verified device or unverified recovery rows", async () => {
  await seed();
  for (const [kind, verified] of [
    ["recovery", true],
    ["device", true],
    ["recovery", false],
  ] as const) {
    const wrapper = {
      version: 1,
      wrapperId: crypto.randomUUID(),
      kind,
      verified,
      credentialId: null,
      prfSalt: null,
      wrappedBundle: cards.testSecrets[0].encryptedBundle,
    };
    await env.DB.prepare("INSERT INTO wrappers VALUES(?,?,?)")
      .bind(wrapper.wrapperId, actors[0].accountId, JSON.stringify(wrapper))
      .run();
    const replacement = {
      ...wrapper,
      kind: "device",
      verified: false,
      wrappedBundle: cards.testSecrets[1].encryptedBundle,
    };
    expect(
      (
        await http(
          0,
          "/v1/vault/wrappers/" + wrapper.wrapperId,
          "PUT",
          replacement,
        )
      ).status,
    ).toBe(403);
    const row = await env.DB.prepare("SELECT json FROM wrappers WHERE id=?")
      .bind(wrapper.wrapperId)
      .first<any>();
    expect(JSON.parse(row.json)).toEqual(wrapper);
  }
});

for (const transition of ["revoke", "expire"]) {
  it(`exact committed contribution retry reconciles after ${transition}, changed or fresh requests cannot write`, async () => {
    const { g, moment } = await grant();
    const content = await photo(1);
    const input = {
      version: 1,
      operationId: crypto.randomUUID(),
      expectedGrantVersion: 1,
      manifests: [content.s],
      envelopes: [await share(1, g, content.m.photoId)],
    };
    const path = `/v1/moments/${moment}/contributions`;
    const first = await http(1, path, "POST", input);
    expect(first.status).toBe(200);
    const result = await first.json();
    if (transition === "revoke")
      expect((await http(0, "/v1/grants/" + g.grantId, "DELETE")).status).toBe(
        200,
      );
    else
      await env.DB.prepare("UPDATE grants SET expires=? WHERE id=?")
        .bind(Date.now(), g.grantId)
        .run();
    const retry = await http(1, path, "POST", input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect(
      (await http(1, path, "POST", { ...input, expectedGrantVersion: 2 }))
        .status,
    ).toBe(409);
    expect(
      (
        await http(1, path, "POST", {
          ...input,
          operationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM contributions WHERE account_id=? AND operation_id=?",
        )
          .bind(actors[1].accountId, input.operationId)
          .first<any>()
      ).n,
    ).toBe(1);
  });
}

it("a saved retained photo can contribute unchanged source AAD, but cannot clone ownership onto a new photo or alter object evidence", async () => {
  const { g, moment, source } = await grant();
  const id = crypto.randomUUID();
  const manifest = {
    ...source.m,
    photoId: id,
    ownerAccountId: actors[1].accountId,
  };
  const proof = await signed(1, "photo-manifest", manifest);
  expect(
    (
      await http(1, "/v1/saves", "POST", {
        version: 1,
        expectedGrantVersion: 1,
        save: {
          version: 1,
          operationId: crypto.randomUUID(),
          photoId: id,
          sourceGrantId: g.grantId,
          sourcePhotoId: source.m.photoId,
          manifest,
          signedPayload: proof,
        },
      })
    ).status,
  ).toBe(200);
  const input = {
    version: 1,
    operationId: crypto.randomUUID(),
    expectedGrantVersion: 1,
    manifests: [proof],
    envelopes: [await share(1, g, id)],
  };
  expect(
    (await http(1, `/v1/moments/${moment}/contributions`, "POST", input))
      .status,
  ).toBe(200);
  const unrelatedId = crypto.randomUUID();
  const clone = { ...manifest, photoId: unrelatedId };
  expect(
    (
      await http(1, `/v1/moments/${moment}/contributions`, "POST", {
        ...input,
        operationId: crypto.randomUUID(),
        manifests: [await signed(1, "photo-manifest", clone)],
        envelopes: [await share(1, g, unrelatedId)],
      })
    ).status,
  ).toBe(400);
  const modified = {
    ...manifest,
    representations: [
      {
        ...manifest.representations[0],
        ciphertextBytes: manifest.representations[0].ciphertextBytes + 1,
      },
    ],
  };
  expect(
    (
      await http(1, `/v1/moments/${moment}/contributions`, "POST", {
        ...input,
        operationId: crypto.randomUUID(),
        manifests: [await signed(1, "photo-manifest", modified)],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await http(
        1,
        "/v1/photos",
        "POST",
        await signed(1, "photo-manifest", clone),
      )
    ).status,
  ).toBe(400);
});

async function reservation() {
  const bytes = new TextEncoder().encode(
    "durable identical pending ciphertext",
  );
  const input = {
    version: 1 as const,
    operationId: crypto.randomUUID(),
    binding: {
      version: 1 as const,
      photoId: crypto.randomUUID(),
      representationId: crypto.randomUUID(),
      kind: "original" as const,
    },
    ciphertextBytes: bytes.length,
    ciphertextSha256: b64(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ),
  };
  const reserved = await reserveUpload(
    env as any,
    actors[0],
    input,
    "http://localhost:8787",
  );
  return { bytes, input, reserved };
}

it("a freshly authenticated device on the same account resumes unchanged reserve/PUT/commit while creator device remains audit-only", async () => {
  await seed();
  const { bytes, input, reserved } = await reservation();
  const deviceId = crypto.randomUUID(),
    token = "public-resumed-" + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO devices(id,account_id,trusted) VALUES(?,?,1)",
  )
    .bind(deviceId, actors[0].accountId)
    .run();
  const hash = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
  await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(hash, actors[0].accountId, deviceId, Date.now() + 60000)
    .run();
  const request = (url: string, method: string, body?: string | Uint8Array) =>
    app.fetch(
      new Request(url, {
        method,
        headers: {
          authorization: "Bearer " + token,
          origin: "http://localhost:4310",
          "content-type": "application/json",
        },
        body,
      }),
      env as any,
    );
  const retry = await request(
    "http://localhost:8787/v1/uploads/reserve",
    "POST",
    JSON.stringify(input),
  );
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(reserved);
  expect((await request(reserved.stagingUrl, "PUT", bytes)).status).toBe(200);
  const committed = await request(
    `http://localhost:8787/v1/uploads/${reserved.uploadId}/commit`,
    "POST",
  );
  expect(committed.status).toBe(200);
  const result = await committed.json();
  expect(
    await (
      await request(
        `http://localhost:8787/v1/uploads/${reserved.uploadId}/commit`,
        "POST",
      )
    ).json(),
  ).toEqual(result);
  expect(
    (
      await env.DB.prepare("SELECT device_id FROM uploads WHERE id=?")
        .bind(reserved.uploadId)
        .first<any>()
    ).device_id,
  ).toBe(actors[0].deviceId);
  await expect(
    commitUpload(env as any, actors[1], reserved.uploadId),
  ).rejects.toThrow("FORBIDDEN");
});

it("expired reserved upload renews exact operation with a new capability; old capability fails and uploaded/committed identities stay immutable", async () => {
  const { bytes, input, reserved } = await reservation();
  const oldCap = new URL(reserved.stagingUrl).searchParams.get("cap")!;
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?")
    .bind(reserved.uploadId)
    .run();
  const renewed = await reserveUpload(
    env as any,
    actors[0],
    input,
    "http://localhost:8787",
  );
  expect(renewed.uploadId).toBe(reserved.uploadId);
  expect(renewed.stagingUrl).not.toBe(reserved.stagingUrl);
  expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
  await expect(
    putStaging(
      env as any,
      actors[0],
      renewed.uploadId,
      oldCap,
      new Request(reserved.stagingUrl, { method: "PUT", body: bytes }),
    ),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    reserveUpload(
      env as any,
      actors[0],
      { ...input, ciphertextBytes: input.ciphertextBytes + 1 },
      "http://localhost",
    ),
  ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  const cap = new URL(renewed.stagingUrl).searchParams.get("cap")!;
  await putStaging(
    env as any,
    actors[0],
    renewed.uploadId,
    cap,
    new Request(renewed.stagingUrl, { method: "PUT", body: bytes }),
  );
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?")
    .bind(renewed.uploadId)
    .run();
  const uploaded = await reserveUpload(
    env as any,
    actors[0],
    input,
    "http://localhost:8787",
  );
  expect(uploaded.stagingUrl).toBe(renewed.stagingUrl);
  expect(uploaded.expiresAt).toBe(new Date(0).toISOString());
  // Simulate an old capability PUT finishing after the renewed upload.
  await env.BUCKET.put(
    `staging/${renewed.uploadId}/${oldCap}`,
    new TextEncoder().encode("stale old-cap ciphertext"),
  );
  expect(await cleanupUpload(env as any, renewed.uploadId)).toBe(false);
  const committed = await commitUpload(env as any, actors[0], renewed.uploadId);
  expect(
    await (await env.BUCKET.get("final/" + committed.objectId))!.text(),
  ).toBe(new TextDecoder().decode(bytes));
  expect(
    await commitUpload(
      env as any,
      { ...actors[0], deviceId: crypto.randomUUID() },
      renewed.uploadId,
    ),
  ).toEqual(committed);
  expect(
    await reserveUpload(env as any, actors[0], input, "http://localhost:8787"),
  ).toEqual(uploaded);
});
