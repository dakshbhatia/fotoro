import {useEffect, useMemo, useRef, useState} from "react";
import type {Photo, CatalogCoverage} from "./catalog";
import {cloudSearchRecords} from "./search";
import type {LocalPhoto} from "../local/resources";
import {LocalResources, imageDimensions} from "../local/resources";
import type {SearchResult, SearchMeaning, SearchPhoto, PhotoSearchIndex} from "../local/search";
import type {PhotoLocationV1} from "@fotoro/contracts";
import type {PhotoObservationV1} from "@fotoro/contracts/intelligence";
import type {PeopleAssignment} from "@fotoro/contracts/people";
const savedSources = new WeakMap<object, {snapshot: OwnedPhotoSnapshot; photo: Photo; date: string; dateSource: LocalPhoto["dateSource"]; digest?: string; file?: File; location?: PhotoLocationV1}>();
// Only an adapted, owned source can bind private inference to an account.
export function savedInferenceSource(photo: LocalPhoto) {
  const source = savedSources.get(photo);
  if (!source || !source.digest || source.digest !== photo.digest || source.photo.grantId
    || source.photo.manifest.ownerAccountId !== source.snapshot.accountId) return;
  const digest = source.digest, revision = JSON.stringify(source.photo.manifest);
  const current = () => photo.current?.() !== false && photo.digest === digest
    && source.photo.metadata.originalSha256 === digest && JSON.stringify(source.photo.manifest) === revision
    && (source.snapshot.sourceCurrent?.(source.photo) ?? source.snapshot.current());
  if (!current()) return;
  return {accountId: source.snapshot.accountId, token: source.snapshot.token, photoId: source.photo.manifest.photoId, digest, revision, current};
}
export function mergeConsumerSearchPhotos<T extends {id: string}>(local: T[], saved: T[]): T[] {
  const localIDs = new Set(local.map(photo => photo.id));
  const currentSaved = saved.filter(photo => savedSources.get(photo)?.snapshot.current() ?? true);
  const savedByID = new Map(currentSaved.map(photo => [photo.id, photo]));
  const displayed = local.map(photo => {
    const savedPhoto = savedByID.get(photo.id), source = savedPhoto && savedSources.get(savedPhoto);
    const original = photo as T & Partial<LocalPhoto>;
    if (!source || !(original.file instanceof File) || original.file !== source.file || !source.digest || comparableDigest(original) !== source.digest
      || (savedPhoto as Partial<LocalPhoto>).current?.() === false) return photo;
    const location = original.location ?? source.location;
    const favorite = original.favorite ?? (savedPhoto as Partial<LocalPhoto>).favorite;
    const promoteDate = original.dateSource === "selected" && ["photos", "exif"].includes(source.dateSource) && Number.isFinite(Date.parse(source.date));
    if (!promoteDate && location === original.location && favorite === original.favorite) return photo;
    return {...photo, ...(promoteDate ? {date: source.date, dateSource: source.dateSource, captureVerified: source.dateSource === "exif" ? true : original.captureVerified} : {}), ...(location ? {location} : {}), ...(favorite !== undefined ? {favorite} : {}),
      current: () => source.snapshot.current() && original.current?.() !== false && (savedPhoto as Partial<LocalPhoto>).current?.() !== false};
  });
  return [...displayed, ...currentSaved.filter(photo => !localIDs.has(photo.id))];
}
export interface OwnedPhotoSnapshot {
  accountId: string;
  token: object;
  photos: Photo[];
  coverage?: CatalogCoverage;
  metadataSearchError?: string;
  metadataSearch?: {token: object; complete: boolean; records: SearchPhoto[]; browseIds: ReadonlySet<string>; current: () => boolean;
    search: PhotoSearchIndex["search"];
    searchAsync: PhotoSearchIndex["searchAsync"];
    hydrate: (ids: readonly string[], signal: AbortSignal, current: () => boolean) => Promise<void>};
  selectionReady?: boolean;
  retainSelection?: (ids: ReadonlySet<string>) => void;
  current: () => boolean;
  sourceCurrent?: (photo: Photo) => boolean;
  preview: (photo: Photo) => Promise<Blob>;
  edit?: (photo: Photo, changes: {labels?: string[]; favorite?: boolean; location?: PhotoLocationV1; observation?: PhotoObservationV1; people?: PeopleAssignment[]}) => Promise<void>;
  locate?: (updates: readonly {photo: Photo; location: PhotoLocationV1}[]) => Promise<{applied: number; failed: number; updatedPhotoIDs: string[]}>;
  people?: (updates: readonly {photo: Photo; assignments: PeopleAssignment[]}[]) => Promise<void>;
}
export function accountSearchResult(search: PhotoSearchIndex["search"], records: SearchPhoto[], ids: ReadonlyMap<string, string>, query: string, options: Parameters<PhotoSearchIndex["search"]>[1]) {
  const allowedIds = options?.allowedIds ? new Set(records.filter(record => options.allowedIds!.has(ids.get(record.id) ?? "saved:" + record.id)).map(record => record.id)) : undefined;
  const result = search(query, {...options, allowedIds});
  const idFor = (id: string) => ids.get(id) ?? "saved:" + id;
  const meaning = (value: SearchMeaning) => ({...value, photoIds: [...new Set(value.photoIds.map(idFor))], evidence: Object.fromEntries(Object.entries(value.evidence).map(([id, source]) => [idFor(id), source]))});
  return {...result, photoIds: [...new Set(result.photoIds.map(idFor))], photoId: result.photoId ? idFor(result.photoId) : undefined,
    meanings: result.meanings.map(meaning), meaning: result.meaning ? meaning(result.meaning) : undefined};
}
export async function accountSearchResultAsync(search: PhotoSearchIndex["searchAsync"], records: SearchPhoto[], ids: ReadonlyMap<string, string>, query: string, options: Parameters<PhotoSearchIndex["search"]>[1], signal: AbortSignal, current: () => boolean) {
  let deadline = performance.now() + 4;
  const check = () => {if (signal.aborted || !current()) throw new DOMException("Search cancelled", "AbortError");};
  const pause = async () => {check(); if (performance.now() >= deadline) {await new Promise(resolve => setTimeout(resolve, 0)); check(); deadline = performance.now() + 4;}};
  const idFor = (id: string) => ids.get(id) ?? "saved:" + id;
  const allowedIds = options?.allowedIds ? new Set<string>() : undefined;
  if (allowedIds) for (const record of records) {if (options!.allowedIds!.has(idFor(record.id))) allowedIds.add(record.id); await pause();}
  const result = await search(query, {...options, allowedIds}, signal, current);
  const mapped = new Map<SearchMeaning, SearchMeaning>();
  for (const value of new Set([...result.meanings, ...(result.meaning ? [result.meaning] : [])])) {
    const photoIds = new Set<string>(), evidence: SearchMeaning["evidence"] = {};
    for (const id of value.photoIds) {const display = idFor(id); photoIds.add(display); evidence[display] = value.evidence[id]; await pause();}
    mapped.set(value, {...value, photoIds: [...photoIds], evidence});
  }
  check(); if (result.current?.() === false) throw new Error("CACHED_SEARCH_SOURCE_CHANGED"); return {...result, photoIds: [...new Set(result.photoIds.map(idFor))], photoId: result.photoId ? idFor(result.photoId) : undefined,
    meanings: result.meanings.map(value => mapped.get(value)!), meaning: result.meaning ? mapped.get(result.meaning) : undefined};
}
// A result belongs to one request. Replacement clears it and aborts its work.
export function useAccountSearch(query: string, scope: string, request: ((signal: AbortSignal, current: () => boolean) => Promise<SearchResult>) | undefined, enabled: boolean) {
  const latest = useRef(request); latest.current = request;
  const [visibleEpoch, setVisibleEpoch] = useState(0);
  const [published, setPublished] = useState<{request: typeof request; result: SearchResult}>();
  useEffect(() => {
    setPublished(undefined);
    if (!request || !enabled) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && latest.current === request && document.visibilityState === "visible";
    const withdraw = () => {controller.abort(); setPublished(undefined);};
    const visibility = () => {withdraw(); if (document.visibilityState === "visible") setVisibleEpoch(value => value + 1);};
    document.addEventListener("visibilitychange", visibility); window.addEventListener("fotoro-lock", withdraw); window.addEventListener("pagehide", withdraw);
    if (current()) void request(controller.signal, current).then(result => {if (current()) {
        if (result.current?.() === false) throw new Error("CACHED_SEARCH_SOURCE_CHANGED");
        setPublished({request, result});
      }}).catch(() => {
      if (current()) setPublished({request, result: {query, scope, meanings: [], photoIds: [], metadataIncomplete: true}});
    });
    return () => {controller.abort(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("fotoro-lock", withdraw); window.removeEventListener("pagehide", withdraw);};
  }, [request, enabled, visibleEpoch]);
  const pending = useMemo<SearchResult>(() => ({query, scope, meanings: [], photoIds: [], searching: !!request && enabled}), [query, scope, request, enabled]);
  const stale = useMemo<SearchResult>(() => ({query, scope, meanings: [], photoIds: [], metadataIncomplete: true}), [query, scope]);
  if (published && published.request === request && enabled) return published.result.current?.() === false ? stale : published.result;
  return pending;
}
export function savedMetadataRecords(records: SearchPhoto[], local: LocalPhoto[]): SearchPhoto[] {
  const selected = new Map(local.flatMap(photo => {
    const digest = comparableDigest(photo);
    return photo.file instanceof File && digest ? [[digest, photo.id] as const] : [];
  }));
  return records.map(record => {
    const id = record.digest && selected.get(record.digest) || "saved:" + record.id;
    return {...record, id, observationPhotoId: record.id,
      ocr: record.ocr ? {...record.ocr, photoID: id} : undefined,
      visual: record.visual ? {...record.visual, photoID: id} : undefined};
  });
}
export class SavedMetadataProjection {
  private source?: SearchPhoto[];
  private binding = "";
  private records: SearchPhoto[] = [];
  read(source: SearchPhoto[] | undefined, local: LocalPhoto[]) {
    if (!source) {
      if (this.source) this.records = [];
      this.source = undefined; this.binding = ""; return this.records;
    }
    const binding = JSON.stringify(local.filter(photo => photo.file instanceof File && comparableDigest(photo)).map(photo => [photo.id, comparableDigest(photo)]));
    if (this.source === source && this.binding === binding) return this.records;
    this.source = source; this.binding = binding;
    return this.records = savedMetadataRecords(source, local);
  }
}
export class ConsumerSelectionRetention {
  private binding?: {accountId: string; token: object; origin: string; current: () => boolean};
  private selected = new Set<string>();
  clear() {this.binding = undefined; this.selected.clear();}
  idsFor(token: object, accountId: string, origin: string) {
    if (this.binding?.token !== token || this.binding.accountId !== accountId || this.binding.origin !== origin || !this.binding.current()) return [];
    return [...this.selected];
  }
  bind(snapshot: OwnedPhotoSnapshot, origin: string, currentOrigin: () => string) {
    if (this.binding?.token !== snapshot.token || this.binding.accountId !== snapshot.accountId || this.binding.origin !== origin) {
      this.clear(); this.binding = {accountId: snapshot.accountId, token: snapshot.token, origin, current: () => currentOrigin() === origin && snapshot.current()};
    }
    this.binding.current = () => currentOrigin() === origin && snapshot.current();
    const binding = this.binding;
    return (ids: ReadonlySet<string>) => {
      if (this.binding !== binding || currentOrigin() !== origin || !snapshot.current()) return;
      const eligible = new Set(snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId
        && (snapshot.sourceCurrent?.(photo) ?? true)).map(photo => photo.manifest.photoId));
      const next = new Set([...ids].filter(id => eligible.has(id)));
      if (snapshot.selectionReady === false && [...next].some(id => !this.selected.has(id))) return;
      this.selected = next;
    };
  }
}
export class ConsumerPreviewResources extends LocalResources {
  private sourceGeneration = 0;
  private previewReads = new WeakMap<object, Promise<Blob | undefined>>();
  private dimensions = new WeakMap<object, {width: number; height: number}>();
  override async load(photo: LocalPhoto, kind: "thumbnail" | "preview", signal?: AbortSignal) {
    signal?.throwIfAborted();
    const generation = this.sourceGeneration;
    if (!photo.file && (photo.preview || photo.previewLoader)) {
      const identity = photo.preview ?? photo.previewLoader!;
      const known = this.dimensions.get(identity);
      if (known) return super.load({...photo, ...known, rasterIdentity: identity,
        previewLoader: photo.preview ? undefined : async () => {
          const preview = await photo.previewLoader!();
          const dimensions = imageDimensions(new Uint8Array(await preview.slice(0,256*1024).arrayBuffer()));
          if (generation !== this.sourceGeneration || !dimensions || dimensions.width !== known.width || dimensions.height !== known.height) throw new Error("Saved preview source changed.");
          return preview;
        }}, kind, signal);
      let read = this.previewReads.get(identity);
      if (!read) {
        read = Promise.resolve().then(() => photo.preview ?? photo.previewLoader?.());
        this.previewReads.set(identity, read);
      }
      let preview: Blob | undefined;
      try {preview = await read;} finally {if (this.previewReads.get(identity) === read) this.previewReads.delete(identity);}
      signal?.throwIfAborted();
      if (!preview) throw new Error("Saved preview unavailable.");
      const dimensions = imageDimensions(new Uint8Array(await preview.slice(0, 256 * 1024).arrayBuffer()));
      if (generation !== this.sourceGeneration) throw new Error("Photos were cleared.");
      if (!dimensions || dimensions.width > 1600 || dimensions.height > 1600) throw new Error("Saved preview dimensions are unavailable.");
      this.dimensions.set(identity, dimensions);
      return super.load({...photo, ...dimensions, preview, previewLoader: undefined, rasterIdentity: identity}, kind, signal);
    }
    return super.load(photo, kind, signal);
  }
  override clear() {this.sourceGeneration++; this.previewReads = new WeakMap(); this.dimensions = new WeakMap(); super.clear();}
}
function comparableDigest(photo: Pick<LocalPhoto, "digest">) {
  const digest = photo.digest;
  if (!digest) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(digest)) return digest;
  return btoa(String.fromCharCode(...digest.match(/../g)!.map(value => parseInt(value, 16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/* This adapter consumes verified owned catalog records. Account records never enter local retention. */
// Search projection identity is independent of Save availability/progress snapshots.
export class SavedSearchProjection {
  private snapshot?: OwnedPhotoSnapshot;
  private local: LocalPhoto[] = [];
  private photos: LocalPhoto[] = [];
  read(snapshot: OwnedPhotoSnapshot | null, local: LocalPhoto[]): LocalPhoto[] {
    if (!snapshot?.current()) {
      if (this.snapshot) this.photos = [];
      this.snapshot = undefined; this.local = []; return this.photos;
    }
    if (this.snapshot?.current() && this.snapshot.token === snapshot.token && this.snapshot.accountId === snapshot.accountId
      && this.snapshot.photos === snapshot.photos && (this.local === local || !this.local.length && !local.length)) return this.photos;
    this.snapshot = snapshot; this.local = local;
    return this.photos = savedSearchPhotos(snapshot, local);
  }
}
export function savedSearchPhotos(snapshot: OwnedPhotoSnapshot | null, local: LocalPhoto[]): LocalPhoto[] {
  if (!snapshot?.current()) return [];
  const selected = new Map(local.flatMap(photo => {
    const digest = comparableDigest(photo);
    return photo.file instanceof File && digest ? [[digest, photo] as const] : [];
  }));
  const owned = snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId);
  return cloudSearchRecords(owned).map((record, index) => {
    const photo = owned[index];
    const original = record.digest ? selected.get(record.digest) : undefined;
    const id = original?.id ?? "saved:" + photo.manifest.photoId;
    const adapted = {...record, id, observationPhotoId: record.id, originalSize: photo.metadata.originalBytes,
      ocr: record.ocr ? {...record.ocr, photoID: id} : undefined,
      visual: record.visual ? {...record.visual, photoID: id} : undefined,
      current: () => (snapshot.sourceCurrent?.(photo) ?? snapshot.current()) && record.current?.() !== false,
      captureVerified: record.dateSource === "exif" ? true as const : undefined,
      previewLoader: async () => {
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        const blob = await snapshot.preview(photo);
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        return blob;
      }};
    savedSources.set(adapted, {snapshot, photo, date: record.date, dateSource: record.dateSource, digest: record.digest, file: original?.file, location: record.location});
    return adapted;
  });
}
export function combineConsumerSearch(local: SearchResult, saved: SearchResult, committed?: string): SearchResult {
  const meanings = new Map<string, SearchMeaning>();
  for (const meaning of [...local.meanings, ...saved.meanings]) {
    const existing = meanings.get(meaning.id);
    meanings.set(meaning.id, existing ? {...existing, photoIds: [...new Set([...existing.photoIds, ...meaning.photoIds])], evidence: {...meaning.evidence, ...existing.evidence}} : meaning);
  }
  const meaning = meanings.get(committed ?? "") ?? meanings.get(local.meaning?.id ?? saved.meaning?.id ?? "");
  const photoIds = [...new Set([
    ...(local.meaning?.id === meaning?.id ? local.photoIds : []),
    ...(saved.meaning?.id === meaning?.id ? saved.photoIds : []),
  ])];
  const photoId = [local.photoId, saved.photoId].find(id => id && photoIds.includes(id)) ?? photoIds[0];
  return {...local, searching: local.searching || saved.searching, metadataIncomplete: local.metadataIncomplete || saved.metadataIncomplete, meanings: [...meanings.values()], meaning: meaning ? {...meaning, photoIds} : undefined, photoIds, photoId};
}
