// Structurally valid bounded HEIF metadata for parser/intake tests. Image decoding
// is mocked separately; this fixture does not claim to contain encoded HEVC pixels.
const text = (value: string) => new TextEncoder().encode(value);
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) {result.set(part, at); at += part.length;}
  return result;
};
const integer = (value: number, size: number) => {
  const bytes = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {bytes[i] = value % 256; value = Math.floor(value / 256);}
  return bytes;
};
const box = (type: string, ...parts: Uint8Array[]) => {const body = join(...parts); return join(integer(body.length + 8, 4), text(type), body);};
const full = (type: string, version: number, ...parts: Uint8Array[]) => box(type, new Uint8Array([version, 0, 0, 0]), ...parts);
export const HEIC_CAPTURE_CLOCK = "2026:09:01 11:00:00";
export function exifPayload(options: {little?: boolean; original?: string; modifiedOnly?: boolean; tiffOffset?: number} = {}) {
  const little = options.little ?? true, tiffOffset = options.tiffOffset ?? 0;
  const tiff = new Uint8Array(80), view = new DataView(tiff.buffer);
  tiff.set(little ? [73, 73] : [77, 77]);
  const u16 = (at: number, value: number) => view.setUint16(at, value, little), u32 = (at: number, value: number) => view.setUint32(at, value, little);
  u16(2, 42); u32(4, 8); u16(8, 1);
  u16(10, 0x8769); u16(12, 4); u32(14, 1); u32(18, 30);
  u16(30, 1); u16(32, options.modifiedOnly ? 0x132 : 0x9003); u16(34, 2); u32(36, 20); u32(40, 50);
  tiff.set(text((options.original ?? HEIC_CAPTURE_CLOCK) + "\0"), 50);
  const prefix = new Uint8Array(tiffOffset); prefix.set(text("Exif\0\0").subarray(0, tiffOffset));
  return join(integer(tiffOffset, 4), prefix, tiff);
}
interface Options {
  version?: 0 | 1 | 2; method?: number; reference?: number; associated?: boolean;
  fragmented?: boolean; padding?: number; payload?: Uint8Array; unrelated?: boolean;
  ambiguous?: boolean; index?: number; extentCount?: number; location?: "header" | "outside";
}
export function heicWithExif(options: Options = {}) {
  const version = options.version ?? 1, wide = version === 2, idSize = wide ? 4 : 2;
  const primary = wide ? 70_013 : 13, metadata = wide ? 70_014 : 14, thumbnail = wide ? 70_015 : 15, otherExif = wide ? 70_016 : 16;
  const method = options.method ?? 0, payload = options.payload ?? exifPayload(), padding = options.padding ?? 11;
  const primaryId = integer(primary, idSize), metadataId = integer(metadata, idSize), thumbnailId = integer(thumbnail, idSize);
  const infe = (id: number, type: string) => full("infe", wide ? 3 : 2, integer(id, idSize), integer(0, 2), text(type), new Uint8Array(1));
  const entries = [infe(primary, "hvc1"), infe(metadata, "Exif"), infe(thumbnail, "hvc1")];
  if (options.unrelated || options.ambiguous) entries.push(infe(otherExif, "Exif"));
  const iinf = full("iinf", wide ? 1 : 0, integer(entries.length, wide ? 4 : 2), ...entries);
  const association = (id: number, target: number) => box("cdsc", integer(id, idSize), integer(1, 2), integer(target, idSize));
  const refs = [association(metadata, options.associated === false ? thumbnail : primary)];
  if (options.unrelated || options.ambiguous) refs.push(association(otherExif, options.ambiguous ? primary : thumbnail));
  const iref = full("iref", wide ? 1 : 0, ...refs);
  const iprp = box("iprp", box("ipco", full("ispe", 0, integer(1920, 4), integer(1200, 4))), full("ipma", wide ? 1 : 0, integer(1, 4), primaryId, new Uint8Array([1, 1])));
  const otherPayload = exifPayload({original: "2025:02:02 02:02:02"});
  const fragment = options.fragmented ? 10 : payload.length, gap = options.fragmented ? 7 : 0;
  const storage = join(new Uint8Array(padding), payload.subarray(0, fragment), new Uint8Array(gap), payload.subarray(fragment), options.unrelated || options.ambiguous ? otherPayload : new Uint8Array());
  const indexSize = options.index !== undefined ? 4 : 0;
  const extent = (offset: number, length: number) => join(version ? integer(options.index ?? 0, indexSize) : new Uint8Array(), integer(offset, 4), integer(length, 4));
  const extents = options.fragmented ? [extent(padding, fragment), extent(padding + fragment + gap, payload.length - fragment)] : [extent(padding, payload.length)];
  const location = (id: Uint8Array, base: number, parts: Uint8Array[]) => join(id, version ? integer(method, 2) : new Uint8Array(), integer(options.reference ?? 0, 2), integer(base, 4), integer(options.extentCount ?? parts.length, 2), ...parts);
  const meta = (base: number) => full("meta", 0,
    full("hdlr", 0, integer(0, 4), text("pict")), full("pitm", wide ? 1 : 0, primaryId), iinf, iref, iprp,
    method === 1 ? box("idat", storage) : new Uint8Array(),
    full("iloc", version, new Uint8Array([0x44, 0x40 | indexSize]), integer(options.unrelated || options.ambiguous ? 2 : 1, wide ? 4 : 2),
      location(metadataId, base, extents),
      options.unrelated || options.ambiguous ? location(integer(otherExif, idSize), base, [extent(padding + payload.length + gap, otherPayload.length)]) : new Uint8Array()));
  const ftyp = box("ftyp", text("heic"), integer(0, 4), text("mif1"));
  let base = method === 1 ? 0 : ftyp.length + meta(0).length + 8;
  if (options.location === "header") base = 0;
  if (options.location === "outside") base += storage.length + 1;
  const bytes = join(ftyp, meta(base), method === 1 ? new Uint8Array() : box("mdat", storage));
  return {bytes, payload, primary, metadata};
}

// Preserve the checked-in grid photo's encoded pixels while adding test-authored
// Exif and rebasing its declared file extents as the metadata container grows.
export function gridHeicWithExif(original: Uint8Array, payload = exifPayload()) {
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const boxes = (start: number, end: number) => {
    const result: {type: string; start: number; data: number; end: number}[] = [];
    for (let at = start; at < end;) {
      let size = view.getUint32(at) || end - at, headerSize = 8;
      if (size === 1) {size = Number(view.getBigUint64(at + 8)); headerSize = 16;}
      if (size < headerSize || at + size > end) throw Error("Public grid fixture changed");
      result.push({type: new TextDecoder().decode(original.subarray(at + 4, at + 8)), start: at, data: at + headerSize, end: at + size});
      at += size;
    }
    return result;
  };
  const tops = boxes(0, original.length), meta = tops.find(item => item.type === "meta")!, mdat = tops.find(item => item.type === "mdat")!;
  const contents = boxes(meta.data + 4, meta.end), iinf = contents.find(item => item.type === "iinf")!, iref = contents.find(item => item.type === "iref")!, iloc = contents.find(item => item.type === "iloc")!;
  if (original[iinf.data] !== 0 || original[iref.data] !== 0 || original[iloc.data] !== 1 || original[iloc.data + 4] !== 0x44 || original[iloc.data + 5] !== 0 || view.getUint16(iloc.data + 6) !== 13)
    throw Error("Public grid fixture layout changed");
  const info = full("iinf", 0, integer(14, 2), original.subarray(iinf.data + 6, iinf.end), full("infe", 2, integer(14, 2), integer(0, 2), text("Exif"), new Uint8Array(1)));
  const refs = full("iref", 0, original.subarray(iref.data + 4, iref.end), box("cdsc", integer(14, 2), integer(1, 2), integer(13, 2)));
  const delta = info.length - (iinf.end - iinf.start) + refs.length - (iref.end - iref.start) + 16;
  const locations = new Uint8Array(original.subarray(iloc.data + 8, iloc.end)), locationsView = new DataView(locations.buffer);
  for (let at = 0; at < locations.length; at += 16) {
    if (locationsView.getUint16(at + 6) !== 1) throw Error("Public grid extents changed");
    if (locationsView.getUint16(at + 2) === 0) locationsView.setUint32(at + 8, locationsView.getUint32(at + 8) + delta);
  }
  const location = full("iloc", 1, new Uint8Array([0x44, 0]), integer(14, 2), locations, integer(14, 2), integer(0, 2), integer(0, 2), integer(1, 2), integer(original.length + delta, 4), integer(payload.length, 4));
  const rebuilt = full("meta", 0, ...contents.map(item => item === iinf ? info : item === iref ? refs : item === iloc ? location : original.subarray(item.start, item.end)));
  const media = join(original.subarray(mdat.data, mdat.end), payload);
  const rebuiltMedia = mdat.data - mdat.start === 16 ? join(integer(1, 4), text("mdat"), integer(media.length + 16, 8), media) : box("mdat", media);
  return join(...tops.map(item => item === meta ? rebuilt : item === mdat ? rebuiltMedia : original.subarray(item.start, item.end)));
}
