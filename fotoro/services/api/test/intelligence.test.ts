import {it, expect, vi, beforeEach, afterEach} from "vitest";
import {env} from "cloudflare:test";
import app from "../src/index";
import {seed, http, actors} from "./helpers";
import {capabilities, observe, validatePreview, validateObservation} from "../src/intelligence";

const configured = (account = 10, global = 20) => ({...env, CLOUD_INTELLIGENCE_ENABLED: "true", GEMINI_API_KEY: "test-key-never-real", CLOUD_INTELLIGENCE_DAILY_ACCOUNT_REQUESTS: String(account), CLOUD_INTELLIGENCE_DAILY_GLOBAL_REQUESTS: String(global), CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: "100000000", CLOUD_INTELLIGENCE_DAILY_GLOBAL_MICROUSD: "1000000000"});
const actor = () => ({accountId: crypto.randomUUID(), deviceId: crypto.randomUUID()});
// A tiny structural JPEG fixture; provider is mocked and never receives pixels.
function jpeg(width = 16, height = 8, metadata = false) {
  return new Uint8Array([0xff,0xd8, ...(metadata ? [0xff,0xe1,0,4,0,0] : []), 0xff,0xc0,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,0,0xff,0xd9]);
}
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
const input = (expectedAccountId: string) => ({version: 1, expectedAccountId, photoId: crypto.randomUUID(), sourceRevision: "public_source_digest", consent: "send-this-preview-to-google", model: "gemini-3.8-flash", preview: {mimeType: "image/jpeg", base64: base64(jpeg())}});
const request = (body: unknown) => new Request("http://localhost:8787/v1/intelligence/observe", {method: "POST", headers: {"content-type": "application/json", origin: "http://localhost:4310"}, body: JSON.stringify(body)});
const observations = {objects: ["dog"], scene: ["beach"], visibleText: "", uncertainty: ["Small distant object unclear"]};
function provider(value: unknown = observations) {return new Response(JSON.stringify({candidates: [{finishReason: "STOP", content: {parts: [{text: JSON.stringify(value)}]}}]}));}
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-08T12:00:00.000Z")));
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

it("is off by default and fails closed without every bounded setting or migrated ledger", async () => {
  const a = actor();
  expect(await capabilities(env, a, a.accountId)).toEqual({version: 1, enabled: false});
  const e = configured();
  for (const broken of [{GEMINI_API_KEY: ""}, {CLOUD_INTELLIGENCE_ENABLED: "false"}, {CLOUD_INTELLIGENCE_DAILY_ACCOUNT_REQUESTS: "0"}, {CLOUD_INTELLIGENCE_DAILY_GLOBAL_REQUESTS: "10001"}]) {
    expect(await capabilities({...e, ...broken}, a, a.accountId)).toEqual({version: 1, enabled: false});
    await expect(observe({...e, ...broken}, a, request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_UNAVAILABLE"});
  }
  expect(await capabilities({...e, DB: {prepare: () => {throw new Error("missing migration");}}} as any, a, a.accountId)).toEqual({version: 1, enabled: false});
});

it("enforces session and existing origin rules before cloud inference", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect((await app.fetch(request(input(actor().accountId)), configured())).status).toBe(401);
  const foreign = request(input(actor().accountId)); foreign.headers.set("origin", "https://other.example");
  expect((await app.fetch(foreign, configured())).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});

it("sends bounded inline pixels and schema only, never account/photo identity or credentials in URL", async () => {
  const fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const e = configured(), a = actor(), body = input(a.accountId);
  const result = await observe(e, a, request(body));
  expect(result).toMatchObject({version: 1, photoId: body.photoId, sourceRevision: body.sourceRevision, processor: body.model, observations});
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  const wire = JSON.parse(init.body as string);
  expect(JSON.stringify(wire)).not.toContain(body.photoId); expect(JSON.stringify(wire)).not.toContain(a.accountId);
  expect(init.headers).toMatchObject({"x-goog-api-key": "test-key-never-real"});
  expect(init.redirect).toBe("error");
  expect(wire.generationConfig).toMatchObject({maxOutputTokens: 1024, candidateCount: 1, responseFormat: {text: {mimeType: "application/json"}}});
  expect(wire.contents[0].parts[1].inlineData).toEqual({mimeType: "image/jpeg", data: body.preview.base64});
  const ledger = await env.DB.prepare("SELECT * FROM cloud_inference_work WHERE scope=?").bind(`account:${a.accountId}`).all();
  expect(JSON.stringify(ledger)).not.toContain(body.photoId); expect(JSON.stringify(ledger)).not.toContain("beach");
});

it("rejects missing consent, unsupported model, metadata, pixel dimensions and oversized streams before charging or provider call", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const e = configured(), a = actor();
  for (const body of [{...input(a.accountId), consent: "yes"}, {...input(a.accountId), model: "gemini-3.1-pro-preview"}, {...input(a.accountId), filename: "private.jpg"},
    {...input(a.accountId), preview: {mimeType: "image/jpeg", base64: base64(jpeg(1025))}},
    {...input(a.accountId), preview: {mimeType: "image/jpeg", base64: base64(jpeg(16,8,true))}},
    {...input(a.accountId), preview: {mimeType: "image/jpeg", base64: "A".repeat(710000)}}]) await expect(observe(e, a, request(body))).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT 1 FROM cloud_inference_work WHERE scope=?").bind(`account:${a.accountId}`).first()).toBeNull();
  expect(() => validatePreview(jpeg())).not.toThrow();
  expect(() => validatePreview(jpeg(0))).toThrow();
  const afterScan = jpeg();
  expect(() => validatePreview(new Uint8Array([...afterScan.slice(0,-2), 0xff,0xe1,0,4,0,0,0xff,0xd9]))).toThrow();
  expect(() => validatePreview(new Uint8Array([...afterScan.slice(0,-2), ...jpeg(2048).slice(2)]))).toThrow();
});

it("atomically caps concurrent account and global work, including provider failures", async () => {
  const fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_791_417_600_000);
  try {
    const a = actor(), e = configured(1, 20);
    const attempts = await Promise.allSettled([observe(e,a,request(input(a.accountId))),observe(e,a,request(input(a.accountId)))]);
    expect(attempts.filter(v => v.status === "fulfilled")).toHaveLength(1);
    expect((attempts.find(v => v.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({code: "CLOUD_WORK_LIMIT", status: 429});
    expect(fetch).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(1_791_504_000_000);
    const global = configured(20, 1), b = actor(), c = actor();
    fetch.mockImplementation(async () => new Response("unavailable", {status: 503}));
    await expect(observe(global,b,request(input(b.accountId)))).rejects.toMatchObject({code: "CLOUD_PROVIDER_UNAVAILABLE"});
    await expect(observe(global,c,request(input(c.accountId)))).rejects.toMatchObject({code: "CLOUD_WORK_LIMIT"});
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {clock.mockRestore();}
});

it("validates provider results independently from the requested schema and returns generic failure", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_791_590_400_000);
  try {
    for (const invalid of [{...observations, caption: "invented personal copy"}, {...observations, objects: new Array(13).fill("dog")}, {...observations, visibleText: "x".repeat(1201)}]) {
      vi.stubGlobal("fetch", vi.fn(async () => provider(invalid)));
      const a = actor();
      await expect(observe(configured(),a,request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_RESULT_INVALID"});
      expect(() => validateObservation(invalid)).toThrow();
    }
    vi.stubGlobal("fetch", vi.fn(async () => {throw new Error("private-provider-error");}));
    const a = actor();
    await expect(observe(configured(),a,request(input(a.accountId)))).rejects.toMatchObject({message: "CLOUD_PROVIDER_UNAVAILABLE"});
  } finally {clock.mockRestore();}
});

it("rejects truncated, blocked and oversized provider envelopes", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_791_676_800_000);
  try {
    for (const envelope of [{candidates: []}, {candidates: [{finishReason: "MAX_TOKENS", content: {parts: [{text: JSON.stringify(observations)}]}}]},
      {candidates: [{finishReason: "SAFETY"}]}]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(envelope))));
      const a = actor();
      await expect(observe(configured(),a,request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_RESULT_INVALID"});
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(65537))));
    const a = actor();
    await expect(observe(configured(),a,request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_RESULT_INVALID", status: 502});
  } finally {clock.mockRestore();}
});

it("uses the allowed cheap extraction model without inheriting unsupported thinking settings", async () => {
  const fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const a = actor();
  const result = await observe(configured(),a,request({...input(a.accountId), model: "gemini-3.5-flash-lite"}));
  expect(result.processor).toBe("gemini-3.5-flash-lite");
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/gemini-3.5-flash-lite:generateContent");
  expect(JSON.parse(init.body as string).generationConfig.thinkingConfig).toEqual({thinkingLevel: "minimal"});
});

it("authenticates a real opaque session for capability and observation HTTP routes", async () => {
  await seed(); await http(0, "/v1/intelligence/capabilities?expectedAccountId=" + actors[0].accountId);
  const e = configured(), fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const headers = {authorization: "Bearer public-test-0", origin: "http://localhost:4310", "content-type": "application/json"};
  const capability = await app.fetch(new Request(`http://localhost:8787/v1/intelligence/capabilities?expectedAccountId=${actors[0].accountId}`, {headers}), e);
  expect(await capability.json()).toMatchObject({version: 1, enabled: true, models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"]});
  expect(capability.headers.get("cache-control")).toBe("no-store");
  const body = input(actors[0].accountId), response = await app.fetch(new Request("http://localhost:8787/v1/intelligence/observe", {method: "POST", headers, body: JSON.stringify(body)}), e);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({photoId: body.photoId, sourceRevision: body.sourceRevision, observations});
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects missing, malformed and switched-cookie accounts before work or provider dispatch", async () => {
  await seed(); await http(1, "/v1/intelligence/capabilities?expectedAccountId=" + actors[1].accountId);
  const e = configured(), fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const ledger = () => env.DB.prepare("SELECT scope,window,attempts,expires FROM cloud_inference_work ORDER BY scope,window").all();
  const before = await ledger();
  // The cookie now belongs to account 1; the still-unlocked tab expects account 0.
  const headers = {cookie: "fotoro_session=public-test-1", origin: "http://localhost:4310", "content-type": "application/json"};
  for (const expected of [undefined, "not-an-account", actors[0].accountId]) {
    const query = expected === undefined ? "" : "?expectedAccountId=" + encodeURIComponent(expected);
    const capability = await app.fetch(new Request("http://localhost:8787/v1/intelligence/capabilities" + query, {headers}), e);
    const body: any = {...input(actors[1].accountId), expectedAccountId: expected};
    const response = await app.fetch(new Request("http://localhost:8787/v1/intelligence/observe", {method: "POST", headers, body: JSON.stringify(body)}), e);
    for (const rejected of [capability, response]) {
      expect(rejected.status).toBe(expected === actors[0].accountId ? 403 : 400);
      expect(await rejected.json()).toMatchObject({code: expected === actors[0].accountId ? "CLOUD_ACCOUNT_MISMATCH" : "INVALID_WIRE"});
      expect(rejected.headers.get("cache-control")).toBe("no-store");
    }
  }
  expect(fetch).not.toHaveBeenCalled();
  expect((await ledger()).results).toEqual(before.results);
  const matching = await app.fetch(new Request(`http://localhost:8787/v1/intelligence/capabilities?expectedAccountId=${actors[1].accountId}`, {headers}), e);
  expect(matching.status).toBe(200);
});

it("requires bounded spend settings and expires the reviewed pricing before any provider dispatch", async () => {
  const a = actor(), fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  for (const broken of [
    {CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: undefined},
    {CLOUD_INTELLIGENCE_DAILY_GLOBAL_MICROUSD: undefined},
    {CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: "0"},
    {CLOUD_INTELLIGENCE_DAILY_GLOBAL_MICROUSD: "10000000001"},
    {CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: "1.5"},
  ]) {
    const e = {...configured(), ...broken};
    expect(await capabilities(e, a, a.accountId)).toEqual({version: 1, enabled: false});
    await expect(observe(e, a, request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_UNAVAILABLE"});
  }
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-01-01T00:00:00.000Z"));
  try {
    expect(await capabilities(configured(), a, a.accountId)).toEqual({version: 1, enabled: false});
    await expect(observe(configured(), a, request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_UNAVAILABLE"});
  } finally {clock.mockRestore();}
  expect(fetch).not.toHaveBeenCalled();
});

it("reserves conservative model spend atomically before dispatch and never refunds ambiguous failures", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-20T12:00:00.000Z"));
  // Full supported input/output ceilings at reviewed standard rates, including thinking.
  // Flash: 1048576 * .75 + 65536 * 3.75 = 1032192 micro-USD.
  // Lite: ceil(1048576 * .30 + 65536 * 2.50) = 478413 micro-USD.
  const spend = async (scope: string) => (await env.DB.prepare("SELECT attempts FROM cloud_inference_work WHERE scope=? AND window LIKE 'spend:%'").bind(scope).first<{attempts: number}>())?.attempts;
  const fetch = vi.fn(async () => {throw new Error("ambiguous public-fixture transport failure");}); vi.stubGlobal("fetch", fetch);
  try {
    const a = actor(), b = actor();
    const e = {...configured(), CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: "1032192", CLOUD_INTELLIGENCE_DAILY_GLOBAL_MICROUSD: "1510605"};
    const concurrent = await Promise.allSettled([observe(e,a,request(input(a.accountId))), observe(e,a,request(input(a.accountId)))]);
    expect(concurrent.map(value => value.status === "rejected" ? value.reason.code : "success").sort()).toEqual(["CLOUD_PROVIDER_UNAVAILABLE", "CLOUD_WORK_LIMIT"]);
    expect(await spend(`account:${a.accountId}`)).toBe(1032192);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(observe(e,b,request({...input(b.accountId), model: "gemini-3.5-flash-lite"}))).rejects.toMatchObject({code: "CLOUD_PROVIDER_UNAVAILABLE"});
    expect(await spend("global")).toBe(1510605);
    const c = actor();
    await expect(observe(e,c,request({...input(c.accountId), model: "gemini-3.5-flash-lite"}))).rejects.toMatchObject({code: "CLOUD_WORK_LIMIT"});
    expect(await spend(`account:${c.accountId}`)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(Date.parse("2026-10-21T00:00:00.000Z"));
    fetch.mockImplementation(async () => provider());
    await expect(observe(e,a,request(input(a.accountId)))).resolves.toMatchObject({observations});
    expect(await spend("global")).toBe(1032192);
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {clock.mockRestore();}
});

it("rejects unaffordable work without charging counters and caps cross-account concurrent spend", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T12:00:00.000Z"));
  const fetch = vi.fn(async () => provider()); vi.stubGlobal("fetch", fetch);
  const spend = () => env.DB.prepare("SELECT scope,window,attempts FROM cloud_inference_work ORDER BY scope,window").all();
  try {
    const a = actor(), e = {...configured(), CLOUD_INTELLIGENCE_DAILY_ACCOUNT_MICROUSD: "1032191"};
    const before = await spend();
    await expect(observe(e,a,request(input(a.accountId)))).rejects.toMatchObject({code: "CLOUD_WORK_LIMIT"});
    expect((await spend()).results).toEqual(before.results);
    expect(fetch).not.toHaveBeenCalled();
    const limited = {...configured(), CLOUD_INTELLIGENCE_DAILY_GLOBAL_MICROUSD: "1032192"};
    const people = [actor(), actor()];
    const results = await Promise.allSettled(people.map(person => observe(limited,person,request(input(person.accountId)))));
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect((results.find(value => value.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({code: "CLOUD_WORK_LIMIT"});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await spend()).results.filter(value => value.scope === "global" && String(value.window).startsWith("spend:"))).toEqual([{scope: "global", window: `spend:day:${Math.floor(Date.now() / 86400000)}`, attempts: 1032192}]);
  } finally {clock.mockRestore();}
});
