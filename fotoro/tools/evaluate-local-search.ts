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
  // Public synthetic text/metadata only. Keep a fixed ten-day cohort while
  // measuring changes; reducing the former 10,000 rows is not a code speedup.
  const days = 10, recordsPerDay = 100;
  const daily = Array.from({length: days}, (_, day) => Array.from({length: recordsPerDay}, (_, item): SearchPhoto => {
    const id = `day-${String(day).padStart(2, "0")}-${String(item).padStart(3, "0")}`;
    return {id, filename: `IMG_${day * recordsPerDay + item}.jpg`,
      date: new Date(now - (day * 86400 + item * 60) * 1000).toISOString(), dateSource: "photos", captureVerified: true,
      labels: [item % 2 ? "Trip" : "Family"],
      facts: item === 0 ? ["Backstage rehearsal"] : item === 4 ? ["screenshot"] : [],
      location: item === 1 ? {latitude: 41.9142, longitude: 12.4921, source: "photos", name: "Villa Borghese"} : undefined,
      ocr: item === 2 || item === 4 ? {photoID: id, revision: id, processor: "public-fixture-v1", status: "complete",
        text: item === 2 ? "SEATTLE RECEIPT INVOICE 4826 TOTAL 28.50" : "BOARDING PASS FLIGHT BOSTON", confidence: .94} : undefined};
  }));
  const expanded = daily.flat();
  const cohortValid = expanded.every(photo => Date.parse(photo.date) >= now - days * 86400000 && Date.parse(photo.date) <= now);
  const tasks = [
    {id: "supplied-name", query: "Family", expectedID: "day-00-000", expectedMatches: 500, evidence: "label"},
    {id: "fact-component", query: "rehearsal", expectedID: "day-00-000", expectedMatches: 10, evidence: "fact"},
    {id: "recorded-place", query: "Borghese", expectedID: "day-00-001", expectedMatches: 10, evidence: "fact"},
    {id: "ocr-phrase", query: "Seattle recei", expectedID: "day-00-002", expectedMatches: 10, evidence: "ocr"},
    {id: "ocr-exact-number", query: "4826", expectedID: "day-00-002", expectedMatches: 10, evidence: "ocr"},
    {id: "ocr-separated-words", query: "Seattle 4826", expectedID: "day-00-002", expectedMatches: 10, evidence: "ocr"},
    {id: "ocr-reversed-words", query: "4826 Seattle", expectedID: "day-00-002", expectedMatches: 10, evidence: "ocr"},
    {id: "ocr-number-prefix-refused", query: "Seattle 482", expectedID: undefined, expectedMatches: 0, evidence: undefined},
    {id: "screenshot-text", query: "Boarding pass", expectedID: "day-00-004", expectedMatches: 10, evidence: "ocr"},
    {id: "original-filename", query: "IMG_103.jpg", expectedID: "day-01-003", expectedMatches: 1, evidence: "filename"},
    {id: "absent-evidence", query: "Dragonfruit", expectedID: undefined, expectedMatches: 0, evidence: undefined},
  ];
  const signal = () => new AbortController().signal;
  const buildAt = performance.now(), cold = await PhotoSearchIndex.build(expanded, signal(), () => true);
  const coldIndexMs = performance.now() - buildAt;
  const check = async (target: PhotoSearchIndex) => {
    const checks = [];
    for (const task of tasks) {
      const began = performance.now(), result = await target.searchAsync(task.query, {now});
      const elapsedMs = performance.now() - began, matches = result.meaning?.photoIds.length ?? 0;
      checks.push({id: task.id, elapsedMs, matches, passed: result.photoId === task.expectedID && matches === task.expectedMatches
        && (result.photoId ? result.meaning?.evidence[result.photoId] : undefined) === task.evidence});
    }
    return checks;
  };
  const firstQueries = await check(cold);
  const warmAt = performance.now(), warm = await PhotoSearchIndex.build(expanded, signal(), () => true, undefined,
    {index: cold, unchanged: new Set(expanded.map(photo => photo.id))});
  const unchangedReceiptIndexMs = performance.now() - warmAt;
  const warmChecks = await check(warm), samples: number[] = [];
  for (let round = 0; round < 25; round++) for (const task of tasks) {
    const at = performance.now(); await warm.searchAsync(task.query, {now}); samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  let previous: PhotoSearchIndex | undefined;
  const ingested: SearchPhoto[] = [], batches = [];
  for (const [day, rows] of daily.entries()) {
    const unchanged = new Set(ingested.map(photo => photo.id)); ingested.push(...rows);
    const at = performance.now(), next = await PhotoSearchIndex.build(ingested, signal(), () => true, undefined,
      previous ? {index: previous, unchanged} : undefined);
    const elapsedMs = performance.now() - at;
    const fact = await next.searchAsync("rehearsal", {now}), ocr = await next.searchAsync("Seattle recei", {now});
    const filename = await next.searchAsync(rows[3].filename, {now});
    batches.push({batch: day + 1, added: rows.length, indexed: ingested.length, elapsedMs,
      checksPassed: fact.photoId === "day-00-000" && fact.meaning?.photoIds.length === day + 1
        && ocr.photoId === "day-00-002" && ocr.meaning?.photoIds.length === day + 1 && filename.photoId === rows[3].id});
    previous?.dispose(); previous = next;
  }
  const batchChecks = await check(previous!);
  const correct = cohortValid && batches.every(batch => batch.checksPassed) && [...firstQueries, ...warmChecks, ...batchChecks].every(item => item.passed);
  console.log(JSON.stringify({workloadVersion: 1, cohortDays: days, recordsPerDay, syntheticRecords: expanded.length,
    captureFrom: new Date(now - days * 86400000).toISOString(), captureThrough: corpus.clock, cohortValid,
    coldIndexMs, firstQueries, unchangedReceiptIndexMs, warmChecks,
    warmQueries: {samples: samples.length, p50Ms: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.ceil(samples.length * .95) - 1]},
    dailyBatches: batches, batchChecks, passed: correct, node: process.version,
    qualification: "Fixed public synthetic ten-day cohort; cold means first build/query of this index in an already-running Node process. Warm index reuses verified unchanged token contributions. Repeated timings include cooperative index/query yields on this Mac, excluding OCR, model inference, storage, previews, rendering and hardware qualification. The smaller cohort is a scope reduction, not a measured code speedup or a 100x claim."}, null, 2));
  cold.dispose(); warm.dispose(); previous?.dispose();
  if (!correct) process.exitCode = 1;
}
if (process.argv.includes("--require-covered") && covered.some((result: any) => !result.passed)) process.exitCode = 1;
