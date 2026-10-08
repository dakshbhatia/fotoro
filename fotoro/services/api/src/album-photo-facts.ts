import {albumUUID} from "@fotoro/contracts/albums";
import {ALBUM_FACTS_KIND, ALBUM_FACTS_PAGE_SIZE, validateAlbumPhotoFactsRequest, validateAlbumPhotoFactsReply, validateAlbumPhotoFactsPage, readAlbumPhotoFacts} from "@fotoro/contracts/album-photo-facts";
import {type Env, type Actor, fail, json, signedBody} from "./errors";

const active = "EXISTS(SELECT 1 FROM albums a JOIN album_members m ON m.album_id=a.id WHERE a.id=? AND a.ended IS NULL AND m.account_id=? AND m.status='accepted')";
async function requireActive(env: Env, actor: Actor, albumId: string) {
  if (!albumUUID(albumId)) fail("INVALID_WIRE");
  const row = await env.DB.prepare("SELECT a.definition FROM albums a JOIN album_members m ON m.album_id=a.id WHERE a.id=? AND a.ended IS NULL AND m.account_id=? AND m.status='accepted'").bind(albumId, actor.accountId).first<{definition: string}>();
  if (!row) fail("ALBUM_INACTIVE", 403);
  return JSON.parse(row!.definition).signature as string;
}
async function requirePhoto(env: Env, albumId: string, photoId: string) {
  if (!albumUUID(photoId)) fail("INVALID_WIRE");
  const row = await env.DB.prepare("SELECT p.owner FROM album_photos p JOIN photos f ON f.id=p.photo_id AND f.account_id=p.owner WHERE p.album_id=? AND p.photo_id=?").bind(albumId, photoId).first<{owner: string}>();
  if (!row) fail("FORBIDDEN", 403);
  return row!.owner;
}
export const capabilities = () => ({version: 1, albumFactsVersion: 1});
export async function get(env: Env, actor: Actor, albumId: string, photoId: string) {
  await requireActive(env, actor, albumId); await requirePhoto(env, albumId, photoId);
  const row = await env.DB.prepare("SELECT signed FROM album_photo_facts WHERE album_id=? AND photo_id=?").bind(albumId, photoId).first<{signed: string}>();
  await requireActive(env, actor, albumId);
  return validateAlbumPhotoFactsReply({version: 1, facts: row ? JSON.parse(row.signed) : null});
}
export async function list(env: Env, actor: Actor, albumId: string, cursor: string | undefined) {
  await requireActive(env, actor, albumId);
  if (cursor !== undefined && (!/^[0-9]{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) fail("INVALID_WIRE");
  const rows = await env.DB.prepare("SELECT p.sequence,f.signed FROM album_photo_facts f JOIN album_photos p ON p.album_id=f.album_id AND p.photo_id=f.photo_id WHERE f.album_id=? AND p.sequence>? ORDER BY p.sequence LIMIT ?").bind(albumId, Number(cursor ?? 0), ALBUM_FACTS_PAGE_SIZE + 1).all<{sequence: number; signed: string}>();
  await requireActive(env, actor, albumId);
  const page = rows.results.slice(0, ALBUM_FACTS_PAGE_SIZE), hasMore = rows.results.length > ALBUM_FACTS_PAGE_SIZE;
  return validateAlbumPhotoFactsPage({version: 1, facts: page.map(row => JSON.parse(row.signed)), nextCursor: hasMore ? String(page.at(-1)!.sequence) : null, hasMore});
}
export async function put(env: Env, actor: Actor, albumId: string, photoId: string, input: unknown) {
  const definitionSignature = await requireActive(env, actor, albumId), owner = await requirePhoto(env, albumId, photoId);
  if (owner !== actor.accountId) fail("FORBIDDEN", 403);
  const request = validateAlbumPhotoFactsRequest(input), value = readAlbumPhotoFacts(request.facts);
  await signedBody(env, actor, request.facts, ALBUM_FACTS_KIND);
  if (value.albumId !== albumId || value.photoId !== photoId || value.ownerAccountId !== owner || value.definitionSignature !== definitionSignature) fail("SOURCE_MISMATCH");
  const proof = json(request.facts);
  // Membership, contribution ownership and revision are checked in the same
  // atomic statement. The server stores only the contributor's signed ciphertext.
  const written = await env.DB.prepare(`INSERT INTO album_photo_facts(album_id,photo_id,owner,revision,signed) SELECT ?,?,?,?,? WHERE ${active} AND EXISTS(SELECT 1 FROM album_photos p JOIN photos f ON f.id=p.photo_id AND f.account_id=p.owner WHERE p.album_id=? AND p.photo_id=? AND p.owner=?) AND ((?=1 AND NOT EXISTS(SELECT 1 FROM album_photo_facts WHERE album_id=? AND photo_id=?)) OR EXISTS(SELECT 1 FROM album_photo_facts WHERE album_id=? AND photo_id=? AND owner=? AND revision=?)) ON CONFLICT(album_id,photo_id) DO UPDATE SET revision=excluded.revision,signed=excluded.signed WHERE album_photo_facts.owner=excluded.owner AND album_photo_facts.revision=?`)
    .bind(albumId, photoId, owner, value.revision, proof, albumId, actor.accountId, albumId, photoId, owner, value.revision, albumId, photoId, albumId, photoId, owner, value.revision - 1, value.revision - 1).run();
  await requireActive(env, actor, albumId);
  if (written.meta.changes !== 1) {
    const current = await env.DB.prepare("SELECT signed FROM album_photo_facts WHERE album_id=? AND photo_id=?").bind(albumId, photoId).first<{signed: string}>();
    if (current?.signed !== proof) fail("VERSION_CONFLICT", 409);
    await requireActive(env, actor, albumId);
  }
  return validateAlbumPhotoFactsReply({version: 1, facts: request.facts});
}
