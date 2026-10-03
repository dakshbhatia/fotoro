import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import app from "../src/index";
import { seed, photo, signed, http, actors, share } from "./helpers";

const update = (photoId: string, revision = 1, marker = "A") => ({version: 1, photoId, revision, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: marker.repeat(43)}});

it("owner-only encrypted annotations sync through signed changes with idempotent writes", async () => {
  await seed();
  const {m} = await photo(0);
  const path = `/v1/photos/${m.photoId}/annotations`;
  expect(await (await http(0, path)).json()).toEqual({version: 1, annotations: null});
  const payload = await signed(0, "photo-annotations", update(m.photoId));
  expect((await http(0, path, "PUT", payload)).status).toBe(200);
  expect(await (await http(0, path, "PUT", payload)).json()).toEqual(payload);
  expect(await (await http(0, path)).json()).toEqual({version: 1, annotations: payload});
  const changes = await (await http(0, "/v1/changes")).json() as any;
  expect(changes.changes.filter((c: any) => c.entity === "annotation" && c.entityId === m.photoId)).toEqual([expect.objectContaining({payload})]);
  expect((await http(1, path)).status).toBe(403);
  expect((await http(1, path, "PUT", await signed(1, "photo-annotations", update(m.photoId)))).status).toBe(403);
  expect(await env.DB.prepare("SELECT revision FROM photo_annotations WHERE photo_id=?").bind(m.photoId).first()).toEqual({revision: 1});
});

it("annotation revisions atomically reject concurrent edits and stale retries", async () => {
  await seed(); const {m} = await photo(0); const path = `/v1/photos/${m.photoId}/annotations`;
  const first = await signed(0, "photo-annotations", update(m.photoId));
  const competing = await signed(0, "photo-annotations", update(m.photoId, 1, "B"));
  const results = await Promise.all([http(0, path, "PUT", first), http(0, path, "PUT", competing)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  const next = await signed(0, "photo-annotations", update(m.photoId, 2, "C"));
  expect((await http(0, path, "PUT", next)).status).toBe(200);
  expect((await http(0, path, "PUT", first)).status).toBe(409);
  expect(await (await http(0, path)).json()).toEqual({version: 1, annotations: next});
});

it("annotation route binds signed kind, photo identity, trusted owner and payload limits", async () => {
  await seed(); const {m} = await photo(0); const path = `/v1/photos/${m.photoId}/annotations`;
  for (const [payload, status] of [
    [await signed(0, "photo-manifest", update(m.photoId)), 403],
    [await signed(1, "photo-annotations", update(m.photoId)), 403],
    [await signed(0, "photo-annotations", update(crypto.randomUUID())), 400],
    [await signed(0, "photo-annotations", update(m.photoId, 0)), 400],
    [await signed(0, "photo-annotations", {...update(m.photoId), encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(262145)}}), 400],
  ] as const) expect((await http(0, path, "PUT", payload)).status).toBe(status);
  const proof = await signed(0, "photo-annotations", update(m.photoId));
  proof.signature = "A".repeat(86);
  expect((await http(0, path, "PUT", proof)).status).toBe(403);
  expect((await http(0, `/v1/photos/${crypto.randomUUID()}/annotations`, "PUT", await signed(0, "photo-annotations", update(crypto.randomUUID())))).status).not.toBe(200);
});

it("private annotations do not travel through shared grants or recipient changes", async () => {
  await seed(); const {m} = await photo(0);
  const payload = await signed(0, "photo-annotations", update(m.photoId));
  expect((await http(0, `/v1/photos/${m.photoId}/annotations`, "PUT", payload)).status).toBe(200);
  const moment = crypto.randomUUID();
  const grant = await (await http(0, `/v1/moments/${moment}/grants/options`, "POST", {version:1,recipientAccountId:actors[1].accountId,role:"viewer",access:"temporary"})).json() as any;
  const envelopes = [await share(0, grant, m.photoId)];
  expect((await http(0, `/v1/moments/${moment}/grants`, "POST", {version:1,grant,envelopes,signedPayload:await signed(0,"grant",{grant,envelopes})})).status).toBe(200);
  const detail = await (await http(1, `/v1/grants/${grant.grantId}`)).text();
  expect(detail).not.toContain("photo-annotations");
  expect((await http(1, `/v1/photos/${m.photoId}/annotations`)).status).toBe(403);
  const changes = await (await http(1, "/v1/changes")).json() as any;
  expect(changes.changes.some((c: any) => c.entity === "annotation")).toBe(false);
});

it("Apple webcredentials association fails closed until explicit app IDs are configured", async () => {
  const request = () => new Request("https://fotoro.cloud/.well-known/apple-app-site-association");
  const missing = await app.fetch(request(), {...env, APPLE_APP_IDS: undefined} as any);
  expect(missing.status).toBe(503);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const configured = await app.fetch(request(), {...env, APPLE_APP_IDS: "ABCDEFGHIJ.cloud.fotoro.Fotoro"} as any);
  expect(configured.status).toBe(200);
  expect(await configured.json()).toEqual({
    webcredentials: {apps:["ABCDEFGHIJ.cloud.fotoro.Fotoro"]},
    applinks: {details: [{appIDs:["ABCDEFGHIJ.cloud.fotoro.Fotoro"], components: [
      {"/":"/", "#":"contact=*"}, {"/":"/", "#":"moment=*"},
    ]}]},
  });
  expect(configured.headers.get("content-type")).toContain("application/json");
  expect((await app.fetch(request(), {...env, APPLE_APP_IDS:"bad,ABCDEFGHIJ.*"} as any)).status).toBe(503);
});
