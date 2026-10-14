import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") throw new Error("Sync host tests require macOS and Xcode.");
const selected = spawnSync("xcode-select", ["-p"], { encoding: "utf8" });
if (selected.status !== 0) throw new Error("Select the installed Xcode developer directory.");
const developer = join(selected.stdout.trim(), "Platforms/MacOSX.platform/Developer");
const libraries = join(developer, "usr/lib"), frameworks = join(developer, "Library/Frameworks");
const privateFrameworks = join(developer, "Library/PrivateFrameworks");
if (!existsSync(join(libraries, "XCTest.swiftmodule"))) throw new Error("Xcode's macOS XCTest runtime is unavailable.");

const read = path => readFileSync(new URL(`../apps/ios/${path}`, import.meta.url), "utf8");
const withoutAppImport = source => {
  if (!source.includes("@testable import Fotoro")) throw new Error("Expected the Fotoro test module import.");
  return source.replace("@testable import Fotoro", "");
};
const background = read("FotoroTests/BackgroundUploadTests.swift");
const boundary = background.indexOf("// These exercise APIClient's real URLSession error boundary");
if (boundary < 0) throw new Error("Expected the boundary between host receipt tests and app API tests.");
const receiptTests = withoutAppImport(background.slice(0, boundary));
const retryTests = withoutAppImport(read("FotoroTests/AutomaticPhotoSyncRetryTests.swift"));
const expected = [...(receiptTests + retryTests).matchAll(/\bfunc test\w+\(/g)].length;
if (expected === 0) throw new Error("No Sync host tests were found.");

const root = mkdtempSync(join(tmpdir(), "fotoro-sync-host-"));
try {
  const source = join(root, "main.swift");
  writeFileSync(source, [
    read("Fotoro/Support/FotoroError.swift"),
    read("Fotoro/Exchange/BackgroundUploadState.swift"),
    read("Fotoro/Library/AutomaticPhotoSyncRetry.swift"),
    receiptTests, retryTests,
    `
let suite = XCTestSuite(name: "Fotoro Sync host regressions")
suite.addTest(BackgroundUploadTests.defaultTestSuite)
suite.addTest(AutomaticPhotoSyncRetryTests.defaultTestSuite)
suite.run()
guard let run = suite.testRun, run.executionCount == ${expected}, run.failureCount == 0 else { exit(1) }
`,
  ].join("\n"));
  const executable = join(root, "sync-host-tests");
  const compilation = spawnSync("xcrun", ["swiftc", "-swift-version", "5", "-I", libraries,
    "-F", frameworks, "-L", libraries,
    "-Xlinker", "-rpath", "-Xlinker", frameworks,
    "-Xlinker", "-rpath", "-Xlinker", privateFrameworks,
    "-Xlinker", "-rpath", "-Xlinker", libraries, source, "-o", executable],
  { stdio: "inherit", timeout: 60_000 });
  if (compilation.error) throw compilation.error;
  if (compilation.status !== 0) throw new Error("Sync host test compilation failed.");
  const result = spawnSync(executable, [], {stdio: "inherit", timeout: 60_000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
