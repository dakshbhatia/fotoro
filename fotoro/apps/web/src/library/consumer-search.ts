import type {Photo} from "./catalog";
import {cloudSearchRecords} from "./search";
import type {LocalPhoto} from "../local/resources";
import {LocalResources, imageDimensions} from "../local/resources";
import type {SearchResult, SearchMeaning} from "../local/search";
import type {PhotoLocationV1} from "@fotoro/contracts";
import type {PhotoObservationV1} from "@fotoro/contracts/intelligence";
import type {PeopleAssignment} from "@fotoro/contracts/people";
const savedSources = new WeakMap<object, {snapshot: OwnedPhotoSnapshot; date: string; dateSource: LocalPhoto["dateSource"]; digest?: string; file?: File; location?: PhotoLocationV1}>();
export function mergeConsumerSearchPhotos<T extends {id: string}>(local: T[], saved: T[]): T[] {
  const localIDs = new Set(local.map(photo => photo.id));
  const currentSaved = saved.filter(photo => savedSources.get(photo)?.snapshot.current() ?? true);
  const savedByID = new Map(currentSaved.map(photo => [photo.id, photo]));
  const displayed = local.map(photo => {
    const savedPhoto = savedByID.get(photo.id), source = savedPhoto && savedSources.get(savedPhoto);
    const original = photo as T & Partial<LocalPhoto>;
    if (!source || !(original.file instanceof File) || original.file !== source.file || !source.digest || comparableDigest(original) !== source.digest) return photo;
    const location = original.location ?? source.location;
    const promoteDate = original.dateSource === "selected" && ["photos", "exif"].includes(source.dateSource) && Number.isFinite(Date.parse(source.date));
    if (!promoteDate && location === original.location) return photo;
    return {...photo, ...(promoteDate ? {date: source.date, dateSource: source.dateSource, captureVerified: source.dateSource === "exif" ? true : original.captureVerified} : {}), ...(location ? {location} : {}),
      current: () => source.snapshot.current() && original.current?.() !== false && (savedPhoto as Partial<LocalPhoto>).current?.() !== false};
  });
  return [...displayed, ...currentSaved.filter(photo => !localIDs.has(photo.id))];
}
export interface OwnedPhotoSnapshot {
  accountId: string;
  token: object;
  photos: Photo[];
  current: () => boolean;
  preview: (photo: Photo) => Promise<Blob>;
  edit?: (photo: Photo, changes: {labels?: string[]; favorite?: boolean; location?: PhotoLocationV1; observation?: PhotoObservationV1; people?: PeopleAssignment[]}) => Promise<void>;
  locate?: (updates: readonly {photo: Photo; location: PhotoLocationV1}[]) => Promise<{applied: number; failed: number; updatedPhotoIDs: string[]}>;
  people?: (updates: readonly {photo: Photo; assignments: PeopleAssignment[]}[]) => Promise<void>;
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
      visual: record.visual ? {...record.visual, photoID: id} : undefined,
      current: () => snapshot.current() && record.current?.() !== false,
      captureVerified: record.dateSource === "exif" ? true as const : undefined,
      previewLoader: async () => {
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        const blob = await snapshot.preview(photo);
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        return blob;
      }};
    savedSources.set(adapted, {snapshot, date: record.date, dateSource: record.dateSource, digest: record.digest, file: original?.file, location: record.location});
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
  return {...local, meanings: [...meanings.values()], meaning: meaning ? {...meaning, photoIds} : undefined, photoIds, photoId};
}
