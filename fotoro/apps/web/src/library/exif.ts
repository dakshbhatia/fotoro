import type {PhotoLocationV1} from "@fotoro/contracts";
import {heicExifExtents, MAX_EXIF_BYTES, PHOTO_HEADER_BYTES, type ExifExtent} from "../media/photo-source";

export interface PhotoExif {date?: string; location?: PhotoLocationV1; captureTimezoneVerified?: true}
// JPEG and primary-associated HEIF Exif share a bounded TIFF reader. Modification
// and import clocks never establish capture provenance.
function tiffExif(bytes: Uint8Array): PhotoExif {
  try {
    if (bytes.length < 8 || bytes.length > MAX_EXIF_BYTES) return {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint16(0) === 0x4949;
    if (!little && view.getUint16(0) !== 0x4d4d) return {};
    const u16 = (at: number) => {if (at < 0 || at + 2 > bytes.length) throw Error(); return view.getUint16(at, little);};
    const u32 = (at: number) => {if (at < 0 || at + 4 > bytes.length) throw Error(); return view.getUint32(at, little);};
    if (u16(2) !== 42) return {};
    const visited = new Set<number>();
    const table = (start: number, depth: number): number[] | undefined => {
      if (depth > 2 || start < 8 || visited.has(start)) return;
      visited.add(start);
      try {
        const count = u16(start);
        if (count > 512 || start + 2 + count * 12 > bytes.length) return;
        return Array.from({length: count}, (_, i) => start + 2 + i * 12);
      } catch {return;}
    };
    const ascii = (at: number, minimum: number, maximum: number): string | undefined => {
      if (u16(at + 2) !== 2) return;
      const size = u32(at + 4), start = size <= 4 ? at + 8 : u32(at + 8);
      if (size < minimum || size > maximum || start < 8 || start + size > bytes.length) return;
      return new TextDecoder().decode(bytes.subarray(start, start + size));
    };
    const pointer = (at: number) => u16(at + 2) === 4 && u32(at + 4) === 1 ? u32(at + 8) : undefined;
    const root = table(u32(4), 0);
    if (!root) return {};
    let gps: number[] | undefined;
    const directories: number[][] = [];
    const captureDirectories = (entries: number[], depth: number) => {
      directories.push(entries);
      for (const at of entries) if (u16(at) === 0x8769) {
        const start = pointer(at), child = start === undefined ? undefined : table(start, depth + 1);
        if (child) captureDirectories(child, depth + 1);
      }
    };
    captureDirectories(root, 0);
    const gpsPointers = root.filter(at => u16(at) === 0x8825);
    if (gpsPointers.length === 1) {const start = pointer(gpsPointers[0]); if (start !== undefined) gps = table(start, 1);}
    const dates = directories.flat();
    const result: PhotoExif = {};
    for (const at of dates) {
      if (u16(at) !== 0x9003) continue;
      const raw = ascii(at, 19, 64)?.slice(0, 19);
      if (!raw || !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) continue;
      const clock = raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11), calendar = new Date(clock + "Z");
      const parts = raw.split(/[: ]/).map(Number);
      if (![calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds()].every((value, i) => value === parts[i])) continue;
      const directory = directories.find(entries => entries.includes(at))!;
      const offsets = directory.filter(entry => u16(entry) === 0x9011);
      const offset = offsets.length === 1 ? ascii(offsets[0], 7, 7) : undefined;
      // -00:00 means an unknown local offset; only a strict known EXIF offset
      // establishes absolute time for conservative Timeline matching.
      const validOffset = directory.filter(entry => u16(entry) === 0x9003).length === 1 && offset && /^[+-]\d{2}:\d{2}\0$/.test(offset) && offset !== "-00:00\0" &&
        Number(offset.slice(1, 3)) <= 14 && Number(offset.slice(4, 6)) < 60 && (Number(offset.slice(1, 3)) !== 14 || offset.slice(4, 6) === "00");
      const date = new Date(clock + (validOffset ? offset.slice(0, 6) : ""));
      if (Number.isFinite(date.getTime())) {
        result.date = date.toISOString();
        if (validOffset) result.captureTimezoneVerified = true;
        break;
      }
    }
    if (gps) {
      try {
        const find = (tag: number) => {const matches = gps!.filter(at => u16(at) === tag); return matches.length === 1 ? matches[0] : undefined;};
        const coordinate = (tag: number, positive: string, negative: string, maximum: number): number | undefined => {
          const refAt = find(tag - 1), at = find(tag);
          if (refAt === undefined || at === undefined) return;
          const ref = ascii(refAt, 2, 2);
          if (ref !== positive + "\0" && ref !== negative + "\0") return;
          if (u16(at + 2) !== 5 || u32(at + 4) !== 3) return;
          const start = u32(at + 8);
          if (start < 8 || start + 24 > bytes.length) return;
          const values = [0, 1, 2].map(i => {const denominator = u32(start + i * 8 + 4); return denominator ? u32(start + i * 8) / denominator : NaN;});
          if (!values.every(Number.isFinite) || values[0] > maximum || values[1] >= 60 || values[2] >= 60) return;
          const decimal = values[0] + values[1] / 60 + values[2] / 3600;
          if (!Number.isFinite(decimal) || decimal > maximum) return;
          return (ref === negative + "\0" ? -1 : 1) * decimal;
        };
        const latitude = coordinate(2, "N", "S", 90), longitude = coordinate(4, "E", "W", 180);
        if (latitude !== undefined && longitude !== undefined) result.location = {latitude, longitude, source: "exif"};
      } catch {/* Optional corrupt GPS cannot erase a valid capture date. */}
    }
    return result;
  } catch {return {};}
}
function heifExif(bytes: Uint8Array): PhotoExif {
  if (bytes.length < 12 || bytes.length > MAX_EXIF_BYTES) return {};
  const offset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return tiffExif(bytes.subarray(4 + offset));
}
function joinedExif(extents: ExifExtent[], read: (extent: ExifExtent) => Uint8Array): Uint8Array | undefined {
  const bytes = new Uint8Array(extents.reduce((sum, extent) => sum + extent.length, 0));
  let at = 0;
  for (const extent of extents) {const part = read(extent); if (part.length !== extent.length) return; bytes.set(part, at); at += part.length;}
  return bytes;
}
export function photoExif(input: Uint8Array): PhotoExif {
  try {
    const bytes = input.subarray(0, PHOTO_HEADER_BYTES);
    if (bytes[0] !== 255 || bytes[1] !== 216) {
      const extents = heicExifExtents(bytes, input.length);
      if (!extents) return {};
      const exif = joinedExif(extents, ({offset, length}) => input.subarray(offset, offset + length));
      return exif ? heifExif(exif) : {};
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return {};
      const marker = bytes[offset + 1];
      if (marker === 218 || marker === 217) return {};
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return {};
      if (marker === 225 && new TextDecoder().decode(bytes.subarray(offset + 4, offset + 10)) === "Exif\0\0")
        return tiffExif(bytes.subarray(offset + 10, offset + 2 + length));
      offset += length + 2;
    }
  } catch {}
  return {};
}
// Intake already reads a bounded header. Date and GPS use the same targeted
// declared Exif extents, never a second complete original read.
export async function photoExifFromFile(file: Blob, header: Uint8Array): Promise<PhotoExif> {
  try {
    if (header[0] === 255 && header[1] === 216) return photoExif(header);
    const extents = heicExifExtents(header, file.size);
    if (!extents) return {};
    const parts: Uint8Array[] = [];
    for (const {offset, length} of extents)
      parts.push(offset + length <= header.length ? header.subarray(offset, offset + length) : new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()));
    let index = 0;
    const bytes = joinedExif(extents, () => parts[index++]);
    return bytes ? heifExif(bytes) : {};
  } catch {return {};}
}
export function captureDate(input: Uint8Array): string | undefined {return photoExif(input).date;}
export async function captureDateFromFile(file: Blob, header: Uint8Array): Promise<string | undefined> {return (await photoExifFromFile(file, header)).date;}
