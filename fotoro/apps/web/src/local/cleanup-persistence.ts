import {isPhotoTrashed} from "@fotoro/contracts/organization";
import {savedInferenceSource} from "../library/consumer-search";
import {LocalRetention} from "./retention";
import {loadLocalChoices} from "./preferences";
import {privateInferenceEpoch} from "./semantic-persistence";
import {validPhotoSignals, type PhotoSignals} from "./auto-picks";
import type {LocalPhoto} from "./resources";
import {requireVault} from "../vault/vault";

export const CLEANUP_PROCESSOR = "cleanup-preview-v1";
const MAX_SCOPE = 4096;
interface Source {id: string; digest: string; revision: string; width?: number; height?: number}
type StoredSignal = Omit<PhotoSignals, "hash"> & {hash: string};
export interface CleanupCheckpoint {
  version: 1; processor: string; origin: string; account: string | null;
  sources: Source[]; completed: number; signals: [string, StoredSignal][];
}
export interface RestoredCleanup {photos: LocalPhoto[]; completed: number; signals: Map<string, PhotoSignals>}
const pageOrigin = () => typeof location === "undefined" ? "" : location.origin;
function source(photo: LocalPhoto): Source {
  const saved = savedInferenceSource(photo);
  return {id: photo.id, digest: photo.digest ?? "", revision: saved?.revision ?? "local", width: photo.width, height: photo.height};
}
function sameSource(a: Source, b: Source) {
  return a.id === b.id && a.digest === b.digest && a.revision === b.revision && a.width === b.width && a.height === b.height;
}
const identity = (photo: LocalPhoto) => photo.file ?? photo.preview ?? photo.previewLoader ?? photo;
export function restoreCleanupCheckpoint(raw: unknown, photos: readonly LocalPhoto[], origin: string, account: string | null, retired: readonly LocalPhoto[] = []): RestoredCleanup | undefined {
  const row = raw as CleanupCheckpoint | undefined;
  if (!row || row.version !== 1 || row.processor !== CLEANUP_PROCESSOR || row.origin !== origin || row.account !== account ||
    !Array.isArray(row.sources) || row.sources.length < photos.length || row.sources.length > MAX_SCOPE ||
    !Number.isSafeInteger(row.completed) || row.completed < 0 || row.completed > row.sources.length ||
    !Array.isArray(row.signals) || row.signals.length > row.completed) return;
  const byID = new Map(photos.map(photo => [photo.id, photo])), removed = new Map(retired.map(photo => [photo.id, photo]));
  const ordered: LocalPhoto[] = [], seen = new Set<string>(), retiredIDs = new Set<string>();
  let completed = 0;
  for (const [index, entry] of row.sources.entries()) {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) return;
    const photo = byID.get(entry.id);
    if (!photo) {
      const trashed = removed.get(entry.id);
      if (!trashed || trashed.current?.() === false || !isPhotoTrashed(trashed) || !sameSource(entry, source(trashed))) return;
      retiredIDs.add(entry.id); seen.add(entry.id); continue;
    }
    if (photo.current?.() === false || isPhotoTrashed(photo) || !sameSource(entry, source(photo))) return;
    ordered.push(photo); seen.add(entry.id); if (index < row.completed) completed++;
  }
  if (ordered.length !== photos.length) return;
  const admitted = new Set(row.sources.slice(0, row.completed).map(photo => photo.id)), signals = new Map<string, PhotoSignals>();
  for (const entry of row.signals) {
    if (!Array.isArray(entry) || entry.length !== 2 || !admitted.has(entry[0]) || signals.has(entry[0])) return;
    const stored = entry[1];
    if (!stored || typeof stored.hash !== "string" || !/^\d{1,20}$/.test(stored.hash) || !Array.isArray(stored.color)) return;
    const signal = {...stored, hash: BigInt(stored.hash)};
    if (!validPhotoSignals(signal)) return;
    if (!retiredIDs.has(entry[0])) signals.set(entry[0], signal);
  }
  return {photos: ordered, completed, signals};
}
interface Memory {row: CleanupCheckpoint; epoch: number; identities: Map<string, WeakRef<object>>}
let memory: Memory | undefined;

// One encrypted checkpoint per account/origin or opted-in retained local library.
// There is no new photo discovery, image retention or plaintext identifier store.
export class CleanupReviewPersistence {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private retention = new LocalRetention(), private remember = () => loadLocalChoices()?.retain === true,
    private origin = pageOrigin) {}
  private binding(photos: readonly LocalPhoto[], current: () => boolean) {
    const epoch = privateInferenceEpoch(), origin = this.origin(), sources = photos.map(source);
    const saved = photos.map(savedInferenceSource), first = saved[0];
    const allSaved = !!first && saved.every(value => value?.accountId === first.accountId && value.token === first.token);
    const allLocal = !saved.some(Boolean) && photos.every(photo => !photo.id.startsWith("saved:"));
    const account = allSaved ? first.accountId : null;
    const vaultCurrent = () => {
      try {return saved.every(value => !value || requireVault() === value.token && requireVault().accountId === value.accountId && value.current());}
      catch {return false;}
    };
    const valid = () => epoch === privateInferenceEpoch() && this.origin() === origin && current() && photos.every((photo, index) =>
      photo.current?.() !== false && !isPhotoTrashed(photo) && sameSource(sources[index], source(photo))) &&
      vaultCurrent();
    const durable = photos.length <= MAX_SCOPE && photos.every(photo => !!photo.digest && photo.digest.length <= 128);
    return {epoch, origin, sources, saved: allSaved ? first : undefined, account, valid,
      local: durable && allLocal && this.remember(), durable: durable && (allSaved || allLocal && this.remember())};
  }
  async read(photos: readonly LocalPhoto[], current: () => boolean, retired: readonly LocalPhoto[] = []): Promise<RestoredCleanup | undefined> {
    const binding = this.binding(photos, current);
    if (!binding.valid()) return;
    // Session-only progress also checks the exact in-memory source, not just a chosen ID.
    if (!binding.durable) {
      if (memory?.epoch === binding.epoch && photos.every(photo => memory?.identities.get(photo.id)?.deref() === identity(photo)))
        return restoreCleanupCheckpoint(memory.row, photos, binding.origin, binding.account, retired);
      return;
    }
    let raw: unknown;
    if (binding.saved) {
      const {requireVault, decryptPrivate} = await import("../vault/vault");
      const {get} = await import("../exchange/cache");
      const saved = binding.saved;
      const valid = () => binding.valid() && requireVault() === saved.token && requireVault().accountId === saved.accountId;
      try {
        if (!valid()) return;
        const envelope = await get<Parameters<typeof decryptPrivate>[0]>("settings", `${saved.accountId}:cleanup:review-v1`);
        if (!valid() || !envelope || typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 3 * 1024 * 1024) return;
        raw = decryptPrivate(envelope);
        if (!valid()) return;
      } catch {return;}
    } else if (binding.local) {
      try {raw = await this.retention.readCleanupReview(() => binding.valid() && this.remember());}
      catch {return;}
    }
    return binding.valid() ? restoreCleanupCheckpoint(raw, photos, binding.origin, binding.account, retired) : undefined;
  }
  write(photos: readonly LocalPhoto[], completed: number, signals: ReadonlyMap<string, PhotoSignals>, current: () => boolean): Promise<boolean> {
    const binding = this.binding(photos, current);
    const row: CleanupCheckpoint = {version: 1, processor: CLEANUP_PROCESSOR, origin: binding.origin, account: binding.account,
      sources: binding.sources, completed, signals: [...signals].map(([id, value]) => [id, {...value, hash: value.hash.toString()}])};
    if (!binding.valid() || JSON.stringify(row).length > 2 * 1024 * 1024 || !restoreCleanupCheckpoint(row, photos, binding.origin, binding.account)) return Promise.resolve(false);
    memory = {row, epoch: binding.epoch, identities: new Map(photos.map(photo => [photo.id, new WeakRef(identity(photo))]))};
    const operation = this.queue.catch(() => {}).then(async () => {
      if (!binding.valid() || !binding.durable) return false;
      if (binding.local) return this.retention.writeCleanupReview(row, () => binding.valid() && this.remember());
      const saved = binding.saved;
      if (!saved) return false;
      const {requireVault, encryptPrivate} = await import("../vault/vault");
      const {db} = await import("../exchange/cache");
      const valid = () => binding.valid() && requireVault() === saved.token && requireVault().accountId === saved.accountId;
      if (!valid()) return false;
      const envelope = encryptPrivate(row), database = await db();
      return new Promise<boolean>((resolve, reject) => {
        let wrote = false;
        const tx = database.transaction("settings", "readwrite"), store = tx.objectStore("settings");
        try {if (valid()) {store.put(envelope, `${saved.accountId}:cleanup:review-v1`); wrote = true;}} catch {tx.abort();}
        tx.oncomplete = () => resolve(wrote); tx.onabort = () => reject(tx.error ?? new Error("Review checkpoint cancelled")); tx.onerror = () => {};
      });
    });
    this.queue = operation;
    return operation;
  }
}
