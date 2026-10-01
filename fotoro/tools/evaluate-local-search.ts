import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PhotoSearchIndex, type SearchPhoto } from "../apps/web/src/local/search.js";

const corpus = JSON.parse(readFileSync(new URL("../fixtures/search/cases.json", import.meta.url), "utf8"));
const now = Date.parse(corpus.clock);
const photos: SearchPhoto[] = corpus.records.map((record: any) => ({
  id: record.id,
  filename: record.filename,
  date: record.capturedAt,
  dateSource: record.captureVerified ? "exif" : "selected",
  favorite: record.favorite,
  labels: record.labels,
  keywords: record.keywords,
  facts: record.facts,
  ocr: record.ocr ? {
    ...record.ocr, photoID: record.id, revision: record.id,
  } : undefined,
}));
const index = new PhotoSearchIndex(photos);
const results = corpus.retrievalTasks.map((task: any) => {
  const response = index.search(task.query, { now });
  return {
    id: task.id, query: task.query, classification: task.classification,
    photoID: response.photoId ?? null,
    expectedIDs: task.acceptablePhotoIDs,
    passed: task.acceptablePhotoIDs.length
      ? task.acceptablePhotoIDs.includes(response.photoId)
      : response.photoId === undefined,
  };
});
const covered = results.filter((result: any) => result.classification === "covered");
console.log(JSON.stringify({
  fixtureVersion: corpus.version,
  covered: { correct: covered.filter((result: any) => result.passed).length, total: covered.length },
  negativeChecks: results.filter((result: any) => result.classification !== "covered"),
  failures: covered.filter((result: any) => !result.passed),
  qualification: "Development fixtures; no held-out accuracy, physical-device latency, inference or visual recognition claim.",
}, null, 2));

if (process.argv.includes("--benchmark")) {
  const expanded = Array.from({ length: 10_000 }, (_, i) => ({
    id: "synthetic-" + i, filename: "IMG_" + i + ".jpg",
    date: corpus.clock, dateSource: "exif" as const,
    labels: [i % 2 ? "Ronald" : "Rome"],
  }));
  const buildAt = performance.now(), synthetic = new PhotoSearchIndex(expanded);
  const buildMs = performance.now() - buildAt;
  for (let i = 0; i < 20; i++) synthetic.search("Ro", { now });
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const at = performance.now();
    synthetic.search(["R", "Ro", "Ron", "Ronald"][i % 4], { now });
    times.push(performance.now() - at);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ syntheticRecords: expanded.length, buildMs,
    lookupP50Ms: times[100], lookupP95Ms: times[189], node: process.version,
    qualification: "Warm pure index on this Mac; excludes previews, rendering, OCR and storage. Not the 100ms physical-iPhone release gate." }, null, 2));
}
if (process.argv.includes("--require-covered") && covered.some((result: any) => !result.passed)) process.exitCode = 1;
