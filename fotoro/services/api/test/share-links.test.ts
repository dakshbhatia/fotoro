import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { b64 } from "../src/errors";
import { actors, seed, http, photo, share, signed } from "./helpers";
import { createMomentLink, parseShareLink } from "@fotoro/contracts/share-links";
import cards from "../../../fixtures/accounts.json";
import type { AccountCardV1 } from "@fotoro/contracts";

it("associates only configured app IDs with root contact and moment fragments and keeps fixtures inaccessible", async () => {
  const e = {...env, AUTH_MODE: "production", APPLE_APP_IDS: " ABCDEFGHIJ.cloud.fotoro.Fotoro,ABCDEFGHIJ.cloud.fotoro.Fotoro,ZYXWVUTSRQ.cloud.fotoro.Other ",
    ASSETS: {fetch: async () => new Response("Fotoro web")}} as any;
  const response = await app.fetch(new Request("https://fotoro.cloud/.well-known/apple-app-site-association"), e);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    webcredentials: {apps: ["ABCDEFGHIJ.cloud.fotoro.Fotoro", "ZYXWVUTSRQ.cloud.fotoro.Other"]},
    applinks: {details: [{appIDs: ["ABCDEFGHIJ.cloud.fotoro.Fotoro", "ZYXWVUTSRQ.cloud.fotoro.Other"], components: [{"/": "/", "#": "contact=*"}, {"/": "/", "#": "moment=*"}]}]},
  });
  expect((await app.fetch(new Request("https://fotoro.cloud/__fixtures/accounts"), e)).status).toBe(404);
  expect((await app.fetch(new Request("https://fotoro.cloud/v1/grants"), e)).status).toBe(401);
  for (const ids of [undefined, "", " ", "ABCDEFGHIJ.*", "ABCDEFGHIJ.cloud.fotoro.Fotoro,"]) {
    const denied = await app.fetch(new Request("https://fotoro.cloud/.well-known/apple-app-site-association"), {...e, APPLE_APP_IDS: ids});
    expect(denied.status).toBe(503);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  }
});

it("public moment link possession never replaces an authenticated recipient grant", async () => {
  await seed();
  const source = await photo(0), moment = crypto.randomUUID();
  const grant = await (await http(0, `/v1/moments/${moment}/grants/options`, "POST", {version: 1, recipientAccountId: actors[1].accountId, role: "contributor", access: "ongoing"})).json() as any;
  const envelopes = [await share(0, grant, source.m.photoId)];
  expect((await http(0, `/v1/moments/${moment}/grants`, "POST", {version: 1, grant, envelopes, signedPayload: await signed(0, "grant", {grant, envelopes})})).status).toBe(200);
  const link = createMomentLink(grant.grantId, cards.accounts[0] as AccountCardV1);
  const invitation = parseShareLink(link);
  expect(invitation.kind).toBe("moment");
  const endpoint = `/v1/grants/${grant.grantId}`;
  const request = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request("http://localhost:8787" + path, {headers}), env as any);
  expect((await request(endpoint)).status).toBe(401);
  expect((await request(endpoint, {"x-fotoro-fixture-account": actors[1].accountId})).status).toBe(401);
  expect((await request(endpoint, {origin: "https://evil.invalid", authorization: "Bearer public-test-1"})).status).toBe(403);
  expect((await http(1, endpoint)).status).toBe(200);

  const accountId = crypto.randomUUID(), deviceId = crypto.randomUUID(), token = "public-unrelated-recipient";
  const tokenHash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
  await env.DB.prepare("INSERT INTO accounts VALUES(?,?)").bind(accountId, JSON.stringify({...cards.accounts[0], accountId})).run();
  await env.DB.prepare("INSERT INTO devices(id,account_id,trusted) VALUES(?,?,1)").bind(deviceId, accountId).run();
  await env.DB.prepare("INSERT INTO sessions VALUES(?,?,?,?)").bind(tokenHash, accountId, deviceId, Date.now() + 60000).run();
  const foreignHeaders = {origin: "http://localhost:4310", authorization: "Bearer " + token, "content-type": "application/json"};
  expect((await request(endpoint, foreignHeaders)).status).toBe(403);
  expect((await request("/v1/objects/" + source.m.representations[0].objectId, foreignHeaders)).status).toBe(403);
  expect((await app.fetch(new Request("http://localhost:8787" + endpoint + "/viewed", {method: "POST", headers: foreignHeaders}), env as any)).status).toBe(403);
  const savedId = crypto.randomUUID(), manifest = {...source.m, photoId: savedId, ownerAccountId: actors[1].accountId};
  const save = {version: 1, operationId: crypto.randomUUID(), photoId: savedId, sourceGrantId: grant.grantId, sourcePhotoId: source.m.photoId, manifest, signedPayload: await signed(1, "photo-manifest", manifest)};
  expect((await app.fetch(new Request("http://localhost:8787/v1/saves", {method: "POST", headers: foreignHeaders, body: JSON.stringify({version: 1, expectedGrantVersion: 1, save})}), env as any)).status).toBe(403);
  const contribution = {version: 1, operationId: crypto.randomUUID(), expectedGrantVersion: 1, manifests: [source.s], envelopes};
  expect((await app.fetch(new Request(`http://localhost:8787/v1/moments/${moment}/contributions`, {method: "POST", headers: foreignHeaders, body: JSON.stringify(contribution)}), env as any)).status).toBe(403);

  const wrongSource = {...save, operationId: crypto.randomUUID(), sourcePhotoId: crypto.randomUUID()};
  expect((await http(1, "/v1/saves", "POST", {version: 1, expectedGrantVersion: 1, save: wrongSource})).status).toBe(403);
  const modifiedManifest = {...manifest, representations: manifest.representations.map(rep => ({...rep, ciphertextSha256: "A".repeat(43)}))};
  const modifiedSave = {...save, operationId: crypto.randomUUID(), manifest: modifiedManifest, signedPayload: await signed(1, "photo-manifest", modifiedManifest)};
  const mismatch = await http(1, "/v1/saves", "POST", {version: 1, expectedGrantVersion: 1, save: modifiedSave});
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json() as any).code).toBe("SOURCE_MISMATCH");
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE account_id=?").bind(accountId).first<any>();
  expect(rows.n).toBe(0);
});
