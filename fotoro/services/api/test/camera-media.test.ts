import {it, expect} from "vitest";
import {actors, seed, http, photo, share, signed} from "./helpers";

it("legacy catalog readers never receive new media or its annotations; opted-in readers receive both with an acknowledgment", async () => {
  await seed();
  const image = await photo(0), motion = await photo(0, "photo-media-manifest-v1");
  const update = {version: 1, photoId: motion.m.photoId, revision: 1, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: "A".repeat(43)}};
  const annotation = await http(0, `/v1/photos/${motion.m.photoId}/annotations`, "PUT", await signed(0, "photo-annotations", update));
  expect(annotation.status).toBe(200);
  const legacy = await (await http(0, "/v1/changes?limit=100")).json() as any;
  expect(legacy.mediaVersion).toBeUndefined();
  expect(legacy.changes.some((change: any) => change.entityId === image.m.photoId)).toBe(true);
  expect(legacy.changes.some((change: any) => change.entityId === motion.m.photoId)).toBe(false);
  const current = await (await http(0, "/v1/changes?limit=100&media=1")).json() as any;
  expect(current.mediaVersion).toBe(1);
  expect(current.changes.filter((change: any) => change.entityId === motion.m.photoId).map((change: any) => change.entity)).toEqual(["photo", "annotation"]);
  const other = await (await http(1, "/v1/changes?media=1")).json() as any;
  expect(other.changes.some((change: any) => change.entityId === motion.m.photoId)).toBe(false);
  const replay = await http(0, "/v1/photos", "POST", motion.s);
  expect(replay.status).toBe(200);
  expect((await http(0, "/v1/photos", "POST", await signed(0, "unknown-media", motion.m))).status).toBe(400);
});

it("received media remains complete through Save, while its authenticated compatibility kind cannot be downgraded", async () => {
  await seed();
  const motion = await photo(0, "photo-media-manifest-v1"), moment = crypto.randomUUID();
  const grant = await (await http(0, `/v1/moments/${moment}/grants/options`, "POST", {version: 1, recipientAccountId: actors[1].accountId, role: "viewer", access: "temporary"})).json() as any;
  const envelope = await share(0, grant, motion.m.photoId);
  expect((await http(0, `/v1/moments/${moment}/grants`, "POST", {version: 1, grant, envelopes: [envelope], signedPayload: await signed(0, "grant", {grant, envelopes: [envelope]})})).status).toBe(200);
  const oldDetail = await (await http(1, `/v1/grants/${grant.grantId}`)).json() as any;
  expect(oldDetail.manifests).toHaveLength(0); expect(oldDetail.envelopes).toHaveLength(0);
  const detail = await (await http(1, `/v1/grants/${grant.grantId}?media=1`)).json() as any;
  expect(detail.manifests[0]).toEqual(motion.s); expect(detail.envelopes).toHaveLength(1);
  const id = crypto.randomUUID(), manifest = {...motion.m, photoId: id, ownerAccountId: actors[1].accountId};
  const save = {version: 1, operationId: crypto.randomUUID(), photoId: id, sourceGrantId: grant.grantId, sourcePhotoId: motion.m.photoId, manifest, signedPayload: await signed(1, "photo-manifest", manifest)};
  expect((await http(1, "/v1/saves", "POST", {version: 1, expectedGrantVersion: 1, save})).status).toBe(400);
  save.signedPayload = await signed(1, "photo-media-manifest-v1", manifest);
  const request = {version: 1, expectedGrantVersion: 1, save};
  const response = await http(1, "/v1/saves", "POST", request);
  expect(response.status).toBe(200); expect(await response.json()).toEqual(save);
  expect(await (await http(1, "/v1/saves", "POST", request)).json()).toEqual(save);
  const legacy = await (await http(1, "/v1/changes")).json() as any;
  expect(legacy.changes.some((change: any) => change.entityId === id)).toBe(false);
  const current = await (await http(1, "/v1/changes?media=1")).json() as any;
  expect(current.changes.some((change: any) => change.entityId === id && change.payload.kind === "photo-media-manifest-v1")).toBe(true);
});
