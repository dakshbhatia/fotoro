const stores = ["catalog", "read", "staging", "journal", "settings", "saves"] as const;
export type Store = (typeof stores)[number];
export const CIPHER_CACHE_BYTES = 100 * 1024 * 1024;
const metadataStore = "read-cache-metadata", totalsKey = "@totals";
interface CacheEntry {bytes: number; sequence: number}
interface CacheTotals {bytes: number; nextSequence: number}
let opened: Promise<IDBDatabase> | undefined;
export function db() {
  if (opened) return opened;
  let attempt: Promise<IDBDatabase>;
  attempt = new Promise<IDBDatabase>((resolve, reject) => {
    let rejected = false;
    const reset = () => {if (opened === attempt) opened = undefined;};
    const r = indexedDB.open("fotoro-v1", 2);
    r.onupgradeneeded = () => {
      for (const name of stores) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name);
      if (!r.result.objectStoreNames.contains(metadataStore)) {
        const metadata = r.result.createObjectStore(metadataStore);
        metadata.createIndex("sequence", "sequence");
        const totals: CacheTotals = {bytes: 0, nextSequence: 0};
        const cursor = r.transaction!.objectStore("read").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {metadata.put(totals, totalsKey); return;}
          const bytes = row.value;
          // A legacy cache is optional: retain only bounded ciphertext, once at upgrade.
          if (!(bytes instanceof Uint8Array) || totals.bytes + bytes.byteLength > CIPHER_CACHE_BYTES) row.delete();
          else {
            metadata.put({bytes: bytes.byteLength, sequence: totals.nextSequence++}, row.key);
            totals.bytes += bytes.byteLength;
          }
          row.continue();
        };
      }
    };
    r.onsuccess = () => {
      if (rejected) {r.result.close(); reset(); return;}
      r.result.onversionchange = () => {r.result.close(); reset();};
      resolve(r.result);
    };
    r.onblocked = () => {rejected = true; reset(); reject(new Error("CACHE_UPDATE_REQUIRES_RELOAD"));};
    r.onerror = () => {rejected = true; reset(); reject(r.error);};
  });
  opened = attempt;
  return attempt;
}
export async function get<T>(store: Store, key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
// Account keys use an ASCII UUID followed by ':'. A prefix range avoids reading other accounts.
export async function all<T>(store: Store, prefix?: string): Promise<[string, T][]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out: [string, T][] = [];
    const upper = prefix ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) : undefined;
    const range = prefix ? IDBKeyRange.bound(prefix, upper, false, true) : undefined;
    const r = d.transaction(store).objectStore(store).openCursor(range);
    r.onsuccess = () => {
      if (r.result) {
        out.push([String(r.result.key), r.result.value]);
        r.result.continue();
      } else resolve(out);
    };
    r.onerror = () => reject(r.error);
  });
}
type Write = {store: Store; key: string; value?: unknown};
// The read + metadata transaction serializes accounting across tabs and crashes.
function cipherWrites(tx: IDBTransaction, writes: Write[]) {
  const read = tx.objectStore("read"), metadata = tx.objectStore(metadataStore);
  const request = metadata.get(totalsKey);
  request.onsuccess = () => {
    let totals = request.result as CacheTotals | undefined;
    if (!totals || !Number.isSafeInteger(totals.bytes) || totals.bytes < 0 || totals.bytes > CIPHER_CACHE_BYTES || !Number.isSafeInteger(totals.nextSequence) || totals.nextSequence < 0) {
      read.clear(); metadata.clear(); totals = {bytes: 0, nextSequence: 0};
    }
    const state = totals;
    let n = 0;
    const next = () => {
      if (n === writes.length) {metadata.put(state, totalsKey); return;}
      const write = writes[n++];
      if (write.value !== undefined && (!(write.value instanceof Uint8Array) || write.value.byteLength > CIPHER_CACHE_BYTES)) {next(); return;}
      const old = metadata.get(write.key);
      old.onsuccess = () => {
        const prior = old.result as CacheEntry | undefined;
        if (prior) state.bytes -= prior.bytes;
        read.delete(write.key); metadata.delete(write.key);
        if (write.value === undefined) {next(); return;}
        const bytes = write.value as Uint8Array;
        const insert = () => {
          read.put(bytes, write.key);
          metadata.put({bytes: bytes.byteLength, sequence: state.nextSequence++}, write.key);
          state.bytes += bytes.byteLength;
          next();
        };
        if (state.bytes + bytes.byteLength <= CIPHER_CACHE_BYTES) {insert(); return;}
        const cursor = metadata.index("sequence").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {insert(); return;}
          state.bytes -= (row.value as CacheEntry).bytes;
          read.delete(row.primaryKey); row.delete();
          if (state.bytes + bytes.byteLength <= CIPHER_CACHE_BYTES) insert();
          else row.continue();
        };
      };
    };
    next();
  };
}
export async function atomic(writes: Write[]) {
  if (!writes.length) return;
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const cipher = writes.filter(w => w.store === "read");
    const names = [...new Set(writes.map(w => w.store))] as string[];
    if (cipher.length) names.push(metadataStore);
    const tx = d.transaction(names, "readwrite");
    try {
      for (const w of writes) {
        if (w.store === "read") continue;
        const s = tx.objectStore(w.store);
        w.value === undefined ? s.delete(w.key) : s.put(w.value, w.key);
      }
      if (cipher.length) cipherWrites(tx, cipher);
    } catch (error) {tx.abort(); reject(error); return;}
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("STORAGE_ABORTED"));
  });
}
export async function put(store: Store, key: string, value: unknown) {await atomic([{store, key, value}]);}
export async function cacheCipher(key: string, bytes: Uint8Array) {await atomic([{store: "read", key, value: bytes}]);}
export async function clearAccount(accountId: string) {
  if ((await get("settings", "last-account")) === accountId) await atomic([{store: "settings", key: "last-account"}]);
  for (const store of stores) {
    const rows = await all(store, accountId + ":");
    await atomic(rows.map(([key]) => ({store, key})));
  }
}
