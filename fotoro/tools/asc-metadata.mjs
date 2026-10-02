import { createPrivateKey, KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "6818330547";
const BUNDLE_ID = "cloud.fotoro.Fotoro";
const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const internalBetaStates = new Set([
  "PROCESSING", "PROCESSING_EXCEPTION", "MISSING_EXPORT_COMPLIANCE",
  "READY_FOR_BETA_TESTING", "IN_BETA_TESTING", "EXPIRED", "IN_EXPORT_COMPLIANCE_REVIEW",
]);
const externalBetaStates = new Set([
  ...internalBetaStates, "READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW",
  "IN_BETA_REVIEW", "BETA_REJECTED", "BETA_APPROVED", "NOT_APPLICABLE",
]);
const locales = new Set([
  "da", "de-DE", "el", "en-AU", "en-CA", "en-GB", "en-US", "es-ES", "es-MX",
  "fi", "fr-CA", "fr-FR", "id", "it", "ja", "ko", "ms", "nl-NL", "no",
  "pt-BR", "pt-PT", "ru", "sv", "th", "tr", "vi", "zh-Hans", "zh-Hant",
]);
export const LOCAL_PREVIEW_NOTES = "Browse photos from the last 10 days. Search permitted photos and recognized text (OCR). Share original photos. This local-only preview does not include hosted backup.";

function fail(code) {
  const error = new Error(`ASC metadata failed: ${code}.`);
  error.name = "AscMetadataError";
  error.code = code;
  throw error;
}
function safeError(error, fallback = "INVALID_API_RESPONSE") {
  if (error?.name === "AscMetadataError") throw error;
  fail(fallback);
}
function resource(value, type) {
  if (!value || value.type !== type || typeof value.id !== "string"
      || !/^[A-Za-z0-9-]{1,128}$/.test(value.id)) fail("INVALID_API_RESPONSE");
  return value;
}
function appScope(value) {
  if (value?.type !== "apps" || value.id !== APP_ID || value.attributes?.bundleId !== BUNDLE_ID) {
    fail("APP_SCOPE_MISMATCH");
  }
}
function selectedBuild({ version, buildNumber } = {}) {
  if (typeof version !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(version)
      || typeof buildNumber !== "string" || !/^[1-9]\d{0,17}$/.test(buildNumber)) {
    fail("INVALID_BUILD_SELECTOR");
  }
  return { version, buildNumber };
}
function date(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}
function status({ build, betaDetail }, selector) {
  const attributes = build.attributes ?? {};
  const betaAttributes = betaDetail?.attributes ?? {};
  return {
    version: selector.version,
    buildNumber: selector.buildNumber,
    platform: "IOS",
    processingState: ["PROCESSING", "FAILED", "INVALID", "VALID"].includes(attributes.processingState)
      ? attributes.processingState : "UNKNOWN",
    uploadedDate: date(attributes.uploadedDate),
    expirationDate: date(attributes.expirationDate),
    expired: typeof attributes.expired === "boolean" ? attributes.expired : null,
    usesNonExemptEncryption: typeof attributes.usesNonExemptEncryption === "boolean" ? attributes.usesNonExemptEncryption : null,
    internalBuildState: internalBetaStates.has(betaAttributes.internalBuildState) ? betaAttributes.internalBuildState : "UNKNOWN",
    externalBuildState: externalBetaStates.has(betaAttributes.externalBuildState) ? betaAttributes.externalBuildState : "UNKNOWN",
  };
}
function notesInput({ locale = "en-US", notes, localPreview = false }) {
  if (!locales.has(locale)) fail("INVALID_LOCALE");
  if (typeof localPreview !== "boolean" || (localPreview && notes !== undefined)) fail("AMBIGUOUS_NOTES_INPUT");
  if (localPreview && locale !== "en-US") fail("PREVIEW_NOTES_LOCALE_MISMATCH");
  const text = localPreview ? LOCAL_PREVIEW_NOTES : notes;
  if (typeof text !== "string" || !text.trim() || [...text].length > 4000 || text.includes("\0")) fail("INVALID_NOTES");
  // Validate without trimming or rewriting user-supplied copy.
  return { locale, notes: text };
}
function list(document) {
  if (!Array.isArray(document?.data)) fail("INVALID_API_RESPONSE");
  // Exact filtered build and locale queries fit in one page. Never follow an
  // arbitrary response link with a credential or choose from a partial result.
  if (document.links?.next) fail("PAGINATION_REQUIRED");
  return document.data;
}

/*
 * App Store Connect authentication is deliberately separate from archive/export.
 * Team keys use iss; individual keys use sub=user and must not invent an issuer.
 * Tokens and private keys remain in process memory and never enter diagnostics.
 */
export function createAscMetadataClient({
  keyId, issuerId, subject, privateKey, fetchImpl = globalThis.fetch, now = Date.now,
} = {}) {
  if (typeof keyId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(keyId)) fail("KEY_ID_REQUIRED");
  if (subject !== undefined && subject !== "" && subject !== "user") fail("INVALID_KEY_SUBJECT");
  const individual = subject === "user";
  if (individual && issuerId !== undefined && issuerId !== "") fail("INDIVIDUAL_ISSUER_NOT_ALLOWED");
  if (!individual && (typeof issuerId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issuerId))) {
    fail("TEAM_ISSUER_REQUIRED");
  }
  if (typeof fetchImpl !== "function" || typeof now !== "function") fail("INVALID_CLIENT_CONFIGURATION");
  let key;
  try {
    key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    if (key.type !== "private" || key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      fail("INVALID_SIGNING_KEY");
    }
  } catch (error) { safeError(error, "INVALID_SIGNING_KEY"); }

  function token(method, path) {
    try {
      const issued = Math.floor(now() / 1000);
      if (!Number.isSafeInteger(issued) || issued < 0) fail("INVALID_CLOCK");
      const header = { alg: "ES256", kid: keyId, typ: "JWT" };
      const claims = {
        ...(individual ? { sub: "user" } : { iss: issuerId }),
        iat: issued, exp: issued + 120, aud: "appstoreconnect-v1",
        // Apple documents operation scopes for GET tokens. Writes use a fresh
        // two-minute token and the closed notes-only request surface below.
        ...(method === "GET" ? { scope: [`GET ${path}`] } : {}),
      };
      const message = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      const signature = sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" });
      if (signature.length !== 64) fail("INVALID_SIGNATURE");
      return `${message}.${signature.toString("base64url")}`;
    } catch (error) { safeError(error, "JWT_SIGNING_FAILED"); }
  }
  async function request(path, method = "GET", body) {
    const url = new URL(path, API_ORIGIN);
    const readPath = /^\/v1\/(?:apps\/6818330547|builds|builds\/[A-Za-z0-9-]+\/(?:app|betaBuildLocalizations)|betaBuildLocalizations\/[A-Za-z0-9-]+(?:\/relationships\/build)?)$/;
    const writePath = method === "POST" ? url.pathname === "/v1/betaBuildLocalizations"
      : method === "PATCH" && /^\/v1\/betaBuildLocalizations\/[A-Za-z0-9-]+$/.test(url.pathname);
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash
        || (method === "GET" ? !readPath.test(url.pathname) : !writePath)) fail("REQUEST_SCOPE_REJECTED");
    let response;
    try {
      response = await fetchImpl(url.href, {
        method,
        headers: { Authorization: `Bearer ${token(method, url.pathname + url.search)}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000),
      });
    } catch (error) { safeError(error, "ASC_NETWORK_FAILED"); }
    if (response?.redirected || (response?.status >= 300 && response.status < 400)) fail("ASC_REDIRECT_REJECTED");
    if (response?.url && new URL(response.url).origin !== API_ORIGIN) fail("ASC_RESPONSE_ORIGIN_MISMATCH");
    if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599) fail("INVALID_API_RESPONSE");
    if (response.status < 200 || response.status >= 300) fail(`ASC_HTTP_${response.status}`);
    try {
      const text = await response.text();
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) fail("API_RESPONSE_TOO_LARGE");
      return JSON.parse(text);
    } catch (error) { safeError(error); }
  }
  async function exactBuild(selector) {
    appScope((await request(`/v1/apps/${APP_ID}?fields[apps]=bundleId`)).data);
    const query = new URLSearchParams({
      "filter[app]": APP_ID,
      "filter[version]": selector.buildNumber,
      "filter[preReleaseVersion.version]": selector.version,
      "filter[preReleaseVersion.platform]": "IOS",
      include: "preReleaseVersion,app,buildBetaDetail",
      "fields[builds]": "version,uploadedDate,expirationDate,expired,processingState,usesNonExemptEncryption,app,preReleaseVersion,buildBetaDetail",
      "fields[preReleaseVersions]": "version,platform",
      "fields[apps]": "bundleId",
      "fields[buildBetaDetails]": "internalBuildState,externalBuildState",
      limit: "200",
    });
    const document = await request(`/v1/builds?${query}`);
    const builds = list(document);
    if (!builds.length) fail("BUILD_NOT_FOUND");
    if (builds.length !== 1) fail("AMBIGUOUS_BUILD");
    const build = resource(builds[0], "builds");
    const prerelease = build.relationships?.preReleaseVersion?.data;
    const related = Array.isArray(document.included) ? document.included.filter(value => value.type === "preReleaseVersions" && value.id === prerelease?.id) : [];
    if (build.attributes?.version !== selector.buildNumber || build.relationships?.app?.data?.type !== "apps"
        || build.relationships.app.data.id !== APP_ID || prerelease?.type !== "preReleaseVersions"
        || related.length !== 1 || related[0].attributes?.version !== selector.version || related[0].attributes?.platform !== "IOS") {
      fail("BUILD_SCOPE_MISMATCH");
    }
    resource(prerelease, "preReleaseVersions");
    const betaLink = build.relationships?.buildBetaDetail?.data;
    const betaDetails = Array.isArray(document.included) ? document.included.filter(value => value.type === "buildBetaDetails") : [];
    if ((betaLink == null && betaDetails.length)
        || (betaLink != null && (betaLink.type !== "buildBetaDetails" || typeof betaLink.id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(betaLink.id)))
        || betaDetails.length > 1 || (betaDetails.length && betaDetails[0].id !== betaLink?.id)) {
      fail("BETA_DETAIL_SCOPE_MISMATCH");
    }
    // During processing Apple may omit both detail and linkage, or provide
    // linkage before the included detail. Neither case proves availability.
    const betaDetail = betaDetails[0];
    if (betaDetail) {
      resource(betaDetail, "buildBetaDetails");
      const linkedBuild = betaDetail.relationships?.build?.data;
      if (linkedBuild !== undefined && (linkedBuild?.type !== "builds" || linkedBuild.id !== build.id)) fail("BETA_DETAIL_SCOPE_MISMATCH");
    }
    return { build, betaDetail };
  }
  async function readBuildStatus(input) {
    try {
      const selector = selectedBuild(input);
      return Object.freeze(status(await exactBuild(selector), selector));
    } catch (error) { safeError(error); }
  }
  async function setWhatToTest(input = {}) {
    try {
      const selector = selectedBuild(input);
      const { locale, notes } = notesInput(input);
      const selection = await exactBuild(selector);
      const { build } = selection;
      const localizations = list(await request(`/v1/builds/${build.id}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale,whatsNew,build&limit=200`));
      const matching = localizations.filter(value => value.attributes?.locale === locale);
      if (matching.length > 1) fail("AMBIGUOUS_LOCALIZATION");
      const existing = matching.length ? resource(matching[0], "betaBuildLocalizations") : undefined;
      if (existing) {
        const linked = (await request(`/v1/betaBuildLocalizations/${existing.id}/relationships/build`)).data;
        if (linked?.type !== "builds" || linked.id !== build.id) fail("LOCALIZATION_SCOPE_MISMATCH");
      }
      // Fresh exact app/bundle check on the selected build immediately before
      // the sole write. Filter responses alone never authorize a mutation.
      appScope((await request(`/v1/builds/${build.id}/app?fields[apps]=bundleId`)).data);
      const document = existing
        ? await request(`/v1/betaBuildLocalizations/${existing.id}`, "PATCH", { data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew: notes } } })
        : await request("/v1/betaBuildLocalizations", "POST", { data: { type: "betaBuildLocalizations", attributes: { locale, whatsNew: notes }, relationships: { build: { data: { type: "builds", id: build.id } } } } });
      const written = resource(document.data, "betaBuildLocalizations");
      if (existing && written.id !== existing.id) fail("LOCALIZATION_SCOPE_MISMATCH");
      const verified = resource((await request(`/v1/betaBuildLocalizations/${written.id}?fields[betaBuildLocalizations]=locale,whatsNew,build`)).data, "betaBuildLocalizations");
      if (verified.id !== written.id || verified.attributes?.locale !== locale || verified.attributes?.whatsNew !== notes) fail("NOTES_NOT_VERIFIED");
      const linked = verified.relationships?.build?.data;
      if (linked?.type !== "builds" || linked.id !== build.id) fail("LOCALIZATION_SCOPE_MISMATCH");
      return Object.freeze({ ...status(selection, selector), locale, action: existing ? "updated" : "created", notesVerified: true });
    } catch (error) { safeError(error); }
  }
  return Object.freeze({ readBuildStatus, setWhatToTest });
}

function cliArguments(args) {
  const action = args[0];
  if (!["status", "set-what-to-test"].includes(action)) fail("INVALID_CLI_ARGUMENTS");
  const options = {};
  const flags = new Map([["--version", "version"], ["--build", "buildNumber"], ["--locale", "locale"], ["--notes-file", "notesFile"]]);
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--local-preview") {
      if (options.localPreview) fail("INVALID_CLI_ARGUMENTS");
      options.localPreview = true;
      continue;
    }
    const name = flags.get(flag);
    if (!name || name in options || !args[index + 1] || args[index + 1].startsWith("--")) fail("INVALID_CLI_ARGUMENTS");
    options[name] = args[++index];
  }
  selectedBuild(options);
  if (action === "status" && (options.notesFile || options.localPreview || options.locale)) fail("INVALID_CLI_ARGUMENTS");
  if (action === "set-what-to-test" && Boolean(options.notesFile) === Boolean(options.localPreview)) fail("INVALID_CLI_ARGUMENTS");
  return { action, options };
}
async function main() {
  try {
    const { action, options } = cliArguments(process.argv.slice(2));
    if (options.notesFile) options.notes = readFileSync(options.notesFile, "utf8");
    if (!process.env.ASC_KEY_PATH) fail("KEY_PATH_REQUIRED");
    const client = createAscMetadataClient({
      keyId: process.env.ASC_KEY_ID,
      issuerId: process.env.ASC_ISSUER_ID || undefined,
      subject: process.env.ASC_KEY_SUBJECT || undefined,
      privateKey: readFileSync(process.env.ASC_KEY_PATH),
    });
    const result = action === "status" ? await client.readBuildStatus(options) : await client.setWhatToTest(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = error?.name === "AscMetadataError" ? error.code : "LOCAL_INPUT_FAILED";
    console.error(`ASC metadata failed: ${code}.`);
    console.error("Usage: node tools/asc-metadata.mjs status --version VERSION --build BUILD");
    console.error("   or: node tools/asc-metadata.mjs set-what-to-test --version VERSION --build BUILD [--locale en-US] (--local-preview | --notes-file FILE)");
    process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
