import { captureDate } from "../library/exif";
export interface LocalPhoto {
  id: string;
  file: File;
  filename: string;
  date: string;
  dateSource: "exif" | "selected";
  width?: number;
  height?: number;
}
export const MAX_ORIGINAL = 50 * 1024 * 1024;
export const LOCAL_RASTER_BUDGET = 48 * 1024 * 1024;
export function localFormat(file: Pick<File, "type" | "name" | "size">) {
  if (!file.size) throw new Error("This file is empty.");
  if (file.size > MAX_ORIGINAL)
    throw new Error("Choose photos smaller than 50 MB.");
  if (file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)) return "jpeg";
  if (file.type === "image/png" || /\.png$/i.test(file.name)) return "png";
  if (/image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name))
    return "heic";
  throw new Error(
    "Choose JPEG, PNG, or HEIC photos. Other files were skipped.",
  );
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
export async function localPhoto(file: File): Promise<LocalPhoto> {
  const format = localFormat(file);
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  if (format === "jpeg" && (bytes[0] !== 255 || bytes[1] !== 216))
    throw new Error("This JPEG could not be read. It was skipped.");
  if (
    format === "png" &&
    ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
  )
    throw new Error("This PNG could not be read. It was skipped.");
  const captured = captureDate(bytes);
  let dimensions = imageDimensions(bytes);
  if (dimensions && jpegOrientation(bytes) >= 5)
    dimensions = { width: dimensions.height, height: dimensions.width };
  if (!dimensions)
    throw new Error(
      format === "heic"
        ? "This HEIC cannot be opened safely by this browser. Try a JPEG or PNG copy."
        : "This photo’s dimensions could not be read safely. It was skipped.",
    );
  if (dimensions.width * dimensions.height > 80_000_000)
    throw new Error(
      "This photo is too large to open safely in this browser. It was skipped.",
    );
  return {
    id: crypto.randomUUID(),
    file,
    filename: file.name,
    date: captured ?? new Date().toISOString(),
    dateSource: captured ? "exif" : "selected",
    ...dimensions,
  };
}
interface Raster {
  url: string;
  bytes: number;
  decoded: number;
  width: number;
  height: number;
  used: number;
}
/** File references stay in memory. Raster generation is sequential and caches are bounded. */
export class LocalResources {
  private cache = new Map<string, Raster>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<Raster>>();
  private generation = 0;
  async load(
    photo: LocalPhoto,
    kind: "thumbnail" | "preview",
  ): Promise<Raster> {
    const key = photo.id + ":" + kind;
    const found = this.cache.get(key);
    if (found) {
      found.used = Date.now();
      return found;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const promise = this.queue.then(async () => {
      if (generation !== this.generation)
        throw new Error("Photos were cleared.");
      let image: ImageBitmap;
      try {
        const max = kind === "thumbnail" ? 256 : 1600;
        if (!photo.width || !photo.height)
          throw new Error("Photo dimensions are unavailable.");
        const ratio = Math.min(1, max / Math.max(photo.width, photo.height));
        image = await createImageBitmap(photo.file, {
          resizeWidth: Math.max(1, Math.round(photo.width * ratio)),
          resizeHeight: Math.max(1, Math.round(photo.height * ratio)),
          resizeQuality: "high",
        });
      } catch {
        throw new Error(
          localFormat(photo.file) === "heic"
            ? "HEIC is not supported by this browser. It was skipped."
            : "This photo could not be opened. It was skipped.",
        );
      }
      try {
        photo.width ??= image.width;
        photo.height ??= image.height;
        const max = kind === "thumbnail" ? 256 : 1600;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context)
          throw new Error("This browser could not prepare the photo.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error("This photo could not be prepared.")),
            "image/jpeg",
            0.85,
          ),
        );
        if (generation !== this.generation)
          throw new Error("Photos were cleared.");
        const decoded = canvas.width * canvas.height * 4;
        const budget = LOCAL_RASTER_BUDGET / 2;
        const entries = [...this.cache.entries()]
          .filter(([id]) => id.endsWith(":" + kind))
          .sort((a, b) => a[1].used - b[1].used);
        let held = entries.reduce((n, [, v]) => n + v.decoded, 0);
        for (const [id, value] of entries) {
          if (held + decoded <= budget) break;
          URL.revokeObjectURL(value.url);
          this.cache.delete(id);
          held -= value.decoded;
        }
        const value = {
          url: URL.createObjectURL(blob),
          bytes: blob.size,
          decoded,
          width: photo.width,
          height: photo.height,
          used: Date.now(),
        };
        this.cache.set(key, value);
        canvas.width = 0;
        canvas.height = 0;
        return value;
      } finally {
        image.close();
      }
    });
    this.queue = promise.catch(() => undefined);
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(key);
    }
  }
  clear() {
    this.generation++;
    for (const value of this.cache.values()) URL.revokeObjectURL(value.url);
    this.cache.clear();
    this.pending.clear();
  }
  get decodedBytes() {
    return [...this.cache.values()].reduce((n, v) => n + v.decoded, 0);
  }
}
export function inLast30Days(
  photo: Pick<LocalPhoto, "date" | "dateSource">,
  now = Date.now(),
) {
  // Missing capture metadata stays visible; selection time is never called capture time.
  if (photo.dateSource !== "exif") return true;
  const date = Date.parse(photo.date);
  return date >= now - 30 * 86400000 && date <= now;
}

export async function collectLocalFiles(
  files: File[],
  isCurrent: () => boolean,
  onBatch: (photos: LocalPhoto[]) => void,
  onProgress: (completed: number) => void,
  load: (file: File) => Promise<LocalPhoto> = localPhoto,
): Promise<{ skipped: number; reason: string }> {
  let batch: LocalPhoto[] = [],
    skipped = 0,
    reason = "";
  for (let index = 0; index < files.length; index++) {
    if (!isCurrent()) return { skipped: 0, reason: "" };
    try {
      const photo = await load(files[index]);
      if (!isCurrent()) return { skipped: 0, reason: "" };
      batch.push(photo);
    } catch (error) {
      if (!isCurrent()) return { skipped: 0, reason: "" };
      skipped++;
      reason = (error as Error).message;
    }
    if (!isCurrent()) return { skipped: 0, reason: "" };
    if (batch.length >= 50 || index === files.length - 1) {
      const append = batch;
      batch = [];
      onBatch(append);
      if (!isCurrent()) return { skipped: 0, reason: "" };
      onProgress(index + 1);
    }
  }
  return { skipped, reason };
}
