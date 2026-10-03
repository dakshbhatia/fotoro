import {readFileSync} from "node:fs";
import {PhotoSearchIndex} from "../apps/web/src/local/search.js";
import {recommendPhotos, PICK_PROCESSOR, type PhotoSignals} from "../apps/web/src/local/auto-picks.js";
import type {LocalPhoto} from "../apps/web/src/local/resources.js";

interface Record extends LocalPhoto {
  signal: (Omit<PhotoSignals, "hash"> & {hash: string}) | null;
}
interface Task {id: string; query: string; picks: string[]; groups: number; unassessed: number}
interface Corpus {version: number; processor: string; clock: string; qualification: string; records: Record[]; tasks: Task[]}
const corpus: Corpus = JSON.parse(readFileSync(new URL("../fixtures/search/picks-v1.json", import.meta.url), "utf8"));
if (corpus.version !== 1 || corpus.processor !== PICK_PROCESSOR) throw new Error("Requalify moment picks before changing its processor.");
const photos: LocalPhoto[] = corpus.records.map(({signal: _signal, ...record}) => ({
  ...record, captureVerified: record.dateSource === "exif" ? true : undefined,
}));
const signals = new Map(corpus.records.flatMap(record => record.signal
  ? [[record.id, {...record.signal, hash: BigInt(record.signal.hash)}] as const] : []));
const unchanged = JSON.stringify(photos), index = new PhotoSearchIndex(photos), now = Date.parse(corpus.clock);
const tasks = corpus.tasks.map(task => {
  const response = index.search(task.query, {now});
  const matched = new Set(response.photoIds);
  // Scope before quality grouping and the quota. Intersecting the global Picks
  // can lose every useful shot from a smaller matching moment.
  const subset = photos.filter(photo => matched.has(photo.id));
  const result = recommendPhotos(subset, signals);
  const ids = [...result.ids].sort();
  const passed = JSON.stringify(ids) === JSON.stringify([...task.picks].sort())
    && result.groupCount === task.groups && result.unassessed === task.unassessed
    && ids.every(id => matched.has(id) && result.reasons.has(id));
  return {id: task.id, query: task.query, matched: subset.length, picks: ids,
    groups: result.groupCount, unassessed: result.unassessed, passed};
});
const preserved = JSON.stringify(photos) === unchanged;
console.log(JSON.stringify({fixtureVersion: corpus.version, processor: PICK_PROCESSOR,
  correct: tasks.filter(task => task.passed).length, total: tasks.length,
  sourcesPreserved: preserved, tasks, qualification: corpus.qualification}, null, 2));
if (!preserved || tasks.some(task => !task.passed)) process.exitCode = 1;
