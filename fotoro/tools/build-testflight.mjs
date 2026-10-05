import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, copyFileSync, chmodSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkIosPreview } from "./check-ios-preview.mjs";
import { checkIosRelease } from "./check-ios-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [buildNumber, ...flags] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(buildNumber ?? "") || flags.some(flag => !["--upload", "--local-preview", "--preflight"].includes(flag))
    || flags.includes("--preflight") && flags.includes("--upload")) {
  console.error("Usage: node tools/build-testflight.mjs <build-number> [--upload | --preflight] [--local-preview]");
  console.error("Set FOTORO_DEVELOPMENT_TEAM; sign in to Xcode or provide all three ASC_KEY_* variables.");
  process.exit(2);
}
const team = process.env.FOTORO_DEVELOPMENT_TEAM;
if (!team) throw new Error("FOTORO_DEVELOPMENT_TEAM is required.");
const credentials = [process.env.ASC_KEY_PATH, process.env.ASC_KEY_ID, process.env.ASC_ISSUER_ID];
const individual = process.env.ASC_KEY_SUBJECT === "user";
if (flags.includes("--preflight")) {
  let localDistributionIdentityCount = null;
  try {
    localDistributionIdentityCount = (execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {encoding: "utf8"})
      .match(/Apple Distribution:/g) ?? []).length;
  } catch { /* This read-only check is also usable on CI without a macOS keychain. */ }
  const keyPresent = !!credentials[0] && existsSync(credentials[0]);
  const keyType = individual ? "individual" : credentials.every(Boolean) ? "team" : credentials.some(Boolean) ? "incomplete" : "none";
  console.log(JSON.stringify({
    buildNumber, localDistributionIdentityCount,
    apiKeyType: keyType,
    metadataCredentialsConfigured: keyPresent && !!credentials[1] && (individual ? !credentials[2] : !!credentials[2]),
    provisioningAuthentication: keyType === "team" && keyPresent ? "team-api-key" : "signed-in-xcode-account-required",
    xcodeAccountVerified: false,
  }));
  process.exit(0);
}
if (individual && credentials.some(Boolean)) {
  throw new Error("Individual API keys work for App Store Connect metadata, but cannot provision signing. Use a team API key for provisioning, or unset ASC_KEY_* variables to use the signed-in Xcode account.");
}
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
} else {
  checkIosRelease({archivePath: archive, buildNumber, teamIdentifier: team});
  console.log("Full app archive audit passed.");
}
if (flags.includes("--upload")) {
  {
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
    if (ipas.length !== 1) throw new Error("Export must contain exactly one IPA.");
    const audit = localPreview
      ? checkIosPreview({archivePath: archive, ipaPath: join(localExport, ipas[0]), linkMapPath: linkMap})
      : checkIosRelease({archivePath: archive, ipaPath: join(localExport, ipas[0]), buildNumber, teamIdentifier: team});
    if (audit.ipaAudited !== true) throw new Error("The distribution IPA audit is required before upload.");
    writeFileSync(join(output, localPreview ? "preview-audit.json" : "release-audit.json"), JSON.stringify(audit, null, 2), { mode: 0o600 });
    console.log(`${localPreview ? "Local preview" : "Full app"} distribution IPA audit passed.`);
  }
  console.log("Uploading to App Store Connect…");
  await run([
    "-exportArchive", "-archivePath", archive, "-exportOptionsPlist", exportOptions,
    "-exportPath", join(output, "export"), "-allowProvisioningUpdates", ...authentication,
  ], "upload.log");
  console.log("Upload succeeded. Verify build processing and encryption compliance in App Store Connect before distributing.");
}
console.log(`Release diagnostics: ${output}`);
