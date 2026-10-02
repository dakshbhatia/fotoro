const stores = [
  "catalog",
  "read",
  "staging",
  "journal",
  "settings",
  "saves",
] as const;
export type Store = (typeof stores)[number];
let opened: Promise<IDBDatabase> | undefined;
export function db() {
  return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("fotoro-v1", 1);
    r.onupgradeneeded = () => {
      for (const name of stores) r.result.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function get<T>(
  store: Store,
  key: string,
): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function all<T>(store: Store): Promise<[string, T][]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out: [string, T][] = [];
    const r = d.transaction(store).objectStore(store).openCursor();
    r.onsuccess = () => {
      if (r.result) {
        out.push([String(r.result.key), r.result.value]);
        r.result.continue();
      } else resolve(out);
    };
    r.onerror = () => reject(r.error);
  });
}
export async function atomic(
  writes: { store: Store; key: string; value?: unknown }[],
) {
  if (!writes.length) return;
  const d = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = d.transaction(
      [...new Set(writes.map((w) => w.store))],
      "readwrite",
    );
    try {
      for (const w of writes) {
        const s = tx.objectStore(w.store);
        w.value === undefined ? s.delete(w.key) : s.put(w.value, w.key);
      }
    } catch (error) {
      tx.abort();
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("STORAGE_ABORTED"));
  });
}
export async function put(store: Store, key: string, value: unknown) {
  await atomic([{ store, key, value }]);
}
export async function cacheCipher(key: string, bytes: Uint8Array) {
  const entries = await all<Uint8Array>("read");
  let size =
    entries.reduce((n, [, v]) => n + v.byteLength, 0) + bytes.byteLength;
  const writes: { store: Store; key: string; value?: unknown }[] = [];
  for (const [id, v] of entries) {
    if (size <= 100 * 1024 * 1024) break;
    writes.push({ store: "read", key: id });
    size -= v.byteLength;
  }
  if (bytes.byteLength <= 100 * 1024 * 1024)
    writes.push({ store: "read", key, value: bytes });
  await atomic(writes);
}
export async function clearAccount(accountId: string) {
  if ((await get("settings", "last-account")) === accountId)
    await atomic([{ store: "settings", key: "last-account" }]);
  for (const store of stores) {
    const rows = await all(store);
    await atomic(
      rows
        .filter(([k]) => k.startsWith(accountId + ":"))
        .map(([key]) => ({ store, key })),
    );
  }
}
