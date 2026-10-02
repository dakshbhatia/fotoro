import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createAscMetadataClient, LOCAL_PREVIEW_NOTES } from "./asc-metadata.mjs";

const APP = "6818330547";
const BUNDLE = "cloud.fotoro.Fotoro";
const BUILD = "11111111-1111-4111-8111-111111111111";
const PRE = "22222222-2222-4222-8222-222222222222";
const LOCALIZATION = "33333333-3333-4333-8333-333333333333";
const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY_ID = "FAKEKEY123";
const ISSUER = "44444444-4444-4444-8444-444444444444";
const selector = { version: "0.1.0", buildNumber: "3" };
const app = { type: "apps", id: APP, attributes: { bundleId: BUNDLE } };
function buildDocument() {
  return { data: [{ type: "builds", id: BUILD, attributes: { version: "3", processingState: "VALID", uploadedDate: "2026-10-01T23:00:00Z", expired: false }, relationships: { app: { data: { type: "apps", id: APP } }, preReleaseVersion: { data: { type: "preReleaseVersions", id: PRE } } } }], included: [{ type: "preReleaseVersions", id: PRE, attributes: { version: "0.1.0", platform: "IOS" } }], links: { next: null } };
}
function localization(notes = "Old notes") {
  return { type: "betaBuildLocalizations", id: LOCALIZATION, attributes: { locale: "en-US", whatsNew: notes }, relationships: { build: { data: { type: "builds", id: BUILD } } } };
}
function fixture(options = {}) {
  const calls = [];
  let notes = "Old notes";
  const fetchImpl = async (url, request) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, request });
    if (options.fetchOverride) {
      const response = await options.fetchOverride(parsed, request, calls);
      if (response) return response;
    }
    let data;
    if (parsed.pathname === `/v1/apps/${APP}` || parsed.pathname === `/v1/builds/${BUILD}/app`) data = { data: structuredClone(options.app ?? app) };
    else if (parsed.pathname === "/v1/builds") data = options.builds ?? buildDocument();
    else if (parsed.pathname === `/v1/builds/${BUILD}/betaBuildLocalizations`) data = { data: options.existing ? [localization()] : [], links: { next: null } };
    else if (parsed.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}/relationships/build`) data = { data: { type: "builds", id: options.localizationBuild ?? BUILD } };
    else if (request.method === "POST" && parsed.pathname === "/v1/betaBuildLocalizations") { notes = JSON.parse(request.body).data.attributes.whatsNew; data = { data: localization(notes) }; }
    else if (request.method === "PATCH" && parsed.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}`) { notes = JSON.parse(request.body).data.attributes.whatsNew; data = { data: localization(notes) }; }
    else if (request.method === "GET" && parsed.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}`) data = { data: localization(notes) };
    else throw new Error("Unexpected test endpoint");
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createAscMetadataClient({ keyId: KEY_ID, issuerId: ISSUER, privateKey: keyPair.privateKey, fetchImpl, now: () => 1_800_000_000_000, ...(options.auth ?? {}) });
  return { client, calls };
}
function jwt(call) {
  const token = call.request.headers.Authorization.slice("Bearer ".length);
  const parts = token.split(".");
  return { header: JSON.parse(Buffer.from(parts[0], "base64url")), claims: JSON.parse(Buffer.from(parts[1], "base64url")), signature: Buffer.from(parts[2], "base64url"), message: `${parts[0]}.${parts[1]}`, token };
}
function writes(calls) { return calls.filter(call => call.request.method !== "GET"); }
function safeError(code) { return error => error.code === code && !error.message.includes(KEY_ID) && !error.message.includes(ISSUER) && !error.message.includes("PRIVATE KEY"); }

test("team auth creates a short-lived valid ES256 P1363 JWT in memory", async () => {
  const { client, calls } = fixture(); await client.readBuildStatus(selector);
  const token = jwt(calls[0]);
  assert.deepEqual(token.header, { alg: "ES256", kid: KEY_ID, typ: "JWT" });
  assert.equal(token.claims.iss, ISSUER); assert.equal(token.claims.sub, undefined);
  assert.equal(token.claims.aud, "appstoreconnect-v1"); assert.equal(token.claims.exp - token.claims.iat, 120);
  assert.equal(token.signature.length, 64);
  assert.equal(verify("sha256", Buffer.from(token.message), { key: keyPair.publicKey, dsaEncoding: "ieee-p1363" }, token.signature), true);
});
test("individual auth uses sub user and omits issuer", async () => {
  const { client, calls } = fixture({ auth: { issuerId: undefined, subject: "user" } }); await client.readBuildStatus(selector);
  const token = jwt(calls[0]); assert.equal(token.claims.sub, "user"); assert.equal(token.claims.iss, undefined);
  assert.equal(verify("sha256", Buffer.from(token.message), { key: keyPair.publicKey, dsaEncoding: "ieee-p1363" }, token.signature), true);
});
test("individual credentials cannot silently invent or use an issuer", () => {
  assert.throws(() => fixture({ auth: { subject: "user" } }), safeError("INDIVIDUAL_ISSUER_NOT_ALLOWED"));
});
test("missing team issuer and unsupported subjects fail safely", () => {
  assert.throws(() => fixture({ auth: { issuerId: undefined } }), safeError("TEAM_ISSUER_REQUIRED"));
  assert.throws(() => fixture({ auth: { subject: "somebody" } }), safeError("INVALID_KEY_SUBJECT"));
});
test("non-P256 private keys are rejected", () => {
  const wrong = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  assert.throws(() => fixture({ auth: { privateKey: wrong.privateKey } }), safeError("INVALID_SIGNING_KEY"));
});
test("read status is GET-only and restricts exact app, iOS version and build", async () => {
  const { client, calls } = fixture(); const status = await client.readBuildStatus(selector);
  assert.equal(writes(calls).length, 0); assert.equal(status.processingState, "VALID"); assert.equal(status.buildNumber, "3");
  const query = calls.find(call => call.url.pathname === "/v1/builds").url.searchParams;
  assert.equal(query.get("filter[app]"), APP); assert.equal(query.get("filter[version]"), "3"); assert.equal(query.get("filter[preReleaseVersion.version]"), "0.1.0"); assert.equal(query.get("filter[preReleaseVersion.platform]"), "IOS");
  assert.ok(calls.every(call => call.url.origin === "https://api.appstoreconnect.apple.com" && call.request.redirect === "error" && call.request.credentials === "omit"));
  const serialized = JSON.stringify(status); assert.ok(!serialized.includes(KEY_ID) && !serialized.includes(ISSUER) && !serialized.includes(jwt(calls[0]).token));
});
test("wrong exact app or bundle prevents all writes", async () => {
  for (const changed of [{ ...app, id: "elsewhere" }, { ...app, attributes: { bundleId: "other.bundle" } }]) {
    const { client, calls } = fixture({ app: changed });
    await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("APP_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
  }
});
test("a foreign build relationship cannot pass filtered lookup", async () => {
  const builds = buildDocument(); builds.data[0].relationships.app.data.id = "other-app";
  const { client, calls } = fixture({ builds }); await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("BUILD_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
});
test("wrong marketing version, platform or build cannot pass lookup", async () => {
  for (const mutate of [doc => doc.included[0].attributes.version = "9.0", doc => doc.included[0].attributes.platform = "MAC_OS", doc => doc.data[0].attributes.version = "30"]) {
    const builds = buildDocument(); mutate(builds); const { client, calls } = fixture({ builds });
    await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("BUILD_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
  }
});
test("missing and ambiguous exact builds fail closed", async () => {
  const missing = buildDocument(); missing.data = [];
  await assert.rejects(fixture({ builds: missing }).client.readBuildStatus(selector), safeError("BUILD_NOT_FOUND"));
  const duplicate = buildDocument(); duplicate.data.push(structuredClone(duplicate.data[0]));
  const { client, calls } = fixture({ builds: duplicate }); await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("AMBIGUOUS_BUILD")); assert.equal(writes(calls).length, 0);
});
test("unexpected pagination is not followed with a bearer token", async () => {
  const builds = buildDocument(); builds.links.next = "https://attacker.invalid/collect";
  const { client, calls } = fixture({ builds }); await assert.rejects(client.readBuildStatus(selector), safeError("PAGINATION_REQUIRED")); assert.equal(calls.length, 2);
});
test("explicit local-preview notes create only the exact build localization", async () => {
  const { client, calls } = fixture(); const result = await client.setWhatToTest({ ...selector, localPreview: true });
  const mutations = writes(calls); assert.equal(mutations.length, 1); const write = mutations[0];
  assert.equal(write.request.method, "POST"); assert.equal(write.url.pathname, "/v1/betaBuildLocalizations");
  const body = JSON.parse(write.request.body).data;
  assert.deepEqual(body.attributes, { locale: "en-US", whatsNew: LOCAL_PREVIEW_NOTES }); assert.deepEqual(body.relationships.build.data, { type: "builds", id: BUILD });
  assert.equal(calls[calls.indexOf(write) - 1].url.pathname, `/v1/builds/${BUILD}/app`);
  assert.equal(result.action, "created"); assert.equal(result.notesVerified, true);
  assert.match(LOCAL_PREVIEW_NOTES, /last 10 days/); assert.match(LOCAL_PREVIEW_NOTES, /OCR/); assert.match(LOCAL_PREVIEW_NOTES, /[Ss]hare/); assert.match(LOCAL_PREVIEW_NOTES, /does not include hosted backup/);
});
test("existing exact locale patches only whatsNew", async () => {
  const { client, calls } = fixture({ existing: true }); const result = await client.setWhatToTest({ ...selector, notes: "Precisely supplied notes" });
  const write = writes(calls)[0]; assert.equal(write.request.method, "PATCH"); assert.equal(write.url.pathname, `/v1/betaBuildLocalizations/${LOCALIZATION}`);
  assert.deepEqual(JSON.parse(write.request.body), { data: { type: "betaBuildLocalizations", id: LOCALIZATION, attributes: { whatsNew: "Precisely supplied notes" } } });
  assert.equal(result.action, "updated"); assert.ok(calls.some(call => call.url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}/relationships/build`));
});
test("localization linked to another build cannot be patched", async () => {
  const { client, calls } = fixture({ existing: true, localizationBuild: "other-build" });
  await assert.rejects(client.setWhatToTest({ ...selector, notes: "notes" }), safeError("LOCALIZATION_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
});
test("fresh build app ownership check runs immediately before any write", async () => {
  const { client, calls } = fixture({ fetchOverride(url) { if (url.pathname === `/v1/builds/${BUILD}/app`) return new Response(JSON.stringify({ data: { ...app, attributes: { bundleId: "changed.bundle" } } })); } });
  await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("APP_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
});
test("custom notes preserve every supplied character and are not printed in results", async () => {
  const notes = "  My original wording.\nNo added words.  "; const { client } = fixture(); const result = await client.setWhatToTest({ ...selector, notes });
  assert.equal(result.notesVerified, true); assert.ok(!JSON.stringify(result).includes(notes));
});
test("invalid selectors, locale and notes fail before a request", async () => {
  const { client, calls } = fixture();
  for (const input of [{ version: "0.1.0", buildNumber: "../../groups" }, { ...selector, locale: "bad", notes: "notes" }, { ...selector, notes: "  " }, { ...selector, notes: "a".repeat(4001) }, { ...selector, notes: "notes", localPreview: true }, { ...selector, localPreview: true, locale: "fr-FR" }]) {
    await assert.rejects(client.setWhatToTest(input));
  }
  assert.equal(calls.length, 0);
});
test("malformed resource IDs cannot redirect a notes operation", async () => {
  const builds = buildDocument(); builds.data[0].id = "../../betaGroups";
  const { client, calls } = fixture({ builds }); await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("INVALID_API_RESPONSE")); assert.equal(writes(calls).length, 0);
});
test("network and API errors never expose credentials or raw server text", async () => {
  const { client } = fixture({ fetchOverride() { throw new Error(`${KEY_ID} ${ISSUER} PRIVATE KEY /private/key.p8`); } });
  await assert.rejects(client.readBuildStatus(selector), safeError("ASC_NETWORK_FAILED"));
  const denied = fixture({ fetchOverride() { return new Response(`${KEY_ID} /private/key.p8`, { status: 401 }); } });
  await assert.rejects(denied.client.readBuildStatus(selector), error => safeError("ASC_HTTP_401")(error) && !error.message.includes("/private"));
});
test("redirect and foreign response origins fail closed", async () => {
  const redirect = fixture({ fetchOverride() { return new Response(null, { status: 302 }); } });
  await assert.rejects(redirect.client.readBuildStatus(selector), safeError("ASC_REDIRECT_REJECTED"));
  const foreign = fixture({ fetchOverride() { return { ok: true, status: 200, redirected: false, url: "https://attacker.invalid", text: async () => JSON.stringify({ data: app }) }; } });
  await assert.rejects(foreign.client.readBuildStatus(selector), safeError("ASC_RESPONSE_ORIGIN_MISMATCH"));
});
test("notes must be read back exactly, with no mutation retry", async () => {
  const { client, calls } = fixture({ fetchOverride(url, request) { if (request.method === "GET" && url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}`) return new Response(JSON.stringify({ data: localization("different") })); } });
  await assert.rejects(client.setWhatToTest({ ...selector, localPreview: true }), safeError("NOTES_NOT_VERIFIED")); assert.equal(writes(calls).length, 1);
});
test("notes readback verifies build through linkage when inline data is omitted", async () => {
  const notes = "Keep these exact words.";
  for (const existing of [true, false]) {
    const { client, calls } = fixture({ existing, fetchOverride(url, request) {
      if (request.method === "GET" && url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}`) {
        const data = localization(notes);
        data.relationships.build = { links: { related: `https://api.appstoreconnect.apple.com/v1/betaBuildLocalizations/${LOCALIZATION}/build` } };
        return new Response(JSON.stringify({ data }));
      }
    } });
    const result = await client.setWhatToTest({ ...selector, notes });
    assert.equal(result.notesVerified, true);
    assert.equal(result.action, existing ? "updated" : "created");
    assert.equal(writes(calls).length, 1);
    const readbackIndex = calls.findIndex(call => call.request.method === "GET" && call.url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}`);
    assert.equal(calls[readbackIndex + 1].url.pathname, `/v1/betaBuildLocalizations/${LOCALIZATION}/relationships/build`);
    if (existing) assert.ok(calls.slice(0, calls.indexOf(writes(calls)[0])).some(call => call.url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}/relationships/build`));
  }
});
test("foreign postwrite linkage cannot pass exact notes and inline build readback", async () => {
  for (const linked of [{ type: "builds", id: "foreign-build" }, { type: "apps", id: BUILD }]) {
    const { client, calls } = fixture({ existing: true, fetchOverride(url, request, recorded) {
      if (url.pathname === `/v1/betaBuildLocalizations/${LOCALIZATION}/relationships/build` && writes(recorded).length) {
        return new Response(JSON.stringify({ data: linked }));
      }
    } });
    await assert.rejects(client.setWhatToTest({ ...selector, notes: "Keep these exact words." }), safeError("LOCALIZATION_SCOPE_MISMATCH"));
    assert.equal(writes(calls).length, 1);
  }
});
test("no upload, compliance, group or tester endpoints are reachable", async () => {
  const { client, calls } = fixture(); await client.readBuildStatus(selector); await client.setWhatToTest({ ...selector, localPreview: true });
  assert.deepEqual(Object.keys(client).sort(), ["readBuildStatus", "setWhatToTest"]);
  assert.ok(calls.every(call => !/upload|encryption|betaGroups|testers|review/i.test(call.url.pathname)));
});

test("processing validity is separate from compliance and beta states", async () => {
  const builds = buildDocument();
  const betaID = "55555555-5555-4555-8555-555555555555";
  builds.data[0].attributes.usesNonExemptEncryption = null;
  builds.data[0].relationships.buildBetaDetail = { data: { type: "buildBetaDetails", id: betaID } };
  builds.included.push({ type: "buildBetaDetails", id: betaID, attributes: { internalBuildState: "MISSING_EXPORT_COMPLIANCE", externalBuildState: "MISSING_EXPORT_COMPLIANCE" } });
  const { client, calls } = fixture({ builds });
  const result = await client.readBuildStatus(selector);
  assert.equal(result.processingState, "VALID");
  assert.equal(result.usesNonExemptEncryption, null);
  assert.equal(result.internalBuildState, "MISSING_EXPORT_COMPLIANCE");
  assert.equal(result.externalBuildState, "MISSING_EXPORT_COMPLIANCE");
  const query = calls.find(call => call.url.pathname === "/v1/builds").url.searchParams;
  assert.ok(query.get("include").split(",").includes("buildBetaDetail"));
  assert.ok(query.get("fields[builds]").split(",").includes("buildBetaDetail"));
  assert.ok(query.get("fields[builds]").split(",").includes("usesNonExemptEncryption"));
  assert.equal(query.get("fields[buildBetaDetails]"), "internalBuildState,externalBuildState");
  assert.equal(writes(calls).length, 0);
});
test("pending beta detail reports UNKNOWN without claiming tester readiness", async () => {
  for (const linked of [undefined, null, { type: "buildBetaDetails", id: "55555555-5555-4555-8555-555555555555" }]) {
    const builds = buildDocument();
    builds.data[0].attributes.processingState = "PROCESSING";
    builds.data[0].attributes.usesNonExemptEncryption = false;
    if (linked !== undefined) builds.data[0].relationships.buildBetaDetail = { data: linked };
    const { client } = fixture({ builds }); const result = await client.readBuildStatus(selector);
    assert.equal(result.processingState, "PROCESSING"); assert.equal(result.usesNonExemptEncryption, false);
    assert.equal(result.internalBuildState, "UNKNOWN"); assert.equal(result.externalBuildState, "UNKNOWN");
    assert.equal(result.testerReady, undefined);
  }
});
test("unlinked, mismatched and duplicate beta details cannot supply readiness", async () => {
  const betaID = "55555555-5555-4555-8555-555555555555";
  for (const mutate of [
    doc => {},
    doc => doc.data[0].relationships.buildBetaDetail = { data: { type: "buildBetaDetails", id: "other-detail" } },
    doc => { doc.data[0].relationships.buildBetaDetail = { data: { type: "buildBetaDetails", id: betaID } }; doc.included.push(structuredClone(doc.included.at(-1))); },
    doc => doc.data[0].relationships.buildBetaDetail = { data: { type: "betaGroups", id: betaID } },
  ]) {
    const builds = buildDocument();
    builds.included.push({ type: "buildBetaDetails", id: betaID, attributes: { internalBuildState: "IN_BETA_TESTING", externalBuildState: "IN_BETA_TESTING" } });
    mutate(builds); const { client, calls } = fixture({ builds });
    await assert.rejects(client.readBuildStatus(selector), safeError("BETA_DETAIL_SCOPE_MISMATCH")); assert.equal(writes(calls).length, 0);
  }
});
test("unknown beta-state values never become raw output", async () => {
  const builds = buildDocument(); const betaID = "55555555-5555-4555-8555-555555555555";
  builds.data[0].attributes.usesNonExemptEncryption = "false";
  builds.data[0].relationships.buildBetaDetail = { data: { type: "buildBetaDetails", id: betaID } };
  builds.included.push({ type: "buildBetaDetails", id: betaID, attributes: { internalBuildState: KEY_ID, externalBuildState: ISSUER } });
  const { client } = fixture({ builds }); const result = await client.readBuildStatus(selector);
  assert.equal(result.internalBuildState, "UNKNOWN"); assert.equal(result.externalBuildState, "UNKNOWN");
  assert.equal(result.usesNonExemptEncryption, null);
  assert.ok(!JSON.stringify(result).includes(KEY_ID) && !JSON.stringify(result).includes(ISSUER));
});
