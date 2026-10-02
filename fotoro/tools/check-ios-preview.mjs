import { spawnSync } from "node:child_process";
import {
  closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This checks built artifacts, including statically linked code. Package names
// or otool's dynamic-library inventory alone cannot establish this boundary.
const forbiddenCode = /(?:sodium|Clibsodium|libsodium|CryptoAdapter|VaultStore|NativeAuth|DeviceTrust|AppServices|APIClient|TransferJournal|BackgroundUploadTransport|PhotoAnnotationsV1|AnnotationSync|(?:^|[^A-Za-z0-9])_?(?:crypto|sodium)_)/im;
const positiveControls = ["RecentPhotosView", "SearchIndex", "GRDB"];
const forbiddenResource = /(?:fixture|accounts?|crypto-v1|native-interop|singapore|neutral-[ac]|search-cases|device-request|account-card)/i;
const machoMagic = new Set([
  "feedface", "cefaedfe", "feedfacf", "cffaedfe",
  "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
]);
const toolchainEnv = {
  ...process.env,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`,
};

function fail(code) {
  const error = new Error(`Preview artifact audit failed: ${code}.`);
  error.name = "PreviewArtifactAuditError";
  error.code = code;
  throw error;
}

function runTool(tool, args, { input, allowNoSymbols = false } = {}) {
  const result = spawnSync(`/usr/bin/${tool}`, args, {
    env: toolchainEnv,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // A stripped Release binary can have no symbol table. This one explicit nm
  // outcome is acceptable; strings, UUID provenance and positive controls still
  // apply. Every other failed scan is an audit failure.
  const noSymbols = allowNoSymbols && result.status === 1 && !result.stdout
    && /: no symbols\s*$/.test(result.stderr ?? "");
  if (result.error || result.signal || (result.status !== 0 && !noSymbols)) {
    fail(`TOOL_${tool.toUpperCase()}_FAILED`);
  }
  return result.stdout ?? "";
}

function plist(path) {
  const parsed = JSON.parse(runTool("plutil", ["-convert", "json", "-o", "-", path]));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("INVALID_PLIST");
  return parsed;
}

function regularFiles(root) {
  if (!lstatSync(root).isDirectory()) fail("INVALID_ARTIFACT_DIRECTORY");
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      // Reject rather than follow archive or ZIP symlinks. This prevents both
      // an escaped audit and a library hidden behind an unaudited alias.
      if (stat.isSymbolicLink()) fail("SYMLINK_IN_ARTIFACT");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else fail("UNSUPPORTED_ARTIFACT_ENTRY");
    }
  }
  visit(root);
  return files.sort();
}

function isMachO(path) {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(4);
    return readSync(fd, prefix, 0, 4, 0) === 4 && machoMagic.has(prefix.toString("hex"));
  } finally { closeSync(fd); }
}

function singleApp(directory) {
  const apps = readdirSync(directory).filter(name => name.endsWith(".app"));
  if (apps.length !== 1) fail("EXPECTED_ONE_APP");
  const app = join(directory, apps[0]);
  const stat = lstatSync(app);
  if (stat.isSymbolicLink()) fail("SYMLINK_IN_ARTIFACT");
  if (!stat.isDirectory()) fail("INVALID_APP_DIRECTORY");
  return app;
}

function uuids(path) {
  const output = runTool("dwarfdump", ["--uuid", path]);
  const entries = [...output.matchAll(/^UUID:\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s+\(([^)\s]+)\)/gim)]
    .map(match => `${match[2]}:${match[1].toUpperCase()}`);
  if (!entries.length || new Set(entries).size !== entries.length) fail("INVALID_MACHO_UUIDS");
  return entries.sort();
}

function uuidKey(entries) { return entries.join("|"); }

function binaryEvidence(path) {
  const symbols = runTool("nm", ["-a", path], { allowNoSymbols: true });
  const strings = runTool("strings", ["-a", path]);
  if (!strings.trim()) fail("EMPTY_BINARY_STRINGS");
  const evidence = `${symbols}\n${strings}`;
  if (forbiddenCode.test(evidence)) fail("FORBIDDEN_BINARY_EVIDENCE");
  return evidence;
}

function requirePositiveControls(evidence, code) {
  if (positiveControls.some(control => !evidence.includes(control))) fail(code);
}

function readDsyms(archive) {
  const dwarfFiles = regularFiles(join(archive, "dSYMs"))
    .filter(path => relative(join(archive, "dSYMs"), path).includes("/Contents/Resources/DWARF/"))
    .filter(isMachO);
  if (!dwarfFiles.length) fail("MISSING_DSYM");
  const byUuid = new Map();
  for (const path of dwarfFiles) {
    const identity = uuidKey(uuids(path));
    if (byUuid.has(identity)) fail("AMBIGUOUS_DSYM_UUID");
    byUuid.set(identity, { path, evidence: binaryEvidence(path) });
  }
  return byUuid;
}

function auditEntitlements(path) {
  // Operational identity and entitlement values stay in captured process
  // memory. Neither successful metadata nor errors contain this raw output.
  const xml = runTool("codesign", ["-d", "--entitlements", ":-", path]);
  if (!xml.trim()) return;
  const entitlements = JSON.parse(runTool("plutil", ["-convert", "json", "-o", "-", "-"], { input: xml }));
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) fail("INVALID_ENTITLEMENTS");
  if (Object.keys(entitlements).some(key =>
    /associated-domains|background|networkextension|pushkit/i.test(key)
      || key === "aps-environment" || key === "com.apple.security.network.client")) {
    fail("FORBIDDEN_ENTITLEMENT");
  }
}

function validateInfo(info) {
  if (info.CFBundleIdentifier !== "cloud.fotoro.Fotoro") fail("INVALID_BUNDLE_ID");
  if (info.FotoroBuildMode !== "local-preview") fail("INVALID_BUILD_MODE");
  if (info.ITSAppUsesNonExemptEncryption !== false) fail("INVALID_ENCRYPTION_DECLARATION");
  for (const key of ["UIBackgroundModes", "BGTaskSchedulerPermittedIdentifiers"]) {
    if (key in info && !(Array.isArray(info[key]) && info[key].length === 0)) {
      fail("FORBIDDEN_BACKGROUND_CONFIGURATION");
    }
  }
  if ("NSExtension" in info) fail("FORBIDDEN_BACKGROUND_CONFIGURATION");
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || !executable || executable === "." || executable === ".."
      || /[\\/\0]/.test(executable)) fail("INVALID_EXECUTABLE_NAME");
}

function auditResources(app, files, binaries) {
  for (const path of files) {
    const name = relative(app, path);
    if (forbiddenCode.test(name) || forbiddenResource.test(name)) fail("FORBIDDEN_RESOURCE");
    if (binaries.has(path)) continue;
    // This target intentionally has only its icon catalog and privacy metadata.
    // Unknown resources fail closed rather than allowing an innocuously renamed
    // account/fixture payload. GRDB's SwiftPM privacy bundle is the one SDK resource.
    const allowed = /^(?:Info\.plist|PkgInfo|embedded\.mobileprovision|PrivacyInfo\.xcprivacy|Assets\.car|AppIcon[^/]*\.png|_CodeSignature\/CodeResources)$/.test(name)
      || /^GRDB_GRDB\.bundle\/(?:Info\.plist|PrivacyInfo\.xcprivacy)$/.test(name);
    if (!allowed) fail("UNEXPECTED_RESOURCE");
    if (name === "Assets.car") {
      const assetNames = runTool("strings", ["-a", path]);
      if (forbiddenResource.test(assetNames) || forbiddenCode.test(assetNames)) fail("FORBIDDEN_RESOURCE");
    }
  }
}

function auditApp(app, dsyms) {
  const info = plist(join(app, "Info.plist"));
  validateInfo(info);
  const files = regularFiles(app);
  const binaries = files.filter(isMachO);
  if (!binaries.length || !binaries.includes(join(app, info.CFBundleExecutable))) fail("MISSING_APP_EXECUTABLE");
  auditResources(app, files, new Set(binaries));
  runTool("codesign", ["--verify", "--strict", "--deep", app]);
  auditEntitlements(app);
  const identities = new Map();
  const evidence = [];
  for (const path of binaries) {
    const identity = uuidKey(uuids(path));
    if (!dsyms.has(identity)) fail("MISSING_MATCHING_DSYM");
    // Check all Mach-O files, including libraries with no filename extension.
    auditEntitlements(path);
    evidence.push(binaryEvidence(path));
    identities.set(relative(app, path), identity);
  }
  // The explicit preview graph links GRDB statically into its one executable.
  // A second binary must not inherit the main executable's positive controls or
  // bypass the resource allowlist merely by supplying its own matching dSYM.
  // Any future embedded runtime/library needs an explicit reviewed exception.
  if (binaries.length !== 1) fail("UNEXPECTED_MACHO");
  requirePositiveControls(evidence.join("\n"), "MISSING_BINARY_POSITIVE_CONTROL");
  return { info, identities, count: binaries.length };
}

function auditLinkMap(path, app) {
  const map = readFileSync(path, "utf8");
  const objectSection = map.match(/^# Object files:\s*\n([\s\S]*?)(?=^# Sections:)/m)?.[1];
  const liveSection = map.match(/^# Symbols:\s*\n([\s\S]*?)(?=^# Dead Stripped Symbols:|(?![\s\S]))/m)?.[1];
  const deadSection = map.match(/^# Dead Stripped Symbols:\s*\n([\s\S]*)/m)?.[1] ?? "";
  const arch = map.match(/^# Arch:\s*(\S+)\s*$/m)?.[1];
  const output = map.match(/^# Path:\s*(.+)\s*$/m)?.[1];
  if (!objectSection?.trim() || !liveSection?.trim() || !arch || !output
      || basename(output.trim()) !== app.info.CFBundleExecutable
      || ![...app.identities.values()].some(identity => identity.split("|").some(entry => entry.startsWith(`${arch}:`)))) {
    fail("INVALID_LINK_MAP");
  }
  const evidence = `${objectSection}\n${liveSection}\n${deadSection}`;
  if (forbiddenCode.test(evidence)) fail("FORBIDDEN_LINK_MAP_EVIDENCE");
  // Positive controls must be live symbol records, not comments, paths, or
  // dead-stripped names. Negative checks intentionally cover all linked objects.
  const liveSymbols = liveSection.split("\n")
    .filter(line => /^0x[0-9a-f]+\s+0x[0-9a-f]+\s+\[\s*\d+\]\s+\S+/i.test(line)).join("\n");
  requirePositiveControls(liveSymbols, "MISSING_LINK_MAP_POSITIVE_CONTROL");
}

function extractIpa(ipa, directory) {
  if (!lstatSync(ipa).isFile()) fail("INVALID_IPA_FILE");
  const listing = runTool("unzip", ["-Z1", ipa]);
  const entries = listing.trimEnd().split("\n");
  if (!listing.trim() || entries.some(entry =>
    !entry || /[\\\x00-\x1f\x7f]/.test(entry) || entry.startsWith("/")
      || /^[A-Za-z]:/.test(entry) || entry.split("/").some(part => part === "." || part === ".."))) {
    fail("UNSAFE_IPA_ENTRY");
  }
  if (new Set(entries).size !== entries.length) fail("DUPLICATE_IPA_ENTRY");
  const attributes = runTool("zipinfo", ["-l", ipa]);
  const unixEntries = attributes.split("\n").filter(line => /^[bcdlps-][rwxstST-]{9}\s/.test(line));
  // Refuse ZIP symlinks before extraction, preventing zip-slip via a link whose
  // later entries would otherwise write outside the private directory.
  if (unixEntries.some(line => line.startsWith("l"))) fail("SYMLINK_IN_IPA");
  if (unixEntries.length !== entries.length || unixEntries.some(line => !/^[d-]/.test(line))) fail("UNSUPPORTED_IPA_ATTRIBUTES");
  runTool("unzip", ["-q", ipa, "-d", directory]);
  // Inventory the entire extraction before locating the app, so an unexpected
  // link or special file elsewhere in Payload cannot bypass this traversal.
  regularFiles(directory);
  return singleApp(join(directory, "Payload"));
}

/*
 * Synchronously audit the signed local preview archive and, when supplied, its
 * exported IPA. Archive-only validation is permitted, but callers must require
 * ipaAudited === true before uploading. No build, signing or upload is performed.
 */
export function checkIosPreview({ archivePath, ipaPath, linkMapPath } = {}) {
  let extracted;
  try {
    if (typeof archivePath !== "string" || !archivePath || typeof linkMapPath !== "string" || !linkMapPath) {
      fail("MISSING_REQUIRED_PATHS");
    }
    if (ipaPath !== undefined && (typeof ipaPath !== "string" || !ipaPath)) fail("INVALID_IPA_PATH");
    const archive = realpathSync(resolve(archivePath));
    const app = singleApp(join(archive, "Products", "Applications"));
    const dsyms = readDsyms(archive);
    const archiveResult = auditApp(app, dsyms);
    auditLinkMap(realpathSync(resolve(linkMapPath)), archiveResult);
    let ipaResult;
    if (ipaPath !== undefined) {
      extracted = mkdtempSync(join(tmpdir(), "fotoro-preview-audit-"));
      const exportedApp = extractIpa(realpathSync(resolve(ipaPath)), extracted);
      ipaResult = auditApp(exportedApp, dsyms);
      if (JSON.stringify([...archiveResult.identities].sort()) !== JSON.stringify([...ipaResult.identities].sort())) {
        fail("IPA_ARCHIVE_BINARY_MISMATCH");
      }
      for (const key of ["CFBundleVersion", "CFBundleShortVersionString", "CFBundleExecutable"]) {
        if (archiveResult.info[key] !== ipaResult.info[key]) fail("IPA_ARCHIVE_METADATA_MISMATCH");
      }
    }
    return Object.freeze({
      mode: "local-preview",
      archiveMachOCount: archiveResult.count,
      dsymCount: dsyms.size,
      ipaMachOCount: ipaResult?.count ?? 0,
      ipaAudited: Boolean(ipaResult),
      checkedLinkMap: true,
    });
  } catch (error) {
    if (error?.name === "PreviewArtifactAuditError") throw error;
    // Native tool stderr and filesystem errors may contain private identifiers,
    // credentials or operational paths. Never propagate those diagnostics.
    fail("ARTIFACT_IO_FAILED");
  } finally {
    if (extracted) {
      try { rmSync(extracted, { recursive: true, force: true }); }
      catch { fail("TEMP_CLEANUP_FAILED"); }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    const flags = new Map([["--archive", "archivePath"], ["--ipa", "ipaPath"], ["--link-map", "linkMapPath"]]);
    for (let index = 0; index < args.length; index += 2) {
      const key = flags.get(args[index]);
      if (!key || key in options || !args[index + 1] || args[index + 1].startsWith("--")) fail("INVALID_CLI_ARGUMENTS");
      options[key] = args[index + 1];
    }
    console.log(JSON.stringify(checkIosPreview(options)));
  } catch (error) {
    const code = error?.name === "PreviewArtifactAuditError" ? error.code : "ARTIFACT_IO_FAILED";
    console.error(`Preview artifact audit failed: ${code}.`);
    console.error("Usage: node tools/check-ios-preview.mjs --archive PATH --link-map PATH [--ipa PATH]");
    process.exitCode = 1;
  }
}
