import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [buildNumber, ...flags] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(buildNumber ?? "") || flags.some(flag => flag !== "--upload")) {
  console.error("Usage: node tools/build-testflight.mjs <build-number> [--upload]");
  console.error("Set FOTORO_DEVELOPMENT_TEAM; sign in to Xcode or provide all three ASC_KEY_* variables.");
  process.exit(2);
}
const team = process.env.FOTORO_DEVELOPMENT_TEAM;
if (!team) throw new Error("FOTORO_DEVELOPMENT_TEAM is required.");
const credentials = [process.env.ASC_KEY_PATH, process.env.ASC_KEY_ID, process.env.ASC_ISSUER_ID];
if (credentials.some(Boolean) && !credentials.every(Boolean)) {
  throw new Error("Provide ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID together, or use the signed-in Xcode account.");
}
if (credentials[0] && !existsSync(credentials[0])) throw new Error("ASC_KEY_PATH does not exist.");
const authentication = credentials.every(Boolean) ? [
  "-authenticationKeyPath", credentials[0],
  "-authenticationKeyID", credentials[1],
  "-authenticationKeyIssuerID", credentials[2],
] : [];
const output = mkdtempSync(join(tmpdir(), "fotoro-testflight-"));
const archive = join(output, `Fotoro-${buildNumber}.xcarchive`);
const project = join(root, "apps/ios/Fotoro.xcodeproj");
const exportOptions = join(root, "apps/ios/ExportOptions-TestFlight.plist");
// Apple's rsync launches a peer by name. Keep both peers on the Apple toolchain
// so Homebrew rsync cannot reject Apple's extended-attributes option at export.
const toolchainEnv = {...process.env, PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`};

async function run(args, logName) {
  const log = join(output, logName);
  const fd = openSync(log, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/xcodebuild", args, { cwd: root, env: toolchainEnv, stdio: ["ignore", fd, fd] });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(`xcodebuild failed (${code}); diagnostics: ${log}`)));
    });
  } finally { closeSync(fd); }
}

console.log(`Archiving Fotoro build ${buildNumber}…`);
await run([
  "-project", project, "-scheme", "Fotoro", "-configuration", "Release",
  "-destination", "generic/platform=iOS", "-archivePath", archive,
  "-derivedDataPath", join(tmpdir(), "fotoro-release-derived"),
  "-allowProvisioningUpdates", ...authentication,
  `DEVELOPMENT_TEAM=${team}`, `CURRENT_PROJECT_VERSION=${buildNumber}`, "archive",
], "archive.log");
console.log(`Archive succeeded: ${archive}`);
if (flags.includes("--upload")) {
  console.log("Uploading to App Store Connect…");
  await run([
    "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", exportOptions,
    "-exportPath", join(output, "export"), "-allowProvisioningUpdates", ...authentication,
  ], "upload.log");
  console.log("Upload succeeded. Verify build processing and encryption compliance in App Store Connect before distributing.");
}
console.log(`Release diagnostics: ${output}`);
