import {it, expect, vi} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {b64, unb64, utf8} from "../src/errors";
import {accountStorage, throttleAuth} from "../src/limits";
import {reserveUpload, putStaging, commitUpload} from "../src/storage";
import {actors, seed, photo, http, signed, share} from "./helpers";
import cards from "../../../fixtures/accounts.json";

const actor = () => ({accountId: crypto.randomUUID(), deviceId: crypto.randomUUID()});
const limited = (bytes: number) => ({...env, ACCOUNT_STORAGE_LIMIT_BYTES: String(bytes)} as any);
async function input(bytes = new TextEncoder().encode("public-ciphertext")) {
  return {version: 1 as const, operationId: crypto.randomUUID(),
    binding: {version: 1 as const, photoId: crypto.randomUUID(), representationId: crypto.randomUUID(), kind: "original" as const},
    ciphertextBytes: bytes.length, ciphertextSha256: b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))};
}

it("atomically admits only one competing reservation and leaves no partial upload or claim", async () => {
  const a = actor(), first = await input(), second = await input(), e = limited(first.ciphertextBytes);
  const result = await Promise.allSettled([reserveUpload(e, a, first, "https://fotoro.cloud"), reserveUpload(e, a, second, "https://fotoro.cloud")]);
  expect(result.filter(value => value.status === "fulfilled")).toHaveLength(1);
  const rejected = result.find(value => value.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.code).toBe("STORAGE_QUOTA_EXCEEDED");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE account_id=?").bind(a.accountId).first<any>()).n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_storage_claims WHERE account_id=?").bind(a.accountId).first<any>()).n).toBe(1);
  expect(await accountStorage(e, a)).toMatchObject({reservedBytes: first.ciphertextBytes, storedBytes: 0, availableBytes: 0});
});

it("identical concurrent retries reserve once and changed replay cannot consume headroom", async () => {
  const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
  const result = await Promise.all([reserveUpload(e, a, i, "https://fotoro.cloud"), reserveUpload(e, a, i, "https://fotoro.cloud")]);
  expect(result[0]).toEqual(result[1]);
  await expect(reserveUpload(e, a, {...i, ciphertextBytes: i.ciphertextBytes + 1}, "https://fotoro.cloud")).rejects.toMatchObject({code: "IDEMPOTENCY_CONFLICT"});
  expect((await accountStorage(e, a)).reservedBytes).toBe(i.ciphertextBytes);
});

it("unused expired leases release headroom and exact renewal reacquires it atomically", async () => {
  const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
  const first = await reserveUpload(e, a, i, "https://fotoro.cloud");
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(first.uploadId).run();
  expect((await accountStorage(e, a)).availableBytes).toBe(i.ciphertextBytes);
  const replacement = await reserveUpload(e, a, await input(), "https://fotoro.cloud");
  await expect(reserveUpload(e, a, i, "https://fotoro.cloud")).rejects.toMatchObject({code: "STORAGE_QUOTA_EXCEEDED"});
  expect((await env.DB.prepare("SELECT cap FROM uploads WHERE id=?").bind(first.uploadId).first<any>()).cap).toBe(new URL(first.stagingUrl).searchParams.get("cap"));
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(replacement.uploadId).run();
  const renewed = await reserveUpload(e, a, i, "https://fotoro.cloud");
  expect(renewed.uploadId).toBe(first.uploadId); expect(renewed.stagingUrl).not.toBe(first.stagingUrl);
  expect((await accountStorage(e, a)).reservedBytes).toBe(i.ciphertextBytes);
});

it("concurrent renewal retries issue one capability and charge once", async () => {
  const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
  const old = await reserveUpload(e, a, i, "https://fotoro.cloud");
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(old.uploadId).run();
  const renewed = await Promise.all([reserveUpload(e, a, i, "https://fotoro.cloud"), reserveUpload(e, a, i, "https://fotoro.cloud")]);
  expect(renewed[0]).toEqual(renewed[1]);
  expect(renewed[0].stagingUrl).not.toBe(old.stagingUrl);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_storage_claims WHERE account_id=?").bind(a.accountId).first<any>()).n).toBe(1);
  expect(await accountStorage(e, a)).toMatchObject({reservedBytes: i.ciphertextBytes, storedBytes: 0, availableBytes: 0});
});

it("renewal uses the current clock when the old lease expires during reservation reads", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_001_000_000);
  try {
    const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
    const old = await reserveUpload(e, a, i, "https://fotoro.cloud");
    const expiry = Date.parse(old.expiresAt);
    clock.mockReturnValue(expiry - 1);
    const delayed = {...e, DB: {
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (sql !== "SELECT * FROM uploads WHERE account_id=? AND operation_id=?") return statement;
        return {bind(...args: any[]) {
          const bound = statement.bind(...args);
          return {async first() {
            const row = await bound.first();
            clock.mockReturnValue(expiry + 1);
            return row;
          }};
        }};
      },
    }};
    const renewed = await reserveUpload(delayed as any, a, i, "https://fotoro.cloud");
    expect(renewed.stagingUrl).not.toBe(old.stagingUrl);
    expect(Date.parse(renewed.expiresAt)).toBe(expiry + 1 + 900000);
    expect(await accountStorage(e, a)).toMatchObject({reservedBytes: i.ciphertextBytes, storedBytes: 0});
  } finally {clock.mockRestore();}
});

it("a lease expired and refunded after the initial read cannot start an uncharged R2 write", async () => {
  const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
  const r = await reserveUpload(e, a, i, "https://fotoro.cloud"), cap = new URL(r.stagingUrl).searchParams.get("cap")!;
  const put = vi.fn();
  const changing = {...e, BUCKET: {put}, DB: {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (sql !== "SELECT * FROM uploads WHERE id=? AND account_id=?") return statement;
      return {bind(...args: any[]) {
        const bound = statement.bind(...args);
        return {async first() {
          const row = await bound.first();
          await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(r.uploadId).run();
          await accountStorage(e, a);
          return row;
        }};
      }};
    },
  }};
  await expect(putStaging(changing as any, a, r.uploadId, cap,
    new Request(r.stagingUrl, {method: "PUT", body: new TextEncoder().encode("public-ciphertext")}))).rejects.toMatchObject({code: "FORBIDDEN"});
  expect(put).not.toHaveBeenCalled();
  expect(await accountStorage(e, a)).toMatchObject({reservedBytes: 0, storedBytes: 0, availableBytes: i.ciphertextBytes});
});

it("staging and commit transfer one charge, remain charged beyond expiry and replay below a lowered limit", async () => {
  const a = actor(), bytes = new TextEncoder().encode("public-ciphertext"), i = await input(bytes), e = limited(bytes.length);
  const reservation = await reserveUpload(e, a, i, "https://fotoro.cloud"), cap = new URL(reservation.stagingUrl).searchParams.get("cap")!;
  await putStaging(e, a, reservation.uploadId, cap, new Request(reservation.stagingUrl, {method: "PUT", body: bytes}));
  expect(await accountStorage(e, a)).toMatchObject({reservedBytes: 0, storedBytes: bytes.length, availableBytes: 0});
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(reservation.uploadId).run();
  const committed = await commitUpload(e, a, reservation.uploadId);
  expect(await commitUpload(limited(1), a, reservation.uploadId)).toEqual(committed);
  expect(await reserveUpload(limited(1), a, i, "https://fotoro.cloud")).toEqual({...reservation, expiresAt: new Date(0).toISOString()});
  expect((await accountStorage(e, a)).storedBytes).toBe(bytes.length);
  await expect(reserveUpload(e, a, await input(), "https://fotoro.cloud")).rejects.toMatchObject({code: "STORAGE_QUOTA_EXCEEDED"});
});

it("an interrupted write cannot refund ciphertext via expiry; a new capability needs new headroom", async () => {
  const a = actor(), i = await input(), e = limited(i.ciphertextBytes);
  const r = await reserveUpload(e, a, i, "https://fotoro.cloud"), cap = new URL(r.stagingUrl).searchParams.get("cap")!;
  const broken = new ReadableStream({start(controller) {controller.error(new Error("public controlled interruption"));}});
  await expect(putStaging(e, a, r.uploadId, cap, new Request(r.stagingUrl, {method: "PUT", body: broken}))).rejects.toMatchObject({code: "UPLOAD_INCOMPLETE"});
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(r.uploadId).run();
  expect(await accountStorage(e, a)).toMatchObject({reservedBytes: 0, storedBytes: i.ciphertextBytes, availableBytes: 0});
  await expect(reserveUpload(e, a, i, "https://fotoro.cloud")).rejects.toMatchObject({code: "STORAGE_QUOTA_EXCEEDED"});
  const renewed = await reserveUpload(limited(i.ciphertextBytes * 2), a, i, "https://fotoro.cloud");
  expect(renewed.stagingUrl).not.toBe(r.stagingUrl);
  expect(await accountStorage(limited(i.ciphertextBytes * 2), a)).toMatchObject({storedBytes: i.ciphertextBytes, reservedBytes: i.ciphertextBytes});
});

it("expiry during a staging write cannot release the charge or revive a stale capability", async () => {
  const a = actor(), bytes = new TextEncoder().encode("public-ciphertext"), i = await input(bytes), e = limited(bytes.length);
  const r = await reserveUpload(e, a, i, "https://fotoro.cloud"), cap = new URL(r.stagingUrl).searchParams.get("cap")!;
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => {entered = resolve;});
  const gate = new Promise<void>(resolve => {release = resolve;});
  const stream = new ReadableStream({async pull(controller) {entered(); await gate; controller.enqueue(bytes); controller.close();}}, {highWaterMark: 0});
  const pending = putStaging(e, a, r.uploadId, cap, new Request(r.stagingUrl, {method: "PUT", body: stream}));
  await ready;
  await env.DB.prepare("UPDATE uploads SET expires=0 WHERE id=?").bind(r.uploadId).run();
  expect((await accountStorage(e, a)).availableBytes).toBe(0);
  release(); await expect(pending).rejects.toMatchObject({code: "VERSION_CONFLICT"});
  await expect(reserveUpload(e, a, await input(), "https://fotoro.cloud")).rejects.toMatchObject({code: "STORAGE_QUOTA_EXCEEDED"});
});

it("storage status is private and recipient Save/revocation preserves independently retained ciphertext", async () => {
  await seed();
  expect((await app.fetch(new Request("http://localhost:8787/v1/storage"), env as any)).status).toBe(401);
  const {m} = await photo(0), before = await accountStorage(env as any, actors[0]);
  const moment = crypto.randomUUID();
  const options = await http(0, `/v1/moments/${moment}/grants/options`, "POST", {version: 1, recipientAccountId: actors[1].accountId, role: "viewer", access: "ongoing"});
  const grant = await options.json() as any;
  const envelope = await share(0, grant, m.photoId);
  expect((await http(0, `/v1/moments/${moment}/grants`, "POST", {version: 1, grant, envelopes: [envelope], signedPayload: await signed(0, "grant", {grant, envelopes: [envelope]})})).status).toBe(200);
  const manifest = {...m, photoId: crypto.randomUUID(), ownerAccountId: actors[1].accountId};
  const save = {version: 1, operationId: crypto.randomUUID(), photoId: manifest.photoId, sourceGrantId: grant.grantId, sourcePhotoId: m.photoId,
    manifest, signedPayload: await signed(1, "photo-manifest", manifest)};
  // Recipient copies retain the source objects; they do not allocate new R2 ciphertext.
  const recipientEnv = limited(1);
  await http(1, "/v1/storage");
  const response = await app.fetch(new Request("http://localhost:8787/v1/saves", {method: "POST", headers: {origin: "http://localhost:4310", authorization: "Bearer public-test-1", "content-type": "application/json"}, body: JSON.stringify({version: 1, expectedGrantVersion: 1, save})}), recipientEnv);
  expect(response.status).toBe(200);
  expect((await accountStorage(recipientEnv, actors[1])).storedBytes).toBe(0);
  expect(await accountStorage(env as any, actors[0])).toEqual(before);
  expect((await http(0, `/v1/grants/${grant.grantId}`, "DELETE")).status).toBe(200);
  expect((await http(1, `/v1/objects/${m.representations[0].objectId}`)).status).toBe(200);
});

const production = (extra = {}) => ({...env, AUTH_MODE: "production", AUTH_REQUESTS_PER_MINUTE: "30", ENROLLMENTS_PER_MINUTE: "6", ...extra} as any);
const authRequest = (path: string, body: unknown, address = "192.0.2.10") => new Request("https://fotoro.cloud/v1/auth/" + path, {
  method: "POST", headers: {origin: "https://fotoro.cloud", "cf-connecting-ip": address, "content-type": "application/json"}, body: JSON.stringify(body),
});

it("production enrollment throttles concurrent requests without partial challenges and allows explicit Retry next window", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const e = production({AUTH_REQUESTS_PER_MINUTE: "20", ENROLLMENTS_PER_MINUTE: "2"});
    const responses = await Promise.all(Array.from({length: 4}, () => app.fetch(authRequest("start/options", {version: 1, client: "native"}), e)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 200, 429, 429]);
    const blocked = responses.find(response => response.status === 429)!;
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toMatchObject({code: "AUTH_RATE_LIMITED", retryable: true});
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_challenges").first<any>()).n).toBe(2);
    clock.mockReturnValue(1_800_000_060_000);
    expect((await app.fetch(authRequest("start/options", {version: 1, client: "native"}), e)).status).toBe(200);
    const rows = await env.DB.prepare("SELECT key FROM auth_rate_limits").all<any>();
    expect(JSON.stringify(rows.results)).not.toContain("192.0.2.10");
  } finally {clock.mockRestore();}
});

it("auth throttling is IP scoped, local mode remains unchanged, and production requires its edge address", async () => {
  const e = production({AUTH_REQUESTS_PER_MINUTE: "1"});
  await throttleAuth(e, authRequest("login/options", {}));
  await expect(throttleAuth(e, authRequest("login/options", {}))).rejects.toMatchObject({code: "AUTH_RATE_LIMITED"});
  await expect(throttleAuth(e, authRequest("login/options", {}, "192.0.2.11"))).resolves.toBeUndefined();
  await expect(throttleAuth({...e, AUTH_MODE: "local"}, authRequest("login/options", {}))).resolves.toBeUndefined();
  const missing = authRequest("start/options", {version: 1, client: "native"}); missing.headers.delete("cf-connecting-ip");
  expect((await app.fetch(missing, e)).status).toBe(503);
});

it("authenticated device-enrollment throttling remains account scoped across different edge addresses", async () => {
  const e = production({AUTH_REQUESTS_PER_MINUTE: "1"}), accountId = crypto.randomUUID();
  await throttleAuth(e, authRequest("unused", {}, "192.0.2.20"), true, accountId);
  await expect(throttleAuth(e, authRequest("unused", {}, "192.0.2.21"), true, accountId)).rejects.toMatchObject({code: "AUTH_RATE_LIMITED"});
  await expect(throttleAuth(e, authRequest("unused", {}, "192.0.2.22"), true, crypto.randomUUID())).resolves.toBeUndefined();
});

it("a throttled valid enrollment proof leaves its challenge unconsumed for explicit Retry", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const e = production({AUTH_REQUESTS_PER_MINUTE: "1"});
    const request = (path: string, body: unknown) => authRequest(path, body, "192.0.2.13");
    const opts = await (await app.fetch(request("start/options", {version: 1, client: "native"}), e)).json() as any;
    const card = {...cards.accounts[0], accountId: opts.accountId};
    const wrapper = {version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: cards.testSecrets[0].encryptedBundle};
    const makeProof = async (kind: string, body: unknown) => {
      const der = new Uint8Array(48); der.set([48,46,2,1,0,48,5,6,3,43,101,112,4,34,4,32]); der.set(unb64(cards.testSecrets[0].signingSecretKey).slice(0, 32), 16);
      const key = await crypto.subtle.importKey("pkcs8", der, {name: "Ed25519"}, false, ["sign"]);
      const value = {version: 1, kind, accountId: opts.accountId, body: b64(utf8(body)), signature: ""};
      value.signature = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, utf8(["fotoro-signed-v1", kind, opts.accountId, value.body])))); return value;
    };
    const body = {version: 1, challengeId: opts.challengeId, client: "native", enrollment: {version: 1, accountCard: card, recoveryWrapper: wrapper,
      proof: await makeProof("account-enrollment", {accountCard: card, recoveryWrapper: wrapper})},
      signedPayload: await makeProof("start-enrollment", {version: 1, challengeId: opts.challengeId, challenge: opts.challenge, accountId: opts.accountId, client: "native", origin: "https://fotoro.cloud"})};
    expect((await app.fetch(request("start/verify", body), e)).status).toBe(429);
    expect((await env.DB.prepare("SELECT consumed FROM auth_challenges WHERE id=?").bind(opts.challengeId).first<any>()).consumed).toBe(0);
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE id=?").bind(opts.accountId).first()).toBeNull();
    clock.mockReturnValue(1_800_000_060_000);
    expect((await app.fetch(request("start/verify", body), e)).status).toBe(200);
    expect((await env.DB.prepare("SELECT consumed FROM auth_challenges WHERE id=?").bind(opts.challengeId).first<any>()).consumed).toBe(1);
  } finally {clock.mockRestore();}
});
