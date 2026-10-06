import test from "node:test";
import assert from "node:assert/strict";
import {
  localFormat,
  localPhoto,
  imageDimensions,
  inLast30Days,
  LocalResources,
  LOCAL_RASTER_BUDGET,
} from "../src/local/resources";
const png = () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 4000);
  view.setUint32(20, 3000);
  return bytes;
};
test("local trial retains exact source File and explicitly marks unknown capture date", async () => {
  const file = new File([png()], "photo.png", { type: "image/png" });
  const photo = await localPhoto(file);
  assert.equal(photo.file, file);
  assert.equal(photo.dateSource, "selected");
  assert.equal(photo.width, 4000);
  assert.equal(photo.height, 3000);
  assert.deepEqual(new Uint8Array(await photo.file.arrayBuffer()), png());
});
test("last30 filter preserves unknown capture dates and does not change selected sources", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  assert.equal(
    inLast30Days({ date: "2020-01-01T00:00:00Z", dateSource: "selected" }, now),
    true,
  );
  assert.equal(
    inLast30Days({ date: "2020-01-01T00:00:00Z", dateSource: "exif" }, now),
    false,
  );
  assert.equal(
    inLast30Days({ date: "2026-09-20T00:00:00Z", dateSource: "exif" }, now),
    true,
  );
});
test("local trial rejects unsupported/oversize/mislabeled sources with readable errors", async () => {
  assert.throws(
    () => localFormat({ name: "clip.mov", type: "video/quicktime", size: 123 }),
    /JPEG, PNG, or HEIC/,
  );
  assert.throws(
    () =>
      localFormat({
        name: "big.png",
        type: "image/png",
        size: 50 * 1024 * 1024 + 1,
      }),
    /50 MB/,
  );
  assert.equal(
    localFormat({ name: "photo.HEIC", type: "", size: 100 }),
    "heic",
  );
  await assert.rejects(
    localPhoto(new File(["not jpeg"], "photo.jpg", { type: "image/jpeg" })),
    /JPEG could not be read/,
  );
});
test("bounded image header read recognizes dimensions and rejects unsafe pixel counts", async () => {
  assert.deepEqual(imageDimensions(png()), { width: 4000, height: 3000 });
  const bytes = png(),
    view = new DataView(bytes.buffer);
  view.setUint32(16, 40000);
  view.setUint32(20, 40000);
  await assert.rejects(
    localPhoto(new File([bytes], "giant.png", { type: "image/png" })),
    /too large to open safely/,
  );
});
test("raster queue is sequential, bounded, and clears/revokes session resources", async () => {
  const oldBitmap = globalThis.createImageBitmap,
    oldDocument = globalThis.document,
    oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  let active = 0,
    peak = 0,
    closed = 0;
  const revoked: string[] = [];
  let serial = 0;
  globalThis.createImageBitmap = (async (_file: any, options: any) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 1));
    active--;
    return {
      width: options?.resizeWidth ?? 1600,
      height: options?.resizeHeight ?? 1600,
      close() {
        closed++;
      },
    };
  }) as any;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(callback: any) {
          callback(new Blob(["preview"], { type: "image/jpeg" }));
        },
      };
    },
  } as any;
  URL.createObjectURL = () => "blob:local-" + serial++;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  try {
    const manager = new LocalResources();
    const photos = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      file: new File([png()], "photo.png", { type: "image/png" }),
      filename: "photo.png",
      date: new Date().toISOString(),
      dateSource: "selected" as const,
      width: 4000,
      height: 4000,
    }));
    const rasters = await Promise.all(photos.map((photo) => manager.load(photo, "preview")));
    assert.ok(rasters.every(raster => raster.width === 1600 && raster.height === 1600));
    assert.ok(photos.every(photo => photo.width === 4000 && photo.height === 4000));
    assert.equal(peak, 1);
    assert.equal(closed, 5);
    assert.ok(manager.decodedBytes <= LOCAL_RASTER_BUDGET);
    assert.ok(revoked.length >= 3);
    manager.clear();
    assert.equal(manager.decodedBytes, 0);
    assert.equal(revoked.length, 5);
  } finally {
    globalThis.createImageBitmap = oldBitmap;
    globalThis.document = oldDocument;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
});
test("Clear fences a photo completing metadata after the previous batch rendered", async () => {
  const { collectLocalFiles } = await import("../src/local/resources");
  let active = true,
    resolveLast: ((value: any) => void) | undefined;
  const files = Array.from(
    { length: 51 },
    () => new File([png()], "photo.png", { type: "image/png" }),
  );
  const batches: any[][] = [];
  let count = 0;
  const operation = collectLocalFiles(
    files,
    () => active,
    (batch) => {
      batches.push(batch);
    },
    () => {},
    async (file) => {
      count++;
      if (count === 51)
        return new Promise((resolve) => {
          resolveLast = resolve;
        });
      return {
        id: String(count),
        file,
        filename: file.name,
        date: new Date().toISOString(),
        dateSource: "selected",
      };
    },
  );
  while (!resolveLast) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 50);
  active = false;
  resolveLast!({
    id: "51",
    file: files[50],
    filename: "photo.png",
    date: new Date().toISOString(),
    dateSource: "selected",
  });
  await operation;
  assert.equal(batches.length, 1);
});
test("unknown dimensions including HEIC are skipped before an unbounded browser decode", async () => {
  await assert.rejects(
    localPhoto(new File(["heic"], "photo.heic", { type: "image/heic" })),
    /HEIC cannot be opened safely/,
  );
  await assert.rejects(
    localPhoto(
      new File([new Uint8Array([255, 216, 255, 217])], "photo.jpg", {
        type: "image/jpeg",
      }),
    ),
    /dimensions could not be read safely/,
  );
});
test("portrait EXIF orientation uses display dimensions for undistorted bounded resize", async () => {
  const bytes = new Uint8Array(48);
  bytes.set([
    255, 216, 255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0,
    0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 255, 192, 0, 8, 8,
    11, 184, 15, 160, 0,
  ]);
  const photo = await localPhoto(
    new File([bytes], "portrait.jpg", { type: "image/jpeg" }),
  );
  assert.equal(photo.width, 3000);
  assert.equal(photo.height, 4000);
});
test("visible URL lease survives cache eviction and cancels queued viewport decodes", async () => {
  const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const revoked: string[] = [], decoded: string[] = []; let serial = 0;
  const manager = new LocalResources();
  let release!: () => void;
  globalThis.createImageBitmap = (async (file: File, options: any) => {
    decoded.push(file.name);
    if (file.name === "first.png") await new Promise<void>(resolve => {release = resolve;});
    return {width: options.resizeWidth, height: options.resizeHeight, close() {}};
  }) as any;
  globalThis.document = {createElement: () => ({width: 0, height: 0, getContext: () => ({drawImage() {}}), toBlob: (callback: any) => callback(new Blob(["preview"], {type: "image/jpeg"}))})} as any;
  URL.createObjectURL = () => `blob:lease-${serial++}`; URL.revokeObjectURL = url => {revoked.push(url);};
  const source = (id: string) => ({id, file: new File([png()], `${id}.png`, {type: "image/png"}), filename: `${id}.png`, date: new Date().toISOString(), dateSource: "selected" as const, width: 4000, height: 4000});
  try {
    const visible = new AbortController(), leaving = new AbortController();
    const first = manager.lease(source("first"), "preview", visible.signal);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    const skipped = manager.load(source("leaving"), "thumbnail", leaving.signal);
    const rejection = assert.rejects(skipped, {name: "AbortError"}); leaving.abort(); release();
    const leased = await first; await rejection;
    assert.deepEqual(decoded, ["first.png"]);
    for (let index = 0; index < 4; index++) await manager.load(source(`next${index}`), "preview");
    assert.ok(!revoked.includes(leased.url), "LRU eviction must not break the mounted view URL");
    assert.ok(manager.decodedBytes <= LOCAL_RASTER_BUDGET);
    visible.abort(); assert.ok(revoked.includes(leased.url));
    const count = revoked.length; manager.clear(); assert.equal(revoked.filter(url => url === leased.url).length, 1); assert.ok(revoked.length >= count);
    const {ConsumerPreviewResources}=await import("../src/library/consumer-search");
    const saved=new ConsumerPreviewResources(),savedController=new AbortController();let reads=0;
    const bytes=png();new DataView(bytes.buffer).setUint32(16,512);new DataView(bytes.buffer).setUint32(20,320);
    const savedPhoto={id:"saved:one",filename:"saved.png",date:new Date().toISOString(),dateSource:"photos" as const,width:4000,height:3000,
      previewLoader:async()=>{reads++;await Promise.resolve();return new Blob([bytes],{type:"image/png"});}};
    const [left,right]=await Promise.all([saved.lease(savedPhoto,"thumbnail",savedController.signal),saved.lease(savedPhoto,"thumbnail",savedController.signal)]);
    assert.equal(reads,1,"Concurrent visible faces share one verified preview read");
    await saved.load(savedPhoto,"thumbnail");
    assert.equal(reads,1,"A warm thumbnail reuses its verified dimensions and raster without decrypting the saved preview again");
    assert.ok(!revoked.includes(left.url)&&!revoked.includes(right.url),"Fresh Blob wrappers must not invalidate other faces of the same saved original");
    saved.clear();assert.ok(revoked.includes(left.url)&&revoked.includes(right.url));savedController.abort();
  } finally {manager.clear(); globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;}
});
