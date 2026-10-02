import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { verifySigned } from "../src/errors";
import vectors from "../../../fixtures/crypto-v1.json";
import cards from "../../../fixtures/accounts.json";
it("verifies the frozen libsodium Ed25519 tuple in workerd", async () => {
  await expect(
    verifySigned(
      vectors.signed,
      cards.accounts[0].signingPublicKey,
      "vector",
      vectors.signed.accountId,
    ),
  ).resolves.toEqual(
    new TextEncoder().encode("Fotoro public vector\nOriginal bytes preserved."),
  );
});
it("rejects fixture headers independently of production config", async () => {
  const response = await app.fetch(
    new Request("https://fotoro.cloud/v1/vault", {
      headers: { "x-fotoro-fixture-account": crypto.randomUUID() },
    }),
    { ...env, AUTH_MODE: "production" } as any,
  );
  expect(response.status).toBe(401);
});
it("rejects unapproved auth origins and cannot mistake arbitrary response for WebAuthn", async () => {
  const r = await app.fetch(
    new Request("http://localhost/v1/auth/register/options", {
      method: "POST",
      headers: {
        origin: "https://evil.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, client: "web" }),
    }),
    env as any,
  );
  expect(r.status).toBe(403);
});

import { seed, signed, actors, http } from "./helpers";
import { enroll, approve, complete } from "../src/devices";
import { unb64, b64 } from "../src/errors";
it("recovery session proves signing key once, binds origin/client and expires at server boundary", async () => {
  await seed();
  const request = (path: string, body: any, origin = "http://localhost:4310") =>
    app.fetch(
      new Request("http://localhost:8787/v1/auth/recovery/" + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env as any,
    );
  const opts = (await (
    await request("options", {
      version: 1,
      accountId: actors[0].accountId,
      client: "native",
    })
  ).json()) as any;
  const body = {
    version: 1,
    challengeId: opts.challengeId,
    challenge: opts.challenge,
    accountId: actors[0].accountId,
    client: "native",
    origin: "http://localhost:4310",
  };
  const proof = await signed(0, "recovery-session", body);
  expect(
    (
      await request("verify", {
        version: 1,
        challengeId: opts.challengeId,
        client: "web",
        signedPayload: proof,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("verify", {
        version: 1,
        challengeId: opts.challengeId,
        client: "native",
        signedPayload: await signed(1, "recovery-session", body),
      })
    ).status,
  ).toBe(403);
  const result = await request("verify", {
    version: 1,
    challengeId: opts.challengeId,
    client: "native",
    signedPayload: proof,
  });
  expect(result.status).toBe(200);
  expect(((await result.json()) as any).token).toBeTypeOf("string");
  expect(
    (
      await request("verify", {
        version: 1,
        challengeId: opts.challengeId,
        client: "native",
        signedPayload: proof,
      })
    ).status,
  ).toBe(403);
  const expired = (await (
    await request("options", {
      version: 1,
      accountId: actors[0].accountId,
      client: "native",
    })
  ).json()) as any;
  await env.DB.prepare("UPDATE auth_challenges SET expires=? WHERE id=?")
    .bind(Date.now(), expired.challengeId)
    .run();
  expect(
    (
      await request("verify", {
        version: 1,
        challengeId: expired.challengeId,
        client: "native",
        signedPayload: await signed(0, "recovery-session", {
          ...body,
          challengeId: expired.challengeId,
          challenge: expired.challenge,
        }),
      })
    ).status,
  ).toBe(403);
});
it("device approval rejects binding swaps, completion replay and expiry", async () => {
  await seed();
  const r = new Request("http://localhost:8787", {
      headers: { origin: "http://localhost:4310" },
    }),
    challenge = await enroll(env as any, actors[0], r, {
      version: 1,
      deviceId: actors[0].deviceId,
      boxPublicKey: cards.accounts[0].boxPublicKey,
      origin: "http://localhost:4310",
    }),
    sealed = b64(new Uint8Array(128));
  await expect(
    approve(env as any, actors[0], r, challenge.enrollmentId, {
      version: 1,
      sealedBundle: sealed,
      signedPayload: await signed(0, "device-approval", {
        challenge: { ...challenge, deviceId: crypto.randomUUID() },
        sealedBundle: sealed,
      }),
    }),
  ).rejects.toThrow("BODY_MISMATCH");
  await approve(env as any, actors[0], r, challenge.enrollmentId, {
    version: 1,
    sealedBundle: sealed,
    signedPayload: await signed(0, "device-approval", {
      challenge,
      sealedBundle: sealed,
    }),
  });
  const done = await complete(
    env as any,
    actors[0],
    r,
    challenge.enrollmentId,
    { version: 1, challenge: challenge.challenge },
  );
  expect(done.challenge.state).toBe("completed");
  await expect(
    complete(env as any, actors[0], r, challenge.enrollmentId, {
      version: 1,
      challenge: challenge.challenge,
    }),
  ).rejects.toThrow("FORBIDDEN");
  const exp = await enroll(env as any, actors[0], r, {
    version: 1,
    deviceId: crypto.randomUUID(),
    boxPublicKey: cards.accounts[0].boxPublicKey,
    origin: "http://localhost:4310",
  });
  await env.DB.prepare("UPDATE enrollments SET expires=? WHERE id=?")
    .bind(Date.now(), exp.enrollmentId)
    .run();
  await expect(
    approve(env as any, actors[0], r, exp.enrollmentId, {
      version: 1,
      sealedBundle: sealed,
      signedPayload: await signed(0, "device-approval", {
        challenge: exp,
        sealedBundle: sealed,
      }),
    }),
  ).rejects.toThrow("FORBIDDEN");
});
it("last credential removal needs verified recovery and immutable identity rejects replacement signatures", async () => {
  await seed();
  const id = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO credentials VALUES(?,?,?,?,?)")
    .bind(id, actors[1].accountId, "key", 0, "[]")
    .run();
  expect((await http(1, "/v1/credentials/" + id, "DELETE")).status).toBe(403);
  const bad = await signed(0, "photo-manifest", { version: 1 });
  bad.accountId = actors[1].accountId;
  expect((await http(1, "/v1/photos", "POST", bad)).status).toBe(403);
});
it("logout invalidates the current session and expires the secure cookie", async () => {
  await seed();
  const token = "public-logout-token",
    hash = b64(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    );
  await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(hash, actors[0].accountId, actors[0].deviceId, Date.now() + 60000)
    .run();
  const request = (
    path: string,
    method: string,
    origin = "http://localhost:4310",
  ) =>
    app.fetch(
      new Request("http://localhost:8787" + path, {
        method,
        headers: { origin, authorization: "Bearer " + token },
      }),
      env as any,
    );
  expect(
    (await request("/v1/auth/logout", "POST", "https://evil.invalid")).status,
  ).toBe(403);
  const response = await request("/v1/auth/logout", "POST");
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await request("/v1/vault", "GET")).status).toBe(401);
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE token_hash=?",
      )
        .bind(hash)
        .first<any>()
    ).n,
  ).toBe(0);
});
it("serves built static assets on one origin but never fixture or API fallback", async () => {
  const e = {
    ...env,
    AUTH_MODE: "production",
    ASSETS: {
      fetch: async () =>
        new Response("<html>Fotoro</html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
  } as any;
  expect(
    await (
      await app.fetch(new Request("https://fotoro.cloud/photos"), e)
    ).text(),
  ).toContain("<html>");
  expect(
    (
      await app.fetch(
        new Request("https://fotoro.cloud/__fixtures/accounts"),
        e,
      )
    ).status,
  ).toBe(404);
  expect(
    (await app.fetch(new Request("https://fotoro.cloud/v1/missing"), e)).status,
  ).toBe(401);
});
