import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, copyFileSync, chmodSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIosPreview } from "./check-ios-preview.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [buildNumber, ...flags] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(buildNumber ?? "") || flags.some(flag => !["--upload", "--local-preview"].includes(flag))) {
  console.error("Usage: node tools/build-testflight.mjs <build-number> [--upload] [--local-preview]");
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
const localPreview = flags.includes("--local-preview");
const scheme = localPreview ? "FotoroLocalPreview" : "Fotoro";
const output = mkdtempSync(join(tmpdir(), localPreview ? "fotoro-preview-testflight-" : "fotoro-testflight-"));
const archive = join(output, `${scheme}-${buildNumber}.xcarchive`);
const linkMap = join(output, "FotoroLocalPreview-arm64-LinkMap.txt");
const linkMapBuildPath = join(output, "$(TARGET_NAME)-$(CURRENT_ARCH)-LinkMap.txt");
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

console.log(`Archiving ${scheme} build ${buildNumber}…`);
await run([
  "-project", project, "-scheme", scheme, "-configuration", "Release",
  "-destination", "generic/platform=iOS", "-archivePath", archive,
  "-derivedDataPath", localPreview ? join(output, "derived-data") : join(tmpdir(), "fotoro-release-derived"),
  "-allowProvisioningUpdates", ...authentication,
  `DEVELOPMENT_TEAM=${team}`, `CURRENT_PROJECT_VERSION=${buildNumber}`,
  ...(localPreview ? ["LD_GENERATE_MAP_FILE=YES", `LD_MAP_FILE_PATH=${linkMapBuildPath}`] : []), "archive",
], "archive.log");
console.log(`Archive succeeded: ${archive}`);
if (localPreview) {
  checkIosPreview({archivePath: archive, linkMapPath: linkMap});
  console.log("Local preview archive audit passed.");
}
if (flags.includes("--upload")) {
  if (localPreview) {
    // Audit a distribution-signed export as well as the archive before the
    // signed-in Xcode account uploads from that same immutable archive.
    const localExportOptions = join(output, "ExportOptions-Audit.plist");
    copyFileSync(exportOptions, localExportOptions);
    chmodSync(localExportOptions, 0o600);
    execFileSync("/usr/libexec/PlistBuddy", ["-c", "Set :destination export", localExportOptions]);
    const localExport = join(output, "audited-export");
    await run([
      "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", localExportOptions,
      "-exportPath", localExport, "-allowProvisioningUpdates", ...authentication,
    ], "audit-export.log");
    const ipas = readdirSync(localExport).filter(name => name.endsWith(".ipa"));
    if (ipas.length !== 1) throw new Error("Preview export must contain exactly one IPA.");
    const audit = checkIosPreview({archivePath: archive, ipaPath: join(localExport, ipas[0]), linkMapPath: linkMap});
    if (audit.ipaAudited !== true) throw new Error("The distribution IPA audit is required before preview upload.");
    writeFileSync(join(output, "preview-audit.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
    console.log("Local preview distribution IPA audit passed.");
  }
  console.log("Uploading to App Store Connect…");
  await run([
    "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", exportOptions,
    "-exportPath", join(output, "export"), "-allowProvisioningUpdates", ...authentication,
  ], "upload.log");
  console.log("Upload succeeded. Verify build processing and encryption compliance in App Store Connect before distributing.");
}
console.log(`Release diagnostics: ${output}`);
