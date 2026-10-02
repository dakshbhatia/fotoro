import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import { validateWire } from "@fotoro/contracts/validate";
import app from "../src/index";
import { b64, unb64, utf8, json } from "../src/errors";
import cards from "../../../fixtures/accounts.json";

const origin = "http://localhost:4310";
const request = (path: string, body: unknown, requestOrigin = origin) => app.fetch(
  new Request("http://localhost:8787/v1/auth/" + path, {
    method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env as any);
async function options(client = "native") {
  const response = await request("start/options", { version: 1, client });
  expect(response.status).toBe(200);
  const value = await response.json() as any;
  validateWire("StartOptionsV1", value);
  return value;
}
async function sign(accountId: string, kind: string, body: unknown, signer = 0) {
  const der = new Uint8Array(48);
  der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);
  der.set(unb64(cards.testSecrets[signer].signingSecretKey).slice(0, 32), 16);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const value = { version: 1, kind, accountId, body: b64(utf8(body)), signature: "" };
  value.signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key,
    utf8(["fotoro-signed-v1", kind, accountId, value.body]))));
  return value;
}
const challengeBody = (opts: any, client = "native") => ({ version: 1,
  accountId: opts.accountId, challengeId: opts.challengeId, challenge: opts.challenge,
  client, origin });
async function enrollment(opts: any, client = "native") {
  const card = { ...cards.accounts[0], accountId: opts.accountId };
  const wrapper = { version: 1, wrapperId: crypto.randomUUID(), kind: "recovery",
    credentialId: null, prfSalt: null, verified: true, wrappedBundle: { ...cards.testSecrets[0].encryptedBundle } };
  return { version: 1, challengeId: opts.challengeId, client,
    enrollment: { version: 1, accountCard: card, recoveryWrapper: wrapper,
      proof: await sign(opts.accountId, "account-enrollment", { accountCard: card, recoveryWrapper: wrapper }) },
    signedPayload: await sign(opts.accountId, "start-enrollment", challengeBody(opts, client)) };
}
async function count(table: string, accountId: string) {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`)
    .bind(accountId).first<any>()).n;
}

it("creates a nonce-bound code-only account and signs in again through existing recovery", async () => {
  const opts = await options();
  expect(unb64(opts.challenge).length).toBe(32);
  expect(Date.parse(opts.expiresAt) - Date.now()).toBeGreaterThan(290_000);
  expect(opts.options).toBeUndefined();
  expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(opts.accountId).first()).toBeNull();
  const input = await enrollment(opts);
  const created = await request("start/verify", input);
  expect(created.status).toBe(200);
  const session = await created.json() as any;
  validateWire("SessionV1", session);
  expect(session.accountId).toBe(opts.accountId);
  expect(session.token).toBeTypeOf("string");
  expect(await count("credentials", opts.accountId)).toBe(0);
  expect(await count("wrappers", opts.accountId)).toBe(1);
  const catalog = await app.fetch(new Request("http://localhost:8787/v1/vault", {
    headers: { authorization: "Bearer " + session.token, origin },
  }), env as any);
  expect(catalog.status).toBe(200);
  const vault = await catalog.json() as any;
  expect(vault.accountCard).toEqual(input.enrollment.accountCard);
  expect(vault.wrappers).toEqual([input.enrollment.recoveryWrapper]);
  const recovery = await request("recovery/options", { version: 1, accountId: opts.accountId, client: "native" });
  expect(recovery.status).toBe(200);
  const recovering = await recovery.json() as any;
  const proof = await sign(opts.accountId, "recovery-session", challengeBody({ ...recovering, accountId: opts.accountId }));
  const restored = await request("recovery/verify", { version: 1, challengeId: recovering.challengeId,
    client: "native", signedPayload: proof });
  expect(restored.status).toBe(200);
  expect((await restored.json() as any).accountId).toBe(opts.accountId);
});

it("code enrollment issues the existing secure web cookie without a bearer response", async () => {
  const opts = await options("web");
  const response = await request("start/verify", await enrollment(opts, "web"));
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
  expect((await response.json() as any).token).toBeUndefined();
});

it("refuses caller-chosen identities, raw passwords and unapproved origins before creating challenges", async () => {
  for (const extra of [{ accountId: cards.accounts[0].accountId }, { password: "PRIVATE_START_PASSWORD" }]) {
    expect((await request("start/options", { version: 1, client: "native", ...extra })).status).toBe(400);
  }
  expect((await request("start/options", { version: 1, client: "native" }, "https://evil.invalid")).status).toBe(403);
  const opts = await options();
  const input = await enrollment(opts);
  expect((await request("start/verify", { ...input, password: "PRIVATE_START_PASSWORD" })).status).toBe(400);
  expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(opts.accountId).first()).toBeNull();
});

it("binds enrollment keys and encrypted wrapper, rejecting tampering without partial accounts", async () => {
  for (const mutation of ["card", "wrapper", "signature", "unverified", "credential", "prfSalt"]) {
    const opts = await options();
    const input: any = await enrollment(opts);
    if (mutation === "card") input.enrollment.accountCard.accountId = crypto.randomUUID();
    if (mutation === "wrapper") input.enrollment.recoveryWrapper.wrappedBundle.nonce = b64(new Uint8Array(24));
    if (mutation === "signature") input.enrollment.proof.signature = b64(new Uint8Array(64));
    if (mutation === "unverified") input.enrollment.recoveryWrapper.verified = false;
    if (mutation === "credential") input.enrollment.recoveryWrapper.credentialId = b64(new Uint8Array(32));
    if (mutation === "prfSalt") input.enrollment.recoveryWrapper.prfSalt = b64(new Uint8Array(32));
    expect([400, 403]).toContain((await request("start/verify", input)).status);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(opts.accountId).first()).toBeNull();
    expect(await count("wrappers", opts.accountId)).toBe(0);
    expect(await count("sessions", opts.accountId)).toBe(0);
  }
});

it("binds challenge proof to nonce, origin, client and protocol and leaves rejected challenges reusable", async () => {
  for (const mutation of ["nonce", "origin", "client", "protocol", "requestOrigin", "requestClient", "signer"]) {
    const opts = await options();
    const input: any = await enrollment(opts);
    const body = challengeBody(opts);
    if (mutation === "nonce") body.challenge = b64(new Uint8Array(32));
    if (mutation === "origin") body.origin = "http://127.0.0.1:4310";
    if (mutation === "client") body.client = "web";
    input.signedPayload = await sign(opts.accountId, mutation === "protocol" ? "recovery-session" : "start-enrollment",
      body, mutation === "signer" ? 1 : 0);
    if (mutation === "requestClient") input.client = "web";
    const response = await request("start/verify", input, mutation === "requestOrigin" ? "http://127.0.0.1:4310" : origin);
    expect([400, 403]).toContain(response.status);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(opts.accountId).first()).toBeNull();
    expect((await env.DB.prepare("SELECT consumed FROM auth_challenges WHERE id=?").bind(opts.challengeId).first<any>()).consumed).toBe(0);
    expect((await request("start/verify", await enrollment(opts))).status).toBe(200);
  }
});

it("rejects expired and replayed enrollment, including simultaneous verification", async () => {
  const expired = await options();
  await env.DB.prepare("UPDATE auth_challenges SET expires=? WHERE id=?").bind(Date.now(), expired.challengeId).run();
  expect((await request("start/verify", await enrollment(expired))).status).toBe(403);
  const opts = await options(), input = await enrollment(opts);
  const concurrent = await Promise.all([request("start/verify", input), request("start/verify", input)]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([200, 403]);
  expect(await count("wrappers", opts.accountId)).toBe(1);
  expect(await count("sessions", opts.accountId)).toBe(1);
  expect(await count("devices", opts.accountId)).toBe(1);
  expect((await request("start/verify", input)).status).toBe(403);
  expect((await request("recovery/verify", { version: 1, client: "native", challengeId: opts.challengeId,
    signedPayload: input.signedPayload })).status).toBe(403);
});

it("never replaces an existing account identity or wrapper on an enrollment conflict", async () => {
  const opts = await options(), input = await enrollment(opts);
  const original = { ...cards.accounts[1], accountId: opts.accountId };
  await env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(opts.accountId, json(original)).run();
  expect((await request("start/verify", input)).status).toBe(403);
  expect(JSON.parse((await env.DB.prepare("SELECT card FROM accounts WHERE id=?").bind(opts.accountId).first<any>()).card)).toEqual(original);
  expect(await count("wrappers", opts.accountId)).toBe(0);
  expect(await count("sessions", opts.accountId)).toBe(0);
  const collision = await options(), colliding = await enrollment(collision);
  const wrapper = colliding.enrollment.recoveryWrapper;
  await env.DB.prepare("INSERT INTO wrappers VALUES(?,?,?)").bind(wrapper.wrapperId, original.accountId, json(wrapper)).run();
  expect((await request("start/verify", colliding)).status).toBe(403);
  expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(collision.accountId).first()).toBeNull();
  expect((await env.DB.prepare("SELECT account_id FROM wrappers WHERE id=?").bind(wrapper.wrapperId).first<any>()).account_id).toBe(original.accountId);
  expect((await env.DB.prepare("SELECT consumed FROM auth_challenges WHERE id=?").bind(collision.challengeId).first<any>()).consumed).toBe(0);
});

it("preserves the committed code account if session issuance fails, allowing the same code to sign in", async () => {
  const opts = await options(), input = await enrollment(opts);
  let batches = 0;
  const failing = { ...env, DB: {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => {
      batches++;
      if (batches === 2) throw new Error("Controlled session issuance failure");
      return env.DB.batch(statements);
    },
  } };
  const failed = await app.fetch(new Request("http://localhost:8787/v1/auth/start/verify", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(input),
  }), failing as any);
  expect(failed.status).toBe(500);
  expect((await failed.json() as any).code).toBe("INTERNAL_ERROR");
  expect(await count("wrappers", opts.accountId)).toBe(1);
  expect(await count("sessions", opts.accountId)).toBe(0);
  expect((await env.DB.prepare("SELECT consumed FROM auth_challenges WHERE id=?").bind(opts.challengeId).first<any>()).consumed).toBe(1);
  const restoring = await request("recovery/options", { version: 1, accountId: opts.accountId, client: "native" });
  expect(restoring.status).toBe(200);
  const recovery = await restoring.json() as any;
  const proof = await sign(opts.accountId, "recovery-session", challengeBody({ ...recovery, accountId: opts.accountId }));
  const signedIn = await request("recovery/verify", { version: 1, challengeId: recovery.challengeId, client: "native", signedPayload: proof });
  expect(signedIn.status).toBe(200);
  expect((await signedIn.json() as any).accountId).toBe(opts.accountId);
});
