import type { PhotoManifestV1, SignedPayloadV1 } from "@fotoro/contracts";
import {
  type Env,
  type Actor,
  fail,
  json,
  signedBody,
  batchGuard,
  b64,
  unb64,
} from "./errors";
export async function checkObjects(env: Env, actor: Actor, m: PhotoManifestV1) {
  for (const r of [...m.representations, m.metadataRepresentation]) {
    const o = await env.DB.prepare(
      "SELECT o.* FROM objects o WHERE o.id=? AND o.state='live' AND (o.account_id=? OR EXISTS(SELECT 1 FROM retention r JOIN photos p ON p.id=r.photo_id AND p.account_id=r.account_id WHERE r.object_id=o.id AND r.account_id=? AND r.photo_id=?))",
    )
      .bind(r.objectId, actor.accountId, actor.accountId, m.photoId)
      .first<any>();
    if (
      !o ||
      o.bytes !== r.ciphertextBytes ||
      o.digest !== r.ciphertextSha256 ||
      o.binding !== json(r.binding)
    )
      fail("SOURCE_MISMATCH");
  }
}
export async function addPhoto(env: Env, actor: Actor, s: SignedPayloadV1) {
  const m = await signedBody<PhotoManifestV1>(
    env,
    actor,
    s,
    "photo-manifest",
    "PhotoManifestV1",
  );
  if (
    [...m.representations, m.metadataRepresentation].some(
      (r) => r.binding.photoId !== m.photoId,
    )
  )
    fail("SOURCE_MISMATCH");
  if (m.ownerAccountId !== actor.accountId) fail("FORBIDDEN", 403);
  await checkObjects(env, actor, m);
  const prior = await env.DB.prepare("SELECT signed FROM photos WHERE id=?")
    .bind(m.photoId)
    .first<any>();
  if (prior) {
    if (prior.signed !== json(s)) fail("IDEMPOTENCY_CONFLICT", 409);
    return m;
  }
  await env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)")
    .bind(m.photoId, actor.accountId, json(m), json(s))
    .run();
  return m;
}
export async function changes(
  env: Env,
  actor: Actor,
  cursor: string | null,
  limit: number,
) {
  let seq = 0;
  if (cursor) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(unb64(cursor)));
      if (
        parsed.account !== actor.accountId ||
        !Number.isSafeInteger(parsed.seq) ||
        parsed.seq < 0
      )
        fail("INVALID_WIRE");
      seq = parsed.seq;
    } catch {
      fail("INVALID_WIRE");
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    fail("INVALID_WIRE");
  const rows = await env.DB.prepare(
    "SELECT * FROM changes WHERE account_id=? AND seq>? ORDER BY seq LIMIT ?",
  )
    .bind(actor.accountId, seq, limit + 1)
    .all<any>();
  const encode = (s: number) =>
    b64(new TextEncoder().encode(json({ account: actor.accountId, seq: s })));
  const page = rows.results.slice(0, limit);
  return {
    version: 1,
    changes: page.map((r) => ({
      cursor: encode(r.seq),
      entity: r.entity,
      entityId: r.entity_id,
      deleted: !!r.deleted,
      payload: r.payload ? JSON.parse(r.payload) : null,
    })),
    nextCursor: page.length ? encode(page.at(-1)!.seq) : cursor,
    hasMore: rows.results.length > limit,
  };
}
