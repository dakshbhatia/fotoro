import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "darwin") throw new Error("Saved text host tests require macOS and Xcode.");
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
const tests = withoutAppImport(read("FotoroTests/SavedTextAnalysisTests.swift"));
const declaration = (source, start, end) => {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0) throw new Error(`Missing production declaration markers: ${start} / ${end}`);
  return source.slice(begin, finish);
};
const wire = read("Fotoro/WireModels.swift"), annotations = read("Fotoro/Library/AnnotationSync.swift");
const models = [
  declaration(wire, "struct WrappedKeyV1:", "struct PhotoManifestV1:"),
  declaration(wire, "struct SignedPayloadV1:", "struct UploadReservationV1:"),
  declaration(wire, "struct PhotoAnnotationsV1:", "extension PhotoAnnotationsV1 {"),
  declaration(annotations, "struct AnnotationState:", "// Account scoped state keeps"),
].join("\n");
const expected = [...tests.matchAll(/\bfunc test\w+\(/g)].length;
if (expected === 0) throw new Error("No Saved text host tests were found.");

const root = mkdtempSync(join(tmpdir(), "fotoro-saved-text-host-"));
try {
  const source = join(root, "main.swift");
  writeFileSync(source, [
    read("Fotoro/Search/SavedTextAnalysis.swift"), models,
    read("Fotoro/Library/SavedTextAnnotationDraft.swift"), tests,
    `
let suite = XCTestSuite(name: "Fotoro Saved text host regressions")
suite.addTest(SavedTextAnalysisTests.defaultTestSuite)
suite.run()
guard let run = suite.testRun, run.executionCount == ${expected}, run.failureCount == 0 else { exit(1) }
`,
  ].join("\n"));
  const executable = join(root, "saved-text-host-tests");
  const compilation = spawnSync("xcrun", ["swiftc", "-swift-version", "5", "-I", libraries,
    "-F", frameworks, "-L", libraries,
    "-Xlinker", "-rpath", "-Xlinker", frameworks,
    "-Xlinker", "-rpath", "-Xlinker", privateFrameworks,
    "-Xlinker", "-rpath", "-Xlinker", libraries, source, "-o", executable],
  { stdio: "inherit", timeout: 60_000 });
  if (compilation.error) throw compilation.error;
  if (compilation.status !== 0) throw new Error("Saved text host test compilation failed.");
  const result = spawnSync(executable, [], {stdio: "inherit", timeout: 60_000});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
