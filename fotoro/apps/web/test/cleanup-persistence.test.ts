import "fake-indexeddb/auto";
import {isPhotoTrashed, withPhotoOrganization} from "@fotoro/contracts/organization";
import test from "node:test";
import assert from "node:assert/strict";
import accounts from "../../../fixtures/accounts.json";
import {ready, unb64} from "@fotoro/crypto";
import {configureVault, unlockVault, lockVault} from "../src/vault/vault";
import {get, all, clearAccount} from "../src/exchange/cache";
import {savedSearchPhotos, type OwnedPhotoSnapshot} from "../src/library/consumer-search";
import type {Photo} from "../src/library/catalog";
import type {LocalPhoto} from "../src/local/resources";
import {CleanupAnalyzer, type PhotoSignals} from "../src/local/auto-picks";
import {LocalRetention} from "../src/local/retention";
import {emptyFeedback} from "../src/local/search";
import {CleanupReviewPersistence} from "../src/local/cleanup-persistence";
import {cleanupSourceIdentityCurrent} from "../src/local/cleanup-review";
import {clearSemanticInference} from "../src/local/semantic-persistence";

const measured: PhotoSignals = {hash: 2n, luminance: .5, contrast: .2, sharpness: .001, color: [120,120,120]};
const photo = (id: string): LocalPhoto => ({id, digest: "digest-" + id, filename: "private-" + id + ".jpg", date: "2026-10-03", dateSource: "exif", width: 100, height: 100, preview: new Blob(["private-preview"]), labels: []});
const retention = () => new LocalRetention({name: "cleanup-test-" + crypto.randomUUID()});

test("encrypted local cleanup checkpoint resumes exact ordered scope and results across restart without re-decoding", async () => {
  const local = retention(), photos = Array.from({length: 205}, (_, i) => photo(String(i)));
  await local.save(photos, emptyFeedback());
  const store = new CleanupReviewPersistence(local, () => true, () => "https://fotoro.test"), analyzer = new CleanupAnalyzer();
  let reads = 0;
  await analyzer.run(photos.slice(0,200), async value => {reads++; if (value.id === "1") throw new Error("Unavailable"); return measured;}, () => {});
  assert.equal(await store.write(photos, 200, analyzer.signals(photos.slice(0,200)), () => true), true);
  await local.save(photos.map(value => ({...value, labels: ["new tag"]})), emptyFeedback());
  analyzer.clear();
  const reopened = new LocalRetention({name: local.name}), loaded = await reopened.load();
  const restored = await new CleanupReviewPersistence(reopened, () => true, () => "https://fotoro.test").read(loaded.photos, () => true);
  assert.equal(restored?.completed, 200); assert.deepEqual(restored?.photos.map(value => value.id), photos.map(value => value.id));
  const next = new CleanupAnalyzer(); next.restore(restored!.photos, restored!.signals);
  assert.equal(next.review(restored!.photos.slice(0,200)).unassessed, 1);
  assert.match(next.review(restored!.photos.slice(0,200)).reasons.get("0")!.join(" "), /blurry/);
  await next.run(restored!.photos.slice(200), async () => {reads++; return measured;}, () => {});
  assert.equal(reads, 205, "Completed or failed previews before the cursor must not be decoded again");
  const database = await new Promise<IDBDatabase>((resolve, reject) => {const request = indexedDB.open(local.name); request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);});
  const raw = await new Promise<any>(resolve => {const request=database.transaction("data").objectStore("data").get("cleanup-review");request.onsuccess=()=>resolve(request.result);});
  assert.ok(raw.iv instanceof Uint8Array); assert.ok(raw.data instanceof ArrayBuffer); assert.ok(!JSON.stringify(raw).includes("private-")); database.close();
  await local.clear();
  assert.equal(await store.read(photos, () => true), undefined, "Clearing retained metadata must also remove resumable cleanup");
});

test("scope, digest, dimensions, origin, opt-out and withdrawal invalidate durable cleanup", async () => {
  const local = retention(), a = photo("a"), b = photo("b"), photos = [a,b];
  await local.save(photos, emptyFeedback());
  let enabled = true;
  const store = new CleanupReviewPersistence(local, () => enabled, () => "https://one.test");
  await store.write(photos, 1, new Map([[a.id, measured]]), () => true);
  const clone = () => photos.map(value => ({...value, preview: new Blob(["new-preview"])}));
  assert.equal((await store.read(clone(), () => true))?.completed, 1);
  for (const changed of [[clone()[0]], [clone()[0], {...clone()[1], digest: "changed"}], [clone()[0], {...clone()[1], width: 200}], [clone()[0], {...clone()[1], current: () => false}]])
    assert.equal(await store.read(changed, () => true), undefined);
  assert.equal(await new CleanupReviewPersistence(local, () => true, () => "https://two.test").read(clone(), () => true), undefined);
  enabled = false; assert.equal(await store.read(clone(), () => true), undefined);
  assert.equal(await store.write(clone(), 1, new Map([[a.id, measured]]), () => true), false);
  enabled = true; assert.equal(await store.read(clone(), () => false), undefined);
  await local.clear();
});

test("no Remember consent creates no persistent cleanup row and only exact session sources can resume", async () => {
  const local = retention(), photos = [photo("memory")], store = new CleanupReviewPersistence(local, () => false);
  assert.equal(await store.write(photos, 1, new Map([[photos[0].id, measured]]), () => true), false);
  assert.equal((await new CleanupReviewPersistence(local, () => false).read(photos, () => true))?.completed, 1);
  assert.equal(await store.read([{...photos[0], preview: new Blob(["replacement"])}], () => true), undefined);
  assert.equal((await local.load()).enabled, false);
  await clearSemanticInference();
  assert.equal(await store.read(photos, () => true), undefined, "Existing clear action invalidates session checkpoints too");
  await local.clear();
});

async function open(index: number) {
  const account = accounts.accounts[index], secret = accounts.testSecrets[index];
  configureVault({version:1, accountCard:account,wrappers:[{version:1,wrapperId:crypto.randomUUID(),kind:"recovery",credentialId:null,prfSalt:null,verified:true,wrappedBundle:secret.encryptedBundle}]} as any);
  return unlockVault({kind:"recovery",secret:unb64(secret.recoverySecret)});
}
test("Saved cleanup is vault encrypted and bound to account, origin, manifest and source consent", async () => {
  await ready;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
  const owner=accounts.accounts[0].accountId, other=accounts.accounts[1].accountId;
  try {
    lockVault(); await clearAccount(owner); await clearAccount(other); const session=await open(0);
    let available=true;
    const original={manifest:{version:1,photoId:crypto.randomUUID(),ownerAccountId:owner,representations:[]},metadata:{filename:"private-saved.jpg",originalSha256:"A".repeat(43),sourceDate:"2026-10-03",dateSource:"exif",width:100,height:100}} as unknown as Photo;
    const snapshot:OwnedPhotoSnapshot={accountId:owner,token:session,photos:[original],current:()=>available,preview:async()=>new Blob()};
    const photos=savedSearchPhotos(snapshot,[]), store=new CleanupReviewPersistence(retention(),()=>false,()=>"https://one.test");
    assert.equal(await store.write(photos,1,new Map([[photos[0].id,measured]]),()=>true),true);
    const raw=await get<any>("settings",`${owner}:cleanup:review-v1`);
    assert.equal(typeof raw.ciphertext,"string"); assert.ok(!JSON.stringify(raw).includes(photos[0].id)); assert.ok(!JSON.stringify(raw).includes("signals"));
    assert.equal((await store.read(savedSearchPhotos(snapshot,[]),()=>true))?.completed,1);
    available=false; assert.equal(await store.read(photos,()=>true),undefined); available=true;
    original.manifest.representations.push({binding:{kind:"preview"}} as any);
    assert.equal(await store.read(savedSearchPhotos(snapshot,[]),()=>true),undefined);
    original.manifest.representations=[];
    lockVault(); assert.equal(await store.read(photos,()=>true),undefined);
    await open(1); assert.equal(await store.read(photos,()=>true),undefined);
    assert.equal((await all("settings",other+":cleanup:")).length,0);
    snapshot.token=await open(0);
    await clearSemanticInference(); assert.equal((await all("settings",owner+":cleanup:")).length,0);
    assert.equal(await store.read(savedSearchPhotos(snapshot,[]),()=>true),undefined);
  } finally {lockVault();await clearAccount(owner);await clearAccount(other);if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");}
});

test("clear during delayed checkpoint encryption cannot revive progress in a newly retained same scope", async () => {
  const local = retention(), photos = [photo("clear-race")]; await local.save(photos, emptyFeedback());
  const store = new CleanupReviewPersistence(local, () => true), original = crypto.subtle.encrypt;
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(resolve => {began=resolve;}), gate = new Promise<void>(resolve => {release=resolve;});
  crypto.subtle.encrypt = (async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
    const value = await original.apply(crypto.subtle,args);
    if(new TextDecoder().decode((args[0] as AesGcmParams).additionalData)==="cleanup-review") {began();await gate;}
    return value;
  }) as SubtleCrypto["encrypt"];
  try {
    const writing=store.write(photos,1,new Map([[photos[0].id,measured]]),()=>true);await started;
    await new LocalRetention({name:local.name}).clear();await local.save(photos,emptyFeedback());
    release();assert.equal(await writing,false);
    const loaded=await new LocalRetention({name:local.name}).load();
    assert.equal(await store.read(loaded.photos,()=>true),undefined);
  } finally {release();crypto.subtle.encrypt=original;await local.clear();}
});

test("cancellation and Remember revocation during checkpoint encryption prevent a durable commit", async () => {
  const local = retention(), photos = [photo("cancel-race")]; await local.save(photos, emptyFeedback());
  let enabled=true, active=true;
  const store=new CleanupReviewPersistence(local,()=>enabled), original=crypto.subtle.encrypt;
  let release!:()=>void,began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;});
  crypto.subtle.encrypt=(async(...args:Parameters<SubtleCrypto["encrypt"]>)=>{
    const value=await original.apply(crypto.subtle,args);
    if(new TextDecoder().decode((args[0] as AesGcmParams).additionalData)==="cleanup-review"){began();await gate;}
    return value;
  }) as SubtleCrypto["encrypt"];
  try {
    const writing=store.write(photos,1,new Map([[photos[0].id,measured]]),()=>active);await started;
    enabled=false;active=false;release();assert.equal(await writing,false);
    enabled=true;active=true;
    assert.equal(await store.read((await local.load()).photos,()=>true),undefined);
  } finally {release();crypto.subtle.encrypt=original;await local.clear();}
});


test("Trash of a reviewed original preserves unchanged remaining progress without treating missing or revised photos as covered", async () => {
  const local=retention(), photos=[photo("reviewed-trash"),photo("reviewed-keep"),photo("not-yet-checked")];
  await local.save(photos,emptyFeedback());
  const store=new CleanupReviewPersistence(local,()=>true,()=>"https://one.test");
  await store.write(photos,2,new Map(photos.slice(0,2).map(value=>[value.id,measured])),()=>true);
  const updated=photos.map((value,index)=>({...withPhotoOrganization(value,index===0?{trash:true}:{}),preview:new Blob(["reopened"])}));
  const remaining=updated.slice(1), retired=[updated[0]];
  const restored=await store.read(remaining,()=>true,retired);
  assert.equal(restored?.completed,1);
  assert.deepEqual(restored?.photos.map(value=>value.id),remaining.map(value=>value.id));
  assert.deepEqual([...restored!.signals.keys()],[photos[1].id]);
  assert.equal(await store.read(remaining,()=>true),undefined,"Missing source alone is not proof that the user trashed it");
  assert.equal(await store.read(remaining,()=>true,[{...retired[0],digest:"replaced"}]),undefined);
  assert.equal(await store.read([...remaining,photo("new-scope")],()=>true,retired),undefined);
  assert.equal(await new CleanupReviewPersistence(local,()=>true,()=>"https://other.test").read(remaining,()=>true,retired),undefined);
  await local.clear();
});


test("explicit Pause checkpoint supersedes an in-flight older cursor and retains non-periodic progress", async () => {
  const local=retention(), photos=Array.from({length:50},(_,index)=>photo("pause-"+index));
  await local.save(photos,emptyFeedback());
  const store=new CleanupReviewPersistence(local,()=>true), original=crypto.subtle.encrypt;
  let epoch=1, release!:()=>void, began!:()=>void, delayed=false;
  const started=new Promise<void>(resolve=>{began=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  crypto.subtle.encrypt=(async(...args:Parameters<SubtleCrypto["encrypt"]>)=>{
    const value=await original.apply(crypto.subtle,args);
    if(!delayed&&new TextDecoder().decode((args[0] as AesGcmParams).additionalData)==="cleanup-review") {delayed=true;began();await gate;}
    return value;
  }) as SubtleCrypto["encrypt"];
  try {
    const old=store.write(photos,32,new Map(photos.slice(0,32).map(value=>[value.id,measured])),()=>epoch===1);
    await started; epoch=2;
    const paused=store.write(photos,40,new Map(photos.slice(0,40).map(value=>[value.id,measured])),()=>epoch===2);
    release();assert.equal(await old,false);assert.equal(await paused,true);
    const restored=await store.read((await local.load()).photos,()=>true);
    assert.equal(restored?.completed,40);assert.equal(restored?.signals.size,40);
  } finally {release();crypto.subtle.encrypt=original;await local.clear();}
});

test("Saved Trash resume keeps only verified remaining sources across annotation refreshes", async () => {
  await ready;const oldWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:new EventTarget()});
  const owner=accounts.accounts[0].accountId;
  try {
    lockVault();await clearAccount(owner);const session=await open(0);
    const originals=Array.from({length:3},(_,index)=>({manifest:{version:1,photoId:crypto.randomUUID(),ownerAccountId:owner,representations:[]},metadata:{filename:"private-"+index+".jpg",originalSha256:String(index).repeat(43),sourceDate:"2026-10-03",dateSource:"exif",width:100,height:100}} as unknown as Photo));
    const snapshot:OwnedPhotoSnapshot={accountId:owner,token:session,photos:originals,current:()=>true,preview:async()=>new Blob()};
    const photos=savedSearchPhotos(snapshot,[]),store=new CleanupReviewPersistence(retention(),()=>false,()=>"https://one.test");
    await store.write(photos,2,new Map(photos.slice(0,2).map(value=>[value.id,measured])),()=>true);
    originals[0].annotations={version:1,photoId:originals[0].manifest.photoId,originalSha256:originals[0].metadata.originalSha256,facts:withPhotoOrganization({}, {trash:true}).facts} as any;
    const updated=savedSearchPhotos(snapshot,[]);
    assert.equal(cleanupSourceIdentityCurrent(photos[1],updated[1]),true,"Annotation refresh keeps the same verified original revision");
    const restored=await store.read(updated.filter(value=>!isPhotoTrashed(value)),()=>true,updated.filter(isPhotoTrashed));
    assert.equal(restored?.completed,1);assert.deepEqual([...restored!.signals.keys()],[updated[1].id]);
    originals[0].manifest.representations.push({binding:{kind:"preview"}} as any);
    const revised=savedSearchPhotos(snapshot,[]);
    assert.equal(await store.read(revised.filter(value=>!isPhotoTrashed(value)),()=>true,revised.filter(isPhotoTrashed)),undefined);
  } finally {lockVault();await clearAccount(owner);if(oldWindow)Object.defineProperty(globalThis,"window",oldWindow);else Reflect.deleteProperty(globalThis,"window");}
});
