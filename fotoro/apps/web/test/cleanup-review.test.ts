import test from "node:test";
import assert from "node:assert/strict";
import {CLEANUP_BATCH_SIZE, cleanupSourceCurrent, cleanupReviewPhotos, screenshotReviewGroups} from "../src/local/cleanup-review";
import {CleanupAnalyzer, type PhotoSignals} from "../src/local/auto-picks";
import type {LocalPhoto} from "../src/local/resources";
import {withPhotoOrganization} from "@fotoro/contracts/organization";

const photo = (id: string): LocalPhoto => ({id, filename: `${id}.png`, date: "2026-10-01", dateSource: "selected", file: new File([id], `${id}.png`)});
const measured: PhotoSignals = {hash: 0n, sharpness: .2, luminance: .5, contrast: .15, color: [120, 120, 120]};
const screen = (id: string) => withPhotoOrganization(photo(id), {screenshot: true});
const text = (value: LocalPhoto, line: string) => ({...value, ocr: {photoID: value.id, revision: value.digest ?? value.id, processor: "vision-text-v1", status: "complete" as const, text: line, confidence: .95}});

test("cleanup continuation preserves completed pixels and duplicate comparisons across bounded batches", async () => {
  const photos = Array.from({length: 405}, (_, index) => photo(String(index)));
  photos[0].digest = "same"; photos[400].digest = "same";
  const analyzer = new CleanupAnalyzer();
  const reads: string[] = [];
  for (let offset = 0; offset < photos.length; offset += CLEANUP_BATCH_SIZE) {
    const batch = photos.slice(offset, offset + CLEANUP_BATCH_SIZE);
    await analyzer.run(batch, async value => {reads.push(value.id); if (value.id === "1") throw new Error("Unavailable"); return measured;}, () => {});
    const result = analyzer.review(photos.slice(0, offset + batch.length));
    assert.equal(result.unassessed, 1);
    if (offset === 400) assert.match(result.reasons.get("400")!.join(" "), /Identical original/);
  }
  assert.equal(reads.length, 405, "A later batch must not retry unavailable previews from an earlier batch");
  assert.equal(new Set(reads).size, 405);
  analyzer.clear();
  assert.equal(analyzer.review(photos).unassessed, 405);
});

test("cleanup cancellation rejects late pixels without losing earlier completed batches", async () => {
  const analyzer = new CleanupAnalyzer(), a = photo("a"), b = photo("b");
  await analyzer.run([a], async () => measured, () => {});
  let release!: (value: PhotoSignals) => void;
  const pending = analyzer.run([b], () => new Promise(resolve => {release = resolve;}), () => {});
  analyzer.cancel(); release(measured);
  assert.equal(await pending, undefined);
  assert.equal(analyzer.review([a, b]).unassessed, 1);
});

test("screenshot grouping uses literal current OCR or supplied tags and never names or geometry", () => {
  const a = text(screen("a"), "Order confirmed"), b = text(screen("b"), "ORDER confirmed");
  const tagged = {...text(screen("tagged"), "Order confirmed"), labels: ["Travel"]};
  const stale = text(screen("stale"), "Order confirmed"); stale.ocr.revision = "old";
  const weak = text(screen("weak"), "Order confirmed"); weak.ocr.confidence = .5;
  const fake = {...photo("Screenshot-123"), width: 1170, height: 2532};
  const groups = screenshotReviewGroups([a, b, tagged, stale, weak, fake, withPhotoOrganization(screen("trash"), {trash: true}), {...screen("withdrawn"), current: () => false}]);
  assert.deepEqual(groups.map(group => [group.title, group.photos.map(value => value.id)]), [
    ["Text: Order confirmed", ["a", "b"]], ["Tag: Travel", ["tagged"]], ["Without a readable text group", ["stale", "weak"]],
  ]);
  assert.equal(cleanupReviewPhotos([a, a, fake]).length, 2);
});


test("cleanup admission rejects withdrawn, revised or replaced snapshot sources", () => {
  const initial = photo("same");
  assert.equal(cleanupSourceCurrent(initial, {...initial, labels: ["new tag"]}), true);
  for (const latest of [undefined, {...initial, digest: "revised"}, {...initial, file: new File(["new"], "same.png")},
    {...initial, current: () => false}, withPhotoOrganization(initial, {trash: true}), {...initial, previewAvailable: false}])
    assert.equal(cleanupSourceCurrent(initial, latest), false);
});
