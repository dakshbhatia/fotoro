import {it, expect} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {b64, json, utf8} from "../src/errors";
import {actors, seed, signed, http, photo, share} from "./helpers";
import fixtures from "../../../fixtures/accounts.json";
import type {AccountCardV1} from "@fotoro/contracts";

async function person() {
  const keys = await crypto.subtle.generateKey({name: "Ed25519"}, true, ["sign", "verify"]);
  const card: AccountCardV1 = {version: 1, accountId: crypto.randomUUID(), boxPublicKey: b64(crypto.getRandomValues(new Uint8Array(32))), signingPublicKey: b64(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))};
  const device = crypto.randomUUID(), token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(card.accountId, json(card)).run();
  await env.DB.prepare("INSERT INTO devices(id,account_id,trusted) VALUES(?,?,1)").bind(device, card.accountId).run();
  await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)").bind(b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))), card.accountId, device, Date.now() + 60000).run();
  return {card,
    sign: async (kind: string, body: unknown) => {
      const payload = {version: 1, kind, accountId: card.accountId, body: b64(utf8(body)), signature: ""};
      payload.signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, utf8(["fotoro-signed-v1", kind, card.accountId, payload.body])))); return payload;
    },
    http: (path: string, method = "GET", body?: unknown) => app.fetch(new Request("http://localhost:8787" + path, {method, headers: {authorization: "Bearer " + token, origin: "http://localhost:4310", "content-type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}), env as any),
  };
}
async function album(extra?: AccountCardV1) {
  const id = crypto.randomUUID();
  const body = {version: 1, albumId: id, ownerAccountId: actors[0].accountId, createdAt: new Date().toISOString(), encryptedTitle: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(32))}, members: [...fixtures.accounts, ...(extra ? [extra] : [])].map(card => ({card, sealedAlbumKey: b64(new Uint8Array(80))}))};
  const definition = await signed(0, "album-v1", body), request = {version: 1, definition};
  expect((await http(0, "/v1/albums", "POST", request)).status).toBe(200);
  return {id, definition, request, action: {version: 1, albumId: id, definitionSignature: definition.signature}};
}
async function append(index: number, id: string, source: Awaited<ReturnType<typeof photo>>) {
  return {version: 1, operationId: crypto.randomUUID(), entries: [await signed(index, "album-photo-v1", {version: 1, albumId: id, photoId: source.m.photoId, ownerAccountId: actors[index].accountId, wrappedMetadataKey: {version: 1, nonce: b64(new Uint8Array(24)), ciphertext: b64(new Uint8Array(48))}})], manifests: [source.s]};
}
it("three members share unchanged owned originals only after accepting; ending fences every contributor", async () => {
  await seed(); const third = await person(), outsider = await person(), a = await album(third.card), owned = await photo(0), sibling = await photo(1), unrelated = await photo(1);
  const first = await append(0, a.id, owned), second = await append(1, a.id, sibling);
  expect(await (await http(0, `/v1/photos/${owned.m.photoId}/manifest`)).json()).toEqual(owned.s);
  expect((await http(1, `/v1/photos/${owned.m.photoId}/manifest`)).status).toBe(403);
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", first)).status).toBe(200);
  expect((await http(1, `/v1/albums/${a.id}`)).status).toBe(403);
  expect((await third.http(`/v1/albums/${a.id}`)).status).toBe(403);
  expect((await third.http(`/v1/albums/${a.id}/access`)).status).toBe(403);
  expect((await third.http(`/v1/objects/${owned.m.representations[0].objectId}`)).status).toBe(403);
  expect((await http(1, `/v1/albums/${a.id}/photos`, "POST", second)).status).toBe(403);
  expect((await outsider.http(`/v1/albums/${a.id}/accept`, "POST", {version: 1, action: await outsider.sign("album-accept-v1", a.action)})).status).toBe(403);
  expect((await http(1, `/v1/albums/${a.id}/accept`, "POST", {version: 1, action: await signed(1, "album-accept-v1", a.action)})).status).toBe(200);
  expect((await third.http(`/v1/albums/${a.id}/accept`, "POST", {version: 1, action: await third.sign("album-accept-v1", a.action)})).status).toBe(200);
  const receipt = await (await http(1, `/v1/albums/${a.id}/photos`, "POST", second)).json();
  expect(receipt).toMatchObject({added: 1, photoCount: 2});
  const detail = await (await third.http(`/v1/albums/${a.id}`)).json() as any;
  expect(detail.manifests).toEqual([owned.s, sibling.s]);
  expect(detail.photoCount).toBe(2); expect(detail.hasMore).toBe(false);
  expect(await (await third.http(`/v1/albums/${a.id}/access`)).json()).toEqual({definition: a.definition, membership: "accepted", endedAt: null, photoCount: 2});
  expect((await third.http(`/v1/objects/${sibling.m.representations[0].objectId}`)).status).toBe(200);
  expect((await third.http(`/v1/objects/${unrelated.m.representations[0].objectId}`)).status).toBe(403);
  expect((await outsider.http(`/v1/objects/${owned.m.representations[0].objectId}`)).status).toBe(403);
  expect((await http(1, `/v1/albums/${a.id}/end`, "POST", {version: 1, action: await signed(1, "album-end-v1", a.action)})).status).toBe(403);
  expect((await http(0, `/v1/albums/${a.id}/end`, "POST", {version: 1, action: await signed(0, "album-end-v1", a.action)})).status).toBe(200);
  expect((await third.http(`/v1/albums/${a.id}`)).status).toBe(403);
  expect((await third.http(`/v1/albums/${a.id}/access`)).status).toBe(403);
  expect((await third.http(`/v1/objects/${sibling.m.representations[0].objectId}`)).status).toBe(403);
  expect((await http(1, `/v1/objects/${sibling.m.representations[0].objectId}`)).status).toBe(200);
  expect(await (await http(1, `/v1/albums/${a.id}/photos`, "POST", second)).json()).toEqual(receipt);
  expect((await http(1, `/v1/albums/${a.id}/photos`, "POST", {...second, operationId: crypto.randomUUID()})).status).toBe(403);
  expect((await http(1, `/v1/albums/${a.id}/photos`, "POST", {...second, manifests: [unrelated.s]})).status).toBe(400);
  expect((await http(0, "/v1/albums", "POST", a.request)).status).toBe(200);
  const inbox = await (await third.http("/v1/albums")).json() as any;
  expect(inbox.albums.find((row: any) => row.definition.signature === a.definition.signature).endedAt).not.toBeNull();
});
it("rejects forged identities, cross-album entries and changed signed originals without writing", async () => {
  await seed(); const a = await album(), other = await album(), source = await photo(0);
  const request = await append(0, a.id, source);
  expect((await http(0, `/v1/albums/${other.id}/photos`, "POST", request)).status).toBe(400);
  const altered = {...source.m, ownerWrappedMetadataKey: {...source.m.ownerWrappedMetadataKey, ciphertext: b64(crypto.getRandomValues(new Uint8Array(48)))}};
  expect((await http(0, `/v1/albums/${a.id}/photos`, "POST", {...request, manifests: [await signed(0, "photo-manifest", altered)]})).status).toBe(403);
  expect((await http(1, `/v1/albums/${a.id}/accept`, "POST", {version: 1, action: await signed(1, "album-accept-v1", {...a.action, definitionSignature: other.definition.signature})})).status).toBe(400);
  const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(a.definition.body.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))));
  body.albumId = crypto.randomUUID(); body.members[1].card.boxPublicKey = b64(crypto.getRandomValues(new Uint8Array(32)));
  expect((await http(0, "/v1/albums", "POST", {version: 1, definition: await signed(0, "album-v1", body)})).status).toBe(400);
  expect((await http(0, `/v1/albums/${a.id}?cursor=-1`)).status).toBe(400);
  expect((await http(0, `/v1/albums/${a.id}?cursor=9007199254740992`)).status).toBe(400);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?").bind(a.id).first<any>()).n).toBe(0);
});
it("pages more than 100 photos and rejects overflow before any album or operation write", async () => {
  await seed(); const a = await album(), source = await photo(0);
  for (let start = 0; start < 101; start += 50) {
    const statements: ReturnType<typeof env.DB.prepare>[] = [];
    for (let n = start; n < Math.min(start + 50, 101); n++) {
      const id = crypto.randomUUID(), manifest = {...source.m, photoId: id}, signedManifest = await signed(0, "photo-manifest", manifest), entry = (await append(0, a.id, {m: manifest, s: signedManifest})).entries[0];
      statements.push(env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(id, actors[0].accountId, json(manifest), json(signedManifest)), env.DB.prepare("INSERT INTO album_photos(album_id,photo_id,owner,entry) VALUES(?,?,?,?)").bind(a.id, id, actors[0].accountId, json(entry)));
    }
    await env.DB.batch(statements);
  }
  const first = await (await http(0, `/v1/albums/${a.id}`)).json() as any;
  expect(first.entries).toHaveLength(100); expect(first.hasMore).toBe(true);
  const next = await (await http(0, `/v1/albums/${a.id}?cursor=${first.nextCursor}`)).json() as any;
  expect(next.entries).toHaveLength(1); expect(next.hasMore).toBe(false);
  expect(new Set([...first.manifests, ...next.manifests].map((s: any) => s.body)).size).toBe(101);
  // Populate the remaining capacity as isolated database setup; the rejected real HTTP append must leave it unchanged.
  for (let start = 101; start < 1000; start += 50) {
    const statements: ReturnType<typeof env.DB.prepare>[] = [];
    for (let n = start; n < Math.min(start + 50, 1000); n++) {
      const id = crypto.randomUUID(); statements.push(env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(id, actors[0].accountId, json(source.m), json(source.s)), env.DB.prepare("INSERT INTO album_photos(album_id,photo_id,owner,entry) VALUES(?,?,?,?)").bind(a.id, id, actors[0].accountId, "{}"));
    }
    await env.DB.batch(statements);
  }
  const request = await append(0, a.id, source), rejected = await http(0, `/v1/albums/${a.id}/photos`, "POST", request);
  expect(rejected.status).toBe(413); expect(await rejected.json()).toMatchObject({code: "PHOTO_LIMIT"});
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id=?").bind(a.id).first<any>()).n).toBe(1000);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM album_operations WHERE operation_id=?").bind(request.operationId).first<any>()).n).toBe(0);
});
it("legacy moments cannot commit a contribution past the reader's aggregate 100-photo limit", async () => {
  await seed(); const source = await photo(0), contribution = await photo(1), moment = crypto.randomUUID();
  const grant = await (await http(0, `/v1/moments/${moment}/grants/options`, "POST", {version: 1, recipientAccountId: actors[1].accountId, role: "contributor", access: "ongoing"})).json() as any;
  const envelopes = [await share(0, grant, source.m.photoId)];
  expect((await http(0, `/v1/moments/${moment}/grants`, "POST", {version: 1, grant, envelopes, signedPayload: await signed(0, "grant", {grant, envelopes})})).status).toBe(200);
  for (let n = 1; n < 100; n++) {
    const id = crypto.randomUUID(); await env.DB.batch([env.DB.prepare("INSERT INTO photos VALUES(?,?,?,?)").bind(id, actors[0].accountId, json(source.m), json(source.s)), env.DB.prepare("INSERT INTO grant_photos VALUES(?,?,?)").bind(grant.grantId, id, json(envelopes[0]))]);
  }
  const input = {version: 1, operationId: crypto.randomUUID(), expectedGrantVersion: 1, manifests: [contribution.s], envelopes: [await share(1, grant, contribution.m.photoId)]};
  const response = await http(1, `/v1/moments/${moment}/contributions`, "POST", input);
  expect(response.status).toBe(413); expect(await response.json()).toMatchObject({code: "PHOTO_LIMIT"});
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM grant_photos WHERE grant_id=?").bind(grant.grantId).first<any>()).n).toBe(100);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributions WHERE operation_id=?").bind(input.operationId).first<any>()).n).toBe(0);
});
