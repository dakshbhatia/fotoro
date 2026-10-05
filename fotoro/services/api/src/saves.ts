import {acceptedPhotoManifestKind} from "@fotoro/contracts/camera-media";
import { validateWire } from "@fotoro/contracts/validate";
import {
  type Env,
  type Actor,
  fail,
  json,
  signedBody,
  batchGuard,
} from "./errors";
import { active, activeCondition } from "./grants";
export async function savePhoto(env: Env, a: Actor, i: any) {
  validateWire("SaveRequestV1", i);
  const s = i.save;
  const prior = await env.DB.prepare(
    "SELECT json FROM saves WHERE account_id=? AND operation_id=?",
  )
    .bind(a.accountId, s.operationId)
    .first<any>();
  if (prior) {
    if (prior.json !== json(i)) fail("IDEMPOTENCY_CONFLICT", 409);
    return JSON.parse(prior.json).save;
  }
  const g = await active(env, a, s.sourceGrantId, i.expectedGrantVersion);
  const source = await env.DB.prepare(
    "SELECT p.manifest,p.signed,gp.envelope FROM grant_photos gp JOIN photos p ON p.id=gp.photo_id WHERE gp.grant_id=? AND gp.photo_id=?",
  )
    .bind(s.sourceGrantId, s.sourcePhotoId)
    .first<any>();
  if (!source || JSON.parse(source.envelope).recipientAccountId !== a.accountId)
    fail("FORBIDDEN", 403);
  const original = JSON.parse(source.manifest);
  let kind: string;
  try { kind = acceptedPhotoManifestKind(s.signedPayload.kind); } catch { fail("INVALID_WIRE"); }
  if (JSON.parse(source.signed).kind !== kind!) fail("SOURCE_MISMATCH");
  if (
    s.photoId !== s.manifest.photoId ||
    s.manifest.ownerAccountId !== a.accountId ||
    json(s.manifest.representations) !== json(original.representations) ||
    json(s.manifest.metadataRepresentation) !==
      json(original.metadataRepresentation)
  )
    fail("SOURCE_MISMATCH");
  const body = await signedBody(
    env,
    a,
    s.signedPayload,
    kind!,
    "PhotoManifestV1",
  );
  if (json(body) !== json(s.manifest)) fail("BODY_MISMATCH");
  await batchGuard(
    env,
    `EXISTS(SELECT 1 FROM grants WHERE id=? AND (recipient=? OR owner=?) AND revision=? AND revoked IS NULL AND (expires IS NULL OR expires>?)) AND EXISTS(SELECT 1 FROM grant_photos WHERE grant_id=? AND photo_id=? AND json_extract(envelope,'$.recipientAccountId')=?)`,
    [
      s.sourceGrantId,
      a.accountId,
      a.accountId,
      i.expectedGrantVersion,
      Date.now(),
      s.sourceGrantId,
      s.sourcePhotoId,
      a.accountId,
    ],
    [
      env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(
        s.photoId,
        a.accountId,
        json(s.manifest),
        json(s.signedPayload),
      ),
      env.DB.prepare("INSERT INTO saves VALUES(?,?,?)").bind(
        a.accountId,
        s.operationId,
        json(i),
      ),
    ],
    "GRANT_INACTIVE",
  );
  return s;
}
