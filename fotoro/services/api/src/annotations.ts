import type { PhotoAnnotationsUpdateV1, SignedPayloadV1 } from "@fotoro/contracts";
import { type Env, type Actor, fail, json, signedBody } from "./errors";

async function requireOwner(env: Env, actor: Actor, id: string) {
  if (!await env.DB.prepare("SELECT 1 FROM photos WHERE id=? AND account_id=?")
    .bind(id, actor.accountId).first()) fail("FORBIDDEN", 403);
}

export async function getAnnotations(env: Env, actor: Actor, id: string) {
  await requireOwner(env, actor, id);
  const row = await env.DB.prepare("SELECT signed FROM photo_annotations WHERE photo_id=? AND account_id=?")
    .bind(id, actor.accountId).first<{signed: string}>();
  return { version: 1, annotations: row ? JSON.parse(row.signed) : null };
}

export async function putAnnotations(env: Env, actor: Actor, id: string, payload: SignedPayloadV1) {
  await requireOwner(env, actor, id);
  // Bound the encoded signed body before signature verification or decoding it.
  if (typeof payload?.body !== "string" || payload.body.length > 360000) fail("INVALID_WIRE");
  const value = await signedBody<PhotoAnnotationsUpdateV1>(env, actor, payload, "photo-annotations", "PhotoAnnotationsUpdateV1");
  if (value.photoId !== id) fail("SOURCE_MISMATCH");
  const proof = json(payload);
  const prior = await env.DB.prepare("SELECT signed FROM photo_annotations WHERE photo_id=? AND account_id=?")
    .bind(id, actor.accountId).first<{signed: string}>();
  if (prior?.signed === proof) return payload;

  // One conditional write plus its trigger is atomic. A competing edit cannot
  // replace a revision it did not read, even if both callers saw the same prior.
  const written = await env.DB.prepare(
    "INSERT INTO photo_annotations(photo_id,account_id,revision,signed) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM photos WHERE id=? AND account_id=?) AND ((?=1 AND NOT EXISTS(SELECT 1 FROM photo_annotations WHERE photo_id=?)) OR EXISTS(SELECT 1 FROM photo_annotations WHERE photo_id=? AND account_id=? AND revision=?)) ON CONFLICT(photo_id) DO UPDATE SET revision=excluded.revision,signed=excluded.signed WHERE photo_annotations.account_id=excluded.account_id AND photo_annotations.revision=?",
  ).bind(id, actor.accountId, value.revision, proof, id, actor.accountId, value.revision, id, id, actor.accountId, value.revision - 1, value.revision - 1).run();
  if (written.meta.changes !== 1) {
    // Reconcile an identical request that won while this call was in flight.
    const current = await env.DB.prepare("SELECT signed FROM photo_annotations WHERE photo_id=? AND account_id=?")
      .bind(id, actor.accountId).first<{signed: string}>();
    if (current?.signed !== proof) fail("VERSION_CONFLICT", 409);
  }
  return payload;
}

export async function readAnnotationRequest(request: Request): Promise<SignedPayloadV1> {
  const limit = 512 * 1024;
  if (Number(request.headers.get("content-length")) > limit) fail("TOO_LARGE", 413);
  if (!request.body) fail("INVALID_WIRE");
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); fail("TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
