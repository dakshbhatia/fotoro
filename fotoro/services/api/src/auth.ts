import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { validateWire } from "@fotoro/contracts/validate";
import {
  type Env,
  type Actor,
  fail,
  json,
  b64,
  unb64,
  verifySigned,
  batchGuard,
} from "./errors";
async function ceremony<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch {
    return fail("FORBIDDEN", 403);
  }
}
export const config = (env: Env) =>
  env.AUTH_MODE === "production"
    ? { rpID: "fotoro.cloud", origins: ["https://fotoro.cloud"] }
    : {
        rpID: "localhost",
        origins: ["http://localhost:4310", "http://127.0.0.1:4310"],
      };
export function origin(env: Env, r: Request) {
  const value = r.headers.get("origin") || "";
  if (!config(env).origins.includes(value)) fail("ORIGIN_DENIED", 403);
  return value;
}
export async function actorFor(env: Env, r: Request): Promise<Actor> {
  if (r.headers.has("x-fotoro-fixture-account")) fail("UNAUTHENTICATED", 401);
  const token =
    r.headers.get("authorization")?.replace(/^Bearer /, "") ||
    r.headers.get("cookie")?.match(/(?:^|; )fotoro_session=([^;]+)/)?.[1];
  if (!token) fail("UNAUTHENTICATED", 401);
  const hash = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
  const row = await env.DB.prepare(
    "SELECT account_id,device_id FROM sessions WHERE token_hash=? AND expires>?",
  )
    .bind(hash, Date.now())
    .first<any>();
  if (!row) fail("UNAUTHENTICATED", 401);
  return { accountId: row.account_id, deviceId: row.device_id };
}
async function session(env: Env, accountId: string, client: string) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))),
    deviceId = crypto.randomUUID(),
    expires = Date.now() + 30 * 86400000;
  const hash = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO devices(id,account_id,trusted) VALUES(?,?,1)",
    ).bind(deviceId, accountId),
    env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)").bind(
      hash,
      accountId,
      deviceId,
      expires,
    ),
  ]);
  return {
    body: {
      version: 1,
      accountId,
      deviceId,
      expiresAt: new Date(expires).toISOString(),
      ...(client === "native" ? { token } : {}),
    },
    cookie:
      client === "web"
        ? `fotoro_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`
        : null,
  };
}
export async function vault(env: Env, accountId: string) {
  const row = await env.DB.prepare("SELECT card FROM accounts WHERE id=?")
    .bind(accountId)
    .first<any>();
  if (!row) fail("NOT_FOUND", 404);
  const wrappers = await env.DB.prepare(
    "SELECT json FROM wrappers WHERE account_id=?",
  )
    .bind(accountId)
    .all<any>();
  return {
    version: 1,
    accountCard: JSON.parse(row.card),
    wrappers: wrappers.results.map((r) => JSON.parse(r.json)),
  };
}
export async function options(env: Env, r: Request, kind: string, input: any) {
  validateWire(
    kind === "start" ? "StartOptionsRequestV1" : kind === "recovery" ? "RecoveryOptionsRequestV1" : "AuthOptionsRequestV1",
    input,
  );
  const o = origin(env, r),
    id = crypto.randomUUID(),
    account =
      kind === "register" || kind === "start"
        ? input.accountId || crypto.randomUUID()
        : input.accountId || null;
  if (kind === "register" && input.accountId) {
    const actor = await actorFor(env, r);
    if (actor.accountId !== input.accountId) fail("FORBIDDEN", 403);
  }
  let result: any;
  if (kind === "start") {
    result = { challenge: b64(crypto.getRandomValues(new Uint8Array(32))) };
  } else if (kind === "recovery") {
    result = {
      challenge: b64(crypto.getRandomValues(new Uint8Array(32))),
      vault: await vault(env, account),
    };
  } else if (kind === "register") {
    result = await generateRegistrationOptions({
      rpName: "Fotoro",
      rpID: config(env).rpID,
      userName: account,
      userID: new TextEncoder().encode(account),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
  } else {
    const rows = account
      ? await env.DB.prepare(
          "SELECT id,transports FROM credentials WHERE account_id=?",
        )
          .bind(account)
          .all<any>()
      : null;
    result = await generateAuthenticationOptions({
      rpID: config(env).rpID,
      userVerification: "required",
      ...(rows
        ? {
            allowCredentials: rows.results.map((x) => ({
              id: x.id,
              transports: JSON.parse(x.transports),
            })),
          }
        : {}),
    });
  }
  const expires = Date.now() + 300000;
  await env.DB.prepare(
    "INSERT INTO auth_challenges(id,account_id,challenge,kind,client,expires,origin) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(id, account, result.challenge, kind, input.client, expires, o)
    .run();
  return kind === "start"
    ? { version: 1, accountId: account, challengeId: id, challenge: result.challenge,
        expiresAt: new Date(expires).toISOString() }
    : kind === "recovery"
    ? {
        version: 1,
        challengeId: id,
        challenge: result.challenge,
        expiresAt: new Date(expires).toISOString(),
        vault: result.vault,
      }
    : {
        version: 1,
        challengeId: id,
        ...(kind === "register" ? { accountId: account } : {}),
        options: result,
      };
}
export async function verify(env: Env, r: Request, kind: string, input: any) {
  validateWire(
    kind === "start" ? "StartVerifyRequestV1" : kind === "recovery" ? "RecoveryVerifyRequestV1" : "AuthVerifyRequestV1",
    input,
  );
  const o = origin(env, r);
  const c = await env.DB.prepare(
    "SELECT * FROM auth_challenges WHERE id=? AND consumed=0 AND expires>? AND kind=? AND client=? AND origin=?",
  )
    .bind(input.challengeId, Date.now(), kind, input.client, o)
    .first<any>();
  if (!c) fail("FORBIDDEN", 403);
  let account = c.account_id;
  const writes: D1PreparedStatement[] = [];
  let credentialGuard = "";
  let credentialArgs: unknown[] = [];
  if (kind === "start") {
    const e = validateWire<any>("AccountEnrollmentV1", input.enrollment);
    if (e.accountCard.accountId !== account || e.recoveryWrapper.kind !== "recovery" ||
      !e.recoveryWrapper.verified || e.recoveryWrapper.credentialId !== null || e.recoveryWrapper.prfSalt !== null)
      fail("BODY_MISMATCH");
    const enrollmentBody = JSON.parse(new TextDecoder().decode(await verifySigned(
      e.proof, e.accountCard.signingPublicKey, "account-enrollment", account)));
    if (json(enrollmentBody) !== json({ accountCard: e.accountCard, recoveryWrapper: e.recoveryWrapper }))
      fail("BODY_MISMATCH");
    const proof = JSON.parse(new TextDecoder().decode(await verifySigned(
      input.signedPayload, e.accountCard.signingPublicKey, "start-enrollment", account)));
    validateWire("RecoverySessionProofV1", proof);
    if (json(proof) !== json({ version: 1, challengeId: c.id, challenge: c.challenge,
      accountId: account, client: c.client, origin: o })) fail("BODY_MISMATCH");
    // A start code enrolls a new identity only. Conflicts abort every account/wrapper write.
    credentialGuard = " AND NOT EXISTS(SELECT 1 FROM accounts WHERE id=?) AND NOT EXISTS(SELECT 1 FROM wrappers WHERE id=?)";
    credentialArgs = [account, e.recoveryWrapper.wrapperId];
    writes.push(
      env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(account, json(e.accountCard)),
      env.DB.prepare("INSERT INTO wrappers VALUES(?,?,?)").bind(e.recoveryWrapper.wrapperId, account, json(e.recoveryWrapper)),
    );
  } else if (kind === "recovery") {
    const v = await vault(env, account);
    const body = JSON.parse(
      new TextDecoder().decode(
        await verifySigned(
          input.signedPayload,
          v.accountCard.signingPublicKey,
          "recovery-session",
          account,
        ),
      ),
    );
    validateWire("RecoverySessionProofV1", body);
    if (
      json(body) !==
      json({
        version: 1,
        challengeId: c.id,
        challenge: c.challenge,
        accountId: account,
        client: c.client,
        origin: o,
      })
    )
      fail("BODY_MISMATCH");
  } else if (kind === "register") {
    const e = validateWire<any>("AccountEnrollmentV1", input.enrollment);
    if (
      e.accountCard.accountId !== account ||
      e.recoveryWrapper.kind !== "recovery" ||
      !e.recoveryWrapper.verified
    )
      fail("BODY_MISMATCH");
    const bytes = await verifySigned(
      e.proof,
      e.accountCard.signingPublicKey,
      "account-enrollment",
      account,
    );
    if (
      json(JSON.parse(new TextDecoder().decode(bytes))) !==
      json({ accountCard: e.accountCard, recoveryWrapper: e.recoveryWrapper })
    )
      fail("BODY_MISMATCH");
    const verified = await ceremony(
      verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: c.challenge,
        expectedOrigin: o,
        expectedRPID: config(env).rpID,
        requireUserVerification: true,
      }),
    );
    if (!verified.verified || !verified.registrationInfo)
      fail("FORBIDDEN", 403);
    const cred = verified.registrationInfo!.credential;
    const existing = await env.DB.prepare(
      "SELECT card FROM accounts WHERE id=?",
    )
      .bind(account)
      .first<any>();
    if (existing) {
      const actor = await actorFor(env, r);
      if (
        actor.accountId !== account ||
        json(JSON.parse(existing.card)) !== json(e.accountCard)
      )
        fail("FORBIDDEN", 403);
    } else {
      writes.push(
        env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(
          account,
          json(e.accountCard),
        ),
      );
    }
    writes.push(
      env.DB.prepare(
        "INSERT INTO wrappers VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      ).bind(e.recoveryWrapper.wrapperId, account, json(e.recoveryWrapper)),
      env.DB.prepare("INSERT INTO credentials VALUES(?,?,?,?,?)").bind(
        cred.id,
        account,
        b64(cred.publicKey),
        cred.counter,
        json(cred.transports || []),
      ),
    );
  } else {
    const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id=?")
      .bind(input.response?.id || "")
      .first<any>();
    if (!cred || (account && account !== cred.account_id))
      fail("FORBIDDEN", 403);
    account = cred.account_id;
    credentialGuard =
      " AND EXISTS(SELECT 1 FROM credentials WHERE id=? AND counter=?)";
    credentialArgs = [cred.id, cred.counter];
    const v = await ceremony(
      verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: c.challenge,
        expectedOrigin: o,
        expectedRPID: config(env).rpID,
        requireUserVerification: true,
        credential: {
          id: cred.id,
          publicKey: unb64(cred.public_key),
          counter: cred.counter,
          transports: JSON.parse(cred.transports),
        },
      }),
    );
    if (!v.verified) fail("FORBIDDEN", 403);
    writes.push(
      env.DB.prepare(
        "UPDATE credentials SET counter=? WHERE id=? AND counter=?",
      ).bind(v.authenticationInfo.newCounter, cred.id, cred.counter),
    );
  }
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM auth_challenges WHERE id=? AND consumed=0 AND expires>?)" +
      credentialGuard,
    [c.id, Date.now(), ...credentialArgs],
    [
      ...writes,
      env.DB.prepare("UPDATE auth_challenges SET consumed=1 WHERE id=?").bind(
        c.id,
      ),
    ],
  );
  return session(env, account, input.client);
}
export async function putWrapper(
  env: Env,
  actor: Actor,
  id: string,
  input: any,
) {
  validateWire("VaultWrapperV1", input);
  if (input.wrapperId !== id || input.verified) fail("FORBIDDEN", 403);
  if (
    input.credentialId &&
    !(await env.DB.prepare(
      "SELECT 1 FROM credentials WHERE id=? AND account_id=?",
    )
      .bind(input.credentialId, actor.accountId)
      .first())
  )
    fail("FORBIDDEN", 403);
  const result = await env.DB.prepare(
    "INSERT INTO wrappers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE wrappers.account_id=excluded.account_id AND json_extract(wrappers.json,'$.verified')=0 AND json_extract(wrappers.json,'$.kind')<>'recovery'",
  )
    .bind(id, actor.accountId, json(input))
    .run();
  if (result.meta.changes !== 1) fail("FORBIDDEN", 403);
  return input;
}
export async function removeCredential(env: Env, actor: Actor, id: string) {
  await batchGuard(
    env,
    `EXISTS(SELECT 1 FROM credentials WHERE id=? AND account_id=?) AND (EXISTS(SELECT 1 FROM credentials WHERE account_id=? AND id<>?) OR EXISTS(SELECT 1 FROM wrappers WHERE account_id=? AND json_extract(json,'$.verified')=1 AND json_extract(json,'$.kind')='recovery'))`,
    [id, actor.accountId, actor.accountId, id, actor.accountId],
    [
      env.DB.prepare(
        "DELETE FROM wrappers WHERE account_id=? AND json_extract(json,'$.credentialId')=?",
      ).bind(actor.accountId, id),
      env.DB.prepare(
        "DELETE FROM credentials WHERE id=? AND account_id=?",
      ).bind(id, actor.accountId),
    ],
  );
  return { version: 1, removed: true };
}

export async function logout(env: Env, r: Request) {
  origin(env, r);
  await actorFor(env, r);
  const token =
    r.headers.get("authorization")?.replace(/^Bearer /, "") ||
    r.headers.get("cookie")?.match(/(?:^|; )fotoro_session=([^;]+)/)?.[1];
  const hash = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token!)),
    ),
  );
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
    .bind(hash)
    .run();
  return { version: 1, loggedOut: true };
}
