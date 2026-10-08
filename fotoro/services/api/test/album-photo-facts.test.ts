import {it, expect} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {actors, seed, signed, http, photo} from "./helpers";
import {b64, json} from "../src/errors";
import accounts from "../../../fixtures/accounts.json";
import {ALBUM_FACTS_KIND, readAlbumPhotoFacts, validateAlbumPhotoFactsPage} from "@fotoro/contracts/album-photo-facts";
import {validateAlbumDetail} from "@fotoro/contracts/albums";
async function fixture(owner = 0) {
  await seed(); const id = crypto.randomUUID(), source = await photo(owner);
  const definition = await signed(0, "album-v1", {version: 1, albumId: id, ownerAccountId: actors[0].accountId, createdAt: new Date().toISOString(), encryptedTitle: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(32))}, members: accounts.accounts.map(card => ({card, sealedAlbumKey: b64(new Uint8Array(80))}))});
  expect((await http(0, "/v1/albums", "POST", {version: 1, definition})).status).toBe(200);
  const action = {version: 1, albumId: id, definitionSignature: definition.signature};
  const accept = async () => {expect((await http(1, `/v1/albums/${id}/accept`, "POST", {version: 1, action: await signed(1, "album-accept-v1", action)})).status).toBe(200);};
  if (owner === 1) await accept();
  const entry = await signed(owner, "album-photo-v1", {version: 1, albumId: id, photoId: source.m.photoId, ownerAccountId: actors[owner].accountId, wrappedMetadataKey: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(48))}});
  expect((await http(owner, `/v1/albums/${id}/photos`, "POST", {version: 1, operationId: crypto.randomUUID(), entries: [entry], manifests: [source.s]})).status).toBe(200);
  return {id, source, definition, owner, accept, path: `/v1/albums/${id}/photo-facts/${source.m.photoId}`, end: async () => http(0, `/v1/albums/${id}/end`, "POST", {version: 1, action: await signed(0, "album-end-v1", action)})};
}
async function publication(a: Awaited<ReturnType<typeof fixture>>, revision = 1, extra = {}) {
  return signed(a.owner, ALBUM_FACTS_KIND, {version: 1, albumId: a.id, photoId: a.source.m.photoId, ownerAccountId: actors[a.owner].accountId, definitionSignature: a.definition.signature, revision, encrypted: {version: 1, nonce: b64(crypto.getRandomValues(new Uint8Array(24))), ciphertext: b64(crypto.getRandomValues(new Uint8Array(64)))}, ...extra});
}
it("accepted members read only ciphertext; contributor updates do not widen old album wires", async () => {
  const a = await fixture(1), first = await publication(a);
  expect(await (await http(0, "/v1/album-photo-facts/capabilities")).json()).toEqual({version: 1, albumFactsVersion: 1});
  expect(await (await http(0, a.path)).json()).toEqual({version: 1, facts: null});
  expect((await http(0, a.path, "PUT", {version: 1, facts: first})).status).toBe(403);
  expect(await (await http(1, a.path, "PUT", {version: 1, facts: first})).json()).toEqual({version: 1, facts: first});
  expect(await (await http(0, a.path)).json()).toEqual({version: 1, facts: first});
  for (const revision of [2, 3]) {
    const next = await publication(a, revision);
    expect((await http(1, a.path, "PUT", {version: 1, facts: next})).status).toBe(200);
    expect(await (await http(0, a.path)).json()).toEqual({version: 1, facts: next});
  }
  const stored = await env.DB.prepare("SELECT * FROM album_photo_facts WHERE album_id=? AND photo_id=?").bind(a.id, a.source.m.photoId).first<any>();
  expect(stored.revision).toBe(3);
  expect(Object.keys(readAlbumPhotoFacts(JSON.parse(stored.signed))).sort()).toEqual(["albumId", "definitionSignature", "encrypted", "ownerAccountId", "photoId", "revision", "version"]);
  const detail = validateAlbumDetail(await (await http(0, `/v1/albums/${a.id}`)).json());
  expect(detail.entries).toHaveLength(1); expect(detail.manifests).toEqual([a.source.s]);
  expect(Object.keys(detail).sort()).toEqual(["definition", "endedAt", "entries", "hasMore", "manifests", "membership", "nextCursor", "photoCount", "version"]);
  expect(JSON.stringify(await (await http(0, "/v1/changes?media=1")).json())).not.toContain(ALBUM_FACTS_KIND);
});
it("invited/nonmembers, wrong signer/source/definition and oversized bodies cannot publish or read", async () => {
  const a = await fixture(), first = await publication(a);
  for (const path of [a.path, `/v1/albums/${a.id}/photo-facts`]) expect((await http(1, path)).status).toBe(403);
  expect((await http(1, a.path, "PUT", {version: 1, facts: first})).status).toBe(403);
  await a.accept();
  for (const extra of [{albumId: crypto.randomUUID()}, {photoId: crypto.randomUUID()}, {ownerAccountId: actors[1].accountId}, {definitionSignature: b64(new Uint8Array(64))}]) expect((await http(0, a.path, "PUT", {version: 1, facts: await publication(a, 1, extra)})).status).toBe(400);
  const outer = readAlbumPhotoFacts(first);
  expect((await http(0, a.path, "PUT", {version: 1, facts: await signed(1, ALBUM_FACTS_KIND, outer)})).status).toBe(403);
  expect((await http(0, a.path, "PUT", {version: 1, facts: {...first, signature: b64(new Uint8Array(64))}})).status).toBe(403);
  expect((await http(0, a.path, "PUT", {version: 1, facts: await publication(a, 1, {encrypted: {...outer.encrypted, ciphertext: b64(new Uint8Array(8193))}})})).status).toBe(400);
  expect((await http(0, a.path, "PUT", {version: 1, facts: first, padding: "x".repeat(32769)})).status).toBe(413);
  expect((await http(0, `/v1/albums/${a.id}/photo-facts/${crypto.randomUUID()}`)).status).toBe(403);
  const outsider = crypto.randomUUID(), token = "public-album-facts-outsider", device = crypto.randomUUID();
  await env.DB.batch([env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(outsider, json({...accounts.accounts[0], accountId: outsider})), env.DB.prepare("INSERT INTO devices(id,account_id,trusted) VALUES(?,?,1)").bind(device, outsider), env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)").bind(b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))), outsider, device, Date.now() + 60000)]);
  expect((await app.fetch(new Request("http://localhost:8787" + a.path, {headers: {authorization: "Bearer " + token}}), env as any)).status).toBe(403);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photo_facts WHERE album_id=?").bind(a.id).first<any>()).n).toBe(0);
});
it("same-revision races have one winner; exact replay is idempotent and ending denies old signed retries", async () => {
  const a = await fixture(), first = await publication(a);
  const initial = await Promise.all([http(0, a.path, "PUT", {version: 1, facts: first}), http(0, a.path, "PUT", {version: 1, facts: first})]);
  expect(initial.map(response => response.status)).toEqual([200, 200]);
  const left = await publication(a, 2), right = await publication(a, 2);
  const races = await Promise.all([http(0, a.path, "PUT", {version: 1, facts: left}), http(0, a.path, "PUT", {version: 1, facts: right})]);
  expect(races.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = races[0].status === 200 ? left : right;
  expect(await (await http(0, a.path)).json()).toEqual({version: 1, facts: winner});
  expect((await http(0, a.path, "PUT", {version: 1, facts: first})).status).toBe(409);
  expect((await http(0, a.path, "PUT", {version: 1, facts: winner})).status).toBe(200);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photo_facts WHERE album_id=?").bind(a.id).first<any>()).n).toBe(1);
  expect((await a.end()).status).toBe(200);
  for (const [method, body] of [["GET", undefined], ["PUT", {version: 1, facts: winner}]] as const) expect((await http(0, a.path, method, body)).status).toBe(403);
});
it("ending between PUT preflight and atomic insertion prevents every facts write", async () => {
  const a = await fixture(), facts = await publication(a);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(yes => {entered = yes;}), resumed = new Promise<void>(yes => {release = yes;});
  const database = {prepare(sql: string) {
    if (!sql.startsWith("INSERT INTO album_photo_facts")) return env.DB.prepare(sql);
    return {bind(...args: unknown[]) {return {run: async () => {entered(); await resumed; return env.DB.prepare(sql).bind(...args).run();}};}};
  }};
  const pending = app.fetch(new Request("http://localhost:8787" + a.path, {method: "PUT", headers: {authorization: "Bearer public-test-0", origin: "http://localhost:4310", "content-type": "application/json"}, body: JSON.stringify({version: 1, facts})}), {...env, DB: database} as any);
  await ready; expect((await a.end()).status).toBe(200); release();
  expect((await pending).status).toBe(403);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photo_facts WHERE album_id=?").bind(a.id).first<any>()).n).toBe(0);
});
it("facts paginate100 and readbacks recheck album end after database awaits", async () => {
  const a = await fixture(); const statements: D1PreparedStatement[] = [];
  for (let n = 0; n < 101; n++) {
    const id = crypto.randomUUID(), manifest = {...a.source.m, photoId: id}, signedManifest = await signed(0, "photo-manifest", manifest);
    const entry = await signed(0, "album-photo-v1", {version: 1, albumId: a.id, photoId: id, ownerAccountId: actors[0].accountId, wrappedMetadataKey: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(48))}});
    const facts = await publication(a, 1, {photoId: id});
    statements.push(env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(id, actors[0].accountId, json(manifest), json(signedManifest)), env.DB.prepare("INSERT INTO album_photos(album_id,photo_id,owner,entry) VALUES(?,?,?,?)").bind(a.id, id, actors[0].accountId, json(entry)), env.DB.prepare("INSERT INTO album_photo_facts VALUES(?,?,?,?,?)").bind(a.id, id, actors[0].accountId, 1, json(facts)));
    if (statements.length === 99) await env.DB.batch(statements.splice(0));
  }
  if (statements.length) await env.DB.batch(statements);
  const path = `/v1/albums/${a.id}/photo-facts`, first = validateAlbumPhotoFactsPage(await (await http(0, path)).json());
  expect(first.facts).toHaveLength(100); expect(first.hasMore).toBe(true);
  const last = validateAlbumPhotoFactsPage(await (await http(0, path + "?cursor=" + first.nextCursor)).json());
  expect(last.facts).toHaveLength(1); expect(last.nextCursor).toBeNull(); expect(last.hasMore).toBe(false);
  expect(new Set([...first.facts, ...last.facts].map(value => readAlbumPhotoFacts(value).photoId)).size).toBe(101);
  expect((await http(0, path + "?cursor=-1")).status).toBe(400);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(yes => {entered = yes;}), resumed = new Promise<void>(yes => {release = yes;});
  const database = {prepare(sql: string) {
    if (!sql.startsWith("SELECT p.sequence,f.signed")) return env.DB.prepare(sql);
    return {bind(...args: unknown[]) {return {all: async () => {const rows = await env.DB.prepare(sql).bind(...args).all(); entered(); await resumed; return rows;}};}};
  }};
  const pending = app.fetch(new Request("http://localhost:8787" + path, {headers: {authorization: "Bearer public-test-0"}}), {...env, DB: database} as any);
  await ready; await a.end(); release();
  const denied = await pending; expect(denied.status).toBe(403); expect(await denied.text()).not.toContain(ALBUM_FACTS_KIND);
});
