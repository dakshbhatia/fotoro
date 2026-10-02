import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import { actors, seed, http, photo, share, signed } from "./helpers";
it("real Worker HTTP exchange contributes, saves atomically, revokes access and retains saved originals", async () => {
  await seed();
  const source = await photo(0),
    moment = crypto.randomUUID();
  expect(
    (await http(1, "/v1/objects/" + source.m.representations[0].objectId))
      .status,
  ).toBe(403);
  const g = (await (
    await http(0, `/v1/moments/${moment}/grants/options`, "POST", {
      version: 1,
      recipientAccountId: actors[1].accountId,
      role: "contributor",
      access: "temporary",
    })
  ).json()) as any;
  expect(Date.parse(g.expiresAt) - Date.now()).toBeGreaterThan(898000);
  const e = await share(0, g, source.m.photoId);
  const create = {
    version: 1,
    grant: g,
    envelopes: [e],
    signedPayload: await signed(0, "grant", { grant: g, envelopes: [e] }),
  };
  expect(
    (await http(0, `/v1/moments/${moment}/grants`, "POST", create)).status,
  ).toBe(200);
  expect(
    (await http(1, "/v1/objects/" + source.m.representations[0].objectId))
      .status,
  ).toBe(200);
  const view1 = await (
    await http(1, `/v1/grants/${g.grantId}/viewed`, "POST")
  ).json();
  expect(
    await (await http(1, `/v1/grants/${g.grantId}/viewed`, "POST")).json(),
  ).toEqual(view1);
  const contribution = await photo(1),
    ce = await share(1, g, contribution.m.photoId);
  const ci = {
    version: 1,
    operationId: crypto.randomUUID(),
    expectedGrantVersion: 1,
    manifests: [contribution.s],
    envelopes: [ce],
  };
  expect(
    (await http(1, `/v1/moments/${moment}/contributions`, "POST", ci)).status,
  ).toBe(200);
  expect(
    (await http(0, "/v1/objects/" + contribution.m.representations[0].objectId))
      .status,
  ).toBe(200);
  const ownerSaveId = crypto.randomUUID(),
    ownerManifest = {
      ...contribution.m,
      photoId: ownerSaveId,
      ownerAccountId: actors[0].accountId,
    },
    ownerSave = {
      version: 1,
      operationId: crypto.randomUUID(),
      photoId: ownerSaveId,
      sourceGrantId: g.grantId,
      sourcePhotoId: contribution.m.photoId,
      manifest: ownerManifest,
      signedPayload: await signed(0, "photo-manifest", ownerManifest),
    };
  expect(
    (
      await http(0, "/v1/saves", "POST", {
        version: 1,
        expectedGrantVersion: 1,
        save: ownerSave,
      })
    ).status,
  ).toBe(200);
  expect((await http(0, `/v1/grants/${g.grantId}/viewed`, "POST")).status).toBe(
    200,
  );
  const mid = crypto.randomUUID(),
    manifest = {
      ...source.m,
      photoId: mid,
      ownerAccountId: actors[1].accountId,
    };
  const save = {
      version: 1,
      operationId: crypto.randomUUID(),
      photoId: mid,
      sourceGrantId: g.grantId,
      sourcePhotoId: source.m.photoId,
      manifest,
      signedPayload: await signed(1, "photo-manifest", manifest),
    },
    input = { version: 1, expectedGrantVersion: 1, save };
  const result = await http(1, "/v1/saves", "POST", input);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(save);
  expect((await http(0, `/v1/grants/${g.grantId}`, "DELETE")).status).toBe(200);
  expect((await http(1, `/v1/grants/${g.grantId}`)).status).toBe(403);
  expect((await http(1, "/v1/saves", "POST", input)).status).toBe(200);
  const newId = crypto.randomUUID(),
    newManifest = { ...manifest, photoId: newId };
  expect(
    (
      await http(1, "/v1/saves", "POST", {
        ...input,
        save: {
          ...save,
          operationId: crypto.randomUUID(),
          photoId: newId,
          manifest: newManifest,
          signedPayload: await signed(1, "photo-manifest", newManifest),
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await http(1, `/v1/moments/${moment}/contributions`, "POST", {
        ...ci,
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(
    (await http(1, "/v1/objects/" + source.m.representations[0].objectId))
      .status,
  ).toBe(200);
  expect(
    (await http(0, "/v1/objects/" + contribution.m.representations[0].objectId))
      .status,
  ).toBe(200);
  const first = (await (await http(1, "/v1/changes?limit=1")).json()) as any;
  const page = await (
    await http(1, "/v1/changes?cursor=" + first.nextCursor + "&limit=100")
  ).json();
  expect(
    await (
      await http(1, "/v1/changes?cursor=" + first.nextCursor + "&limit=100")
    ).json(),
  ).toEqual(page);
  const ret = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM retention WHERE photo_id=?",
  )
    .bind(mid)
    .first<any>();
  expect(ret.count).toBe(2);
});
it("expiry at server boundary denies downloads and a stale revision cannot save", async () => {
  await seed();
  const source = await photo(0),
    moment = crypto.randomUUID();
  const g = (await (
    await http(0, `/v1/moments/${moment}/grants/options`, "POST", {
      version: 1,
      recipientAccountId: actors[1].accountId,
      role: "viewer",
      access: "temporary",
    })
  ).json()) as any;
  const e = await share(0, g, source.m.photoId);
  expect(
    (
      await http(0, `/v1/moments/${moment}/grants`, "POST", {
        version: 1,
        grant: g,
        envelopes: [e],
        signedPayload: await signed(0, "grant", { grant: g, envelopes: [e] }),
      })
    ).status,
  ).toBe(200);
  const id = crypto.randomUUID(),
    manifest = {
      ...source.m,
      photoId: id,
      ownerAccountId: actors[1].accountId,
    },
    save = {
      version: 1,
      operationId: crypto.randomUUID(),
      photoId: id,
      sourceGrantId: g.grantId,
      sourcePhotoId: source.m.photoId,
      manifest,
      signedPayload: await signed(1, "photo-manifest", manifest),
    };
  expect(
    (
      await http(1, "/v1/saves", "POST", {
        version: 1,
        expectedGrantVersion: 2,
        save,
      })
    ).status,
  ).toBe(409);
  await env.DB.prepare("UPDATE grants SET expires=? WHERE id=?")
    .bind(Date.now(), g.grantId)
    .run();
  expect(
    (await http(1, "/v1/objects/" + source.m.representations[0].objectId))
      .status,
  ).toBe(403);
  expect(
    (
      await http(1, "/v1/saves", "POST", {
        version: 1,
        expectedGrantVersion: 1,
        save,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE id=?")
        .bind(id)
        .first<any>()
    ).n,
  ).toBe(0);
});
