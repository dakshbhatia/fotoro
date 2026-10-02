import type {
  ReserveUploadV1,
  UploadReservationV1,
  UploadCommitV1,
} from "@fotoro/contracts";
import { validateWire } from "@fotoro/contracts/validate";
import { sha256 } from "@noble/hashes/sha2.js";
import { ApiError, type Env, type Actor, fail, json, b64 } from "./errors";
import type { ErrorPhase } from "./diagnostics";
type Upload = {
  id: string;
  account_id: string;
  device_id: string;
  input: string;
  cap: string;
  expires: number;
  object_id: string;
  state: string;
  etag: string | null;
  revision: number;
  commit_json: string | null;
};
// Each renewed capability gets a separate staging key, isolating late PUTs.
const stagingKey = (row: Upload) => `staging/${row.id}/${row.cap}`;

async function storageCall<T>(phase: ErrorPhase, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INTERNAL_ERROR", 500, { phase, errorClass: "storage" });
  }
}

async function writeStaging(env: Env, key: string, body: ReadableStream<Uint8Array>, expected: number) {
  const reader = body.getReader();
  const stop = new AbortController();
  let observed = 0;
  let bodyFailure: ApiError | undefined;
  let storageFailed = false;
  const checked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (storageFailed) return;
        if (item.done) {
          if (observed !== expected) {
            bodyFailure = new ApiError("DIGEST_MISMATCH", 422, { phase: "upload.staging", errorClass: "integrity" });
            controller.error(bodyFailure);
          } else controller.close();
          return;
        }
        observed += item.value.length;
        if (observed > expected) {
          bodyFailure = new ApiError("TOO_LARGE", 413, { phase: "upload.staging", errorClass: "body_limit" });
          controller.error(bodyFailure);
          await reader.cancel().catch(() => {});
          return;
        }
        controller.enqueue(item.value);
      } catch {
        if (storageFailed) return;
        bodyFailure = new ApiError("UPLOAD_INCOMPLETE", 408, { phase: "upload.staging", errorClass: "client_abort" });
        controller.error(bodyFailure);
      }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  }, { highWaterMark: 0 });
  const fixed = new FixedLengthStream(expected);
  const pumping = checked.pipeTo(fixed.writable, { signal: stop.signal });
  const writing = storageCall("upload.staging", () => env.BUCKET.put(key, fixed.readable)).catch(error => {
    storageFailed = true;
    stop.abort();
    throw error;
  });
  const [pump, write] = await Promise.allSettled([pumping, writing]);
  reader.releaseLock();
  if (bodyFailure) throw bodyFailure;
  if (write.status === "rejected" || pump.status === "rejected" || !write.value)
    throw new ApiError("INTERNAL_ERROR", 500, { phase: "upload.staging", errorClass: "storage" });
  return write.value;
}
async function owned(env: Env, actor: Actor, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM uploads WHERE id=? AND account_id=?",
  )
    .bind(id, actor.accountId)
    .first<Upload>();
  if (!row) fail("FORBIDDEN", 403);
  return row!;
}
export async function reserveUpload(
  env: Env,
  actor: Actor,
  input: ReserveUploadV1,
  base: string,
): Promise<UploadReservationV1> {
  validateWire("ReserveUploadV1", input);
  if (input.ciphertextBytes > 55 * 1024 * 1024) fail("TOO_LARGE", 413);
  const id = crypto.randomUUID(),
    cap = b64(crypto.getRandomValues(new Uint8Array(32))),
    expires = Date.now() + 900000;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO uploads(id,account_id,device_id,operation_id,input,cap,expires,object_id) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      actor.accountId,
      actor.deviceId,
      input.operationId,
      json(input),
      cap,
      expires,
      crypto.randomUUID(),
    )
    .run();
  let row = await env.DB.prepare(
    "SELECT * FROM uploads WHERE account_id=? AND operation_id=?",
  )
    .bind(actor.accountId, input.operationId)
    .first<Upload>();
  if (!row || row.input !== json(input)) fail("IDEMPOTENCY_CONFLICT", 409);
  if (row!.state === "reserved" && row!.expires <= Date.now()) {
    await env.DB.prepare(
      "UPDATE uploads SET cap=?,expires=?,revision=revision+1 WHERE id=? AND account_id=? AND input=? AND state='reserved' AND revision=? AND expires<=?",
    )
      .bind(
        cap,
        expires,
        row!.id,
        actor.accountId,
        json(input),
        row!.revision,
        Date.now(),
      )
      .run();
    row = await owned(env, actor, row!.id);
  }
  return {
    version: 1,
    uploadId: row!.id,
    photoId: input.binding.photoId,
    representationId: input.binding.representationId,
    stagingUrl: `${base}/v1/uploads/${row!.id}/staging?cap=${row!.cap}`,
    expiresAt: new Date(row!.expires).toISOString(),
  };
}
export async function putStaging(
  env: Env,
  actor: Actor,
  id: string,
  cap: string,
  request: Request,
) {
  const row = await owned(env, actor, id);
  if (row.cap !== cap || row.expires <= Date.now() || row.state !== "reserved")
    fail("FORBIDDEN", 403);
  if (!request.body) fail("UPLOAD_INCOMPLETE", 409);
  const input = JSON.parse(row.input) as ReserveUploadV1;
  const len = Number(request.headers.get("content-length"));
  if (request.headers.has("content-length") && len !== input.ciphertextBytes)
    fail("DIGEST_MISMATCH", 422);
  const object = await writeStaging(env, stagingKey(row), request.body!, input.ciphertextBytes);
  const result = await env.DB.prepare(
    "UPDATE uploads SET state='uploaded',etag=?,revision=revision+1 WHERE id=? AND account_id=? AND state='reserved' AND revision=? AND expires>?",
  )
    .bind(object!.etag, id, actor.accountId, row.revision, Date.now())
    .run();
  if (result.meta.changes !== 1) fail("VERSION_CONFLICT", 409);
  return { version: 1 };
}
/* A reserve-created, expiring capability can write only its encrypted staging object. */
export async function putBackgroundStaging(env: Env, id: string, cap: string, request: Request) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(cap)) fail("FORBIDDEN", 403);
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE id=? AND cap=? AND expires>? AND state='reserved'")
    .bind(id, cap, Date.now()).first<Upload>();
  if (!row) fail("FORBIDDEN", 403);
  return putStaging(env, {accountId: row!.account_id, deviceId: row!.device_id}, id, cap, request);
}
async function hashObject(body: ReadableStream<Uint8Array>, expected: number) {
  const hash = sha256.create();
  let bytes = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > expected) fail("DIGEST_MISMATCH", 422);
      hash.update(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, digest: b64(hash.digest()) };
}
export async function commitUpload(
  env: Env,
  actor: Actor,
  id: string,
): Promise<UploadCommitV1> {
  const row = await owned(env, actor, id);
  if (row.commit_json) return JSON.parse(row.commit_json);
  if (row.state !== "uploaded" || !row.etag) fail("UPLOAD_INCOMPLETE", 409);
  const input = JSON.parse(row.input) as ReserveUploadV1;
  const finalKey = "final/" + row.object_id;
  let promoted = await storageCall("upload.commit", () => env.BUCKET.head(finalKey));
  if (!promoted) {
    const staging = await storageCall("upload.commit", () => env.BUCKET.get(stagingKey(row), {
      onlyIf: { etagMatches: row.etag! },
    }));
    if (!staging || !("body" in staging)) fail("UPLOAD_INCOMPLETE", 409);
    const observed = await storageCall("upload.commit", () => hashObject(
      (staging as R2ObjectBody).body,
      input.ciphertextBytes,
    ));
    if (
      observed.bytes !== input.ciphertextBytes ||
      observed.digest !== input.ciphertextSha256
    )
      fail("DIGEST_MISMATCH", 422);
    const same = await storageCall("upload.commit", () => env.BUCKET.get(stagingKey(row), {
      onlyIf: { etagMatches: row.etag! },
    }));
    if (!same || !("body" in same)) fail("UPLOAD_INCOMPLETE", 409);
    await storageCall("upload.commit", () => env.BUCKET.put(finalKey, (same as R2ObjectBody).body, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: {
        uploadId: id,
        digest: observed.digest,
        binding: json(input.binding),
      },
    }));
    promoted = await storageCall("upload.commit", () => env.BUCKET.head(finalKey));
  }
  if (
    !promoted ||
    promoted.size !== input.ciphertextBytes ||
    promoted.customMetadata?.digest !== input.ciphertextSha256 ||
    promoted.customMetadata?.uploadId !== id ||
    promoted.customMetadata?.binding !== json(input.binding)
  )
    fail("DIGEST_MISMATCH", 422);
  const commit: UploadCommitV1 = {
    version: 1,
    uploadId: id,
    objectId: row.object_id,
    ciphertextBytes: input.ciphertextBytes,
    ciphertextSha256: input.ciphertextSha256,
  };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO objects(id,account_id,upload_id,bytes,digest,binding) SELECT object_id,account_id,id,?,?,? FROM uploads WHERE id=? AND account_id=? AND state='uploaded' AND revision=?",
    ).bind(
      input.ciphertextBytes,
      input.ciphertextSha256,
      json(input.binding),
      id,
      actor.accountId,
      row.revision,
    ),
    env.DB.prepare(
      "UPDATE uploads SET state='committed',commit_json=?,revision=revision+1 WHERE id=? AND account_id=? AND state='uploaded' AND revision=? AND EXISTS(SELECT 1 FROM objects WHERE id=uploads.object_id AND upload_id=uploads.id AND account_id=uploads.account_id)",
    ).bind(json(commit), id, actor.accountId, row.revision),
  ]);
  const finalized = await owned(env, actor, id);
  if (!finalized.commit_json) fail("VERSION_CONFLICT", 409);
  return JSON.parse(finalized.commit_json!);
}
export async function reconcileUpload(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE id=?")
    .bind(id)
    .first<Upload>();
  if (!row) return null;
  try {
    return await commitUpload(
      env,
      { accountId: row.account_id, deviceId: row.device_id },
      id,
    );
  } catch {
    return null;
  }
}
export async function cleanupUpload(env: Env, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM uploads WHERE id=? AND expires<=? AND state<>'uploaded'",
  )
    .bind(id, Date.now())
    .first<Upload>();
  if (!row) return false;
  await env.BUCKET.delete(stagingKey(row));
  /* Commit-created final objects remain until catalog removal is implemented; never delete ambiguous promotion. */ return true;
}
export async function getObject(env: Env, actor: Actor, id: string) {
  const authorized = await env.DB.prepare(
    `SELECT 1 AS ok FROM objects o WHERE o.id=? AND o.state='live' AND (o.account_id=? OR EXISTS(SELECT 1 FROM retention r WHERE r.object_id=o.id AND r.account_id=?) OR EXISTS(SELECT 1 FROM retention r JOIN grant_photos gp ON gp.photo_id=r.photo_id JOIN grants g ON g.id=gp.grant_id WHERE r.object_id=o.id AND (g.recipient=? OR g.owner=?) AND g.revoked IS NULL AND (g.expires IS NULL OR g.expires>?)))`,
  )
    .bind(
      id,
      actor.accountId,
      actor.accountId,
      actor.accountId,
      actor.accountId,
      Date.now(),
    )
    .first();
  if (!authorized) fail("FORBIDDEN", 403);
  const obj = await env.BUCKET.get("final/" + id);
  if (!obj) fail("NOT_FOUND", 404);
  return new Response(obj!.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj!.size),
      "Cache-Control": "no-store",
    },
  });
}
