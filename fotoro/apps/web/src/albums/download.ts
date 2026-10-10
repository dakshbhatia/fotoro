import {Zip, ZipPassThrough} from "fflate";
import {ready, sodium, b64, CryptoError} from "@fotoro/crypto";
import {CAMERA_ORIGINAL_LIMIT} from "@fotoro/contracts/camera-media";
import {diagnose} from "../diagnostics";
import {ApiError} from "../exchange/api-errors";
import type {Photo} from "../library/catalog";
import {albumPhotoGroups, type AlbumPhotoGroup} from "./browse";
import {albumOriginalFiles, type AlbumAccess} from "./service";

export const TRIP_MEMORY_LIMIT = 128 * 1024 * 1024;
const ZIP32_LIMIT = 0xffffffff, temporaryPrefix = "fotoro-trip-", lockName = "fotoro-trip-output", chunkSize = 256 * 1024;
export interface TripDownloadProgress {phase: "checking" | "preparing"; completed: number; total: number;}
export interface TripDownload {file: File; photos: number; duplicates: number; resources: number; dispose: () => Promise<void>;}
export interface TripDownloadSink {
  limit: number;
  write: (chunk: Uint8Array) => Promise<void>;
  finish: (filename: string) => Promise<File>;
  dispose: () => Promise<void>;
}
async function groupOriginalFiles(access: AlbumAccess, group: AlbumPhotoGroup, signal: AbortSignal, check: () => void) {
  for (let index = 0; index < group.copies.length; index++) {
    check();
    try {return await albumOriginalFiles(access, group.copies[index], signal);}
    catch (error) {
      check();
      // Only unavailable or damaged media can fall back to another authenticated
      // copy of the same digest, byte count and media type. Access failures stop.
      const recoverable = error instanceof ApiError ? ["NOT_FOUND", "HTTP_404"].includes(error.code)
        : error instanceof CryptoError ? ["TRUNCATED", "INVALID_RECORD_LENGTH", "AUTHENTICATION_FAILED", "INVALID_TAG", "TRAILING_DATA"].includes(error.code)
        : error instanceof Error && ["CIPHERTEXT_MISMATCH", "ORIGINAL_DIGEST_MISMATCH", "INVALID_LIVE_PHOTO", "LIVE_PHOTO_DIGEST_MISMATCH", "INVALID_ORIGINAL_FILENAME"].includes(error.message);
      if (!recoverable || index + 1 === group.copies.length) throw error;
      await access.assertAccess(); check();
    }
  }
  throw new Error("TRIP_INVALID_ORIGINAL");
}
export function tripFilename(value: string) {
  let basename = value.split(/[\\/]/).at(-1)!.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/[. ]+$/g, "");
  if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])([. ]|$)/i.test(basename)) basename = "_" + basename;
  const encoder = new TextEncoder(), dot = basename.lastIndexOf(".");
  const extension = dot > 0 && encoder.encode(basename.slice(dot)).length <= 24 ? basename.slice(dot) : "";
  const stem = extension ? basename.slice(0, dot) : basename;
  let safe = "";
  for (const character of stem) {if (encoder.encode(safe + character + extension).length > 200) break; safe += character;}
  return (!safe || safe === "." || safe === ".." ? "photo" : safe) + extension;
}
function memorySink(): TripDownloadSink {
  let chunks: Uint8Array<ArrayBuffer>[] = [], bytes = 0;
  return {limit: TRIP_MEMORY_LIMIT,
    async write(chunk) {if (bytes + chunk.length > TRIP_MEMORY_LIMIT) throw new Error("TRIP_MEMORY_LIMIT"); chunks.push(new Uint8Array(chunk)); bytes += chunk.length;},
    async finish(filename) {const file = new File(chunks, filename, {type: "application/zip"}); chunks = []; return file;},
    async dispose() {for (const chunk of chunks) chunk.fill(0); chunks = [];},
  };
}
async function clearAbandoned(directory: FileSystemDirectoryHandle) {
  const entries = directory as FileSystemDirectoryHandle & {keys(): AsyncIterableIterator<string>};
  for await (const name of entries.keys()) if (name.startsWith(temporaryPrefix)) await directory.removeEntry(name);
}
export async function cleanupTripDownloads() {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory || !navigator.locks) return;
  await navigator.locks.request(lockName, {ifAvailable: true}, async lock => {
    if (lock) await clearAbandoned(await navigator.storage.getDirectory());
  }).catch(() => {});
}
async function outputSink(): Promise<TripDownloadSink> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory || !navigator.locks) return memorySink();
  return new Promise(resolve => {
    // A crash releases this origin-scoped lock. The next Trips visit/export can
    // remove abandoned plaintext without ever deleting another tab's active ZIP.
    void navigator.locks.request(lockName, {ifAvailable: true}, async lock => {
      if (!lock) {resolve(memorySink()); return;}
      let release!: () => void;
      const held = new Promise<void>(done => {release = done;});
      let directory: FileSystemDirectoryHandle | undefined, writable: FileSystemWritableFileStream | undefined;
      const temporaryName = temporaryPrefix + crypto.randomUUID();
      try {
        directory = await navigator.storage.getDirectory(); await clearAbandoned(directory);
        const handle = await directory.getFileHandle(temporaryName, {create: true});
        writable = await handle.createWritable();
        let closed = false, removed = false;
        resolve({limit: ZIP32_LIMIT,
          async write(chunk) {await writable!.write(new Uint8Array(chunk));},
          async finish(filename) {
            await writable!.close(); closed = true;
            const file = await handle.getFile(); return new File([file], filename, {type: "application/zip"});
          },
          async dispose() {
            if (removed) return; removed = true;
            try {
              if (!closed) await writable!.abort().catch(() => {});
              await directory!.removeEntry(temporaryName).catch(() => {});
            } finally {release();}
          },
        });
        await held;
      } catch {
        await writable?.abort().catch(() => {});
        await directory?.removeEntry(temporaryName).catch(() => {});
        resolve(memorySink());
      }
    }).catch(() => resolve(memorySink()));
  });
}
async function* fileChunks(file: File, check: () => void) {
  const reader = file.stream().getReader();
  try {
    for (;;) {
      check(); const {done, value} = await reader.read(); check();
      if (done) break;
      try {yield value;} finally {value.fill(0);}
    }
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
async function resourceFingerprint(files: readonly File[], check: () => void) {
  const result: [string, number, string][] = [];
  for (const file of files) {
    const hash = sodium.crypto_hash_sha256_init() as unknown as Parameters<typeof sodium.crypto_hash_sha256_update>[0]; let size = 0;
    for await (const chunk of fileChunks(file, check)) {sodium.crypto_hash_sha256_update(hash, chunk); size += chunk.length;}
    if (size !== file.size) throw new Error("TRIP_INVALID_ORIGINAL");
    result.push([file.type, size, b64(sodium.crypto_hash_sha256_final(hash))]);
  }
  return JSON.stringify(result);
}
export function prepareTripDownload(access: AlbumAccess, signal: AbortSignal, progress: (value: TripDownloadProgress) => void,
  createSink: () => Promise<TripDownloadSink> = outputSink) {
  return diagnose("album", diagnostic => prepare(access, signal, progress, createSink).catch(error => {
    if (error instanceof Error && /TRIP_(INCOMPLETE|CHANGED)|ORIGINAL_DIGEST_MISMATCH/.test(error.message)) diagnostic.incomplete("verification");
    throw error;
  }), "prepare");
}
async function prepare(access: AlbumAccess, signal: AbortSignal, progress: (value: TripDownloadProgress) => void, createSink: () => Promise<TripDownloadSink>): Promise<TripDownload> {
  let sink: TripDownloadSink | undefined, zip: Zip | undefined, success = false;
  const check = () => {signal.throwIfAborted(); if (!access.current()) throw new DOMException("Trip download cancelled", "AbortError");};
  try {
    check(); await ready; check();
    const photos: Photo[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, count = 0;
    for (let pageNumber = 0; ; pageNumber++) {
      check(); if (pageNumber >= 10) throw new Error("TRIP_INCOMPLETE");
      const page = await access.loadPhotoPage(cursor); check(); count = page.photoCount;
      for (const photo of page.photos) {
        if (seen.has(photo.manifest.photoId)) throw new Error("TRIP_INCOMPLETE");
        seen.add(photo.manifest.photoId); photos.push(photo);
      }
      if (photos.length > 1000 || count > 1000) throw new Error("TRIP_INCOMPLETE");
      progress({phase: "checking", completed: photos.length, total: count});
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error("TRIP_INCOMPLETE");
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    if (photos.length !== count) throw new Error("TRIP_INCOMPLETE");
    const current = await access.assertAccess(); check();
    if (current.photoCount !== count) throw new Error("TRIP_CHANGED");
    if (!photos.length) throw new Error("TRIP_EMPTY");
    const groups = albumPhotoGroups(photos, true, access.current.bind(access));
    let budget = 22;
    for (const {photo} of groups) {
      const bytes = photo.metadata.originalBytes;
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > CAMERA_ORIGINAL_LIMIT) throw new Error("TRIP_INVALID_ORIGINAL");
      // Live resource lengths fit inside their verified envelope; reserve two
      // UTF-8 filenames plus local/central headers and descriptors per photo.
      budget += bytes + 2048;
    }
    if (!Number.isSafeInteger(budget) || budget > ZIP32_LIMIT || groups.length * 2 > 65535) throw new Error("TRIP_ZIP_LIMIT");
    sink = await createSink(); check();
    if (budget > sink.limit) throw new Error("TRIP_MEMORY_LIMIT");
    let emitted: Uint8Array[] = [], failure: Error | null = null, finalized = false, outputBytes = 0;
    zip = new Zip((error, chunk, final) => {if (error) failure = error; else {emitted.push(chunk); finalized ||= final;}});
    const flush = async () => {
      if (failure) throw failure;
      for (const chunk of emitted) {
        check(); outputBytes += chunk.length;
        if (outputBytes > sink!.limit || outputBytes > ZIP32_LIMIT) throw new Error("TRIP_ZIP_LIMIT");
        await sink!.write(chunk); check();
      }
      emitted = [];
    };
    const resourcesSeen = new Set<string>(), names = new Set<string>();
    let duplicates = photos.length - groups.length, exported = 0, resources = 0;
    for (let index = 0; index < groups.length; index++) {
      check(); progress({phase: "preparing", completed: index, total: groups.length});
      const files = await groupOriginalFiles(access, groups[index], signal, check); check();
      try {
        if (!files.length || files.length > 2) throw new Error("TRIP_INVALID_ORIGINAL");
        const fingerprint = await resourceFingerprint(files, check); check();
        if (resourcesSeen.has(fingerprint)) {duplicates++; continue;}
        resourcesSeen.add(fingerprint);
        const localNames = new Set<string>();
        for (let at = 0; at < files.length; at++) {
          const originalName = tripFilename(files[at].name);
          const basename = localNames.has(originalName.toLowerCase()) ? String(at + 1) + "_" + originalName : originalName;
          localNames.add(basename.toLowerCase());
          const name = String(exported + 1).padStart(4, "0") + "/" + basename;
          if (names.has(name) || new TextEncoder().encode(name).length > 255) throw new Error("TRIP_INVALID_FILENAME");
          names.add(name);
          const entry = new ZipPassThrough(name); zip.add(entry); await flush();
          for await (const chunk of fileChunks(files[at], check)) {
            for (let start = 0; start < chunk.length; start += chunkSize) {entry.push(chunk.subarray(start, start + chunkSize), false); await flush();}
          }
          entry.push(new Uint8Array(), true); await flush(); resources++;
        }
        exported++;
      } finally {files.length = 0;}
    }
    check(); if ((await access.assertAccess()).photoCount !== count) throw new Error("TRIP_CHANGED"); check();
    zip.end(); await flush(); if (!finalized) throw new Error("TRIP_INCOMPLETE");
    const file = await sink.finish(tripFilename(access.title) + ".zip"); check();
    if ((await access.assertAccess()).photoCount !== count) throw new Error("TRIP_CHANGED"); check();
    progress({phase: "preparing", completed: groups.length, total: groups.length}); success = true;
    return {file, photos: exported, duplicates, resources, dispose: sink.dispose};
  } finally {
    access.dispose(); zip?.terminate();
    if (!success) await sink?.dispose();
  }
}
