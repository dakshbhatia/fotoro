import type {Photo} from "./catalog";
import {cloudSearchRecords} from "./search";
import type {LocalPhoto} from "../local/resources";
import {LocalResources, imageDimensions} from "../local/resources";
import type {SearchResult, SearchMeaning} from "../local/search";
const savedSources = new WeakMap<object, {snapshot: OwnedPhotoSnapshot; date: string; dateSource: LocalPhoto["dateSource"]; digest?: string; file?: File}>();
export function mergeConsumerSearchPhotos<T extends {id: string}>(local: T[], saved: T[]): T[] {
  const localIDs = new Set(local.map(photo => photo.id));
  const currentSaved = saved.filter(photo => savedSources.get(photo)?.snapshot.current() ?? true);
  const savedByID = new Map(currentSaved.map(photo => [photo.id, photo]));
  const displayed = local.map(photo => {
    const savedPhoto = savedByID.get(photo.id), source = savedPhoto && savedSources.get(savedPhoto);
    const original = photo as T & Partial<LocalPhoto>;
    if (!source || original.dateSource !== "selected" || !(original.file instanceof File) || original.file !== source.file
      || !source.digest || comparableDigest(original) !== source.digest
      || !["photos", "exif"].includes(source.dateSource) || !Number.isFinite(Date.parse(source.date))) return photo;
    return {...photo, date: source.date, dateSource: source.dateSource, captureVerified: source.dateSource === "exif" ? true : original.captureVerified};
  });
  return [...displayed, ...currentSaved.filter(photo => !localIDs.has(photo.id))];
}
export interface OwnedPhotoSnapshot {
  accountId: string;
  token: object;
  photos: Photo[];
  current: () => boolean;
  preview: (photo: Photo) => Promise<Blob>;
  edit?: (photo: Photo, changes: {labels?: string[]; favorite?: boolean}) => Promise<void>;
}
export class ConsumerPreviewResources extends LocalResources {
  private sourceGeneration = 0;
  override async load(photo: LocalPhoto, kind: "thumbnail" | "preview") {
    const generation = this.sourceGeneration;
    if (!photo.file && (photo.preview || photo.previewLoader)) {
      const preview = photo.preview ?? await photo.previewLoader?.();
      if (!preview) throw new Error("Saved preview unavailable.");
      const dimensions = imageDimensions(new Uint8Array(await preview.slice(0, 256 * 1024).arrayBuffer()));
      if (generation !== this.sourceGeneration) throw new Error("Photos were cleared.");
      if (!dimensions || dimensions.width > 1600 || dimensions.height > 1600) throw new Error("Saved preview dimensions are unavailable.");
      return super.load({...photo, ...dimensions, preview, previewLoader: undefined}, kind);
    }
    return super.load(photo, kind);
  }
  override clear() {this.sourceGeneration++; super.clear();}
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
    const adapted = {...record, id: original?.id ?? "saved:" + photo.manifest.photoId, originalSize: photo.metadata.originalBytes,
      captureVerified: record.dateSource === "exif" ? true as const : undefined,
      previewLoader: async () => {
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        const blob = await snapshot.preview(photo);
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        return blob;
      }};
    savedSources.set(adapted, {snapshot, date: record.date, dateSource: record.dateSource, digest: record.digest, file: original?.file});
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
