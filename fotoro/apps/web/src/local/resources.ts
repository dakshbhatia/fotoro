import { captureDate } from "../library/exif";
import {photoFormat, displayPhotoDimensions, safePhotoDimensions, boundedPhotoBitmap, photoPreview, PHOTO_HEADER_BYTES} from "../media/photo-source";
export {imageDimensions} from "../media/photo-source";
import type { SearchOcr } from "./search";
export interface LocalPhoto {
  id: string;
  file?: File;
  digest?: string;
  originalSize?: number;
  preview?: Blob;
  previewLoader?: () => Promise<Blob>;
  previewAvailable?: boolean;
  previewSize?: number;
  labels?: string[];
  caption?: string;
  keywords?: string[];
  facts?: string[];
  favorite?: boolean;
  ocr?: SearchOcr;
  filename: string;
  date: string;
  dateSource: "exif" | "selected";
  captureVerified?: true;
  width?: number;
  height?: number;
}
export const MAX_ORIGINAL = 50 * 1024 * 1024;
export const LOCAL_RASTER_BUDGET = 48 * 1024 * 1024;
export function localFormat(file: Pick<File, "type" | "name" | "size">) {
  if (!file.size) throw new Error("This file is empty.");
  if (file.size > MAX_ORIGINAL)
    throw new Error("Choose photos smaller than 50 MB.");
  const format = photoFormat(file);
  if (format) return format;
  throw new Error(
    "Choose JPEG, PNG, or HEIC photos. Other files were skipped.",
  );
}
export async function localPhoto(file: File): Promise<LocalPhoto & { file: File }> {
  const format = localFormat(file);
  const bytes = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
  if (format === "jpeg" && (bytes[0] !== 255 || bytes[1] !== 216))
    throw new Error("This JPEG could not be read. It was skipped.");
  if (
    format === "png" &&
    ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
  )
    throw new Error("This PNG could not be read. It was skipped.");
  const captured = captureDate(bytes);
  const dimensions = displayPhotoDimensions(bytes, format, file.size);
  if (!dimensions)
    throw new Error(
      format === "heic"
        ? "This HEIC cannot be opened safely by this browser. Try a JPEG or PNG copy."
        : "This photo’s dimensions could not be read safely. It was skipped.",
    );
  safePhotoDimensions(dimensions);
  if (format === "heic") {
    try {const bitmap = await boundedPhotoBitmap(file, dimensions, 256); bitmap.close();}
    catch {throw new Error("HEIC is not supported by this browser. Try Safari 17 or later, or choose a JPEG or PNG copy.");}
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), value => value.toString(16).padStart(2, "0")).join("");
  return {
    id: digest,
    digest,
    originalSize: file.size,
    file,
    filename: file.name,
    date: captured ?? new Date().toISOString(),
    dateSource: captured ? "exif" : "selected",
    captureVerified: captured ? true : undefined,
    ...dimensions,
  };
}
interface Raster {
  url: string;
  blob: Blob;
  bytes: number;
  decoded: number;
  width: number;
  height: number;
  used: number;
}
/* File references stay in memory. Raster generation is sequential and caches are bounded. */
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
      const check = () => {if (generation !== this.generation) throw new Error("Photos were cleared.");};
      let raster: Awaited<ReturnType<typeof photoPreview>>;
      try {
        if (!photo.width || !photo.height) throw new Error("Photo dimensions are unavailable.");
        const source = photo.file ?? photo.preview ?? await photo.previewLoader?.();
        if (!source) throw new Error("Preview unavailable. Reselect this photo.");
        check();
        raster = await photoPreview(source, {width: photo.width, height: photo.height}, kind === "thumbnail" ? 512 : 1600, check);
        check();
      } catch {
        check();
        throw new Error(
          !photo.file ? "Preview unavailable. Reselect this photo."
            : localFormat(photo.file) === "heic" ? "HEIC is not supported by this browser. Try Safari 17 or later, or choose a JPEG or PNG copy."
            : "This photo could not be opened. It was skipped.",
        );
      }
      const {blob, width, height} = raster;
      const decoded = width * height * 4;
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
        blob,
        bytes: blob.size,
        decoded,
        width,
        height,
        used: Date.now(),
      };
      this.cache.set(key, value);
      return value;
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
