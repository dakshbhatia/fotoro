import test from "node:test";
import assert from "node:assert/strict";
import {analyzePixels, recommendPhotos, PickAnalyzer, type PhotoSignals} from "../src/local/auto-picks";
import type {LocalPhoto} from "../src/local/resources";

const photo = (id: string, date?: string): LocalPhoto => ({id, filename: id + ".png", date: date ?? "2026-10-02", dateSource: date ? "exif" : "selected", captureVerified: date ? true : undefined, width: 1200, height: 800});
const signal = (hash: bigint, sharpness = .12): PhotoSignals => ({hash, sharpness, luminance: .5, contrast: .15, color: [120, 120, 120]});

test("Picks never reads withdrawn sources and a withdrawn measured winner cannot suppress its runner-up", async () => {
  let allowed = true, release!: (value: PhotoSignals) => void;
  const best = {...photo("best"),file:new File(['best'],'best.png'),current:()=>allowed};
  const runner = {...photo("runner"),file:new File(['runner'],'runner.png')};
  const denied = {...photo("denied"),file:new File(['denied'],'denied.png'),current:()=>false};
  const analyzer = new PickAnalyzer(), reads:string[] = [];
  const pending = analyzer.run([best,runner,denied], async value => {
    reads.push(value.id); return value.id === 'runner' ? new Promise(resolve => {release = resolve;}) : signal(0n,.4);
  });
  while(!release) await new Promise(resolve => setTimeout(resolve,0));
  allowed = false; release(signal(0n,.1));
  const result = await pending;
  assert.deepEqual([...result!.ids],['runner']); assert.equal(result!.unassessed,0);
  assert.deepEqual(reads,['best','runner']);
});

test("source withdrawal during batched ranking reselects permitted photos and retires the withdrawn cache", async () => {
  let allowed = true, yields = 0, reads = 0;
  const photos = Array.from({length:128},(_,index)=>({...photo(String(index)),file:new File([String(index)],index+'.png'),favorite:index===0,current:()=>index!==0||allowed}));
  const analyzer = new PickAnalyzer(async()=>{if(++yields===3) allowed=false;});
  const load = async()=>{reads++;return signal(0n);};
  const result = await analyzer.run(photos,load);
  assert.deepEqual([...result!.ids],['1']); assert.equal(result!.groupCount,127); assert.equal(result!.unassessed,0);
  allowed=true;
  const restored = await analyzer.run(photos,load);
  assert.deepEqual([...restored!.ids],['0']); assert.equal(reads,129,'Withdrawn private measurements cannot remain cached across re-grant');
});

test("recommendations keep distinct strong highlights without filling a fixed quota", () => {
  const photos = Array.from({length: 20}, (_, i) => photo(String(i)));
  const signals = new Map(photos.map((p, i) => [p.id, signal(BigInt(i), i === 5 ? .5 : i === 12 ? .4 : .01)]));
  signals.set("12", {...signals.get("12")!, color: [230, 20, 50]});
  const result = recommendPhotos(photos, signals);
  assert.deepEqual([...result.ids], ["5", "12"]);
  assert.equal(result.groupCount, 20); assert.equal(photos.length, 20);
  assert.equal(recommendPhotos([photos[0]], signals).ids.size, 1);
  assert.equal(recommendPhotos([], signals).ids.size, 0);
});

test("each capture moment keeps its highlight instead of a global percentage", () => {
  const photos = Array.from({length: 10}, (_, index) => photo(String(index), new Date(Date.UTC(2026, 9, 1) + index * 3 * 3600000).toISOString()));
  const result = recommendPhotos(photos, new Map(photos.map(p => [p.id, signal(0n)])));
  assert.equal(result.ids.size, 10);
  assert.equal(photos.length, 10);
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
  assert.deepEqual([...result.ids],["19"]);
});

test("favorites do not crowd distinct strong moment highlights out of the suggestion budget", () => {
  const photos = [
    {...photo("favorite-a", "2026-10-01T12:00:00Z"), favorite: true},
    {...photo("favorite-b", "2026-10-01T12:01:00Z"), favorite: true},
    photo("clear", "2026-10-01T12:02:00Z"),
    photo("soft", "2026-10-01T12:03:00Z"),
  ];
  const signals = new Map([
    ["favorite-a", {...signal(0n), color: [30, 60, 90] as [number, number, number]}],
    ["favorite-b", {...signal(0n), color: [90, 60, 30] as [number, number, number]}],
    ["clear", {...signal(0n, .4), color: [230, 20, 50] as [number, number, number]}],
    ["soft", signal(0n, .01)],
  ]);
  const result = recommendPhotos(photos, signals);
  assert.deepEqual([...result.ids], ["favorite-a", "favorite-b", "clear"]);
  assert.equal(result.groupCount, 4);
  assert.equal(result.duplicateCount, 0);
  assert.equal(photos.length, 4);
});

test("a dense capture burst has bounded comparison work instead of an all-pairs scan", () => {
  let reads=0;
  const photos=Array.from({length:1500},(_,i)=>photo(String(i),"2026-10-01T12:00:00Z"));
  const signals=new Map(photos.map((p,i)=>[p.id,{...signal(0n),get hash(){reads++;return BigInt(i)*0x9e3779b97f4a7c15n&((1n<<64n)-1n);}}]));
  const result=recommendPhotos(photos,signals);
  assert.ok(result.groupCount>=1200); assert.equal(result.ids.size,6);
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


test("cancelling a metadata review retains completed measurements and applies the newest favorites", async () => {
  const analyzer = new PickAnalyzer();
  const photos = Array.from({length: 20}, (_, i) => ({...photo(String(i)), file: new File([String(i)], i + ".png")}));
  let reads = 0;
  const load = async () => {reads++; return signal(0n);};
  assert.deepEqual([...(await analyzer.run(photos, load))!.ids], ["0"]);
  analyzer.cancel();
  const updated = photos.map(value => ({...value, favorite: value.id === "19", labels: ["trip"], caption: "updated"}));
  assert.deepEqual([...(await analyzer.run(updated, load))!.ids], ["19"]);
  assert.equal(reads, 20);
  analyzer.clear();
  await analyzer.run(updated, load);
  assert.equal(reads, 40, "Clear must fully invalidate completed measurements");
});

test("cancelled pending measurements neither populate nor erase the replacement cache", async () => {
  const analyzer = new PickAnalyzer(), source = {...photo("same"), file: new File(["same"], "same.png")};
  let release!: (value: PhotoSignals) => void, reads = 0;
  const old = analyzer.run([source], () => {reads++; return new Promise(resolve => {release = resolve;});});
  analyzer.cancel();
  const replacement = await analyzer.run([{...source, favorite: true}], async () => {reads++; return signal(0n, .4);});
  release(signal(0n, .01));
  assert.equal(await old, undefined);
  assert.deepEqual([...replacement!.ids], ["same"]);
  await analyzer.run([source], async () => {reads++; return signal(0n);});
  assert.equal(reads, 2, "The old completion must not overwrite or discard the newer completed cache");
});

test("a failed or invalid preview is retried by the next review without looping in the current review", async () => {
  for (const failure of ["decode", "invalid"]) {
    const analyzer = new PickAnalyzer(), source = {...photo(failure), previewLoader: async () => new Blob(["preview"])};
    let reads = 0;
    const load = async () => {
      reads++;
      if (reads === 1) {
        if (failure === "decode") throw new Error("Temporary preview failure");
        return {...signal(0n), sharpness: NaN};
      }
      return signal(0n);
    };
    const missing = await analyzer.run([source, source], load);
    assert.equal(missing!.unassessed, 1); assert.equal(missing!.ids.size, 0); assert.equal(reads, 1);
    assert.equal((await analyzer.run([source], load))!.ids.has(source.id), true);
    await analyzer.run([source], load); assert.equal(reads, 2);
  }
});

test("measurement dimensions and preview availability invalidate same-source cached pixels", async () => {
  const analyzer = new PickAnalyzer(), source = {...photo("same"), file: new File(["same"], "same.png")};
  let reads = 0;
  const load = async () => {reads++; return signal(0n);};
  await analyzer.run([source], load);
  await analyzer.run([{...source, width: 800, height: 1200}], load); assert.equal(reads, 2);
  const unavailable = await analyzer.run([{...source, width: 800, height: 1200, previewAvailable: false}], load);
  assert.equal(unavailable!.unassessed, 1); assert.equal(reads, 2);
  await analyzer.run([{...source, width: 800, height: 1200, previewAvailable: true}], load); assert.equal(reads, 3);
});

test("batched review keeps exact ranking, grouping, reasons and quota while letting browser tasks run", async () => {
  const analyzer = new PickAnalyzer();
  const photos = Array.from({length: 300}, (_, i) => ({...photo(String(i), `2026-10-0${1 + i % 2}T12:${String(Math.floor(i / 2) % 60).padStart(2, "0")}:00Z`),
    file: new File([String(i)], i + ".png"), favorite: i === 249}));
  const measurements = new Map(photos.map((value, i) => [value.id, signal(BigInt(i), (i % 7 + 1) / 30)]));
  const expected = recommendPhotos(photos, measurements);
  let reads = 0, heartbeat = false;
  const load = async (value: LocalPhoto) => {reads++; return measurements.get(value.id)!;};
  assert.deepEqual(await analyzer.run(photos, load), expected);
  setTimeout(() => {heartbeat = true;}, 0);
  assert.deepEqual(await analyzer.run(photos.map(value => ({...value, caption: "updated"})), load), expected);
  assert.equal(reads, 300); assert.equal(heartbeat, true, "A cached review must yield to tasks, not only microtasks");
});

test("cancellation during a ranking batch prevents publication and leaves completed measurements reusable", async () => {
  let yields = 0, reads = 0;
  const analyzer = new PickAnalyzer(async () => {if (++yields === 2) analyzer.cancel();});
  const photos = Array.from({length: 128}, (_, i) => ({...photo(String(i)), file: new File([String(i)], i + ".png")}));
  const measurements = new Map(photos.map(value => [value.id, signal(0n)]));
  const load = async (value: LocalPhoto) => {reads++; return measurements.get(value.id)!;};
  assert.equal(await analyzer.run(photos, load), undefined);
  assert.equal(yields, 2, "Cancellation reaches a ranking checkpoint after the loading batch");
  assert.deepEqual(await analyzer.run(photos, load), recommendPhotos(photos, measurements));
  assert.equal(reads, 128);
});
