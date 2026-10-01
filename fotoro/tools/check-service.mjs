// Read-only checks for the HTTPS service an installed iPhone and Safari share.
const [originArg, appId] = process.argv.slice(2);
if (!originArg) {
  console.error("Usage: pnpm check:service https://fotoro.cloud [APPLICATION_PREFIX.cloud.fotoro.Fotoro]");
  process.exit(1);
}
const origin = new URL(originArg);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("Use the HTTPS origin only, without credentials, a path or query.");
let failed = false;
async function check(name, path, verify) {
  try {
    const response = await fetch(new URL(path, origin), {redirect: "error", signal: AbortSignal.timeout(10000), headers:{accept:"application/json"}});
    await verify(response);
    console.log(name + ": ready");
  } catch (error) {
    failed = true;
    console.error(name + ": " + (error instanceof Error ? error.message : String(error)));
  }
}
await check("Authenticated API", "/v1/vault", async response => {
  const body = await response.json();
  if (response.status !== 401 || body.version !== 1 || body.code !== "UNAUTHENTICATED")
    throw new Error("Expected the deployed API to require authentication (401 UNAUTHENTICATED).");
});
await check("iPhone passkey association", "/.well-known/apple-app-site-association", async response => {
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Configure APPLE_APP_IDS and serve the association JSON directly over HTTPS.");
  const value = await response.json();
  const apps = value.webcredentials?.apps;
  if (!Array.isArray(apps) || !apps.length || apps.some(id => !/^[A-Z0-9]{10}\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id)))
    throw new Error("Association needs valid application identifiers.");
  if (appId && !apps.includes(appId)) throw new Error("The signed app identifier is absent from webcredentials.apps.");
});
console.log("Physical iPhone passkey, recovery and background-transfer checks still require the signed app.");
process.exitCode = failed ? 1 : 0;
