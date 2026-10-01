import type {Photo} from "./catalog";
import {cloudSearchRecords} from "./search";
import type {LocalPhoto} from "../local/resources";
import {LocalResources, imageDimensions} from "../local/resources";
import type {SearchResult, SearchMeaning} from "../local/search";
export interface OwnedPhotoSnapshot {
  accountId: string;
  token: object;
  photos: Photo[];
  current: () => boolean;
  preview: (photo: Photo) => Promise<Blob>;
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
function comparableDigest(photo: LocalPhoto) {
  const digest = photo.digest;
  if (!digest) return undefined;
  if (!/^[a-f0-9]{64}$/i.test(digest)) return digest;
  return btoa(String.fromCharCode(...digest.match(/../g)!.map(value => parseInt(value, 16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** This adapter consumes verified owned catalog records. Account records never enter local retention. */
export function savedSearchPhotos(snapshot: OwnedPhotoSnapshot | null, local: LocalPhoto[]): LocalPhoto[] {
  if (!snapshot?.current()) return [];
  const selected = new Map(local.filter(photo => photo.file).map(photo => [comparableDigest(photo), photo.id]));
  const owned = snapshot.photos.filter(photo => !photo.grantId && photo.manifest.ownerAccountId === snapshot.accountId);
  return cloudSearchRecords(owned).map((record, index) => {
    const photo = owned[index];
    return {...record, id: selected.get(record.digest) ?? "saved:" + photo.manifest.photoId, originalSize: photo.metadata.originalBytes,
      previewLoader: async () => {
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        const blob = await snapshot.preview(photo);
        if (!snapshot.current()) throw new Error("Your saved library is locked.");
        return blob;
      }};
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
