import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.FOTORO_NATIVE_TEST_API_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Native test API requires a valid loopback port");
}
const state = resolve(cwd, process.env.FOTORO_LOCAL_STATE ?? ".wrangler/fotoro-v1");
const directory = await mkdtemp(join(tmpdir(), "fotoro-native-api-"));
let server;
let stopping;
function stop() {
  return stopping ??= (async () => {
    try { await server?.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void stop().then(() => process.exit(0)); });
}
try {
  const config = join(cwd, "wrangler.toml");
  const { workerOptions, main, externalWorkers } = unstable_getMiniflareWorkerOptions(config, "");
  if (workerOptions.bindings?.AUTH_MODE !== "local" || externalWorkers.length > 0 || !main) {
    throw new Error("Native test API requires the local public-fixture Worker configuration");
  }
  const build = spawnSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--env", "", "--config", config,
    "--outdir", directory], { cwd, stdio: "inherit", shell: false });
  if (build.error || build.status !== 0) {
    throw build.error ?? new Error("Native test API bundle failed");
  }
  // Run the real bundled Worker and Wrangler-compatible seeded stores directly.
  // The hot-reload ProxyWorker hop is unnecessary in CI and can lose POSTs.
  // Module rules have already been applied by Wrangler's bundle; v5 accepts
  // the bundled entry directly rather than v4 source-module discovery rules.
  const { modulesRules, ...bundledOptions } = workerOptions;
  server = new Miniflare(convertV4MiniflareOptions({
    ...bundledOptions,
    name: "fotoro-api",
    modules: true,
    modulesRoot: directory,
    scriptPath: join(directory, basename(main, extname(main)) + ".js"),
    host: "127.0.0.1",
    port,
    cf: false,
    resourcePersistencePath: join(state, "v3"),
  }));
  await server.ready;
  console.log(`Public native test API ready at http://127.0.0.1:${port}`);
} catch (error) {
  await stop();
  throw error;
}
