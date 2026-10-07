import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {LocalPhoto} from "../src/local/resources";
import {LocalResources} from "../src/local/resources";
import type {SearchResult} from "../src/local/search";
import {PhotoSearchIndex} from "../src/local/search";
import {LocalSearch} from "../src/local/LocalSearch";
import {useSemanticFind} from "../src/local/useSemanticFind";
import {SemanticFindSession, addSemanticMatches, cosine, eligibleSemanticPhotos, normalizeVector, subscribeSemanticLifecycle, semanticPreviewStatus} from "../src/local/semantic-find";
import {SEMANTIC_ASSETS, SEMANTIC_MODEL, SEMANTIC_REVISION, semanticAssetCache, semanticAssetFetch, retryableSemanticModels, verifySemanticAsset, zeroSemanticPadding} from "../src/local/semantic-config";
const vector = () => {const out = new Float32Array(512); out[0] = 1; return out;};
const photo = (id: string): LocalPhoto => ({id, digest: id, filename: id + ".jpg", date: "2026-10-03T12:00:00Z", dateSource: "exif", preview: new Blob([id])});
const deferred = <T>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};};
class FakeWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  terminated = false;
  messages: any[] = [];
  constructor(private answer = (message: any, worker: FakeWorker) => {if (message.kind !== "cancel") queueMicrotask(() => worker.reply(message.id, vector()));}) {}
  postMessage(message: any) {this.messages.push(message); this.answer(message, this);}
  reply(id: number, data: Float32Array | {error: boolean}) {this.onmessage?.call(this as unknown as Worker, {data: {id, ...(data instanceof Float32Array ? {vector: data} : data)}} as MessageEvent);}
  terminate() {this.terminated = true;}
}
const resources = () => ({loads: 0, cleared: 0, async load(value: LocalPhoto) {this.loads++; return {blob: value.preview!, url: "", bytes: 1, decoded: 1, width: 1, height: 1, used: 0};}, clear() {this.cleared++;}});

test("missing retained previews are distinct from model failures and never initialize a model", async () => {
  let workers = 0;
  const missing = [{...photo("retained"), previewAvailable: false}, {...photo("without-source"), preview: undefined}];
  const engine = new SemanticFindSession(() => {workers++; throw new Error("must not load");}, resources());
  try {
    assert.equal(semanticPreviewStatus(missing, "fireworks"), "missing-preview");
    assert.equal(await engine.search(missing, "fireworks", () => true, () => {throw new Error("must not publish");}), "missing-preview");
    assert.equal(workers, 0);
    assert.equal(semanticPreviewStatus(missing, "2026-10-03"), undefined, "A date query needs no model or preview");
    assert.equal(semanticPreviewStatus(missing.map(value => ({...value, current: () => false})), "fireworks"), undefined);
  } finally {engine.clear();}
});

test("skipped retained previews leave a successful visual check explicitly incomplete", async () => {
  const worker = new FakeWorker(), raster = resources();
  const engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  try {
    let scores: ReadonlyMap<string, number> = new Map();
    assert.equal(await engine.search([photo("readable"), {...photo("retained"), previewAvailable: false}], "fireworks", () => true, value => {scores = value;}), "incomplete");
    assert.deepEqual([...scores.keys()], ["readable"]); assert.equal(raster.loads, 1);
  } finally {engine.clear();}
});

test("the missing-preview hook renders recovery guidance without claiming completed no matches", () => {
  const photos = [{...photo("retained"), previewAvailable: false}];
  function Search() {
    const result = useSemanticFind(photos, new PhotoSearchIndex(photos).search("fireworks"), true, "local");
    return createElement(LocalSearch, {photos, result, resources: new LocalResources(), coverage: "1 photo", onAccept() {}, onNavigate() {}, onOpen() {}, onConfirm() {}, onPin() {}, onFailure() {}});
  }
  const markup = renderToStaticMarkup(createElement(Search));
  assert.match(markup, /Photo previews are unavailable/);
  assert.doesNotMatch(markup, /No matching photos|Searching photos…|aria-busy="true"/);
});

test("unfinished or failed text reading never renders a completed no-match claim, while found evidence stays usable", () => {
  for (const textStatus of ["indexing", "incomplete"] as const) {
    for (const matched of [false,true]) {
      const photos = [{...photo("one"),labels:matched ? ["receipt"] : []}];
      const result = {...new PhotoSearchIndex(photos).search("receipt"),textStatus};
      const markup = renderToStaticMarkup(createElement(LocalSearch,{photos,result,resources:new LocalResources(),coverage:"1 photo",onAccept(){},onNavigate(){},onOpen(){},onConfirm(){},onPin(){},onFailure(){}}));
      assert.doesNotMatch(markup,/No matching photos/);
      assert.match(markup,textStatus === "indexing" ? /Text is still being read/ : /Text couldn’t be read/);
      if(matched) assert.match(markup,/aria-label="Open one.jpg"/);
    }
  }
});

test("semantic cancellation aborts a pending thumbnail consumer without publishing late results", async () => {
  const worker = new FakeWorker(), raster = resources(); let reading = false, aborted = false;
  raster.load = ((_value:LocalPhoto,_kind:string,signal?:AbortSignal) => new Promise((_resolve,reject) => {
    reading = true; signal!.addEventListener("abort",()=>{aborted=true;reject(new DOMException("Canceled","AbortError"));},{once:true});
  })) as any;
  const engine = new SemanticFindSession(()=>worker as unknown as Worker,raster);
  try {
    let emitted = 0;
    const pending = engine.search([photo("one")],"fireworks",()=>true,()=>{emitted++;});
    while(!reading) await new Promise(resolve=>setTimeout(resolve,0));
    engine.cancel();
    assert.equal(await pending,undefined); assert.equal(aborted,true); assert.equal(emitted,0);
  } finally {engine.clear();}
});

test("failed previews and image inference cannot complete as a successful empty visual search", async () => {
  for (const failure of ["preview", "image"] as const) {
    const worker = new FakeWorker((message, own) => {
      if (message.kind !== "cancel") queueMicrotask(() => own.reply(message.id,
        message.kind === "image" ? {error: true} : vector()));
    });
    const raster = resources();
    if (failure === "preview") raster.load = async () => {throw new Error("Preview unavailable");};
    const engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
    try {
      const scores: ReadonlyMap<string, number>[] = [];
      assert.equal(await engine.search([photo("one")], "fireworks", () => true, value => scores.push(value)), failure === "preview" ? "missing-preview" : "unavailable", failure);
      assert.equal(scores.at(-1)?.size, 0);
    } finally {engine.clear();}
  }
});

test("mixed visual checks retain successful matches and distinguish incomplete results from genuine empty results", async () => {
  const worker = new FakeWorker((message, own) => {
    if (message.kind === "cancel") return;
    const value = vector();
    if (message.kind === "text" && message.text === "unrelated") {value[0] = 0; value[1] = 1;}
    queueMicrotask(() => own.reply(message.id, value));
  }), raster = resources();
  raster.load = async value => {if (value.id === "missing") throw new Error("Preview unavailable"); return {blob: value.preview!, url: "", bytes: 1, decoded: 1, width: 1, height: 1, used: 0};};
  const engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  try {
    let scores: ReadonlyMap<string, number> = new Map();
    assert.equal(await engine.search([photo("one"), photo("missing")], "fireworks", () => true, value => {scores = value;}), "incomplete");
    const base = new PhotoSearchIndex([{...photo("label"), labels: ["fireworks"]}]).search("fireworks");
    assert.deepEqual(addSemanticMatches(base, scores, new Set(["one", "label"])).photoIds, ["label", "one"]);
    assert.equal(await engine.search([photo("one")], "unrelated", () => true, value => {scores = value;}), undefined);
    const empty = new PhotoSearchIndex([photo("one")]).search("unrelated");
    assert.deepEqual(addSemanticMatches(empty, scores, new Set(["one"])).photoIds, []);
  } finally {engine.clear();}
});

test("unavailable visual search never claims no matches and still shows lexical results", () => {
  const render = (status: "unavailable" | "incomplete", withLabel = false) => {
    const photos = [{...photo("one"), labels: withLabel ? ["fireworks"] : []}];
    const result = {...new PhotoSearchIndex(photos).search("fireworks"), visualStatus: status};
    return renderToStaticMarkup(createElement(LocalSearch, {photos, result, resources: new LocalResources(), coverage: "1 photo", onAccept() {}, onNavigate() {}, onOpen() {}, onConfirm() {}, onPin() {}, onFailure() {}}));
  };
  for (const status of ["unavailable", "incomplete"] as const) {
    const empty = render(status);
    assert.doesNotMatch(empty, /No matching photos|Searching photos…|aria-busy="true"/);
    assert.match(empty, status === "unavailable" ? /Visual search is unavailable/ : /Some photos couldn’t be checked visually/);
    const lexical = render(status, true);
    assert.match(lexical, /aria-label="Open one.jpg"/);
    assert.match(lexical, status === "unavailable" ? /Visual search is unavailable/ : /Some photos couldn’t be checked visually/);
  }
});

test("a worker failure between requests remains unavailable when its pending preview finishes", async () => {
  const worker = new FakeWorker(), loading = deferred<void>(), finish = deferred<void>();
  const raster = resources(), p = photo("one");
  raster.load = async () => {loading.resolve(); await finish.promise; return {blob: p.preview!, url: "", bytes: 1, decoded: 1, width: 1, height: 1, used: 0};};
  const engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  let published = 0;
  try {
    const pending = engine.search([p], "fireworks", () => true, () => {published++;});
    const rejected = assert.rejects(pending, /Visual search is unavailable/);
    await loading.promise;
    worker.onerror?.call(worker as unknown as Worker, {} as ErrorEvent);
    finish.resolve();
    await rejected;
    assert.equal(published, 0);
    assert.equal(worker.terminated, true);
  } finally {engine.clear();}
});

test("caller cancellation while a preview loads does not publish a visual failure or late match", async () => {
  const worker = new FakeWorker(), loading = deferred<void>(), finish = deferred<void>(), raster = resources(), p = photo("one");
  raster.load = async () => {loading.resolve(); await finish.promise; return {blob: p.preview!, url: "", bytes: 1, decoded: 1, width: 1, height: 1, used: 0};};
  const engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  let published = 0;
  try {
    const pending = engine.search([p], "fireworks", () => true, () => {published++;});
    await loading.promise; engine.cancel(); finish.resolve();
    assert.equal(await pending, undefined);
    assert.equal(published, 0);
  } finally {engine.clear();}
});

test("a worker crash between cached batches cannot finish as a complete visual search", async () => {
  const worker = new FakeWorker(), engine = new SemanticFindSession(() => worker as unknown as Worker, resources());
  const photos = Array.from({length: 64}, (_, index) => photo("cached-" + index));
  let scheduled = false, crashed = false;
  try {
    await engine.search(photos, "city", () => true, () => {});
    await assert.rejects(engine.search(photos, "fireworks", () => true, () => {
      assert.equal(crashed, false, "A failed worker cannot publish another batch");
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {crashed = true; worker.onerror?.call(worker as unknown as Worker, {} as ErrorEvent);});
      }
    }), /Visual search is unavailable/);
    assert.equal(crashed, true);
    assert.equal(worker.terminated, true);
  } finally {engine.clear();}
});

test("the initial semantic search render is busy without a false empty result, while lexical matches stay visible", () => {
  const render = (photos: LocalPhoto[], query: string, active = true, committed?: string) => {
    function InitialSearch() {
      const base = new PhotoSearchIndex(photos).search(query, {committedMeaning: committed});
      const result = useSemanticFind(photos, base, active, "account:one", committed);
      return createElement(LocalSearch, {photos, result, resources: new LocalResources(), coverage: "1 photo", onAccept() {}, onNavigate() {}, onOpen() {}, onConfirm() {}, onPin() {}, onFailure() {}});
    }
    return renderToStaticMarkup(createElement(InitialSearch));
  };
  const pending = render([photo("one")], "fireworks");
  assert.match(pending, /aria-busy="true"/); assert.match(pending, /Searching photos…/);
  assert.doesNotMatch(pending, /No matching photos|Try a label/);
  const lexical = render([{...photo("one"), labels: ["fireworks"]}], "fireworks");
  assert.match(lexical, /aria-label="Open one.jpg"/); assert.doesNotMatch(lexical, /Searching photos…|No matching photos/);
  for (const markup of [render([photo("one")], "fireworks", false), render([photo("one")], "fireworks", true, "label:fireworks"),
    render([photo("one")], "2026-10-03"), render([{...photo("one"), current: () => false}], "fireworks"),
    render([{...photo("one"), previewAvailable: false}], "fireworks")]) {
    assert.doesNotMatch(markup, /aria-busy="true"|Searching photos…/);
  }
  const finished: SearchResult = {query: "fireworks", scope: "account:one", photoIds: [], meanings: []};
  const fallback = renderToStaticMarkup(createElement(LocalSearch, {photos: [photo("one")], result: finished, resources: new LocalResources(), coverage: "1 photo", onAccept() {}, onNavigate() {}, onOpen() {}, onConfirm() {}, onPin() {}, onFailure() {}}));
  assert.match(fallback, /No matching photos/); assert.doesNotMatch(fallback, /Searching photos…|aria-busy="true"/);
});

test("semantic retrieval keeps lexical ordering and supplied evidence, while an accepted meaning stays exact", () => {
  const base: SearchResult = {query: "dog", scope: "account:one", photoIds: ["label"], photoId: "label", meaning: {id: "label:dog", term: "Dog", kind: "label", photoIds: ["label"], evidence: {label: "label"}}, meanings: []};
  const scores = new Map([["label", .21], ["visual", .6], ["withdrawn", .8], ["weak", .19], ["invalid", NaN]]), allowed = new Set(["label", "visual", "weak", "invalid"]);
  const result = addSemanticMatches(base, scores, allowed);
  assert.deepEqual(result.photoIds, ["label", "visual"]); assert.equal(result.photoId, "label");
  assert.equal(result.meaning?.evidence.label, "label"); assert.equal(result.meaning?.evidence.visual, "visual");
  assert.equal(addSemanticMatches(base, scores, allowed, "label:dog"), base);
  assert.deepEqual(base.photoIds, ["label"]);
  assert.equal(addSemanticMatches(base, new Map([["weak", .19]]), allowed), base);
});
test("semantic candidates honor real capture dates and current sources, without inferring dates for selected files", () => {
  const all = [photo("current"), {...photo("selected"), dateSource: "selected" as const}, {...photo("old"), date: "2025-10-03T12:00:00Z"}, {...photo("revoked"), current: () => false}, {...photo("missing"), previewAvailable: false}];
  assert.deepEqual(eligibleSemanticPhotos(all, "fireworks 2026-10-03").map(value => value.id), ["current"]);
  assert.deepEqual(eligibleSemanticPhotos(all, "fireworks").map(value => value.id), ["current", "selected", "old"]);
  assert.deepEqual(eligibleSemanticPhotos(all, "2026-10-03"), []);
});
test("both modalities require finite nonzero 512-dimensional normalized vectors and stable zero padding", () => {
  assert.equal(cosine(normalizeVector(vector()), normalizeVector(vector())), 1);
  assert.throws(() => normalizeVector([1]), /invalid/); assert.throws(() => normalizeVector(new Float32Array(512)), /invalid/);
  const invalid = vector(); invalid[3] = NaN; assert.throws(() => normalizeVector(invalid), /invalid/);
  const input_ids = {data: BigInt64Array.from([49406n, 5n, 49407n, 49407n])}, attention_mask = {data: BigInt64Array.from([1n, 1n, 1n, 0n])};
  zeroSemanticPadding({input_ids, attention_mask}); assert.deepEqual([...input_ids.data], [49406n, 5n, 49407n, 0n]);
});
test("model preparation coalesces startup and retries a failed load instead of retaining a rejected model promise", async () => {
  let calls = 0; const loaded = {dimensions: 512};
  const prepare = retryableSemanticModels(async () => {if (++calls === 1) throw new TypeError("offline"); return loaded;});
  const first = prepare(); assert.equal(prepare(), first); await assert.rejects(first, /offline/);
  assert.equal(await prepare(), loaded); assert.equal(await prepare(), loaded); assert.equal(calls, 2);
});
test("worker startup is lazy; completed vectors survive same-digest metadata refresh without decoding photos again", async () => {
  const workers: FakeWorker[] = [], raster = resources(), engine = new SemanticFindSession(() => {const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;}, raster);
  assert.equal(workers.length, 0); assert.equal(raster.loads, 0);
  const p = photo("one"), updates: Map<string, number>[] = [];
  await engine.search([p], "fireworks", () => true, scores => updates.push(new Map(scores)));
  await engine.search([{...p, previewLoader: async () => p.preview!, preview: undefined, labels: ["Family"]}], "city", () => true, () => {});
  assert.equal(workers.length, 1); assert.equal(raster.loads, 1);
  assert.equal(workers[0].messages.filter(value => value.kind === "image").length, 1);
  assert.equal(updates.at(-1)?.get("one"), 1); engine.clear();
  assert.equal(workers[0].terminated, true); assert.ok(raster.cleared > 0);
});
test("a warm visual search ranks cached photos without scheduling one event-loop turn per photo", async t => {
  const worker = new FakeWorker(), raster = resources(), engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  const photos = Array.from({length: 4096}, (_, index) => photo("warm-" + index));
  try {
    await engine.search(photos, "city", () => true, () => {});
    let turns = 0, latest: ReadonlyMap<string, number> | undefined;
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay === 0) turns++;
      return schedule(callback, delay, ...args);
    });
    const started = performance.now();
    await engine.search(photos, "fireworks", () => true, scores => {latest = scores;});
    t.diagnostic(`4096 cached vectors: ${turns} scheduled turns, ${(performance.now() - started).toFixed(1)} ms`);
    assert.equal(latest?.size, 4096); assert.equal(latest?.get("warm-4095"), 1);
    assert.equal(raster.loads, 4096); assert.equal(worker.messages.filter(value => value.kind === "image").length, 4096);
    assert.equal(worker.messages.filter(value => value.kind === "text").length, 2);
    assert.ok(turns <= 128, `Cached ranking scheduled ${turns} turns for 4096 photos`);
  } finally {engine.clear();}
});
test("cached ranking yields to a replacement query and excludes a source withdrawn between batches", async () => {
  const axis = (index: number) => {const value = new Float32Array(512); value[index] = 1; return value;};
  const worker = new FakeWorker((message, own) => {
    if (message.kind !== "cancel") queueMicrotask(() => own.reply(message.id, axis(message.kind === "text" && message.text !== "new city" ? 0 : 1)));
  });
  const raster = resources(), engine = new SemanticFindSession(() => worker as unknown as Worker, raster);
  let permitted = true, replacementStarted = false, scheduled = false, late = 0;
  const photos = Array.from({length: 96}, (_, index) => ({...photo("cached-" + index), current: () => index !== 95 || permitted}));
  const replaced = deferred<void>(), oldSizes: number[] = [], latest: ReadonlyMap<string, number>[] = [];
  try {
    await engine.search(photos, "seed city", () => true, () => {});
    await engine.search(photos, "old city", () => true, scores => {
      if (replacementStarted) late++;
      oldSizes.push(scores.size);
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        replacementStarted = true; permitted = false;
        void engine.search(photos, "new city", () => true, scores => latest.push(scores)).finally(() => replaced.resolve());
      }, 0);
    });
    await replaced.promise;
    assert.ok(oldSizes.length > 0); assert.ok(Math.max(...oldSizes) <= 64, "Old scoring monopolized the event loop");
    assert.equal(late, 0); assert.equal(latest.at(-1)?.size, 95);
    assert.equal(latest.at(-1)?.get("cached-0"), 1); assert.equal(latest.at(-1)?.has("cached-95"), false);
    assert.equal(raster.loads, 96); assert.equal(worker.messages.filter(value => value.kind === "image").length, 96);
  } finally {engine.clear();}
});
test("a changed or withdrawn original cannot keep its vector or publish a late image match", async () => {
  const raster = resources(), started = deferred<void>(); let allowed = true, reply!: () => void;
  const worker = new FakeWorker((message, own) => {
    if (message.kind === "text") queueMicrotask(() => own.reply(message.id, vector()));
    if (message.kind === "image") {reply = () => own.reply(message.id, vector()); started.resolve();}
  });
  const engine = new SemanticFindSession(() => worker as unknown as Worker, raster), p = {...photo("one"), current: () => allowed};
  const updates: ReadonlyMap<string, number>[] = [], pending = engine.search([p], "city", () => true, scores => updates.push(scores));
  await started.promise; allowed = false; reply(); await pending;
  assert.equal(updates.at(-1)?.size, 0); engine.reconcile([]); allowed = true;
  worker.postMessage = (message: any) => {worker.messages.push(message); if (message.kind !== "cancel") queueMicrotask(() => worker.reply(message.id, vector()));};
  await engine.search([{...p, digest: "changed"}], "city", () => true, () => {});
  assert.equal(raster.loads, 2); engine.clear();
});
test("query replacement cancels pending worker requests and late replies cannot publish the previous query", async () => {
  const worker = new FakeWorker(() => {}), engine = new SemanticFindSession(() => worker as unknown as Worker, resources()), updates: ReadonlyMap<string, number>[] = [];
  const pending = engine.search([photo("one")], "old city", () => true, scores => updates.push(scores)), rejected = assert.rejects(pending, {name: "AbortError"});
  const old = worker.messages.find(value => value.kind === "text"); engine.cancel(); await rejected; worker.reply(old.id, vector());
  assert.equal(updates.length, 0); assert.ok(worker.messages.some(value => value.kind === "cancel" && value.through === old.id)); engine.clear();
});
test("lock and background events immediately terminate private inference; foreground and online permit a new session", async () => {
  for (const kind of ["fotoro-lock", "pagehide", "visibilitychange"]) {
    const worker = new FakeWorker(() => {}), engine = new SemanticFindSession(() => worker as unknown as Worker, resources());
    const pending = engine.search([photo("one")], "city", () => true, () => assert.fail("Closed inference cannot publish")), rejected = assert.rejects(pending, {name: "AbortError"});
    const windowEvents = new EventTarget(), documentEvents = new EventTarget(); let visible = true, resumes = 0;
    const stop = subscribeSemanticLifecycle(() => engine.clear(), () => resumes++, {window: windowEvents, document: documentEvents, visible: () => visible} as any);
    if (kind === "visibilitychange") {visible = false; documentEvents.dispatchEvent(new Event(kind));} else windowEvents.dispatchEvent(new Event(kind));
    assert.equal(worker.terminated, true, kind); await rejected;
    visible = true; documentEvents.dispatchEvent(new Event("visibilitychange")); windowEvents.dispatchEvent(new Event("online")); assert.equal(resumes, 2);
    stop(); documentEvents.dispatchEvent(new Event("visibilitychange")); assert.equal(resumes, 2);
  }
});
test("a stalled worker has a bounded request and can restart without blocking lexical retrieval", async () => {
  const workers: FakeWorker[] = [], engine = new SemanticFindSession(() => {const worker = new FakeWorker(workers.length ? undefined : () => {}); workers.push(worker); return worker as unknown as Worker;}, resources(), 10);
  await assert.rejects(engine.search([photo("one")], "city", () => true, () => {}), {name: "AbortError"}); assert.equal(workers[0].terminated, true);
  const scores: ReadonlyMap<string, number>[] = [];
  await engine.search([photo("one")], "city", () => true, value => scores.push(value)); assert.equal(workers.length, 2); assert.equal(scores.at(-1)?.get("one"), 1); engine.clear();
});
test("asset fetch permits only verified public GETs and rejects tampered bytes, excess size, uploads and unpinned models", async () => {
  const bytes = new TextEncoder().encode("pinned public model"), hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  const url = `https://huggingface.co/${SEMANTIC_MODEL}/resolve/${SEMANTIC_REVISION}/config.json`, assets = new Map([[url, [bytes.length, hash] as const]]); let calls = 0;
  const fetch = semanticAssetFetch((async (input, init) => {calls++; assert.equal(String(input), url); assert.equal(init?.credentials, "omit"); assert.equal(new Headers(init?.headers).has("Authorization"), false); assert.equal(init?.body, undefined); return new Response(bytes);}) as typeof globalThis.fetch, assets);
  assert.equal(await (await fetch(url, {headers: {Authorization: "private token"}})).text(), "pinned public model");
  const metadata = await fetch(url, {headers: {Range: "bytes=0-0"}});
  assert.equal(metadata.status, 206); assert.equal(metadata.headers.get("Content-Range"), `bytes 0-0/${bytes.length}`); assert.equal(calls, 1);
  await assert.rejects(fetch(url, {method: "POST", body: "private photo"}), /only loads public/);
  await assert.rejects(fetch(url.replace(SEMANTIC_REVISION, "main")), /unavailable/);
  await assert.rejects(fetch("https://huggingface.co/Xenova/mobileclip_s0/resolve/20c6e4f26ad3f7f7e9cde13c4f9bb54852dd42c6/onnx/text_model_quantized.onnx"), /unavailable/);
  assert.equal((await fetch(url.replace("config.json", "optional_processor.json"))).status, 404); assert.equal(calls, 1);
  await assert.rejects(verifySemanticAsset(url, new Response(new Uint8Array(bytes.length)), assets), /invalid/);
  await assert.rejects(verifySemanticAsset(url, new Response(new Uint8Array(bytes.length + 1)), assets), /invalid/);
  assert.ok(SEMANTIC_ASSETS.has(`https://huggingface.co/${SEMANTIC_MODEL}/resolve/${SEMANTIC_REVISION}/onnx/model_quantized.onnx`));
  assert.equal(SEMANTIC_ASSETS.has(`https://huggingface.co/${SEMANTIC_MODEL}/resolve/${SEMANTIC_REVISION}/onnx/model.onnx`), false);
});
test("public model cache verifies reads as well as writes and removes corrupted cached weights for network recovery", async () => {
  const data = new TextEncoder().encode("verified"), hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), value => value.toString(16).padStart(2, "0")).join("");
  const url = "https://example.invalid/model", assets = new Map([[url, [data.length, hash] as const]]), values = new Map<string, Response>(); let deleted = 0;
  const cache = semanticAssetCache(async () => ({async match(key: string) {return values.get(key)?.clone();}, async put(key: string, response: Response) {values.set(key, response);}, async delete(key: string) {deleted++; return values.delete(key);}}) as any, assets);
  await cache.put(url, new Response(data)); assert.equal(await (await cache.match(url))?.text(), "verified");
  values.set(url, new Response("poisoned")); assert.equal(await cache.match(url), undefined); assert.equal(deleted, 1);
  await assert.rejects(cache.put(url, new Response("poisoned")), /invalid/); assert.equal(values.has(url), false);
  assert.equal(await cache.match("private-photo"), undefined);
});
