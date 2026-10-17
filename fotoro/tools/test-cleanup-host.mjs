import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") throw new Error("Cleanup host tests require macOS and Xcode.");
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
const picks = read("Fotoro/Library/AutomaticPhotoPicks.swift");
const policyStart = picks.indexOf("enum AutomaticPhotoPickPolicy");
const cleanupStart = picks.indexOf("struct PhotoCleanupCandidate");
if (policyStart < 0 || cleanupStart < policyStart) throw new Error("Expected pure cleanup policy and measurement types.");
const cleanupSource = picks.slice(0, policyStart) + picks.slice(cleanupStart);
const presentation = read("Fotoro/Library/PhotoMetadataSections.swift");
const journalStart = presentation.indexOf("struct PhotoCleanupJournalRecord: Codable");
const journalEnd = presentation.indexOf("@MainActor private enum PhotoCleanupJournal", journalStart);
if (journalStart < 0 || journalEnd < journalStart) throw new Error("Expected pure cleanup checkpoint model.");
const journalSource = presentation.slice(journalStart, journalEnd);
const cleanupTests = withoutAppImport(read("FotoroTests/PhotoCleanupTests.swift"));
const expected = [...cleanupTests.matchAll(/\bfunc test\w+\(/g)].length;
if (expected === 0) throw new Error("No cleanup host tests were found.");

const root = mkdtempSync(join(tmpdir(), "fotoro-cleanup-host-"));
try {
  const source = join(root, "main.swift");
  writeFileSync(source, [
    read("Fotoro/WireModels.swift").split("struct PhotoAnnotationsV1")[0],
    cleanupSource,
    journalSource,
    cleanupTests,
    `
let suite = XCTestSuite(name: "Fotoro cleanup host regressions")
suite.addTest(PhotoCleanupTests.defaultTestSuite)
suite.run()
guard let run = suite.testRun, run.executionCount == ${expected}, run.failureCount == 0 else { exit(1) }
`,
  ].join("\n"));
  const executable = join(root, "cleanup-host-tests");
  const compilation = spawnSync("xcrun", ["swiftc", "-swift-version", "5", "-I", libraries,
    "-F", frameworks, "-L", libraries,
    "-Xlinker", "-rpath", "-Xlinker", frameworks,
    "-Xlinker", "-rpath", "-Xlinker", privateFrameworks,
    "-Xlinker", "-rpath", "-Xlinker", libraries, source, "-o", executable],
  { stdio: "inherit", timeout: 60_000 });
  if (compilation.error) throw compilation.error;
  if (compilation.status !== 0) throw new Error("Cleanup host test compilation failed.");
  const result = spawnSync(executable, [], {stdio: "inherit", timeout: 60_000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
