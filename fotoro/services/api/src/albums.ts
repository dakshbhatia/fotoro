import {
  ALBUM_MAX_MEMBERS, ALBUM_MAX_PHOTOS, ALBUM_PAGE_SIZE, ALBUM_DEFINITION_KIND,
  ALBUM_PHOTO_KIND, ALBUM_ACCEPT_KIND, ALBUM_END_KIND, albumUUID,
  validateAlbumDefinition, validateAlbumPhoto, validateAlbumAction,
  validateCreateAlbum, validateAlbumAppend, validateAlbumOverview,
  validateAlbumInbox, validateAlbumDetail, validateAlbumActionRequest,
  type AlbumOverviewV1,
} from "@fotoro/contracts/albums";
import type {SignedPayloadV1, PhotoManifestV1} from "@fotoro/contracts";
import {acceptedPhotoManifestKind} from "@fotoro/contracts/camera-media";
import {type Env, type Actor, ApiError, fail, json, signedBody, batchGuard} from "./errors";

interface Row {id: string; owner: string; definition: string; ended: number | null; status: "invited" | "accepted"; count: number}
const active = "EXISTS(SELECT 1 FROM albums a JOIN album_members m ON m.album_id=a.id WHERE a.id=? AND a.ended IS NULL AND m.account_id=? AND m.status='accepted')";
export const capabilities = () => ({version: 1, albumsVersion: 1, maxMembers: ALBUM_MAX_MEMBERS, maxPhotos: ALBUM_MAX_PHOTOS, pageSize: ALBUM_PAGE_SIZE});
async function membership(env: Env, actor: Actor, id: string): Promise<Row> {
  if (!albumUUID(id)) fail("INVALID_WIRE");
  const row = await env.DB.prepare("SELECT a.*,m.status,(SELECT COUNT(*) FROM album_photos p WHERE p.album_id=a.id) AS count FROM albums a JOIN album_members m ON m.album_id=a.id WHERE a.id=? AND m.account_id=?")
    .bind(id, actor.accountId).first<Row>();
  if (!row) fail("FORBIDDEN", 403);
  return row!;
}
function overview(row: Row): AlbumOverviewV1 {
  return validateAlbumOverview({definition: JSON.parse(row.definition), membership: row.status, endedAt: row.ended === null ? null : new Date(row.ended).toISOString(), photoCount: row.count});
}
export async function create(env: Env, actor: Actor, input: unknown) {
  const request = validateCreateAlbum(input);
  const definition = validateAlbumDefinition(await signedBody(env, actor, request.definition, ALBUM_DEFINITION_KIND));
  if (definition.ownerAccountId !== actor.accountId) fail("BODY_MISMATCH");
  const old = await env.DB.prepare("SELECT definition FROM albums WHERE id=?").bind(definition.albumId).first<{definition: string}>();
  if (old) {
    if (old.definition !== json(request.definition)) fail("IDEMPOTENCY_CONFLICT", 409);
    return overview(await membership(env, actor, definition.albumId));
  }
  const conditions = [], args: unknown[] = [], writes = [env.DB.prepare("INSERT INTO albums(id,owner,definition,created_at) VALUES(?,?,?,?)").bind(definition.albumId, actor.accountId, json(request.definition), Date.now())];
  for (const member of definition.members) {
    const stored = await env.DB.prepare("SELECT card FROM accounts WHERE id=?").bind(member.card.accountId).first<{card: string}>();
    if (!stored || json(JSON.parse(stored.card)) !== json(member.card)) fail("BODY_MISMATCH");
    // A pending invitation cannot consume its recipient's accepted-album quota.
    if (member.card.accountId === actor.accountId) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='accepted' AND a.ended IS NULL").bind(actor.accountId).first<{count: number}>();
      if ((count?.count ?? 0) >= 50) fail("ALBUM_LIMIT", 413);
      conditions.push("(SELECT COUNT(*) FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='accepted' AND a.ended IS NULL)<50"); args.push(actor.accountId);
    }
    writes.push(env.DB.prepare("INSERT INTO album_members(album_id,account_id,status) VALUES(?,?,?)").bind(definition.albumId, member.card.accountId, member.card.accountId === actor.accountId ? "accepted" : "invited"));
  }
  conditions.push("NOT EXISTS(SELECT 1 FROM albums WHERE id=?)"); args.push(definition.albumId);
  try {await batchGuard(env, conditions.join(" AND "), args, writes, "VERSION_CONFLICT");}
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") throw error;
    const concurrent = await env.DB.prepare("SELECT definition FROM albums WHERE id=?").bind(definition.albumId).first<{definition: string}>();
    if (!concurrent) throw error;
    if (concurrent.definition !== json(request.definition)) fail("IDEMPOTENCY_CONFLICT", 409);
  }
  return overview(await membership(env, actor, definition.albumId));
}
export async function inbox(env: Env, actor: Actor) {
  const rows = await env.DB.prepare("SELECT a.*,m.status,(SELECT COUNT(*) FROM album_photos p WHERE p.album_id=a.id) AS count FROM albums a JOIN album_members m ON m.album_id=a.id WHERE m.account_id=? ORDER BY (a.ended IS NULL) DESC,(m.status='accepted') DESC,a.created_at DESC,a.id DESC LIMIT 100").bind(actor.accountId).all<Row>();
  return validateAlbumInbox({version: 1, albums: rows.results.map(overview)});
}
export async function access(env: Env, actor: Actor, id: string) {
  const row = await membership(env, actor, id);
  if (row.ended !== null || row.status !== "accepted") fail("ALBUM_INACTIVE", 403);
  return overview(row);
}
export async function detail(env: Env, actor: Actor, id: string, cursor: string | undefined) {
  if (cursor !== undefined && (!/^[0-9]{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) fail("INVALID_WIRE");
  const row = await membership(env, actor, id);
  if (row.ended !== null || row.status !== "accepted") fail("ALBUM_INACTIVE", 403);
  const page = await env.DB.prepare("SELECT p.sequence,p.entry,f.signed FROM album_photos p JOIN photos f ON f.id=p.photo_id WHERE p.album_id=? AND p.sequence>? ORDER BY p.sequence LIMIT ?").bind(id, Number(cursor ?? 0), ALBUM_PAGE_SIZE + 1).all<{sequence: number; entry: string; signed: string}>();
  const current = await membership(env, actor, id);
  if (current.ended !== null || current.status !== "accepted") fail("ALBUM_INACTIVE", 403);
  const hasMore = page.results.length > ALBUM_PAGE_SIZE, rows = page.results.slice(0, ALBUM_PAGE_SIZE);
  return validateAlbumDetail({version: 1, ...overview(current), entries: rows.map(p => JSON.parse(p.entry)), manifests: rows.map(p => JSON.parse(p.signed)), hasMore, nextCursor: hasMore ? String(rows.at(-1)!.sequence) : null});
}
async function action(env: Env, actor: Actor, id: string, input: unknown, kind: typeof ALBUM_ACCEPT_KIND | typeof ALBUM_END_KIND) {
  const request = validateAlbumActionRequest(input, kind);
  const body = validateAlbumAction(await signedBody(env, actor, request.action, kind)), row = await membership(env, actor, id);
  if (body.albumId !== id || body.definitionSignature !== (JSON.parse(row.definition) as SignedPayloadV1).signature) fail("BODY_MISMATCH");
  return row;
}
export async function accept(env: Env, actor: Actor, id: string, input: unknown) {
  const row = await action(env, actor, id, input, ALBUM_ACCEPT_KIND);
  if (row.ended !== null) fail("ALBUM_INACTIVE", 403);
  if (row.status === "accepted") return overview(row);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='accepted' AND a.ended IS NULL").bind(actor.accountId).first<{count: number}>();
  if ((count?.count ?? 0) >= 50) fail("ALBUM_LIMIT", 413);
  await batchGuard(env, "EXISTS(SELECT 1 FROM albums WHERE id=? AND ended IS NULL) AND (SELECT COUNT(*) FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='accepted' AND a.ended IS NULL)<50", [id, actor.accountId], [env.DB.prepare("UPDATE album_members SET status='accepted',accepted_payload=? WHERE album_id=? AND account_id=? AND status='invited'").bind(json((input as any).action), id, actor.accountId)], "VERSION_CONFLICT");
  return overview(await membership(env, actor, id));
}
export async function end(env: Env, actor: Actor, id: string, input: unknown) {
  const row = await action(env, actor, id, input, ALBUM_END_KIND);
  if (row.owner !== actor.accountId) fail("FORBIDDEN", 403);
  if (row.ended === null) await env.DB.prepare("UPDATE albums SET ended=? WHERE id=? AND owner=? AND ended IS NULL").bind(Date.now(), id, actor.accountId).run();
  return overview(await membership(env, actor, id));
}
export async function append(env: Env, actor: Actor, id: string, input: unknown) {
  if (!albumUUID(id)) fail("INVALID_WIRE");
  const request = validateAlbumAppend(input), body = json(request);
  const prior = await env.DB.prepare("SELECT body,result FROM album_operations WHERE album_id=? AND account_id=? AND operation_id=?").bind(id, actor.accountId, request.operationId).first<{body: string; result: string}>();
  if (prior) {if (prior.body !== body) fail("IDEMPOTENCY_CONFLICT", 409); return JSON.parse(prior.result);}
  const row = await membership(env, actor, id);
  if (row.ended !== null || row.status !== "accepted") fail("ALBUM_INACTIVE", 403);
  const addedIDs: string[] = [], writes: D1PreparedStatement[] = [];
  for (let index = 0; index < request.entries.length; index++) {
    const entry = request.entries[index], signedManifest = request.manifests[index];
    const photo = validateAlbumPhoto(await signedBody(env, actor, entry, ALBUM_PHOTO_KIND));
    let manifestKind: string; try {manifestKind = acceptedPhotoManifestKind(signedManifest.kind);} catch {fail("INVALID_WIRE");}
    const manifest = await signedBody<PhotoManifestV1>(env, actor, signedManifest, manifestKind!, "PhotoManifestV1");
    if (photo.albumId !== id || photo.ownerAccountId !== actor.accountId || manifest.ownerAccountId !== actor.accountId || photo.photoId !== manifest.photoId) fail("BODY_MISMATCH");
    const owned = await env.DB.prepare("SELECT signed FROM photos WHERE id=? AND account_id=?").bind(photo.photoId, actor.accountId).first<{signed: string}>();
    if (!owned || owned.signed !== json(signedManifest)) fail("FORBIDDEN", 403);
    const existing = await env.DB.prepare("SELECT entry FROM album_photos WHERE album_id=? AND photo_id=?").bind(id, photo.photoId).first<{entry: string}>();
    if (existing) {if (existing.entry !== json(entry)) fail("IDEMPOTENCY_CONFLICT", 409); continue;}
    addedIDs.push(photo.photoId);
    writes.push(env.DB.prepare("INSERT INTO album_photos(album_id,photo_id,owner,entry) VALUES(?,?,?,?)").bind(id, photo.photoId, actor.accountId, json(entry)));
  }
  if (row.count + addedIDs.length > ALBUM_MAX_PHOTOS) fail("PHOTO_LIMIT", 413);
  const result = {version: 1, albumId: id, operationId: request.operationId, added: addedIDs.length, photoCount: row.count + addedIDs.length};
  const fresh = addedIDs.length ? ` AND NOT EXISTS(SELECT 1 FROM album_photos WHERE album_id=? AND photo_id IN (${addedIDs.map(() => "?").join(",")}))` : "";
  await batchGuard(env, active + " AND (SELECT COUNT(*) FROM album_photos WHERE album_id=?)=? AND NOT EXISTS(SELECT 1 FROM album_operations WHERE album_id=? AND account_id=? AND operation_id=?)" + fresh,
    [id, actor.accountId, id, row.count, id, actor.accountId, request.operationId, ...(addedIDs.length ? [id, ...addedIDs] : [])],
    [...writes, env.DB.prepare("INSERT INTO album_operations(album_id,account_id,operation_id,body,result) VALUES(?,?,?,?,?)").bind(id, actor.accountId, request.operationId, body, json(result))], "VERSION_CONFLICT");
  return result;
}
