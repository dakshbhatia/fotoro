import type {Photo} from "./catalog";

export interface ShareEnvironment {
  canShare?: (data: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  download: (file: File) => void;
}
export function downloadOriginal(file: File) {
  const url = URL.createObjectURL(file), link = document.createElement("a");
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function canShareOriginal(file: File, environment: Pick<ShareEnvironment, "canShare" | "share"> = navigator) {
  return canShareOriginals([file], environment);
}
export function canShareOriginals(files: readonly File[], environment: Pick<ShareEnvironment, "canShare" | "share"> = navigator) {
  try {return files.length > 0 && typeof environment.share === "function" && environment.canShare?.({files: [...files]}) === true;} catch {return false;}
}
/* Call with a verified original from a fresh user gesture; no asynchronous preparation precedes share(). */
export async function shareOriginal(file: File, current: () => boolean, environment: ShareEnvironment = {
  canShare: data => navigator.canShare?.(data) ?? false,
  share: data => navigator.share(data),
  download: downloadOriginal,
}): Promise<"shared" | "downloaded" | "cancelled"> {
  return shareOriginals([file], current, environment);
}
export async function shareOriginals(files: readonly File[], current: () => boolean, environment: ShareEnvironment = {
  canShare: data => navigator.canShare?.(data) ?? false,
  share: data => navigator.share(data),
  download: downloadOriginal,
}): Promise<"shared" | "downloaded" | "cancelled"> {
  const originals = [...files];
  if (!originals.length || !current()) throw new Error("SOURCE_UNAVAILABLE");
  if (canShareOriginals(originals, environment)) {
    if (!current()) throw new Error("SOURCE_UNAVAILABLE");
    try {await environment.share!({files: originals}); return "shared";}
    catch (error) {if ((error as Error).name === "AbortError") return "cancelled"; throw error;}
  }
  for (const file of originals) {
    if (!current()) throw new Error("SOURCE_UNAVAILABLE");
    environment.download(file);
  }
  return "downloaded";
}

const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : value;
export function savedOriginalSelectionCurrent(sources: readonly Photo[], catalog: readonly Photo[], selected: ReadonlySet<string>, account: string) {
  if (!sources.length || selected.size !== sources.length) return false;
  return sources.every(source => {
    const id = source.manifest.photoId, photo = catalog.find(value => value.manifest.photoId === id);
    return selected.has(id) && source.manifest.ownerAccountId === account && !source.grantId && !!photo && !photo.grantId &&
      JSON.stringify(ordered([photo.manifest, photo.metadata])) === JSON.stringify(ordered([source.manifest, source.metadata]));
  });
}
export async function prepareSavedOriginals(sources: readonly Photo[], signal: AbortSignal, current: () => boolean,
  read: (photo: Photo, kind: "original", signal: AbortSignal) => Promise<Uint8Array>,
  filesForOriginal: (bytes: Uint8Array, photo: Photo) => File[] | Promise<File[]> = (bytes, photo) => [new File([new Uint8Array(bytes)], photo.metadata.filename, {type: photo.metadata.mediaType})]) {
  const files: File[] = [];
  const check = () => {signal.throwIfAborted(); if (!sources.length || !current()) throw new DOMException("Photo selection changed", "AbortError");};
  try {
    check();
    for (const photo of sources) {
      check();
      const bytes = await read(photo, "original", signal);
      try {
        check(); const originals = await filesForOriginal(bytes, photo); check();
        if (!originals.length) throw new Error("SOURCE_UNAVAILABLE");
        files.push(...originals);
      } finally {bytes.fill(0);}
    }
    check(); return files;
  } catch (error) {files.length = 0; throw error;}
}

/* Keep the native share call inside the click, while coalescing overlapping gestures. */
export class OriginalShareAttempt {
  private running = false;
  get pending() {return this.running;}
  run(file: File, current: () => boolean, environment?: ShareEnvironment): Promise<"shared" | "downloaded" | "cancelled" | "busy"> {
    return this.runFiles([file], current, environment);
  }
  runFiles(files: readonly File[], current: () => boolean, environment?: ShareEnvironment): Promise<"shared" | "downloaded" | "cancelled" | "busy"> {
    if (this.running) return Promise.resolve("busy");
    this.running = true;
    return shareOriginals(files, current, environment).finally(() => {this.running = false;});
  }
}
