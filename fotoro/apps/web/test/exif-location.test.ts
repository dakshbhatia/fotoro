import test from "node:test";
import assert from "node:assert/strict";
import * as exif from "../src/library/exif";
import {localPhoto} from "../src/local/resources";
import {heicWithExif} from "./fixtures/heic-exif";
import {gpsTiff, gpsJpeg, gpsHeifPayload} from "./fixtures/gps-exif";
import {PHOTO_HEADER_BYTES} from "../src/media/photo-source";
const inspect = exif.photoExif;

test("GPS refs and rational degrees preserve both TIFF endian formats and hemispheres", async () => {
  for (const little of [true, false]) for (const southWest of [false, true]) {
    const bytes = gpsJpeg(gpsTiff({little, latitudeRef: southWest ? "S" : "N", longitudeRef: southWest ? "W" : "E"})), snapshot = bytes.slice();
    const result = inspect(bytes), sign = southWest ? -1 : 1;
    assert.ok(Math.abs(result.location?.latitude - sign * 41.9028) < 1e-8);
    assert.ok(Math.abs(result.location?.longitude - sign * 12.4964) < 1e-8);
    assert.equal(result.location.source, "exif");
    assert.equal(result.date, "2026-09-01T05:30:00.000Z");
    assert.equal(result.captureTimezoneVerified, true);
    const photo = await localPhoto(new File([bytes], "camera.jpg", {type: "image/jpeg"}));
    assert.deepEqual(photo.location, result.location);
    assert.equal(photo.captureTimezoneVerified, true);
    assert.deepEqual(bytes, snapshot);
    const padded = new Uint8Array(bytes.length + 23); padded.set(bytes, 17);
    assert.deepEqual(inspect(padded.subarray(17, 17 + bytes.length)), result);
  }
});

test("invalid GPS references, types, rationals, ranges, offsets and cycles cannot create a place", () => {
  for (const little of [true, false]) for (const corrupt of [
    (b: Uint8Array, v: DataView) => {b[90] = 88;},
    (b: Uint8Array, v: DataView) => {b[115] = 65;},
    (b: Uint8Array, v: DataView) => {v.setUint16(96, 4, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(98, 2, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(192, 0, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(196, 60, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(188, 90, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(212, 181, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(102, 0xfffffff0, little);},
    (b: Uint8Array, v: DataView) => {v.setUint32(30, 8, little);},
    (b: Uint8Array, v: DataView) => {v.setUint16(80, 513, little);},
    (b: Uint8Array, v: DataView) => {v.setUint16(80, 14, little);},
  ]) {
    const tiff = gpsTiff({little}); corrupt(tiff, new DataView(tiff.buffer));
    const result = inspect(gpsJpeg(tiff));
    assert.equal(result.location, undefined);
    assert.equal(result.date, "2026-09-01T05:30:00.000Z", "Bad optional GPS does not erase the capture clock");
  }
  for (const end of [0, 7, 83, 211, 235]) assert.equal(inspect(gpsJpeg(gpsTiff().subarray(0, end))).location, undefined);
});

test("only strict original timezone offsets establish absolute EXIF time", () => {
  for (const [offset, want] of [["+05:30", "2026-09-01T05:30:00.000Z"], ["-04:00", "2026-09-01T15:00:00.000Z"], ["+00:00", "2026-09-01T11:00:00.000Z"], ["+14:00", "2026-08-31T21:00:00.000Z"]]) {
    const bytes = gpsJpeg(gpsTiff({offset}));
    assert.equal(exif.captureDate(bytes), want); assert.equal(inspect(bytes).captureTimezoneVerified, true);
  }
  for (const offset of ["+14:01", "+24:00", "+00:60", " 05:30", "+5:30", "-00:00"]) {
    const bytes = gpsJpeg(gpsTiff({offset}));
    assert.equal(exif.captureDate(bytes), new Date("2026-09-01T11:00:00").toISOString());
    assert.equal(inspect(bytes).captureTimezoneVerified, undefined);
  }
  assert.equal(inspect(gpsJpeg(gpsTiff({clock: "2026:02:31 11:00:00"}))).date, undefined);
});

test("HEIC date and GPS share only declared bounded Exif range reads", async () => {
  const bytes = heicWithExif({payload: gpsHeifPayload(gpsTiff({little: false})), padding: PHOTO_HEADER_BYTES + 100, fragmented: true}).bytes;
  const file = new Blob([bytes]), header = bytes.subarray(0, PHOTO_HEADER_BYTES), reads: [number, number][] = [], slice = file.slice.bind(file);
  file.slice = (start = 0, end = file.size) => {reads.push([start, end]); return slice(start, end);};
  file.arrayBuffer = () => {throw Error("Do not read the complete original");};
  const result = await exif.photoExifFromFile(file, header);
  assert.equal(result?.location.source, "exif");
  assert.ok(Math.abs(result.location.latitude - 41.9028) < 1e-8);
  assert.equal(result.date, "2026-09-01T05:30:00.000Z");
  assert.equal(reads.length, 2); assert.equal(reads.reduce((n, [start, end]) => n + end - start, 0), 248);
  assert.deepEqual(inspect(bytes), result);
  assert.equal(inspect(heicWithExif({payload: gpsHeifPayload(), associated: false}).bytes).location, undefined);
});

test("GPS without a capture date retains selection provenance and duplicate GPS pointers are ambiguous", async () => {
  const onlyGps = gpsTiff(); new DataView(onlyGps.buffer).setUint16(42, 0x132, true);
  const photo = await localPhoto(new File([gpsJpeg(onlyGps)], "gps.jpg", {type: "image/jpeg"}));
  assert.equal(photo.location?.source, "exif"); assert.equal(photo.dateSource, "selected");
  assert.equal(photo.captureTimezoneVerified, undefined);
  const duplicate = gpsTiff(), view = new DataView(duplicate.buffer);
  view.setUint16(8, 3, true); view.setUint16(34, 0x8825, true); view.setUint16(36, 4, true);
  view.setUint32(38, 1, true); view.setUint32(42, 80, true);
  assert.equal(inspect(gpsJpeg(duplicate)).location, undefined);
  duplicate.set(duplicate.slice(80, 130), 136); view.setUint32(42, 136, true);
  assert.equal(inspect(gpsJpeg(duplicate)).location, undefined, "Two independently readable GPS directories are ambiguous");
});

test("nested original EXIF date helpers remain compatible and offsets stay bound to the original-date IFD", () => {
  const tiff = gpsTiff(), view = new DataView(tiff.buffer);
  // Add an intermediate Exif IFD and point to the original IFD at 40.
  view.setUint32(18, 136, true); view.setUint16(136, 1, true);
  view.setUint16(138, 0x8769, true); view.setUint16(140, 4, true); view.setUint32(142, 1, true); view.setUint32(146, 40, true);
  assert.equal(exif.captureDate(gpsJpeg(tiff)), "2026-09-01T05:30:00.000Z");
  assert.equal(inspect(gpsJpeg(tiff)).captureTimezoneVerified, true);
  // A timezone on IFD0 does not establish the timezone of another IFD's capture.
  const unbound = gpsTiff(), other = new DataView(unbound.buffer);
  other.setUint16(8, 3, true); other.setUint16(34, 0x9011, true); other.setUint16(36, 2, true);
  other.setUint32(38, 7, true); other.setUint32(42, 180, true); other.setUint32(18, 136, true);
  other.setUint16(136, 1, true); other.setUint16(138, 0x9003, true); other.setUint16(140, 2, true);
  other.setUint32(142, 20, true); other.setUint32(146, 160, true);
  assert.equal(exif.captureDate(gpsJpeg(unbound)), new Date("2026-09-01T11:00:00").toISOString());
  assert.equal(inspect(gpsJpeg(unbound)).captureTimezoneVerified, undefined);
});
