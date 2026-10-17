import {readFile, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import {createWorker} from "tesseract.js";
import {createRequire} from "node:module";
const eng = createRequire(import.meta.url)("@tesseract.js-data/eng") as {langPath: string};
import {AutoTokenizer, AutoProcessor, CLIPModel, RawImage, Tensor, env} from "@huggingface/transformers";
import {LocalOcrQueue} from "../src/local/ocr";
import {PhotoSearchIndex, type SearchPhoto} from "../src/local/search";
import {inBrowseRange} from "../src/local/consumer-range";
import {addSemanticMatches, cosine, normalizeVector, eligibleSemanticPhotos, permitsSemanticMatches} from "../src/local/semantic-find";
import {SEMANTIC_MODEL, SEMANTIC_REVISION, SEMANTIC_THRESHOLD, zeroSemanticPadding} from "../src/local/semantic-config";

import {publicSearchBaselineFailures} from "./public-search-baseline";

function metrics(results: {expected: string[]; actual: string[]; passed: boolean}[]) {
  let relevant = 0, returned = 0, correct = 0, top1 = 0, positiveQueries = 0;
  for (const result of results) {
    relevant += result.expected.length; returned += result.actual.length;
    correct += result.actual.filter(id => result.expected.includes(id)).length;
    if (result.expected.length) {positiveQueries++; if (result.expected.includes(result.actual[0])) top1++;}
  }
  return {exactSetPassed: results.filter(result => result.passed).length, queries: results.length,
    truePositives: correct, falsePositives: returned - correct, falseNegatives: relevant - correct,
    microPrecision: returned ? correct / returned : null, microRecall: relevant ? correct / relevant : null,
    positiveQueryTop1: {correct: top1, total: positiveQueries}};
}

const root = new URL("../../../", import.meta.url);
const cases = JSON.parse(await readFile(new URL("fixtures/search/public-relevance-v1.json", root), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "fotoro-public-search-"));
const files = {receipt: "fixtures/search/neutral-a.png", boarding: "fixtures/search/neutral-b.png", inverted: "fixtures/search/neutral-c.png", singapore: "fixtures/media/singapore.jpg"};
const pixels = new Map<string, RawImage>(), previews = new Map<string, {blob: Blob; width: number; height: number}>();
const ocrTimes: unknown[] = [];
const queue = new LocalOcrQueue({origin: "https://public-fixture.invalid", createWorker: async () => {
  const worker = await createWorker("eng", 1, {langPath: eng.langPath, gzip: true, cacheMethod: "none"});
  return {recognize: async (blob, options) => worker.recognize(Buffer.from(await blob.arrayBuffer()), options), terminate: () => worker.terminate()};
}});
try {
  for (const [id, path] of Object.entries(files)) {
    const image = await RawImage.read(fileURLToPath(new URL(path, root)));
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const resized = scale < 1 ? await image.resize(Math.round(image.width * scale), Math.round(image.height * scale)) : image;
    const bytes = await resized.toSharp().jpeg({quality: 85}).toBuffer();
    previews.set(id, {blob: new Blob([bytes], {type: "image/jpeg"}), width: resized.width, height: resized.height});
    const thumbnailScale = Math.min(1, 512 / Math.max(image.width, image.height));
    const thumbnail = await image.resize(Math.round(image.width * thumbnailScale), Math.round(image.height * thumbnailScale));
    const output = join(temporary, id + ".jpg"); await thumbnail.toSharp().jpeg({quality: 85}).toFile(output);
    pixels.set(id, await RawImage.read(output));
  }
  const photos: SearchPhoto[] = [];
  for (const [id] of Object.entries(files)) {
    const at = performance.now(), ocr = await queue.recognize(id, id, async () => previews.get(id)!, () => true);
    ocrTimes.push({id, elapsedMs: performance.now() - at, state: ocr?.status, confidence: ocr?.confidence,
      recognizedText: ocr?.text, boundary: id === "receipt" ? "first worker/model initialization plus recognition" : "same live worker recognition"});
    photos.push({id, digest: id, filename: id === "receipt" ? "PUBLIC_104.jpg" : id === "boarding" ? "PUBLIC_105.png" : id + ".jpg",
      date: "2026-10-16T12:00:00Z", dateSource: "photos", captureVerified: true, ocr,
      labels: id === "singapore" ? ["Holiday"] : undefined, favorite: id === "singapore",
      location: id === "singapore" ? {name: "Marina Bay Singapore", latitude: 1.28, longitude: 103.86, source: "photos"} : undefined,
      facts: id === "boarding" ? ["fotoro.screenshot.v1:true", "fotoro.name.v1:Screen review.jpg"] : []});
  }
  photos.push({id: "trashed", digest: "trashed", filename: "archived receipt.jpg", date: "2026-10-15", dateSource: "photos", facts: ["fotoro.trash.v1:true"]});
  const buildAt = performance.now(), index = await PhotoSearchIndex.build(photos, new AbortController().signal, () => true);
  const coldIndexMs = performance.now() - buildAt;
  const results = [];
  for (const task of cases.lexical) {
    const allowedIds = new Set(photos.filter(photo => inBrowseRange(photo, false, task.scope === "favorites", Date.parse(cases.clock), task.scope === "trash" ? "trash" : task.scope === "screenshots" ? "screenshots" : task.scope === "photosOnly" ? "photosOnly" : "photos")).map(photo => photo.id));
    const at = performance.now(), result = await index.searchAsync(task.query, {now: Date.parse(cases.clock), allowedIds});
    const firstQueryMs = performance.now() - at;
    const ids = result.photoIds, expected = task.expected as string[];
    const ranks = expected.map(id => ids.indexOf(id) + 1);
    const warm: number[] = [];
    for (let i = 0; i < 10; i++) {const start = performance.now(); await index.searchAsync(task.query, {now: Date.parse(cases.clock), allowedIds}); warm.push(performance.now() - start);}
    warm.sort((a,b) => a-b);
    results.push({...task, actual: ids, ranks, passed: expected.every(id => ids.includes(id)) && ids.every(id => expected.includes(id)), firstQueryMs, warmP50Ms: warm[5], warmP95Ms: warm[9]});
  }
  env.allowLocalModels = false;
  if (process.env.FOTORO_PUBLIC_MODEL_CACHE) env.cacheDir = process.env.FOTORO_PUBLIC_MODEL_CACHE;
  env.remotePathTemplate = `{model}/resolve/${SEMANTIC_REVISION}/`;
  const options = {revision: SEMANTIC_REVISION, dtype: "q8" as const, device: "cpu" as const};
  const loadAt = performance.now();
  const [tokenizer, processor, model] = await Promise.all([AutoTokenizer.from_pretrained(SEMANTIC_MODEL, options), AutoProcessor.from_pretrained(SEMANTIC_MODEL, options), CLIPModel.from_pretrained(SEMANTIC_MODEL, options)]);
  const modelInitializationMs = performance.now() - loadAt;
  try {
    const neutralText = tokenizer("", {padding: "max_length", max_length: 77, truncation: true}); zeroSemanticPadding(neutralText);
    const neutralImage = {pixel_values: new Tensor("float32", new Float32Array(3 * 224 * 224), [1,3,224,224])};
    const vectors = new Map<string, Float32Array>(), inferenceTimes = [];
    const textVectors: Float32Array[] = [];
    for (const [id, image] of pixels) {
      const at = performance.now();
      const output = await model({...neutralText, ...await processor(image)});
      vectors.set(id, normalizeVector(output.image_embeds.data));
      inferenceTimes.push({id, elapsedMs: performance.now() - at, boundary: "single image embedding with neutral text as production worker; Node CPU with live model"});
    }
    const textInferenceTimes = [];
    for (const task of cases.semantic) {
      const tokens = tokenizer(task.query, {padding: "max_length", max_length: 77, truncation: true}); zeroSemanticPadding(tokens);
      const at = performance.now(), output = await model({...tokens, ...neutralImage});
      textVectors.push(normalizeVector(output.text_embeds.data));
      const firstInferenceMs = performance.now() - at;
      const warmAt = performance.now(); await model({...tokens, ...neutralImage});
      textInferenceTimes.push({query: task.query, firstInferenceMs, warmInferenceMs: performance.now() - warmAt});
    }
    const semantic = cases.semantic.map((task: {query: string; expected: string[]}, position: number) => {
      const at = performance.now();
      const scores = new Map([...vectors].map(([id, vector]) => [id, cosine(vector, textVectors[position])]));
      const base = {query: task.query, scope: "public", meanings: [], photoIds: []};
      const result = addSemanticMatches(base, scores, new Set(vectors.keys()));
      const ranking = [...scores].sort((a,b) => b[1]-a[1]);
      return {...task, ranking, threshold: SEMANTIC_THRESHOLD, actual: result.photoIds,
        ranks: task.expected.map(id => ranking.findIndex(([candidate]) => candidate === id) + 1),
        passed: task.expected.every(id => result.photoIds.includes(id)) && result.photoIds.every(id => task.expected.includes(id)),
        warmVectorRankingMs: performance.now() - at};
    });
    const combined = [];
    const visible = photos.filter(photo => inBrowseRange(photo, false, false, Date.parse(cases.clock)));
    const permitted = new Set(visible.map(photo => photo.id));
    const semanticPhotos = visible.map(photo => ({...photo, preview: previews.get(photo.id)?.blob}));
    for (const [position, task] of cases.semantic.entries()) {
      const at = performance.now();
      const base = await index.searchAsync(task.query, {now: Date.parse(cases.clock), allowedIds: permitted});
      const eligible = new Set(eligibleSemanticPhotos(semanticPhotos, task.query).map(photo => photo.id));
      const scores = new Map([...vectors].map(([id, vector]) => [id, cosine(vector, textVectors[position])]));
      const actual = permitsSemanticMatches(base) && eligible.size ? addSemanticMatches(base, scores, eligible) : base;
      combined.push({...task, lexical: base.photoIds, actual: actual.photoIds,
        evidence: Object.fromEntries(actual.photoIds.map(id => [id, actual.matches?.[id]?.evidence ?? actual.meaning?.evidence[id]])),
        ranks: task.expected.map((id: string) => actual.photoIds.indexOf(id) + 1),
        passed: task.expected.every((id: string) => actual.photoIds.includes(id)) && actual.photoIds.every(id => task.expected.includes(id)),
        warmCompositionMs: performance.now() - at});
    }
    const report = {version: 1, qualification: cases.judgment,
      workload: "4 public pixel fixtures + 1 synthetic Trash metadata record; supplied tags/date/place/favorite/screenshot/name are explicit metadata, never inferred from pixels",
      boundaries: "OCR uses actual production LocalOcrQueue orientation/confidence policy with Node Tesseract transport; 1600px JPEG quality85 previews and 512px JPEG quality85 thumbnails use Node RawImage/Sharp rather than browser canvas. Lexical/filter and semantic threshold/composition use production helpers. Semantic model is pinned real q8 ONNX with Node CPU, not browser WASM. Cold initialization may read an existing public model disk cache; no download-cold claim. Warm query timings exclude OCR/inference/storage/UI. First lexical query is cold only to this new index in this process.",
      coldIndexMs, ocrTimes, lexical: {...metrics(results), results},
      modelInitializationMs, inferenceTimes, textInferenceTimes, semantic: {...metrics(semantic), results: semantic}, combined: {...metrics(combined), results: combined}};
    const baselineFailures = publicSearchBaselineFailures(report.lexical, report.combined, cases.baseline);
    const json = JSON.stringify({...report, baseline: {passed: baselineFailures.length === 0, failures: baselineFailures,
      expectations: cases.baseline, qualification: "Regression floor accepting declared failures; passing does not establish broad relevance or awesome search."}}, null, 2);
    const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
    if (output) await writeFile(output, json + "\n");
    console.log(json);
    if (process.argv.includes("--require-baseline") && baselineFailures.length) process.exitCode = 1;
    if (process.argv.includes("--require-exact") && [...results, ...semantic, ...combined].some(item => !item.passed)) process.exitCode = 1;
  } finally {await model.dispose();}
  index.dispose();
} finally {await queue.cancel(); await rm(temporary, {recursive: true, force: true});}
