import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const root = fileURLToPath(new URL("..", import.meta.url));
const state = await mkdtemp(join(tmpdir(), "fotoro-exchange-"));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const env = {
  ...process.env,
  FOTORO_LOCAL_STATE: state,
  WRANGLER_SEND_METRICS: "false",
};
const run = (args, cwd = root) =>
  new Promise((resolve, reject) => {
    const process = spawn("pnpm", args, { cwd, env, stdio: "inherit" });
    process.on("error", reject);
    process.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pnpm ${args.join(" ")} exited ${code}`)),
    );
  });
let worker;
let output = "";
try {
  await run(["seed:local"]);
  worker = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
    ],
    {
      cwd: join(root, "services/api"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  worker.on("error", (error) => {
    output += error.message;
  });
  for (const stream of [worker.stdout, worker.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-8000);
    });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null)
      throw new Error(output || "Local Worker exited");
    try {
      ready = (await fetch(url + "/v1/vault")).status === 401;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error("Local Worker did not start\n" + output);
  env.FOTORO_API_URL = url;
  await run(["test:exchange"]);
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    if (process.platform === "win32") worker.kill();
    else
      try {
        process.kill(-worker.pid, "SIGTERM");
      } catch {}
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
  await rm(state, { recursive: true, force: true });
}
