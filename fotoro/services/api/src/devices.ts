import { validateWire } from "@fotoro/contracts/validate";
import {
  type Env,
  type Actor,
  fail,
  json,
  b64,
  signedBody,
  batchGuard,
} from "./errors";
import { config, origin } from "./auth";
export async function enroll(env: Env, a: Actor, r: Request, i: any) {
  validateWire("EnrollDeviceV1", i);
  if (i.origin !== origin(env, r)) fail("ORIGIN_DENIED", 403);
  const id = crypto.randomUUID(),
    expires = Date.now() + 300000,
    c = {
      ...i,
      enrollmentId: id,
      accountId: a.accountId,
      challenge: b64(crypto.getRandomValues(new Uint8Array(32))),
      expiresAt: new Date(expires).toISOString(),
      state: "pending",
    };
  await env.DB.prepare(
    "INSERT INTO enrollments(id,account_id,device_id,challenge,json,expires) VALUES(?,?,?,?,?,?)",
  )
    .bind(id, a.accountId, i.deviceId, c.challenge, json(c), expires)
    .run();
  return c;
}
export async function approve(
  env: Env,
  a: Actor,
  r: Request,
  id: string,
  i: any,
) {
  validateWire("DeviceApprovalV1", i);
  const row = await env.DB.prepare(
    "SELECT * FROM enrollments WHERE id=? AND account_id=?",
  )
    .bind(id, a.accountId)
    .first<any>();
  if (!row) fail("FORBIDDEN", 403);
  const challenge = JSON.parse(row.json);
  if (challenge.origin !== origin(env, r)) fail("ORIGIN_DENIED", 403);
  const body = await signedBody(env, a, i.signedPayload, "device-approval");
  if (json(body) !== json({ challenge, sealedBundle: i.sealedBundle }))
    fail("BODY_MISMATCH");
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM enrollments WHERE id=? AND account_id=? AND state='pending' AND expires>?)",
    [id, a.accountId, Date.now()],
    [
      env.DB.prepare(
        "UPDATE enrollments SET state='approved',sealed=?,signed=? WHERE id=?",
      ).bind(i.sealedBundle, json(i.signedPayload), id),
    ],
  );
  return { ...challenge, state: "approved" };
}
export async function complete(
  env: Env,
  a: Actor,
  r: Request,
  id: string,
  i: any,
) {
  if (
    i.version !== 1 ||
    typeof i.challenge !== "string" ||
    Object.keys(i).length !== 2
  )
    fail("INVALID_WIRE");
  const row = await env.DB.prepare(
    "SELECT * FROM enrollments WHERE id=? AND account_id=?",
  )
    .bind(id, a.accountId)
    .first<any>();
  if (!row || row.challenge !== i.challenge) fail("FORBIDDEN", 403);
  const c = JSON.parse(row.json);
  if (c.deviceId !== a.deviceId) fail("FORBIDDEN", 403);
  if (c.origin !== origin(env, r)) fail("ORIGIN_DENIED", 403);
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM enrollments WHERE id=? AND account_id=? AND state='approved' AND expires>?)",
    [id, a.accountId, Date.now()],
    [
      env.DB.prepare(
        "UPDATE enrollments SET state='completed' WHERE id=?",
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO devices(id,account_id,trusted,box_key) VALUES(?,?,1,?) ON CONFLICT(id) DO UPDATE SET trusted=1,box_key=excluded.box_key WHERE devices.account_id=excluded.account_id",
      ).bind(c.deviceId, a.accountId, c.boxPublicKey),
    ],
  );
  return {
    version: 1,
    sealedBundle: row.sealed,
    signedPayload: JSON.parse(row.signed),
    challenge: { ...c, state: "completed" },
  };
}
