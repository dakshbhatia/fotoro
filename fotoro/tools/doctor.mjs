import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let failed = false;
for (const [name, args] of [
  ["node", ["--version"]],
  ["pnpm", ["--version"]],
]) {
  const result = spawnSync(name, args, { encoding: "utf8" });
  console.log(
    `${name}: ${result.status === 0 ? result.stdout.trim() : "missing"}`,
  );
  failed ||= result.status !== 0;
}
const installed = existsSync(`${root}/node_modules/typescript`);
console.log(
  `Workspace dependencies: ${installed ? "installed" : "run pnpm install --frozen-lockfile"}`,
);
failed ||= !installed;
if (process.platform === "darwin") {
  const result = spawnSync("xcodebuild", ["-version"], { encoding: "utf8" });
  console.log(
    result.status === 0
      ? result.stdout.trim()
      : "Xcode: unavailable (web/API still work)",
  );
}
console.log("Local demo: pnpm dev → http://127.0.0.1:4310");
console.log("Checks: pnpm check; native checks run through Xcode.");
process.exitCode = failed ? 1 : 0;
