import {heicExifExtents, MAX_EXIF_BYTES, PHOTO_HEADER_BYTES, type ExifExtent} from "../media/photo-source";

// Only DateTimeOriginal establishes capture provenance; modification/import clocks
// never qualify. JPEG and primary-associated HEIF Exif use the same bounded TIFF reader.
function tiffCaptureDate(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.length < 8 || bytes.length > MAX_EXIF_BYTES) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint16(0) === 0x4949;
    if (!little && view.getUint16(0) !== 0x4d4d) return;
    const u16 = (at: number) => {if (at < 0 || at + 2 > bytes.length) throw Error(); return view.getUint16(at, little);};
    const u32 = (at: number) => {if (at < 0 || at + 4 > bytes.length) throw Error(); return view.getUint32(at, little);};
    if (u16(2) !== 42) return;
    const visited = new Set<number>();
    const parse = (start: number, depth: number): string | undefined => {
      if (depth > 2 || start < 8 || visited.has(start)) return;
      visited.add(start);
      const count = u16(start);
      if (count > 512 || start + 2 + count * 12 > bytes.length) return;
      for (let i = 0; i < count; i++) {
        const at = start + 2 + i * 12, tag = u16(at);
        if (tag === 0x8769 && u16(at + 2) === 4 && u32(at + 4) === 1) {
          const found = parse(u32(at + 8), depth + 1);
          if (found) return found;
        }
        if (tag !== 0x9003 || u16(at + 2) !== 2) continue;
        const size = u32(at + 4), value = size <= 4 ? at + 8 : u32(at + 8);
        if (size < 19 || size > 64 || value < 8 || value + size > bytes.length) continue;
        const raw = new TextDecoder().decode(bytes.subarray(value, value + 19));
        if (!/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) continue;
        const clock = raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11);
        // Validate the calendar without browser DST rules, retaining the existing
        // local interpretation when no EXIF timezone offset is available.
        const calendar = new Date(clock + "Z"), date = new Date(clock), parts = raw.split(/[: ]/).map(Number);
        if (Number.isFinite(date.getTime()) &&
          [calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()].every((value, i) => value === parts[i]))
          return date.toISOString();
      }
    };
    return parse(u32(4), 0);
  } catch {return;}
}
function heifCaptureDate(bytes: Uint8Array) {
  if (bytes.length < 12 || bytes.length > MAX_EXIF_BYTES) return;
  const offset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  // HEIF's four-byte big-endian offset is relative to the end of that field.
  return tiffCaptureDate(bytes.subarray(4 + offset));
}
function joinedExif(extents: ExifExtent[], read: (extent: ExifExtent) => Uint8Array): Uint8Array | undefined {
  const bytes = new Uint8Array(extents.reduce((sum, extent) => sum + extent.length, 0));
  let at = 0;
  for (const extent of extents) {
    const part = read(extent);
    if (part.length !== extent.length) return;
    bytes.set(part, at); at += part.length;
  }
  return bytes;
}
export function captureDate(input: Uint8Array): string | undefined {
  try {
    const bytes = input.subarray(0, PHOTO_HEADER_BYTES);
    if (bytes[0] !== 255 || bytes[1] !== 216) {
      const extents = heicExifExtents(bytes, input.length);
      if (!extents) return;
      const exif = joinedExif(extents, ({offset, length}) => input.subarray(offset, offset + length));
      return exif && heifCaptureDate(exif);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return;
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) return;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return;
      if (marker === 225 && new TextDecoder().decode(bytes.subarray(offset + 4, offset + 10)) === "Exif\0\0")
        return tiffCaptureDate(bytes.subarray(offset + 10, offset + 2 + length));
      offset += length + 2;
    }
  } catch {return;}
}
// Intake already reads the bounded header. Read only declared Exif extents beyond
// it (at most 64 KiB, 32 extents); do not load a second complete original for dates.
export async function captureDateFromFile(file: Blob, header: Uint8Array): Promise<string | undefined> {
  try {
    if (header[0] === 255 && header[1] === 216) return captureDate(header);
    const extents = heicExifExtents(header, file.size);
    if (!extents) return;
    const parts: Uint8Array[] = [];
    for (const {offset, length} of extents)
      parts.push(offset + length <= header.length ? header.subarray(offset, offset + length) : new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()));
    let index = 0;
    const bytes = joinedExif(extents, () => parts[index++]);
    return bytes && heifCaptureDate(bytes);
  } catch {return;}
}
