import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const flags = process.argv.slice(2);
if (flags.some(flag => flag !== "--local-preview")) throw new Error("Usage: node tools/test-ios.mjs [--local-preview]");
const localPreview = flags.includes("--local-preview");
const scheme = localPreview ? "FotoroLocalPreview" : "Fotoro";
const listed = spawnSync(
  "xcrun",
  ["simctl", "list", "devices", "available", "--json"],
  { encoding: "utf8" },
);
if (listed.status !== 0)
  throw new Error(listed.stderr || "Unable to discover iOS Simulators");
const runtimes = Object.entries(JSON.parse(listed.stdout).devices)
  .filter(
    ([runtime]) =>
      /iOS-(\d+)/.test(runtime) && Number(runtime.match(/iOS-(\d+)/)[1]) >= 26,
  )
  .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
const candidates = runtimes
  .flatMap(([, devices]) => devices)
  .filter((device) => device.isAvailable && device.name.startsWith("iPhone"));
const device =
  candidates.find(
    (device) => device.udid === process.env.FOTORO_SIMULATOR_ID,
  ) ?? candidates[0];
if (!device)
  throw new Error("Fotoro needs an installed iOS 26+ iPhone Simulator");
console.log(`Testing ${scheme} on ${device.name} (${device.udid})`);
const child = spawn(
  "xcodebuild",
  [
    "test",
    "-project",
    "apps/ios/Fotoro.xcodeproj",
    "-scheme",
    scheme,
    "-destination",
    `platform=iOS Simulator,id=${device.udid}`,
    "-derivedDataPath",
    localPreview ? "apps/ios/build-local-preview" : "apps/ios/build",
    "CODE_SIGN_IDENTITY=-",
  ],
  { cwd, stdio: "inherit", shell: false },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
