export type PhotoFormat = "jpeg" | "png" | "heic";
export interface PhotoDimensions {width: number; height: number;}
export const PHOTO_HEADER_BYTES = 256 * 1024;
export const MAX_PHOTO_PIXELS = 80_000_000;
export const photoMime = (format: PhotoFormat) => format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/heic";
export function photoFormat(file: {type: string; name?: string}): PhotoFormat | undefined {
  if (file.type === "image/jpeg") return "jpeg";
  if (file.type === "image/png") return "png";
  if (/^image\/hei[cf]-sequence$/i.test(file.type)) return;
  if (/^image\/hei[cf]$/i.test(file.type)) return "heic";
  if (/\.jpe?g$/i.test(file.name ?? "")) return "jpeg";
  if (/\.png$/i.test(file.name ?? "")) return "png";
  if (/\.hei[cf]$/i.test(file.name ?? "")) return "heic";
}
export function safePhotoDimensions(value: PhotoDimensions) {
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 || value.width * value.height > MAX_PHOTO_PIXELS)
    throw new Error("This photo is too large to open safely in this browser. It was skipped.");
  return value;
}

export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 137 && bytes[1] === 80 && bytes.length >= 24) {
      const width = view.getUint32(16),
        height = view.getUint32(20);
      if (width && height) return { width, height };
    }
    if (bytes[0] !== 255 || bytes[1] !== 216) return;
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 255) return;
      const marker = bytes[offset + 1],
        length = view.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) return;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        const height = view.getUint16(offset + 5),
          width = view.getUint16(offset + 7);
        if (width && height) return { width, height };
      }
      if (marker === 218 || marker === 217) return;
      offset += length + 2;
    }
  } catch {}
  return;
}
function jpegOrientation(bytes: Uint8Array): number {
  try {
    if (bytes[0] !== 255 || bytes[1] !== 216) return 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 10 <= bytes.length) {
      const marker = bytes[offset + 1],
        length = view.getUint16(offset + 2);
      if (
        bytes[offset] !== 255 ||
        length < 2 ||
        offset + length + 2 > bytes.length
      )
        break;
      if (
        marker === 225 &&
        new TextDecoder().decode(bytes.subarray(offset + 4, offset + 10)) ===
          "Exif\0\0"
      ) {
        const base = offset + 10,
          end = offset + length + 2;
        const little = view.getUint16(base) === 0x4949;
        if (!little && view.getUint16(base) !== 0x4d4d) return 1;
        const start = base + view.getUint32(base + 4, little);
        const count = view.getUint16(start, little);
        if (count > 512 || start + 2 + count * 12 > end) return 1;
        for (let i = 0; i < count; i++) {
          const position = start + 2 + i * 12;
          if (
            view.getUint16(position, little) === 0x112 &&
            view.getUint16(position + 2, little) === 3 &&
            view.getUint32(position + 4, little) === 1
          ) {
            const value = view.getUint16(position + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      }
      if (marker === 218 || marker === 217) break;
      offset += length + 2;
    }
  } catch {}
  return 1;
}
export function displayPhotoDimensions(bytes: Uint8Array, format: PhotoFormat, fileSize = bytes.length) {
  if (format === "heic") return heicDimensions(bytes, fileSize);
  let dimensions = imageDimensions(bytes);
  if (dimensions && format === "jpeg" && jpegOrientation(bytes) >= 5)
    dimensions = {width: dimensions.height, height: dimensions.width};
  return dimensions;
}

interface Box {type: string; data: number; end: number;}
// Only bounded metadata is inspected; media payloads are never searched for box names.
function heicMetadata(bytes: Uint8Array, fileSize: number) {
    if (!Number.isSafeInteger(fileSize) || fileSize < bytes.length) throw Error();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (at: number) => view.getUint16(at), u32 = (at: number) => view.getUint32(at);
    const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    const box = (at: number, end: number): Box => {
      if (at + 8 > end || at + 8 > bytes.length) throw Error();
      let size = u32(at), header = 8;
      if (size === 1) {if (at + 16 > bytes.length) throw Error(); size = Number(view.getBigUint64(at + 8)); header = 16;}
      if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || at + size > end) throw Error();
      return {type: text(at + 4), data: at + header, end: at + size};
    };
    const children = (start: number, end: number) => {
      if (end > bytes.length) throw Error();
      const result: Box[] = [];
      while (start < end) {if (result.length >= 4096) throw Error(); const item = box(start, end); result.push(item); start = item.end;}
      return result;
    };
    const only = (items: Box[], type: string) => {const found = items.filter(item => item.type === type); if (found.length !== 1) throw Error(); return found[0];};
    const full = (item: Box, versions: number[]) => {
      if (item.data + 4 > item.end || !versions.includes(bytes[item.data])) throw Error();
      return {version: bytes[item.data], flags: u32(item.data) & 0xffffff, at: item.data + 4};
    };
    const tops: Box[] = [];
    for (let at = 0; at < Math.min(fileSize, bytes.length);) {
      const item = box(at, fileSize);
      if (item.end > bytes.length) {if (item.type !== "mdat" || !tops.some(value => value.type === "meta")) throw Error(); tops.push(item); break;}
      tops.push(item); if (tops.length > 128) throw Error(); at = item.end;
    }
    const ftyp = only(tops, "ftyp");
    if (ftyp.data + 8 > ftyp.end || (ftyp.end - ftyp.data) % 4) throw Error();
    const brands = [text(ftyp.data)];
    for (let at = ftyp.data + 8; at < ftyp.end; at += 4) brands.push(text(at));
    if (!brands.some(value => ["heic", "heix"].includes(value)) || brands.some(value => ["hevc", "hevx", "avis"].includes(value))) throw Error();
    const meta = only(tops, "meta"), metaHeader = full(meta, [0]);
    if (metaHeader.flags) throw Error();
    const contents = children(metaHeader.at, meta.end), handler = only(contents, "hdlr"), handlerInfo = full(handler, [0]);
    if (handlerInfo.flags || handlerInfo.at + 8 > handler.end || text(handlerInfo.at + 4) !== "pict") throw Error();
    const pitm = only(contents, "pitm"), primary = full(pitm, [0, 1]);
    if (primary.flags || primary.at + (primary.version ? 4 : 2) !== pitm.end) throw Error();
    const primaryId = primary.version ? u32(primary.at) : u16(primary.at);
    if (!primaryId) throw Error();
    const iinf = only(contents, "iinf"), info = full(iinf, [0, 1]);
    if (info.flags) throw Error();
    const countSize = info.version ? 4 : 2, count = info.version ? u32(info.at) : u16(info.at);
    const entries = children(info.at + countSize, iinf.end);
    if (entries.length !== count) throw Error();
    let primaryType: string | undefined;
    const ids = new Set<number>(), types = new Map<number, string>();
    for (const entry of entries) {
      if (entry.type !== "infe") throw Error();
      const value = full(entry, [2, 3]), size = value.version === 3 ? 4 : 2;
      if (value.at + size + 7 > entry.end || value.flags > 1) throw Error();
      const id = size === 4 ? u32(value.at) : u16(value.at);
      if (!id || ids.has(id) || u16(value.at + size) !== 0) throw Error();
      ids.add(id);
      types.set(id, text(value.at + size + 2));
      if (id === primaryId) {if (value.flags) throw Error(); primaryType = text(value.at + size + 2);}
    }
    if (!primaryType || !["hvc1", "grid"].includes(primaryType)) throw Error();
    return {view, u16, u32, children, only, full, tops, contents, ids, types, primaryId, primaryType};
}
export function heicDimensions(bytes: Uint8Array, fileSize = bytes.length): PhotoDimensions | undefined {
  try {
    const {u16, u32, children, only, full, contents, ids, types, primaryId, primaryType} = heicMetadata(bytes, fileSize);
    const iprp = only(contents, "iprp"), properties = children(iprp.data, iprp.end), ipco = only(properties, "ipco");
    const definitions = children(ipco.data, ipco.end);
    // Bound every declared image, including tiles and auxiliary images.
    for (const item of definitions.filter(item => item.type === "ispe")) {
      const value = full(item, [0]);
      if (value.flags || value.at + 8 !== item.end) throw Error();
      safePhotoDimensions({width: u32(value.at), height: u32(value.at + 4)});
    }
    const ipma = only(properties, "ipma"), map = full(ipma, [0, 1]);
    if (map.flags > 1 || map.at + 4 > ipma.end) throw Error();
    const itemCount = u32(map.at); if (itemCount > 4096) throw Error();
    let at = map.at + 4, selected: Box[] | undefined;
    const associations = new Map<number, Box[]>();
    const mapped = new Set<number>();
    for (let i = 0; i < itemCount; i++) {
      const idSize = map.version ? 4 : 2;
      if (at + idSize + 1 > ipma.end) throw Error();
      const id = map.version ? u32(at) : u16(at); at += idSize;
      if (!ids.has(id) || mapped.has(id)) throw Error(); mapped.add(id);
      const associationCount = bytes[at++], indices = new Set<number>(), associated: Box[] = [];
      for (let j = 0; j < associationCount; j++) {
        const size = map.flags & 1 ? 2 : 1; if (at + size > ipma.end) throw Error();
        const index = (size === 2 ? u16(at) : bytes[at]) & (size === 2 ? 0x7fff : 0x7f); at += size;
        if (index === 0) continue;
        if (index > definitions.length || indices.has(index)) throw Error(); indices.add(index); associated.push(definitions[index - 1]);
      }
      associations.set(id, associated);
      if (id === primaryId) selected = associated;
    }
    if (at !== ipma.end || !selected) throw Error();
    const supported = ["ispe", "irot", "imir", "hvcC", "colr", "pixi", "clli", "mdcv", "auxC"];
    if (selected.some(item => !supported.includes(item.type))) throw Error();
    const size = only(selected, "ispe");
    let width = u32(size.data + 4), height = u32(size.data + 8);
    if (primaryType === "grid") {
      // Grid dimensions live in the derived item as well as ispe. Accept a bounded,
      // single idat extent and simple hvc1 tiles; never guess from a thumbnail ispe.
      const idat = only(contents, "idat"), iloc = only(contents, "iloc"), locations = full(iloc, [1, 2]);
      if (locations.flags || locations.at + 2 > iloc.end) throw Error();
      const offsetSize = bytes[locations.at] >> 4, lengthSize = bytes[locations.at] & 15;
      const baseSize = bytes[locations.at + 1] >> 4, indexSize = bytes[locations.at + 1] & 15;
      if ([offsetSize, lengthSize, baseSize, indexSize].some(value => value > 8)) throw Error();
      let cursor = locations.at + 2;
      const integer = (length: number) => {
        if (cursor + length > iloc.end) throw Error();
        let value = 0; for (let i = 0; i < length; i++) value = value * 256 + bytes[cursor++];
        if (!Number.isSafeInteger(value)) throw Error(); return value;
      };
      const locationCount = integer(locations.version === 2 ? 4 : 2); if (locationCount > 4096) throw Error();
      const located = new Set<number>(); let grid: Uint8Array | undefined;
      for (let i = 0; i < locationCount; i++) {
        const id = integer(locations.version === 2 ? 4 : 2), method = integer(2), reference = integer(2), base = integer(baseSize), extents = integer(2);
        if (!ids.has(id) || located.has(id) || extents > 4096) throw Error(); located.add(id);
        for (let j = 0; j < extents; j++) {
          const index = integer(indexSize), offset = integer(offsetSize), length = integer(lengthSize);
          if (id === primaryId) {
            if (method !== 1 || reference !== 0 || extents !== 1 || index !== 0 || ![8, 12].includes(length) || base + offset + length > idat.end - idat.data) throw Error();
            grid = bytes.subarray(idat.data + base + offset, idat.data + base + offset + length);
          }
        }
      }
      if (cursor !== iloc.end || !grid || grid[0] !== 0 || grid[1] > 1 || grid.length !== (grid[1] ? 12 : 8)) throw Error();
      const gridView = new DataView(grid.buffer, grid.byteOffset, grid.byteLength), rows = grid[2] + 1, columns = grid[3] + 1;
      const gridWidth = grid[1] ? gridView.getUint32(4) : gridView.getUint16(4), gridHeight = grid[1] ? gridView.getUint32(8) : gridView.getUint16(6);
      if (gridWidth !== width || gridHeight !== height) throw Error();
      const iref = only(contents, "iref"), refs = full(iref, [0, 1]); if (refs.flags) throw Error();
      let tiles: number[] | undefined;
      for (const item of children(refs.at, iref.end).filter(item => item.type === "dimg")) {
        const idSize = refs.version ? 4 : 2; if (item.data + idSize + 2 > item.end) throw Error();
        const from = idSize === 4 ? u32(item.data) : u16(item.data), count = u16(item.data + idSize);
        if (item.data + idSize + 2 + count * idSize !== item.end) throw Error();
        if (from !== primaryId) continue;
        if (tiles) throw Error(); tiles = [];
        for (let i = 0; i < count; i++) {const at = item.data + idSize + 2 + i * idSize; tiles.push(idSize === 4 ? u32(at) : u16(at));}
      }
      if (!tiles || tiles.length !== rows * columns || new Set(tiles).size !== tiles.length) throw Error();
      let tileDimensions: PhotoDimensions | undefined, decodedPixels = 0;
      for (const tile of tiles) {
        const props = associations.get(tile); if (types.get(tile) !== "hvc1" || !props || props.some(item => !supported.includes(item.type) || ["irot", "imir"].includes(item.type))) throw Error();
        const size = only(props, "ispe"), current = {width: u32(size.data + 4), height: u32(size.data + 8)};
        if (tileDimensions && (tileDimensions.width !== current.width || tileDimensions.height !== current.height)) throw Error();
        tileDimensions = current; decodedPixels += current.width * current.height;
      }
      if (!tileDimensions || decodedPixels > MAX_PHOTO_PIXELS || width > tileDimensions.width * columns || width <= tileDimensions.width * (columns - 1) || height > tileDimensions.height * rows || height <= tileDimensions.height * (rows - 1)) throw Error();
    }
    const rotations = selected.filter(item => item.type === "irot"), mirrors = selected.filter(item => item.type === "imir");
    if (rotations.length > 1 || mirrors.length > 1) throw Error();
    if (rotations[0]) {const item = rotations[0]; if (item.end !== item.data + 1 || bytes[item.data] > 3) throw Error(); if (bytes[item.data] & 1) [width, height] = [height, width];}
    if (mirrors[0] && (mirrors[0].end !== mirrors[0].data + 1 || bytes[mirrors[0].data] > 1)) throw Error();
    return safePhotoDimensions({width, height});
  } catch {return;}
}

export const MAX_EXIF_BYTES = 64 * 1024;
export interface ExifExtent {offset: number; length: number;}
// Exif must describe the primary image. Resolve its declared extents, never TIFF
// signatures in image payloads or metadata attached only to a thumbnail/tile.
export function heicExifExtents(header: Uint8Array, fileSize = header.length): ExifExtent[] | undefined {
  try {
    const bytes = header.subarray(0, PHOTO_HEADER_BYTES);
    if (!heicDimensions(bytes, fileSize)) return;
    const {u16, u32, children, only, full, contents, tops, ids, types, primaryId} = heicMetadata(bytes, fileSize);
    const iref = only(contents, "iref"), refs = full(iref, [0, 1]);
    if (refs.flags) return;
    const idSize = refs.version ? 4 : 2;
    let exifId: number | undefined;
    const described = new Set<number>();
    for (const item of children(refs.at, iref.end).filter(item => item.type === "cdsc")) {
      if (item.data + idSize + 2 > item.end) return;
      const from = idSize === 4 ? u32(item.data) : u16(item.data), count = u16(item.data + idSize);
      if (!ids.has(from) || described.has(from) || item.data + idSize + 2 + count * idSize !== item.end) return;
      described.add(from);
      const targets = new Set<number>();
      for (let i = 0; i < count; i++) {
        const at = item.data + idSize + 2 + i * idSize, target = idSize === 4 ? u32(at) : u16(at);
        if (!ids.has(target) || targets.has(target)) return;
        targets.add(target);
      }
      if (types.get(from) === "Exif" && targets.has(primaryId)) {
        if (exifId !== undefined) return; // Ambiguous primary capture provenance.
        exifId = from;
      }
    }
    if (exifId === undefined) return;
    const iloc = only(contents, "iloc"), locations = full(iloc, [0, 1, 2]);
    if (locations.flags || locations.at + 2 > iloc.end) return;
    const offsetSize = bytes[locations.at] >> 4, lengthSize = bytes[locations.at] & 15;
    const baseSize = bytes[locations.at + 1] >> 4, indexSize = bytes[locations.at + 1] & 15;
    if ([offsetSize, lengthSize, baseSize, indexSize].some(size => size > 8) || (!locations.version && indexSize)) return;
    let cursor = locations.at + 2;
    const integer = (length: number) => {
      if (cursor + length > iloc.end) throw Error();
      let value = 0;
      for (let i = 0; i < length; i++) value = value * 256 + bytes[cursor++];
      if (!Number.isSafeInteger(value)) throw Error();
      return value;
    };
    const count = integer(locations.version === 2 ? 4 : 2);
    if (count > 4096) return;
    const located = new Set<number>();
    let selected: ExifExtent[] | undefined, totalExtents = 0;
    for (let i = 0; i < count; i++) {
      const id = integer(locations.version === 2 ? 4 : 2), method = locations.version ? integer(2) : 0;
      const reference = integer(2), base = integer(baseSize), extentCount = integer(2);
      if (!ids.has(id) || located.has(id) || (totalExtents += extentCount) > 4096) return;
      located.add(id);
      let totalBytes = 0;
      if (id === exifId) {
        if (method > 1 || reference || !extentCount || extentCount > 32) return;
        selected = [];
      }
      for (let j = 0; j < extentCount; j++) {
        const index = integer(indexSize), offset = integer(offsetSize), length = integer(lengthSize);
        if (id !== exifId) continue;
        if (index || !length || (totalBytes += length) > MAX_EXIF_BYTES) return;
        const container = method === 1 ? only(contents, "idat") : undefined;
        const start = base + offset + (container?.data ?? 0), end = start + length;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end > fileSize) return;
        if (container ? end > container.end : !tops.some(item => item.type === "mdat" && start >= item.data && end <= item.end)) return;
        selected!.push({offset: start, length});
      }
    }
    if (cursor !== iloc.end || !selected || selected.reduce((sum, extent) => sum + extent.length, 0) < 12) return;
    return selected;
  } catch {return;}
}

export async function boundedPhotoBitmap(source: Blob, dimensions: PhotoDimensions, maximum: 256 | 512 | 1600, check: () => void = () => {}) {
  safePhotoDimensions(dimensions); check();
  const scale = Math.min(1, maximum / Math.max(dimensions.width, dimensions.height));
  const width = Math.max(1, Math.round(dimensions.width * scale)), height = Math.max(1, Math.round(dimensions.height * scale));
  const image = await createImageBitmap(source, {resizeWidth: width, resizeHeight: height, resizeQuality: "high"});
  try {
    check();
    if (image.width !== width || image.height !== height) throw new Error("This browser could not resize the photo safely.");
    return image;
  } catch (error) {image.close(); throw error;}
}
export async function photoPreview(source: Blob, dimensions: PhotoDimensions, maximum: 256 | 512 | 1600, check: () => void = () => {}) {
  const image = await boundedPhotoBitmap(source, dimensions, maximum, check);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("This browser could not prepare the photo.");
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("This photo could not be prepared.")), "image/jpeg", 0.85));
    check();
    return {blob, width: image.width, height: image.height};
  } finally {image.close(); canvas.width = 0; canvas.height = 0;}
}
