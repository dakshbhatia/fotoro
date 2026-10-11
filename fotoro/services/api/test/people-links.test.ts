import {beforeEach, it, expect} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {actors, http, seed, signed} from "./helpers";
import fixtures from "../../../fixtures/accounts.json";
import {b64, unb64, utf8} from "../src/errors";

const book = (revision = 1, marker = "A") => ({version: 1, revision, encrypted: {version: 1, nonce: "A".repeat(32), ciphertext: marker.repeat(43)}});
const path = "/v1/people-links";
beforeEach(async () => {await env.DB.prepare("DELETE FROM account_people_links").run();});

it("stores one private encrypted owner book with no-store replies and exact retry idempotency", async () => {
  await seed();
  const empty = await http(0, path);
  expect(empty.status).toBe(200); expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({version: 1, peopleLinks: null});
  const payload = await signed(0, "account-people-links", book());
  for (let n = 0; n < 2; n++) {
    const response = await http(0, path, "PUT", payload);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({version: 1, peopleLinks: payload});
  }
  expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: payload});
  expect(await (await http(1, path)).json()).toEqual({version: 1, peopleLinks: null});
  expect(await env.DB.prepare("SELECT account_id,revision FROM account_people_links").all()).toMatchObject({results: [{account_id: actors[0].accountId, revision: 1}]});
  const changes = await (await http(0, "/v1/changes")).json() as any;
  expect(changes.changes).toEqual([]);
});

it("CAS admits one different concurrent edit and reconciles identical concurrent retries", async () => {
  await seed();
  const a = await signed(0, "account-people-links", book()), b = await signed(0, "account-people-links", book(1, "B"));
  expect((await Promise.all([http(0, path, "PUT", a), http(0, path, "PUT", b)])).map(r => r.status).sort()).toEqual([200, 409]);
  const next = await signed(0, "account-people-links", book(2, "C"));
  const retries = await Promise.all([http(0, path, "PUT", next), http(0, path, "PUT", next)]);
  expect(retries.map(r => r.status)).toEqual([200, 200]);
  expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: next});
  expect((await http(0, path, "PUT", a)).status).toBe(409);
  expect((await http(0, path, "PUT", await signed(0, "account-people-links", book(4)))).status).toBe(409);
});

it("requires revision one for an absent book and binds owner, kind, signature and trusted device", async () => {
  await seed();
  expect((await http(0, path, "PUT", await signed(0, "account-people-links", book(2)))).status).toBe(409);
  expect((await http(0, path, "PUT", await signed(1, "account-people-links", book()))).status).toBe(403);
  expect((await http(0, path, "PUT", await signed(0, "photo-annotations", book()))).status).toBe(403);
  const payload = await signed(0, "account-people-links", book());
  expect((await http(0, path, "PUT", {...payload, signature: "A".repeat(86)})).status).toBe(403);
  await env.DB.prepare("UPDATE devices SET trusted=0 WHERE id=?").bind(actors[0].deviceId).run();
  expect((await http(0, path)).status).toBe(403);
  expect((await http(0, path, "PUT", payload)).status).toBe(403);
  await env.DB.prepare("UPDATE devices SET trusted=1 WHERE id=?").bind(actors[0].deviceId).run();
  expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: null});
  const mismatch = await app.fetch(new Request("http://localhost:8787/v1/people-links", {headers: {authorization: "Bearer public-test-0", "x-fotoro-account-id": actors[1].accountId}}), env as any);
  expect(mismatch.status).toBe(403);
  expect((await app.fetch(new Request("http://localhost:8787/v1/people-links"), env as any)).status).toBe(401);
});

it("validates exact encrypted shape, revision bounds and encoded request limits before persistence", async () => {
  await seed();
  for (const value of [book(0), book(2147483648), book(1.5), {...book(), name: "private name"},
    {...book(), encrypted: {...book().encrypted, nonce: "A"}},
    {...book(), encrypted: {...book().encrypted, ciphertext: "!".repeat(43)}},
    {...book(), encrypted: {...book().encrypted, ciphertext: "A".repeat(262145)}}]) {
    expect((await http(0, path, "PUT", await signed(0, "account-people-links", value))).status).toBe(400);
  }
  const valid = await signed(0, "account-people-links", book());
  for (const body of ["A", "A".repeat(360001)]) expect((await http(0, path, "PUT", {...valid, body})).status).toBe(400);
  expect((await http(0, path, "PUT", {...valid, body: "A".repeat(512 * 1024)})).status).toBe(413);
  expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: null});
  const largest = await signed(0, "account-people-links", {...book(), encrypted: {...book().encrypted, ciphertext: "A".repeat(262144)}});
  expect((await http(0, path, "PUT", largest)).status).toBe(200);
});


it("rejects correctly signed non-JSON and non-UTF8 bodies as INVALID_WIRE without storing them", async () => {
  await seed();
  const der = new Uint8Array(48); der.set([48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32]);
  der.set(unb64(fixtures.testSecrets[0].signingSecretKey).slice(0, 32), 16);
  const key = await crypto.subtle.importKey("pkcs8", der, {name: "Ed25519"}, false, ["sign"]);
  // A replacement decoder would silently discard the invalid earlier duplicate
  // field and accept the later version=1. Raw signed bytes must be valid UTF8.
  const invalidUTF8 = new TextEncoder().encode('{"version":"X",' + JSON.stringify(book()).slice(1));
  invalidUTF8[12] = 255;
  for (const bytes of [new TextEncoder().encode("not JSON"), new Uint8Array([255]), invalidUTF8]) {
    const payload = {...await signed(0, "account-people-links", book()), body: b64(bytes)};
    payload.signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, utf8(["fotoro-signed-v1", payload.kind, payload.accountId, payload.body]))));
    const response = await http(0, path, "PUT", payload);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({code: "INVALID_WIRE"});
    expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: null});
  }
});

it("revoked devices cannot use exact retry to read or replace an already stored private book", async () => {
  await seed();
  const payload = await signed(0, "account-people-links", book());
  expect((await http(0, path, "PUT", payload)).status).toBe(200);
  await env.DB.prepare("UPDATE devices SET trusted=0 WHERE id=?").bind(actors[0].deviceId).run();
  expect((await http(0, path)).status).toBe(403);
  expect((await http(0, path, "PUT", payload)).status).toBe(403);
  await env.DB.prepare("UPDATE devices SET trusted=1 WHERE id=?").bind(actors[0].deviceId).run();
  expect(await (await http(0, path)).json()).toEqual({version: 1, peopleLinks: payload});
});
