import type {LocalPhoto} from "./resources";
import {LocalRetention} from "./retention";
import {loadLocalChoices, saveLocalChoices} from "./preferences";
import {savedInferenceSource} from "../library/consumer-search";
import {SEMANTIC_DIMENSIONS, SEMANTIC_PROCESSOR} from "./semantic-config";

export interface SemanticInferenceRecord {
  version: 1; id: string; digest: string; processor: string;
  state: "complete" | "preview-failed" | "model-failed";
  vector?: number[]; attempts?: number; retryAt?: number;
}
export interface SemanticInferenceStore {
  scope?(current: () => boolean): () => boolean;
  read(photo: LocalPhoto, current: () => boolean): Promise<SemanticInferenceRecord | undefined>;
  write(photo: LocalPhoto, record: SemanticInferenceRecord, current: () => boolean): Promise<void>;
}
let persistenceEpoch = 0;
export async function clearSemanticInference() {
  persistenceEpoch++;
  const choice = loadLocalChoices(); if (choice) saveLocalChoices({...choice, retain: false});
  const {db} = await import("../exchange/cache");
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("settings", "readwrite"), cursor = tx.objectStore("settings").openCursor();
    cursor.onsuccess = () => {const row = cursor.result; if (!row) return; if (/^[^:]+:semantic:/.test(String(row.key))) row.delete(); row.continue();};
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Inference could not be cleared")); tx.onerror = () => {};
  });
}
export function validSemanticRecord(value: unknown, photo: LocalPhoto, processor = SEMANTIC_PROCESSOR): value is SemanticInferenceRecord {
  const row = value as SemanticInferenceRecord | undefined;
  if (!row || row.version !== 1 || row.id !== photo.id || !photo.digest || row.digest !== photo.digest || row.processor !== processor) return false;
  if (row.state === "complete") {
    if (!Array.isArray(row.vector) || row.vector.length !== SEMANTIC_DIMENSIONS || !row.vector.every(value => Number.isFinite(value) && Math.abs(value) <= 1)) return false;
    return Math.abs(row.vector.reduce((sum, value) => sum + value * value, 0) - 1) < .001;
  }
  return ["preview-failed", "model-failed"].includes(row.state) && row.vector === undefined
    && Number.isSafeInteger(row.attempts) && row.attempts! >= 1 && row.attempts! <= 8
    && Number.isSafeInteger(row.retryAt) && row.retryAt! >= 0;
}
export function failedSemanticRecord(photo: LocalPhoto, state: "preview-failed" | "model-failed", previous?: SemanticInferenceRecord, now = Date.now()): SemanticInferenceRecord {
  const attempts = Math.min(8, (previous?.attempts ?? 0) + 1);
  return {version: 1, id: photo.id, digest: photo.digest!, processor: SEMANTIC_PROCESSOR, state, attempts,
    retryAt: now + Math.min(60000, 5000 * 2 ** (attempts - 1))};
}

/* Optional encrypted rows reuse retained metadata or the account settings cache. */
export class DurableSemanticInference implements SemanticInferenceStore {
  constructor(private retention = new LocalRetention(), private enabled = () => loadLocalChoices()?.retain === true,
    private processor = SEMANTIC_PROCESSOR) {}
  scope(current: () => boolean) {const epoch = persistenceEpoch; return () => epoch === persistenceEpoch && current();}
  private binding(photo: LocalPhoto, current: () => boolean) {
    const digest = photo.digest, epoch = persistenceEpoch;
    if (!digest || digest.length > 128 || !this.enabled() || photo.previewAvailable === false || photo.current?.() === false || !current()) return;
    const saved = savedInferenceSource(photo);
    if (photo.id.startsWith("saved:") && !saved) return;
    const valid = () => epoch === persistenceEpoch && this.enabled() && current() && photo.current?.() !== false && photo.digest === digest && (!saved || saved.current());
    return {saved, valid, digest};
  }
  async read(photo: LocalPhoto, current: () => boolean) {
    const binding = this.binding(photo, current); if (!binding) return;
    let row: unknown;
    if (binding.saved) {
      const {requireVault, decryptPrivate} = await import("../vault/vault");
      const {get} = await import("../exchange/cache");
      const saved = binding.saved, session = requireVault();
      const valid = () => binding.valid() && requireVault() === session && session === saved.token && session.accountId === saved.accountId;
      if (!valid()) return;
      const envelope = await get<Parameters<typeof decryptPrivate>[0]>("settings", `${saved.accountId}:semantic:${saved.photoId}`);
      if (!valid() || !envelope) return;
      const value = decryptPrivate<{revision: string; record: unknown}>(envelope);
      if (value.revision !== saved.revision || !valid()) return;
      row = value.record && typeof value.record === "object" ? {...value.record, id: photo.id} : undefined;
    } else row = await this.retention.readInference(photo.id, binding.digest, this.processor, binding.valid);
    return binding.valid() && validSemanticRecord(row, photo, this.processor) ? row : undefined;
  }
  async write(photo: LocalPhoto, record: SemanticInferenceRecord, current: () => boolean) {
    const binding = this.binding(photo, current); if (!binding || !validSemanticRecord(record, photo, this.processor)) return;
    if (!binding.saved) {await this.retention.writeInference(photo.id, binding.digest, this.processor, record, binding.valid); return;}
    const {requireVault, encryptPrivate} = await import("../vault/vault");
    const {db} = await import("../exchange/cache");
    const saved = binding.saved, session = requireVault();
    const valid = () => binding.valid() && requireVault() === session && session === saved.token && session.accountId === saved.accountId;
    if (!valid()) return;
    const envelope = encryptPrivate({revision: saved.revision, record}), database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("settings", "readwrite"), store = tx.objectStore("settings"), prefix = saved.accountId + ":semantic:", key = prefix + saved.photoId;
      const keys = store.getAllKeys(IDBKeyRange.bound(prefix, prefix.slice(0, -1) + ";", false, true));
      keys.onsuccess = () => {
        try {
          if (!valid()) return;
          const old = keys.result.filter(value => value !== key);
          for (const value of old.slice(0, Math.max(0, old.length - 511))) store.delete(value);
          store.put(envelope, key);
        } catch {tx.abort();}
      };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Inference cancelled")); tx.onerror = () => {};
    });
  }
}
