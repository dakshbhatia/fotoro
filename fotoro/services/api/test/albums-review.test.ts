import {it, expect} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {b64, unb64, json, utf8} from "../src/errors";
import {actors, seed, signed, http, photo} from "./helpers";
import fixtures from "../../../fixtures/accounts.json";
import {validateAlbumAppendResult, readAlbumSignedBody, validateAlbumPhoto, validateAlbumDefinition, ALBUM_DEFINITION_KIND, ALBUM_PHOTO_KIND} from "@fotoro/contracts/albums";

async function album(owner = 0) {
  const id = crypto.randomUUID(), definition = await signed(owner, "album-v1", {version: 1, albumId: id, ownerAccountId: actors[owner].accountId,
    createdAt: new Date().toISOString(), encryptedTitle: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(32))},
    members: fixtures.accounts.map(card => ({card, sealedAlbumKey: b64(new Uint8Array(80))}))});
  const request = {version: 1, definition};
  expect((await http(owner, "/v1/albums", "POST", request)).status).toBe(200);
  return {id, definition, request, action: {version: 1, albumId: id, definitionSignature: definition.signature}};
}
async function accept(value: Awaited<ReturnType<typeof album>>, index = 1) {
  expect((await http(index, `/v1/albums/${value.id}/accept`, "POST", {version: 1, action: await signed(index, "album-accept-v1", value.action)})).status).toBe(200);
}
async function append(index: number, id: string, source: Awaited<ReturnType<typeof photo>>) {
  return {version: 1, operationId: crypto.randomUUID(), entries: [await signed(index, "album-photo-v1", {version: 1, albumId: id, photoId: source.m.photoId,
    ownerAccountId: actors[index].accountId, wrappedMetadataKey: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(48))}})], manifests: [source.s]};
}
async function end(value: Awaited<ReturnType<typeof album>>) {
  return http(0, `/v1/albums/${value.id}/end`, "POST", {version: 1, action: await signed(0, "album-end-v1", value.action)});
}
function deferred() {let resolve!: () => void; const promise = new Promise<void>(yes => {resolve = yes;}); return {promise, resolve};}

it("ending an album while R2 is pending denies delivery after the storage await", async () => {
  await seed(); const a = await album(), source = await photo(0); await accept(a);
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", await append(0, a.id, source))).status).toBe(200);
  const entered = deferred(), resume = deferred(); let cancelled = false;
  const alteredEnv = {...env, BUCKET: {get: async (key: string) => {
    const original = await env.BUCKET.get(key); await original!.body.cancel(); entered.resolve(); await resume.promise;
    return {...original, size: original!.size, body: new ReadableStream<Uint8Array>({pull() {}, cancel() {cancelled = true;}})};
  }}};
  const pending = app.fetch(new Request("http://localhost:8787/v1/objects/" + source.m.representations[0].objectId,
    {headers: {authorization: "Bearer public-test-1", origin: "http://localhost:4310"}}), alteredEnv as any);
  await entered.promise;
  expect((await end(a)).status).toBe(200); resume.resolve();
  const result = await pending; expect(result.status).toBe(403); expect(cancelled).toBe(true);
  expect(await result.json()).toMatchObject({code: "FORBIDDEN"});
});

it("concurrent append retries converge to one operation and one immutable photo", async () => {
  await seed(); const a = await album(), source = await photo(0), request = await append(0, a.id, source);
  const concurrent = await Promise.all([http(0, `/v1/albums/${a.id}/photos`, "POST", request), http(0, `/v1/albums/${a.id}/photos`, "POST", request)]);
  expect(concurrent.some(response => response.status === 200)).toBe(true);
  expect(concurrent.every(response => [200, 409].includes(response.status))).toBe(true);
  const receipt = validateAlbumAppendResult(await (await http(0, `/v1/albums/${a.id}/photos`, "POST", request)).json());
  expect(receipt).toMatchObject({added: 1, photoCount: 1, operationId: request.operationId});
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_operations WHERE album_id=?").bind(a.id).first<any>()).n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?").bind(a.id).first<any>()).n).toBe(1);
  const altered = readAlbumSignedBody(request.entries[0], ALBUM_PHOTO_KIND, validateAlbumPhoto);
  altered.wrappedMetadataKey.nonce = b64(crypto.getRandomValues(new Uint8Array(24)));
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", {...request, entries: [await signed(0, ALBUM_PHOTO_KIND, altered)]})).status).toBe(409);
  expect((await end(a)).status).toBe(200);
  expect(await (await http(0, `/v1/albums/${a.id}/photos`, "POST", request)).json()).toEqual(receipt);
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", {...request, operationId: crypto.randomUUID()})).status).toBe(403);
});

it("independent concurrent appends or ending cannot leave partial operations or later access", async () => {
  await seed(); const a = await album(), left = await photo(0), right = await photo(0); await accept(a);
  const requests = [await append(0, a.id, left), await append(0, a.id, right)];
  const results = await Promise.all(requests.map(request => http(0, `/v1/albums/${a.id}/photos`, "POST", request)));
  expect(results.every(response => [200, 409].includes(response.status))).toBe(true);
  for (let index = 0; index < results.length; index++) expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", requests[index])).status).toBe(200);
  const next = await photo(0), request = await append(0, a.id, next);
  const [ended, appended] = await Promise.all([end(a), http(0, `/v1/albums/${a.id}/photos`, "POST", request)]);
  expect(ended.status).toBe(200); expect([200, 403, 409]).toContain(appended.status);
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=? AND photo_id=?").bind(a.id, next.m.photoId).first<any>()).n;
  const operations = (await env.DB.prepare("SELECT COUNT(*) AS n FROM album_operations WHERE album_id=? AND operation_id=?").bind(a.id, request.operationId).first<any>()).n;
  expect(count).toBe(operations); expect(count).toBe(appended.status === 200 ? 1 : 0);
  expect((await http(1, `/v1/albums/${a.id}`)).status).toBe(403);
  expect((await http(1, `/v1/objects/${left.m.metadataRepresentation.objectId}`)).status).toBe(403);
});

it("pending invitations cannot exhaust accepted quota and accepted quota remains atomic", async () => {
  await seed(); const invitations = [];
  await env.DB.prepare("UPDATE albums SET ended=? WHERE ended IS NULL").bind(Date.now()).run();
  try {
  // Synthetic setup isolates quota behavior without making 50 network creations.
  for (let count = 0; count < 50; count++) {
    const id = crypto.randomUUID(), definition = await signed(0, "album-v1", {version: 1, albumId: id, ownerAccountId: actors[0].accountId,
      createdAt: new Date().toISOString(), encryptedTitle: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(32))},
      members: fixtures.accounts.map(card => ({card, sealedAlbumKey: b64(new Uint8Array(80))}))});
    invitations.push({id, definition});
    await env.DB.batch([env.DB.prepare("INSERT INTO albums(id,owner,definition,created_at) VALUES(?,?,?,?)").bind(id, actors[0].accountId, json(definition), Date.now() + count),
      env.DB.prepare("INSERT INTO album_members VALUES(?,?,'accepted',NULL)").bind(id, actors[0].accountId),
      env.DB.prepare("INSERT INTO album_members VALUES(?,?,'invited',NULL)").bind(id, actors[1].accountId)]);
  }
  const own = await album(1);
  const inbox = await (await http(1, "/v1/albums")).json() as any;
  expect(inbox.albums[0]).toMatchObject({membership: "accepted", definition: own.definition});
  expect((await http(0, "/v1/albums", "POST", (await albumRequest(0)))).status).toBe(413);
  await env.DB.prepare("UPDATE album_members SET status='accepted' WHERE account_id=? AND album_id IN (SELECT id FROM albums WHERE owner=? AND ended IS NULL LIMIT 48)")
    .bind(actors[1].accountId, actors[0].accountId).run();
  const available = await env.DB.prepare("SELECT m.album_id FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='invited' AND a.ended IS NULL LIMIT 2").bind(actors[1].accountId).all<any>();
  const races = await Promise.all(available.results.map(async row => {
    const invitation = invitations.find(value => value.id === row.album_id)!;
    return http(1, `/v1/albums/${invitation.id}/accept`, "POST", {version: 1, action: await signed(1, "album-accept-v1", {version: 1, albumId: invitation.id, definitionSignature: invitation.definition.signature})});
  }));
  expect(races.filter(response => response.status === 200)).toHaveLength(1);
  expect(races.every(response => [200, 409, 413].includes(response.status))).toBe(true);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='accepted' AND a.ended IS NULL").bind(actors[1].accountId).first<any>()).n).toBe(50);
  const unaccepted = await env.DB.prepare("SELECT m.album_id FROM album_members m JOIN albums a ON a.id=m.album_id WHERE m.account_id=? AND m.status='invited' AND a.ended IS NULL LIMIT 1").bind(actors[1].accountId).first<any>();
  const remaining = invitations.find(value => value.id === unaccepted.album_id)!;
  expect((await http(1, `/v1/albums/${remaining.id}/accept`, "POST", {version: 1, action: await signed(1, "album-accept-v1", {version: 1, albumId: remaining.id, definitionSignature: remaining.definition.signature})})).status).toBe(413);
  expect((await env.DB.prepare("SELECT status FROM album_members WHERE album_id=? AND account_id=?").bind(remaining.id, actors[1].accountId).first<any>()).status).toBe("invited");
  } finally {await env.DB.prepare("UPDATE albums SET ended=? WHERE ended IS NULL").bind(Date.now()).run();}
});

it("concurrent identical album creation preserves the immutable definition and roster", async () => {
  await seed(); const request = await albumRequest(), id = readAlbumSignedBody(request.definition, ALBUM_DEFINITION_KIND, validateAlbumDefinition).albumId;
  const results = await Promise.all([http(0, "/v1/albums", "POST", request), http(0, "/v1/albums", "POST", request)]);
  expect(results.some(response => response.status === 200)).toBe(true);
  expect(results.every(response => [200, 409].includes(response.status))).toBe(true);
  const retry = await http(0, "/v1/albums", "POST", request); expect(retry.status).toBe(200);
  expect((await retry.json() as any).definition).toEqual(request.definition);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM albums WHERE id=?").bind(id).first<any>()).n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_members WHERE album_id=?").bind(id).first<any>()).n).toBe(fixtures.accounts.length);
});

async function albumRequest(owner = 0) {
  return {version: 1, definition: await signed(owner, "album-v1", {version: 1, albumId: crypto.randomUUID(), ownerAccountId: actors[owner].accountId,
    createdAt: new Date().toISOString(), encryptedTitle: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(32))},
    members: fixtures.accounts.map(card => ({card, sealedAlbumKey: b64(new Uint8Array(80))}))})};
}

it("invalid manifest kinds, private fields and oversized bodies fail before writes", async () => {
  await seed(); const a = await album(), source = await photo(0), request = await append(0, a.id, source);
  for (const update of [{manifests: [{...source.s, kind: "photo-annotations-v1"}]}, {entries: [{...request.entries[0], signature: request.entries[0].signature + "="}]}, {caption: "private"}])
    expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", {...request, ...update})).status).toBe(400);
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", {version: 1, filler: "x".repeat(2 * 1024 * 1024)})).status).toBe(413);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?").bind(a.id).first<any>()).n).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_operations WHERE album_id=?").bind(a.id).first<any>()).n).toBe(0);
});

it("a changed session account cannot read album or owned objects under the captured vault identity", async () => {
  await seed(); const a = await album(), source = await photo(0);
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", await append(0, a.id, source))).status).toBe(200);
  // The cookie/session is the accepted owner, but the local vault is still the invited member.
  expect((await http(0, `/v1/albums/${a.id}/access`)).status).toBe(200);
  let reads = 0;
  const alteredEnv = {...env, BUCKET: {get: async () => {reads++; throw new Error("Unexpected R2 read");}}};
  const paths = ["/v1/albums", `/v1/albums/${a.id}`, `/v1/albums/${a.id}/access`, `/v1/photos/${source.m.photoId}/manifest`, `/v1/objects/${source.m.representations[0].objectId}`];
  for (const path of paths) {
    const result = await app.fetch(new Request("http://localhost:8787" + path, {headers: {authorization: "Bearer public-test-0", origin: "http://localhost:4310", "x-fotoro-account-id": actors[1].accountId}}), alteredEnv as any);
    expect(result.status).toBe(403); expect(await result.json()).toMatchObject({code: "ACCOUNT_MISMATCH"});
  }
  const query = await app.fetch(new Request(`http://localhost:8787/v1/albums/${a.id}/access?expectedAlbumAccountId=${actors[1].accountId}`, {headers: {authorization: "Bearer public-test-0", origin: "http://localhost:4310"}}), alteredEnv as any);
  expect(query.status).toBe(403); expect(await query.json()).toMatchObject({code: "ACCOUNT_MISMATCH"});
  const both = await app.fetch(new Request(`http://localhost:8787/v1/objects/${source.m.representations[0].objectId}?expectedAlbumAccountId=${actors[1].accountId}`, {headers: {authorization: "Bearer public-test-0", origin: "http://localhost:4310", "x-fotoro-account-id": actors[0].accountId}}), alteredEnv as any);
  expect(both.status).toBe(403); expect(await both.json()).toMatchObject({code: "ACCOUNT_MISMATCH"});
  expect(reads).toBe(0);
});

it("albums preserve an existing valid legacy manifest's noncompact signed bytes", async () => {
  await seed(); const a = await album(), source = await photo(0);
  const body = b64(new TextEncoder().encode(JSON.stringify(source.m, null, 2)));
  const der = new Uint8Array(48); der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);
  der.set(unb64(fixtures.testSecrets[0].signingSecretKey).slice(0, 32), 16);
  const key = await crypto.subtle.importKey("pkcs8", der, {name: "Ed25519"}, false, ["sign"]);
  const signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, utf8(["fotoro-signed-v1", source.s.kind, source.s.accountId, body]))));
  const original = {...source.s, body, signature};
  // Reset only the fixture record; the original objects remain real committed upload objects.
  await env.DB.batch([env.DB.prepare("DELETE FROM retention WHERE photo_id=?").bind(source.m.photoId), env.DB.prepare("DELETE FROM photos WHERE id=?").bind(source.m.photoId)]);
  expect((await http(0, "/v1/photos", "POST", original)).status).toBe(200);
  expect(await (await http(0, `/v1/photos/${source.m.photoId}/manifest`)).json()).toEqual(original);
  const request = await append(0, a.id, {...source, s: original});
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", request)).status).toBe(200);
  expect((await (await http(0, `/v1/albums/${a.id}`)).json() as any).manifests).toEqual([original]);
});
