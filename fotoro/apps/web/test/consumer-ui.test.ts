import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {LocalSearch, SearchMatchDetails} from "../src/local/LocalSearch";
import {LocalResources, type LocalPhoto} from "../src/local/resources";
import {ConsumerPreviewResources} from "../src/library/consumer-search";
import {PhotoSearchIndex} from "../src/local/search";
import {withPhotoObservation} from "@fotoro/contracts/intelligence";
import {factsWithPeople} from "@fotoro/contracts/people";
import {addSemanticMatches} from "../src/local/semantic-find";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {clearAccount, get} from "../src/exchange/cache";

test("matching photos open without acceptance or correction controls in the main search surface", () => {
  const photos: LocalPhoto[] = [{id: "a", filename: "receipt.png", date: "2026-10-01", width: 100, height: 100, labels: ["receipt"]}];
  const result = new PhotoSearchIndex(photos).search("receipt");
  const markup = renderToStaticMarkup(createElement(LocalSearch, {photos, result, resources: new LocalResources(), coverage: "1 photo", onAccept: () => {}, onNavigate: () => {}, onOpen: () => {}, onConfirm: () => {}, onPin: () => {}, onFailure: () => {}}));
  assert.match(markup, /aria-label="Open receipt.png"/);
  assert.match(markup, /aria-label="Search details"/);
  assert.doesNotMatch(markup, /predicted|accepted|This is the photo|Pin for|Supplied label/);
});

test("a displayed Saved search preview survives background cache pressure until its consumer leaves", async () => {
  const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document;
  globalThis.createImageBitmap = (async (_blob:Blob,options:ImageBitmapOptions) => ({width:options.resizeWidth,height:options.resizeHeight,close(){}})) as any;
  globalThis.document = {createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}}),toBlob:(done:(value:Blob)=>void)=>done(new Blob(["public raster"],{type:"image/jpeg"}))})} as any;
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);
  const header = new DataView(bytes.buffer); header.setUint32(16,1600); header.setUint32(20,1600);
  const source = (id:string):LocalPhoto => ({id,filename:"public.png",date:"2026-10-06",dateSource:"selected",previewLoader:async()=>new Blob([bytes],{type:"image/png"})});
  const resources = new ConsumerPreviewResources(), controller = new AbortController(), leading = source("saved:leading");
  try {
    const displayed = await resources.lease(leading,"preview",controller.signal);
    const cached = await resources.load(leading,"preview");
    for(let index=0;index<4;index++) await resources.load(source("saved:background-"+index),"preview");
    await assert.rejects(fetch(cached.url),"Background indexing should evict the ordinary cache URL");
    assert.equal(await (await fetch(displayed.url)).text(),"public raster","The visible Search image owns a separate URL lease");
    controller.abort(); await assert.rejects(fetch(displayed.url),"Leaving the Search image releases its URL immediately");
  } finally {controller.abort();resources.clear();globalThis.createImageBitmap=oldBitmap;globalThis.document=oldDocument;}
});

test("search details distinguish approved People and machine observations from supplied labels and captions", () => {
  const digest = "a".repeat(64);
  const observation = {version:1 as const,photoId:"one",sourceRevision:digest,processor:"gemini-3.8-flash" as const,observedAt:"2026-10-06T12:00:00.000Z",
    observations:{objects:["bicycle"],scene:[],visibleText:"Menu",uncertainty:["Maybe moonlight"]}};
  const facts = factsWithPeople(withPhotoObservation({facts:[]},observation).facts,digest,[{personId:crypto.randomUUID(),name:"Ronald",box:[0,0,1000,1000]}]);
  const photo: LocalPhoto = {id:"one",digest,filename:"IMG_0001.jpg",date:"2026-10-06",dateSource:"selected",facts,caption:"My exact caption",labels:["Family"]};
  const index = new PhotoSearchIndex([photo]);
  const render = (query:string) => renderToStaticMarkup(createElement(SearchMatchDetails,{photo,meaning:index.search(query).meaning!,coverage:"1 photo",canCorrect:true,onAccept(){},onConfirm(){},onPin(){}}));
  assert.match(render("Ronald"),/Person · Ronald/); assert.doesNotMatch(render("Ronald"),/Supplied label|Source fact/);
  assert.match(render("bicycle"),/Machine observation · bicycle/); assert.doesNotMatch(render("bicycle"),/Source fact|Caption ·/);
  assert.match(render("Menu"),/Machine observation · Menu/);
  assert.match(render("Family"),/Supplied label · Family/);
  assert.match(render("My exact caption"),/Caption · My exact caption/);
  assert.deepEqual(index.search("moonlight").photoIds,[]);
  assert.equal(photo.caption,"My exact caption"); assert.deepEqual(photo.labels,["Family"]);
});

test("visual-only match details preserve evidence without unsupported acceptance or preference actions", () => {
  const photo: LocalPhoto = {id: "a", filename: "city.png", date: "2026-10-01", preview: new Blob(["preview"])};
  const base = new PhotoSearchIndex([photo]).search("fireworks");
  const visual = addSemanticMatches(base, new Map([[photo.id, .4]]), new Set([photo.id]));
  const props = {photo, coverage: "1 photo", canCorrect: true, onAccept() {assert.fail("No unsupported acceptance");}, onConfirm() {}, onPin() {}};
  const markup = renderToStaticMarkup(createElement(SearchMatchDetails, {...props, meaning: visual.meaning!}));
  assert.match(markup, /Visual similarity/); assert.match(markup, /About this match/);
  assert.doesNotMatch(markup, /Search this|Adjust future|This is the photo|Prefer this photo|<button/);
  const labeled = {...photo, labels: ["fireworks"]};
  const mixed = addSemanticMatches(new PhotoSearchIndex([labeled]).search("fireworks"), new Map([["visual", .4]]), new Set(["a", "visual"]));
  const labelMarkup = renderToStaticMarkup(createElement(SearchMatchDetails, {...props, meaning: mixed.meaning!, committed: mixed.meaning!.id}));
  assert.match(labelMarkup, /Supplied label · fireworks/); assert.match(labelMarkup, /aria-pressed="true"[^>]*>Search this label/);
  assert.match(labelMarkup, /This is the photo/); assert.match(labelMarkup, /Prefer this photo/);
  const visualMember = renderToStaticMarkup(createElement(SearchMatchDetails, {...props, photo: {...photo, id: "visual"}, meaning: mixed.meaning!}));
  assert.match(visualMember, /Visual similarity/); assert.match(visualMember, /Search this label/);
});

const facts = {unlocked: true, paused: false, online: true, preparing: false, busy: false, needsAttention: false, committedPhotos: 3, queuedPhotos: 2, failedPhotos: 0, skippedPhotos: 0, pendingEdits: 0, conflictingEdits: 0, localPhotos: 0, lastCheckedAt: "2026-10-01T12:00:00Z"};
test("consumer counts come from verified catalog photos and omit an unknown total", async () => {
  const {deriveConsumerSyncSummary} = await import("../src/library/consumer-sync");
  const result = deriveConsumerSyncSummary(facts);
  assert.equal(result.completedPhotos, 3);
  assert.equal(result.totalPhotos, undefined);
  assert.equal(result.state, "paused");
  assert.equal(result.action, "continue");
  assert.equal(deriveConsumerSyncSummary({...facts, busy: true}).state, "uploading");
  assert.match(result.detail!, /2.*waiting/);
});
test("explicit pause wins over offline and pending uploads; locked snapshots discard account counts", async () => {
  const {deriveConsumerSyncSummary} = await import("../src/library/consumer-sync");
  const paused = deriveConsumerSyncSummary({...facts, paused: true, online: false});
  assert.equal(paused.state, "paused"); assert.equal(paused.action, "continue");
  const locked = deriveConsumerSyncSummary({...facts, unlocked: false});
  assert.equal(locked.state, "notStarted"); assert.equal(locked.action, "signIn");
  assert.equal(locked.completedPhotos, undefined); assert.equal(locked.lastCheckedAt, undefined);
});
test("partial sync always reports unstaged selected originals while preserving verified saved counts", async () => {
  const {deriveConsumerSyncSummary} = await import("../src/library/consumer-sync");
  const cases = [{paused: true}, {online: false}, {needsAttention: true}, {preparing: true}, {busy: true}, {queuedPhotos: 0}];
  for (const extra of cases) {
    const summary = deriveConsumerSyncSummary({...facts, localPhotos: 4, ...extra});
    assert.equal(summary.completedPhotos, 3); assert.equal(summary.totalPhotos, undefined);
    assert.match(summary.detail!, /3 photos saved/); assert.match(summary.detail!, /4 selected to Save/);
    assert.equal((summary.detail!.match(/selected to Save/g) ?? []).length, 1);
  }
  assert.doesNotMatch(deriveConsumerSyncSummary(facts).detail!, /selected to Save/);
  assert.equal(deriveConsumerSyncSummary({...facts, unlocked: false, localPhotos: 4}).detail, undefined);
});
test("skipped photos and pending or conflicting edits prevent an unconditional completion", async () => {
  const {deriveConsumerSyncSummary} = await import("../src/library/consumer-sync");
  for (const extra of [{skippedPhotos: 1}, {pendingEdits: 1}, {conflictingEdits: 1}]) {
    const summary = deriveConsumerSyncSummary({...facts, queuedPhotos: 0, ...extra});
    assert.equal(summary.state, "needsAttention"); assert.notEqual(summary.action, "none");
  }
});
test("local optional features have no implicit choice or storage write", async () => {
  const {loadLocalChoices,saveLocalChoices}=await import("../src/local/preferences");
  const previous=globalThis.localStorage;
  let value:string|null=null,writes=0;
  globalThis.localStorage={getItem:()=>value,setItem:(_key:string,next:string)=>{writes++;value=next;}} as Storage;
  try {
    assert.equal(loadLocalChoices(),undefined);assert.equal(writes,0);
    value='{"readText":true}';assert.equal(loadLocalChoices(),undefined);assert.equal(writes,0);
    saveLocalChoices({readText:false,retain:false});assert.deepEqual(loadLocalChoices(),{readText:false,retain:false});
    saveLocalChoices({readText:true,retain:true});assert.deepEqual(loadLocalChoices(),{readText:true,retain:true});
    assert.equal(writes,2);
  } finally {globalThis.localStorage=previous;}
});

test("saved search joins local ordering and deduplicates only a matching original digest", async () => {
  const {savedSearchPhotos, combineConsumerSearch} = await import("../src/library/consumer-search");
  const local: LocalPhoto = {id: "00".repeat(32), digest: "00".repeat(32), file: new File(["original"], "same.png"), filename: "same.png", date: "2026-10-01", dateSource: "selected", labels: ["receipt"]};
  const saved = (id: string, digest: string) => ({manifest: {photoId: id, ownerAccountId: "owner"}, metadata: {filename: "same.png", sourceDate: "2026-10-01", dateSource: "import", originalSha256: digest}, annotations: {photoId: id, originalSha256: digest, labels: ["receipt"]}} as any);
  const snapshot = {accountId: "owner", token: {}, current: () => true, photos: [saved("matching", "A".repeat(43)), saved("different", "B".repeat(43))], preview: async () => new Blob()};
  const records = savedSearchPhotos(snapshot, [local]);
  assert.deepEqual(records.map(photo => photo.id), [local.id, "saved:different"]);
  const result = combineConsumerSearch(new PhotoSearchIndex([local]).search("receipt"), new PhotoSearchIndex(records).search("receipt"));
  assert.deepEqual(result.photoIds, [local.id, "saved:different"]);
  assert.equal(result.photoId, local.id);
  assert.equal(savedSearchPhotos({...snapshot, current: () => false}, [local]).length, 0);
});
test("recent browser browsing uses the ten-day boundary but preserves undated selected originals", async () => {
  const {inRecentSelectedRange} = await import("../src/local/consumer-range");
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.equal(inRecentSelectedRange({date: "2026-09-21T12:00:00Z", dateSource: "exif"}, now), true);
  assert.equal(inRecentSelectedRange({date: "2026-09-21T11:59:59Z", dateSource: "exif"}, now), false);
  assert.equal(inRecentSelectedRange({date: "2000-01-01", dateSource: "selected"}, now), true);
});
test("joining saved hits preserves local ranking, preferred default and engine result caps", async () => {
  const {combineConsumerSearch} = await import("../src/library/consumer-search");
  const {emptyFeedback} = await import("../src/local/search");
  const feedback = emptyFeedback(); feedback.pins[JSON.stringify(["local:all", "label:receipt"])] = "c";
  const photo = (id: string) => ({id, filename: "photo.png", date: "2026-10-01", labels: ["receipt"]});
  const local = new PhotoSearchIndex([photo("a"), photo("b"), photo("c")], feedback).search("receipt");
  const saved = new PhotoSearchIndex([photo("saved:d")]).search("receipt");
  const result = combineConsumerSearch(local, saved);
  assert.deepEqual(result.photoIds, ["c", "a", "b", "saved:d"]); assert.equal(result.photoId, "c");
  const capped = new PhotoSearchIndex(Array.from({length: 201}, (_, index) => photo("local:" + index.toString().padStart(3, "0")))).search("receipt");
  assert.equal(combineConsumerSearch(capped, saved).photoIds.length, 201);
});
test("saved preview dimensions are read before bounded decode and Lock fences a late preview", async () => {
  const module = await import("../src/library/consumer-search");
  const Resources = module.ConsumerPreviewResources;
  const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document;
  const bytes = new Uint8Array(24); bytes[0] = 137; bytes[1] = 80;
  const header = new DataView(bytes.buffer); header.setUint32(16, 800); header.setUint32(20, 1200);
  let decoded = 0;
  globalThis.createImageBitmap = (async (_blob: Blob, options: ImageBitmapOptions) => {
    decoded++; assert.equal(options.resizeWidth, 800); assert.equal(options.resizeHeight, 1200);
    return {width: 800, height: 1200, close() {}};
  }) as any;
  globalThis.document = {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage() {}}), toBlob: (done: (blob: Blob) => void) => done(new Blob([bytes]))})} as any;
  const resources = new Resources();
  try {
    const photo: LocalPhoto = {id: "saved:receipt", filename: "receipt.png", date: "2026-10-01", dateSource: "selected", previewLoader: async () => new Blob([bytes])};
    const raster = await resources.load(photo, "preview");
    assert.equal(raster.width, 800); assert.equal(raster.height, 1200); assert.equal(decoded, 1);
    let release!: (blob: Blob) => void;
    const late = resources.load({...photo, id: "saved:late", width: 800, height: 1200, previewLoader: () => new Promise<Blob>(resolve => {release = resolve;})}, "preview");
    await new Promise(resolve => setTimeout(resolve, 0)); resources.clear(); release(new Blob([bytes]));
    await assert.rejects(late, /cleared/); assert.equal(decoded, 1);
  } finally {resources.clear(); globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument;}
});
test("system share receives the exact original immediately, cancellation stays silent", async () => {
  const {shareOriginal} = await import("../src/library/system-share");
  const file = new File(["byte-identical original"], "receipt.png", {type: "image/png"});
  let called = false;
  const operation = shareOriginal(file, () => true, {canShare: () => true, share: async data => {
    called = true; assert.equal(data.files![0], file); throw new DOMException("cancel", "AbortError");
  }, download: () => assert.fail("Cancel must never trigger download")});
  assert.equal(called, true, "Web Share must run before losing the click's user activation");
  assert.equal(await operation, "cancelled");
});
test("unsupported sharing downloads the original and a revoked source does neither", async () => {
  const {shareOriginal} = await import("../src/library/system-share");
  const file = new File(["original"], "photo.png");
  let downloads = 0;
  const environment = {canShare: () => false, share: async () => assert.fail("unsupported"), download: (original: File) => {assert.equal(original, file); downloads++;}};
  assert.equal(await shareOriginal(file, () => true, environment), "downloaded");
  assert.equal(downloads, 1);
  await assert.rejects(shareOriginal(file, () => false, environment), /SOURCE_UNAVAILABLE/);
  assert.equal(downloads, 1);
});

async function open(accountId: string) {
  await ready;
  const secret = accounts.testSecrets[0];
  configureVault({version: 1, accountCard: {...accounts.accounts[0], accountId}, wrappers: [{version: 1, wrapperId: crypto.randomUUID(), kind: "recovery", credentialId: null, prfSalt: null, verified: true, wrappedBundle: secret.encryptedBundle}]} as any);
  return unlockVault({kind: "recovery", secret: unb64(secret.recoverySecret)});
}
test("browser Pause survives vault restoration, stays encrypted and does not affect another account", async () => {
  const {loadUploadPause, saveUploadPause} = await import("../src/library/consumer-preferences");
  const owner = "11111111-1111-4111-8111-111111111110", other = "22222222-2222-4222-8222-222222222220";
  try {
    const session = await open(owner);
    assert.equal(await loadUploadPause(session), false, "Manual imports work before opting into backup");
    await saveUploadPause(true, session);
    const record = await get("settings", owner + ":consumer-upload-pause");
    assert.equal(typeof record, "object"); assert.doesNotMatch(JSON.stringify(record), /paused/);
    lockVault(); const restored = await open(owner);
    assert.equal(await loadUploadPause(restored), true);
    await saveUploadPause(false, restored); assert.equal(await loadUploadPause(restored), false);
    await saveUploadPause(true, restored);
    lockVault(); const second = await open(other); assert.equal(await loadUploadPause(second), false);
    await assert.rejects(saveUploadPause(false, restored), /VAULT_LOCKED/);
  } finally {await clearAccount(owner); await clearAccount(other); lockVault();}
});
