import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {captureDate, captureDateFromFile} from "../src/library/exif";
import {heicExifExtents, heicDimensions, MAX_EXIF_BYTES, PHOTO_HEADER_BYTES} from "../src/media/photo-source";
import {heicWithExif, gridHeicWithExif, exifPayload, HEIC_CAPTURE_CLOCK} from "./fixtures/heic-exif";

const expected = new Date(HEIC_CAPTURE_CLOCK.slice(0, 10).replaceAll(":", "-") + "T" + HEIC_CAPTURE_CLOCK.slice(11)).toISOString();
const typeAt = (bytes: Uint8Array, type: string) => Buffer.from(bytes).indexOf(type);
test("HEIF primary-associated Exif supports bounded file/idat extents and 16/32-bit item IDs", () => {
  for (const version of [0, 1, 2] as const) for (const little of [true, false]) for (const fragmented of [false, true]) {
    for (const method of version ? [0, 1] : [0]) {
      const {bytes} = heicWithExif({version, method, fragmented, payload: exifPayload({little, tiffOffset: little ? 6 : 0})});
      assert.deepEqual(heicDimensions(bytes), {width: 1920, height: 1200});
      assert.equal(captureDate(bytes), expected);
      // DataView/subarray readers must honor nonzero underlying byte offsets.
      const padded = new Uint8Array(bytes.length + 23); padded.set(bytes, 17);
      assert.equal(captureDate(padded.subarray(17, 17 + bytes.length)), expected);
    }
  }
});
test("HEIF capture provenance requires an unambiguous Exif item describing the primary image", () => {
  assert.equal(captureDate(heicWithExif({unrelated: true}).bytes), expected, "Unrelated thumbnail date is ignored");
  for (const options of [{associated: false}, {ambiguous: true}, {method: 2}, {method: 0x10}, {reference: 1}, {index: 1}, {extentCount: 33}, {location: "header" as const}, {location: "outside" as const}])
    assert.equal(captureDate(heicWithExif(options).bytes), undefined, JSON.stringify(options));
  assert.equal(captureDate(heicWithExif({index: 0}).bytes), expected);
  const reverse = heicWithExif().bytes, at = typeAt(reverse, "cdsc") + 4, view = new DataView(reverse.buffer);
  view.setUint16(at, 13); view.setUint16(at + 4, 14);
  assert.equal(captureDate(reverse), undefined, "A reverse image-to-metadata reference is not capture provenance");
  const publicFile = new Uint8Array(readFileSync(new URL("../../../fixtures/media/singapore.heic", import.meta.url)));
  assert.equal(captureDate(publicFile), undefined, "The real public HEIC has no Exif item");
});
test("the real public primary grid can read declared Exif after its unchanged encoded image data", async () => {
  const original = new Uint8Array(readFileSync(new URL("../../../fixtures/media/singapore.heic", import.meta.url))), snapshot = new Uint8Array(original);
  const bytes = gridHeicWithExif(original), header = bytes.subarray(0, PHOTO_HEADER_BYTES);
  assert.deepEqual(heicDimensions(header, bytes.length), {width: 1920, height: 1200});
  assert.equal(captureDate(bytes), expected);
  assert.equal(await captureDateFromFile(new Blob([bytes]), header), expected);
  assert.deepEqual(original, snapshot);
});
test("malformed TIFF, modification dates, or missing Exif never become capture dates", () => {
  const malformed: Uint8Array[] = [exifPayload({modifiedOnly: true}), exifPayload({original: "2026:02:31 11:00:00"})];
  for (const mutate of [
    (v: DataView) => v.setUint32(0, 0xffffffff),
    (v: DataView) => v.setUint16(4, 0),
    (v: DataView) => v.setUint16(6, 43, true),
    (v: DataView) => v.setUint32(8, 0xffff, true),
    (v: DataView) => v.setUint16(34, 513, true),
    (v: DataView) => v.setUint16(38, 4, true),
    (v: DataView) => v.setUint32(44, 0xffff, true),
  ]) {const payload = exifPayload(); mutate(new DataView(payload.buffer)); malformed.push(payload);}
  malformed.push(exifPayload().subarray(0, 60));
  for (const payload of malformed) assert.equal(captureDate(heicWithExif({payload}).bytes), undefined);
  const truncatedTable = exifPayload(); new DataView(truncatedTable.buffer).setUint16(34, 5, true);
  assert.equal(captureDate(heicWithExif({payload: truncatedTable}).bytes), undefined, "An early date cannot hide a truncated IFD table");
  const bytes = heicWithExif().bytes;
  for (let end = 0; end < bytes.length; end++) assert.equal(captureDate(bytes.subarray(0, end)), undefined);
});
test("declared Exif bytes and headers stay bounded before any targeted Blob read", async () => {
  for (const mutate of [
    (bytes: Uint8Array) => {const at = typeAt(bytes, "iloc") + 8; bytes[at] = 0x94;},
    (bytes: Uint8Array) => {const at = typeAt(bytes, "iloc") + 8; bytes[at + 1] = 0x90;},
    (bytes: Uint8Array) => {const at = typeAt(bytes, "iloc") + 8; new DataView(bytes.buffer).setUint32(at + 20, 0);},
    (bytes: Uint8Array) => {const at = typeAt(bytes, "iloc") + 8; new DataView(bytes.buffer).setUint32(at + 20, MAX_EXIF_BYTES + 1);},
    (bytes: Uint8Array) => {const at = typeAt(bytes, "cdsc") + 4; new DataView(bytes.buffer).setUint16(at + 2, 500);},
  ]) {
    const bytes = heicWithExif({padding: PHOTO_HEADER_BYTES + 100}).bytes; mutate(bytes);
    const file = new Blob([bytes]); let reads = 0;
    file.slice = () => {reads++; throw Error("Invalid extents must not be read");};
    assert.equal(await captureDateFromFile(file, bytes.subarray(0, PHOTO_HEADER_BYTES)), undefined);
    assert.equal(reads, 0);
    assert.equal(heicExifExtents(bytes.subarray(0, PHOTO_HEADER_BYTES), bytes.length), undefined);
  }
  const payload = new Uint8Array(MAX_EXIF_BYTES + 1); payload.set(exifPayload());
  assert.equal(captureDate(heicWithExif({payload}).bytes), undefined);
  const largeMeta = heicWithExif({method: 1, padding: PHOTO_HEADER_BYTES}).bytes;
  assert.equal(captureDate(largeMeta), undefined, "Metadata containers outside the supported header bound remain unsupported");
});
test("Exif after image data uses only the declared bounded reads, including fragmented extents", async () => {
  for (const fragmented of [false, true]) {
    const {bytes, payload} = heicWithExif({padding: PHOTO_HEADER_BYTES + 100, fragmented});
    const file = new Blob([bytes]), header = bytes.subarray(0, PHOTO_HEADER_BYTES), reads: [number, number][] = [];
    const slice = file.slice.bind(file);
    file.slice = (start = 0, end = file.size) => {reads.push([start, end]); return slice(start, end);};
    file.arrayBuffer = () => {throw Error("Capture date must not read the whole original");};
    assert.equal(await captureDateFromFile(file, header), expected);
    const extents = heicExifExtents(header, file.size)!;
    assert.deepEqual(reads, extents.map(({offset, length}) => [offset, offset + length]));
    assert.equal(reads.reduce((sum, [start, end]) => sum + end - start, 0), payload.length);
    assert.ok(reads.every(([start]) => start > PHOTO_HEADER_BYTES));
    assert.equal(captureDate(bytes), expected, "Manual Save's in-memory original uses the same provenance and clock");
    assert.equal(captureDate(header), undefined, "Partial bytes alone cannot establish an unread extent");
  }
});
test("failed or short Exif range reads safely retain the missing capture date fallback", async () => {
  const {bytes} = heicWithExif({padding: PHOTO_HEADER_BYTES + 100}), header = bytes.subarray(0, PHOTO_HEADER_BYTES);
  for (const failure of ["throw", "short"] as const) {
    const file = new Blob([bytes]);
    file.slice = () => {if (failure === "throw") throw Error("File unavailable"); return new Blob([new Uint8Array(4)]);};
    assert.equal(await captureDateFromFile(file, header), undefined);
  }
});
