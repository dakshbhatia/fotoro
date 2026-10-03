import test from "node:test";
import assert from "node:assert/strict";
import {analyzePixels, recommendPhotos, PickAnalyzer, type PhotoSignals} from "../src/local/auto-picks";
import type {LocalPhoto} from "../src/local/resources";

const photo = (id: string, date?: string): LocalPhoto => ({id, filename: id + ".png", date: date ?? "2026-10-02", dateSource: date ? "exif" : "selected", captureVerified: date ? true : undefined, width: 1200, height: 800});
const signal = (hash: bigint, sharpness = .12): PhotoSignals => ({hash, sharpness, luminance: .5, contrast: .15, color: [120, 120, 120]});

test("recommendations target ten percent of unique groups and leave source photos intact", () => {
  const photos = Array.from({length: 20}, (_, i) => photo(String(i)));
  const signals = new Map(photos.map((p, i) => [p.id, signal(BigInt(i), i === 5 ? .5 : i === 12 ? .4 : .01)]));
  const result = recommendPhotos(photos, signals);
  assert.deepEqual([...result.ids], ["5", "12"]);
  assert.equal(result.groupCount, 20); assert.equal(photos.length, 20);
  assert.equal(recommendPhotos([photos[0]], signals).ids.size, 1);
  assert.equal(recommendPhotos([], signals).ids.size, 0);
});

test("a burst keeps its clearer representative without chaining across capture times", () => {
  const photos = [photo("soft", "2026-10-01T12:00:00Z"), photo("clear", "2026-10-01T12:00:20Z"), photo("later", "2026-10-01T12:00:40Z")];
  const result = recommendPhotos(photos, new Map([["soft", signal(3n, .01)], ["clear", signal(3n, .4)], ["later", signal(3n, .1)]]));
  assert.equal(result.groupCount, 2); assert.equal(result.duplicateCount, 1);
  assert.deepEqual([...result.ids], ["clear"]);
  assert.match(result.reasons.get("clear")!.join(" "), /similar/i);
});

test("unknown capture times and different colors cannot falsely suppress similar-looking photos", () => {
  const unknown = [photo("receipt-a"), photo("receipt-b")];
  assert.equal(recommendPhotos(unknown, new Map(unknown.map(p => [p.id, signal(0n)]))).groupCount, 2);
  const timed = [photo("a", "2026-10-01T12:00:00Z"), photo("b", "2026-10-01T12:00:01Z")];
  assert.equal(recommendPhotos(timed, new Map([["a", signal(0n)], ["b", {...signal(0n), color: [240, 10, 20]}]])).groupCount, 2);
});

test("verified capture-date variety stops one busy day from taking every suggestion", () => {
  const photos = Array.from({length: 19}, (_, i) => photo("a" + i, `2026-10-01T12:${String(i * 2).padStart(2, "0")}:00Z`));
  photos.push(photo("another-day", "2026-09-01T12:00:00Z"));
  const result = recommendPhotos(photos, new Map(photos.map(p => [p.id, signal(0n, p.id === "another-day" ? .1 : .2)])));
  assert.equal(result.ids.size, 2); assert.ok(result.ids.has("another-day"));
});

test("blank or unassessed images do not fill the quota; a document remains eligible", () => {
  const photos = [photo("blank"), photo("receipt"), photo("unavailable")];
  const result = recommendPhotos(photos, new Map([["blank", {...signal(0n, 0), luminance: 1, contrast: 0}], ["receipt", signal(5n)]]));
  assert.deepEqual([...result.ids], ["receipt"]); assert.equal(result.unassessed, 1);
  assert.equal(photos.length, 3);
});

test("pixel measurements distinguish a flat white preview from a detailed image", () => {
  const pixels = (detailed: boolean) => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let y=0;y<16;y++) for (let x=0;x<16;x++) {
      const value = detailed ? ((x+y)%2 ? 60 : 190) : 255;
      const offset=(y*16+x)*4; data.set([value,value,value,255],offset);
    }
    return analyzePixels({width:16,height:16,data});
  };
  const flat=pixels(false), detailed=pixels(true);
  assert.equal(flat.contrast,0); assert.equal(flat.sharpness,0);
  assert.ok(detailed.contrast > .2); assert.ok(detailed.sharpness > flat.sharpness);
  assert.equal(recommendPhotos([photo("flat"),photo("detail")],new Map([["flat",flat],["detail",detailed]])).ids.has("detail"),true);
});

test("uniform colored previews are excluded from Picks while every original remains available", () => {
  const colors: [number, number, number][] = [[0,0,0], [255,255,255], [128,128,128], [255,0,0], [0,255,0], [0,0,255]];
  const photos = colors.map((_, index) => photo(String(index)));
  const signals = new Map(photos.map((value, index) => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([...colors[index],255],offset);
    return [value.id, analyzePixels({width:16,height:16,data})];
  }));
  assert.equal(recommendPhotos(photos,signals).ids.size,0);
  assert.equal(photos.length,6);
  assert.equal(recommendPhotos([photo("detail")],new Map([["detail",signal(1n)]])).ids.size,1);
});

test("analysis reuses the same source and fences a late result after Clear", async () => {
  const analyzer = new PickAnalyzer();
  const a = {...photo("a"),file:new File(["a"],"a.png")};
  let reads=0;
  const load=async()=>{reads++;return signal(0n);};
  assert.equal((await analyzer.run([a],load))?.ids.has("a"),true);
  await analyzer.run([{...a,labels:["Ronald"]}],load); assert.equal(reads,1);
  let release!:(value:PhotoSignals)=>void;
  const pending=analyzer.run([{...a,file:new File(["a"],"a.png")}],()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve(); analyzer.clear(); release(signal(0n));
  assert.equal(await pending,undefined);
});

test("explicit favorites stay eligible even when a different photo is sharper", () => {
  const photos=Array.from({length:20},(_,i)=>({...photo(String(i)),favorite:i===19}));
  const result=recommendPhotos(photos,new Map(photos.map(p=>[p.id,signal(0n,p.favorite ? .01 : .3)])));
  assert.deepEqual([...result.ids],["19","0"]);
});

test("a dense capture burst has bounded comparison work instead of an all-pairs scan", () => {
  let reads=0;
  const photos=Array.from({length:1500},(_,i)=>photo(String(i),"2026-10-01T12:00:00Z"));
  const signals=new Map(photos.map((p,i)=>[p.id,{...signal(0n),get hash(){reads++;return BigInt(i)*0x9e3779b97f4a7c15n&((1n<<64n)-1n);}}]));
  const result=recommendPhotos(photos,signals);
  assert.ok(result.groupCount>=1200); assert.ok(result.ids.size>=120);
  assert.ok(reads<160000,`${reads} descriptor reads exceed the bounded budget`);
});

test("a newer library snapshot wins over an older analysis completing late", async () => {
  const analyzer=new PickAnalyzer();
  let release!:(value:PhotoSignals)=>void;
  const old=analyzer.run([{...photo("old"),file:new File(["old"],"old.png")}],()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();
  const current=await analyzer.run([{...photo("current"),file:new File(["current"],"current.png")}],async()=>signal(0n));
  release(signal(0n));
  assert.deepEqual([...current!.ids],["current"]); assert.equal(await old,undefined);
});
