import { validateWire } from "@fotoro/contracts/validate";
import {
  type Env,
  type Actor,
  fail,
  json,
  signedBody,
  batchGuard,
  verifySigned,
  utf8,
} from "./errors";
import type {
  GrantV1,
  ShareKeyEnvelopeV1,
  PhotoManifestV1,
} from "@fotoro/contracts";
import { addPhoto } from "./catalog";
export const activeCondition =
  "EXISTS(SELECT 1 FROM grants WHERE id=? AND recipient=? AND revision=? AND revoked IS NULL AND (expires IS NULL OR expires>?))";
export async function active(
  env: Env,
  a: Actor,
  id: string,
  revision?: number,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM grants WHERE id=? AND (owner=? OR recipient=?) AND revoked IS NULL AND (expires IS NULL OR expires>?)",
  )
    .bind(id, a.accountId, a.accountId, Date.now())
    .first<any>();
  if (!row) fail("GRANT_INACTIVE", 403);
  if (revision !== undefined && row.revision !== revision)
    fail("VERSION_CONFLICT", 409);
  return row;
}
export async function grantOptions(env: Env, a: Actor, moment: string, i: any) {
  validateWire("GrantOptionsRequestV1", i);
  if (
    i.recipientAccountId === a.accountId ||
    !(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?")
      .bind(i.recipientAccountId)
      .first())
  )
    fail("FORBIDDEN", 403);
  const g: GrantV1 = {
    grantId: crypto.randomUUID(),
    momentId: moment,
    ownerAccountId: a.accountId,
    recipientAccountId: i.recipientAccountId,
    role: i.role,
    expiresAt:
      i.access === "temporary"
        ? new Date(Date.now() + 900000).toISOString()
        : null,
    revokedAt: null,
    version: 1,
  };
  await env.DB.prepare("INSERT INTO grant_reservations VALUES(?,?,?,?)")
    .bind(g.grantId, a.accountId, json(g), Date.now() + 300000)
    .run();
  return g;
}
async function envelope(
  env: Env,
  e: ShareKeyEnvelopeV1,
  g: GrantV1,
  sender: string,
  recipient: string,
) {
  if (
    e.grantId !== g.grantId ||
    e.senderAccountId !== sender ||
    e.recipientAccountId !== recipient
  )
    fail("BODY_MISMATCH");
  const card = await env.DB.prepare("SELECT card FROM accounts WHERE id=?")
    .bind(sender)
    .first<any>();
  const key = await crypto.subtle.importKey(
    "raw",
    (await import("./errors")).unb64(JSON.parse(card.card).signingPublicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      (await import("./errors")).unb64(e.senderSignature),
      utf8([
        "fotoro-share-v1",
        e.grantId,
        e.photoId,
        sender,
        recipient,
        e.sealedMetadataKey,
      ]),
    ))
  )
    fail("BAD_SIGNATURE", 403);
}
export async function createGrant(env: Env, a: Actor, moment: string, i: any) {
  validateWire("CreateGrantV1", i);
  const g = i.grant as GrantV1;
  if (g.ownerAccountId !== a.accountId || g.momentId !== moment)
    fail("FORBIDDEN", 403);
  const body = await signedBody(env, a, i.signedPayload, "grant");
  if (json(body) !== json({ grant: g, envelopes: i.envelopes }))
    fail("BODY_MISMATCH");
  const previous = await env.DB.prepare(
    "SELECT signed,json FROM grants WHERE id=?",
  )
    .bind(g.grantId)
    .first<any>();
  if (previous) {
    if (previous.signed !== json(i.signedPayload))
      fail("IDEMPOTENCY_CONFLICT", 409);
    return JSON.parse(previous.json);
  }
  const res = await env.DB.prepare(
    "SELECT * FROM grant_reservations WHERE id=? AND account_id=?",
  )
    .bind(g.grantId, a.accountId)
    .first<any>();
  if (!res || res.json !== json(g)) fail("BODY_MISMATCH");
  if (
    new Set(i.envelopes.map((e: any) => e.photoId)).size !==
      i.envelopes.length ||
    !i.envelopes.length
  )
    fail("INVALID_WIRE");
  for (const e of i.envelopes) {
    if (
      !(await env.DB.prepare("SELECT 1 FROM photos WHERE id=? AND account_id=?")
        .bind(e.photoId, a.accountId)
        .first())
    )
      fail("FORBIDDEN", 403);
    await envelope(env, e, g, a.accountId, g.recipientAccountId);
  }
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM grant_reservations WHERE id=? AND account_id=? AND expires>?)",
    [g.grantId, a.accountId, Date.now()],
    [
      env.DB.prepare(
        "INSERT INTO grants(id,moment_id,owner,recipient,role,expires,revision,json,signed) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        g.grantId,
        moment,
        a.accountId,
        g.recipientAccountId,
        g.role,
        g.expiresAt ? Date.parse(g.expiresAt) : null,
        1,
        json(g),
        json(i.signedPayload),
      ),
      ...i.envelopes.map((e: any) =>
        env.DB.prepare("INSERT INTO grant_photos VALUES(?,?,?)").bind(
          g.grantId,
          e.photoId,
          json(e),
        ),
      ),
      env.DB.prepare(
        "INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(?,'grant',?,?)",
      ).bind(g.recipientAccountId, g.grantId, json(i.signedPayload)),
      env.DB.prepare("DELETE FROM grant_reservations WHERE id=?").bind(
        g.grantId,
      ),
    ],
  );
  return g;
}
export async function inbox(env: Env, a: Actor) {
  const rows = await env.DB.prepare(
    "SELECT json FROM grants WHERE owner=? OR recipient=?",
  )
    .bind(a.accountId, a.accountId)
    .all<any>();
  return { version: 1, grants: rows.results.map((r) => JSON.parse(r.json)) };
}
export async function detail(env: Env, a: Actor, id: string) {
  const row = await active(env, a, id);
  const photos = await env.DB.prepare(
    "SELECT p.signed,p.account_id,gp.envelope FROM grant_photos gp JOIN photos p ON p.id=gp.photo_id WHERE gp.grant_id=?",
  )
    .bind(id)
    .all<any>();
  const ids = [
    ...new Set([
      row.owner,
      row.recipient,
      ...photos.results.map((x) => x.account_id),
    ]),
  ];
  const cards = [];
  for (const account of ids) {
    const c = await env.DB.prepare("SELECT card FROM accounts WHERE id=?")
      .bind(account)
      .first<any>();
    cards.push(JSON.parse(c.card));
  }
  return {
    version: 1,
    grant: JSON.parse(row.json),
    envelopes: photos.results.map((x) => JSON.parse(x.envelope)),
    manifests: photos.results.map((x) => JSON.parse(x.signed)),
    cards,
  };
}
export async function revoke(env: Env, a: Actor, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM grants WHERE id=? AND owner=?",
  )
    .bind(id, a.accountId)
    .first<any>();
  if (!row) fail("FORBIDDEN", 403);
  if (row.revoked) return JSON.parse(row.json);
  const now = Date.now(),
    g = {
      ...JSON.parse(row.json),
      revokedAt: new Date(now).toISOString(),
      version: row.revision + 1,
    };
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM grants WHERE id=? AND owner=? AND revision=? AND revoked IS NULL)",
    [id, a.accountId, row.revision],
    [
      env.DB.prepare(
        "UPDATE grants SET revoked=?,revision=?,json=? WHERE id=?",
      ).bind(now, g.version, json(g), id),
      env.DB.prepare(
        "INSERT INTO changes(account_id,entity,entity_id,deleted) VALUES(?,'grant',?,1)",
      ).bind(row.recipient, id),
    ],
    "VERSION_CONFLICT",
  );
  return g;
}
export async function viewed(env: Env, a: Actor, id: string) {
  await active(env, a, id);
  await batchGuard(
    env,
    "EXISTS(SELECT 1 FROM grants WHERE id=? AND (owner=? OR recipient=?) AND revoked IS NULL AND (expires IS NULL OR expires>?))",
    [id, a.accountId, a.accountId, Date.now()],
    [
      env.DB.prepare("INSERT OR IGNORE INTO grant_views VALUES(?,?,?)").bind(
        id,
        a.accountId,
        new Date().toISOString(),
      ),
    ],
    "GRANT_INACTIVE",
  );
  const view = await env.DB.prepare(
    "SELECT viewed FROM grant_views WHERE grant_id=? AND account_id=?",
  )
    .bind(id, a.accountId)
    .first<any>();
  return { version: 1, grantId: id, viewedAt: view.viewed };
}
export async function contribute(env: Env, a: Actor, moment: string, i: any) {
  validateWire("ContributionV1", i);
  const first = i.envelopes[0];
  if (
    !first ||
    !i.manifests.length ||
    new Set(i.envelopes.map((e: any) => e.photoId)).size !== i.manifests.length
  )
    fail("INVALID_WIRE");
  const prior = await env.DB.prepare(
    "SELECT json FROM contributions WHERE account_id=? AND operation_id=?",
  )
    .bind(a.accountId, i.operationId)
    .first<any>();
  if (prior) {
    if (prior.json !== json(i)) fail("IDEMPOTENCY_CONFLICT", 409);
    const acceptedGrant = await env.DB.prepare(
      "SELECT 1 FROM grants WHERE id=? AND moment_id=?",
    )
      .bind(first.grantId, moment)
      .first();
    if (!acceptedGrant) fail("IDEMPOTENCY_CONFLICT", 409);
    return {
      version: 1,
      operationId: i.operationId,
      accepted: i.manifests.length,
    };
  }
  const row = await active(env, a, first.grantId, i.expectedGrantVersion),
    g = JSON.parse(row.json);
  if (
    row.recipient !== a.accountId ||
    row.role !== "contributor" ||
    row.moment_id !== moment
  )
    fail("FORBIDDEN", 403);
  const writes = [];
  for (const s of i.manifests) {
    const m = await signedBody<PhotoManifestV1>(
      env,
      a,
      s,
      "photo-manifest",
      "PhotoManifestV1",
    );
    const e = i.envelopes.find((x: any) => x.photoId === m.photoId);
    if (!e || m.ownerAccountId !== a.accountId) fail("BODY_MISMATCH");
    await (await import("./catalog")).checkObjects(env, a, m);
    await envelope(env, e, g, a.accountId, row.owner);
    const p = await env.DB.prepare(
      "SELECT signed FROM photos WHERE id=? AND account_id=?",
    )
      .bind(m.photoId, a.accountId)
      .first<any>();
    if (p && p.signed !== json(s)) fail("IDEMPOTENCY_CONFLICT", 409);
    if (!p)
      writes.push(
        env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(
          m.photoId,
          a.accountId,
          json(m),
          json(s),
        ),
      );
    writes.push(
      env.DB.prepare("INSERT INTO grant_photos VALUES(?,?,?)").bind(
        g.grantId,
        m.photoId,
        json(e),
      ),
      env.DB.prepare(
        "INSERT INTO changes(account_id,entity,entity_id,payload) VALUES(?,'photo',?,?)",
      ).bind(row.owner, m.photoId, json(s)),
    );
  }
  await batchGuard(
    env,
    activeCondition +
      " AND EXISTS(SELECT 1 FROM grants WHERE id=? AND role='contributor')",
    [g.grantId, a.accountId, i.expectedGrantVersion, Date.now(), g.grantId],
    [
      ...writes,
      env.DB.prepare("INSERT INTO contributions VALUES(?,?,?)").bind(
        a.accountId,
        i.operationId,
        json(i),
      ),
    ],
    "GRANT_INACTIVE",
  );
  return {
    version: 1,
    operationId: i.operationId,
    accepted: i.manifests.length,
  };
}
