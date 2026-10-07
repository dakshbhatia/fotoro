import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import {all, atomic, cacheCipher, clearAccount, db, get, put, CIPHER_CACHE_BYTES} from "../src/exchange/cache";

test("legacy encrypted read cache upgrades once, retains bounded bytes, and prefix reads isolate accounts", async () => {
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("fotoro-v1", 1);
    request.onupgradeneeded = () => {for (const name of ["catalog", "read", "staging", "journal", "settings", "saves"]) request.result.createObjectStore(name);};
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction(["read", "catalog"], "readwrite");
    tx.objectStore("read").put(new Uint8Array([1, 2, 3]), "A:legacy");
    tx.objectStore("read").put(new Uint8Array([4, 5]), "B:legacy");
    tx.objectStore("catalog").put({ciphertext: "account-a"}, "A:photo");
    tx.objectStore("catalog").put({ciphertext: "account-b"}, "B:photo");
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  await assert.rejects(db(), /CACHE_UPDATE_REQUIRES_RELOAD/);
  legacy.close();
  assert.equal((await db()).version, 2, "A blocked open must be retryable after the old tab closes");
  assert.deepEqual(await get("read", "A:legacy"), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await all("catalog", "A:"), [["A:photo", {ciphertext: "account-a"}]]);
  await clearAccount("A");
  assert.deepEqual(await get("read", "B:legacy"), new Uint8Array([4, 5]));
  await clearAccount("B");
});

test("concurrent ciphertext inserts, replacement and account deletion preserve the cap without scanning ciphertext", async () => {
  const original = IDBObjectStore.prototype.openCursor;
  let ciphertextScans = 0;
  IDBObjectStore.prototype.openCursor = function(...args) {
    if (this.name === "read") ciphertextScans++;
    return original.apply(this, args);
  };
  try {
    const sixty = new Uint8Array(60 * 1024 * 1024);
    await Promise.all([cacheCipher("A:first", sixty), cacheCipher("B:second", sixty)]);
    assert.equal(await get("read", "A:first"), undefined, "The oldest complete ciphertext must be evicted atomically");
    await cacheCipher("A:third", new Uint8Array(40 * 1024 * 1024));
    await cacheCipher("B:second", new Uint8Array(50 * 1024 * 1024));
    await cacheCipher("C:fourth", new Uint8Array(10 * 1024 * 1024));
    assert.equal(ciphertextScans, 0, "Insert and eviction should read only small byte-ledger records");
    let connection = await db();
    const totals = () => new Promise<any>((resolve, reject) => {
      const request = connection.transaction("read-cache-metadata").objectStore("read-cache-metadata").get("@totals");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    assert.equal((await totals()).bytes, CIPHER_CACHE_BYTES, "Replacing an existing key must not charge it twice");
    await atomic([{store: "read", key: "B:second"}]);
    assert.equal((await totals()).bytes, 50 * 1024 * 1024);
    await cacheCipher("D:fifth", new Uint8Array(50 * 1024 * 1024));
    assert.equal((await totals()).bytes, CIPHER_CACHE_BYTES);
    await cacheCipher("E:oversized", new Uint8Array(CIPHER_CACHE_BYTES + 1));
    assert.equal(await get("read", "E:oversized"), undefined);
    assert.equal((await totals()).bytes, CIPHER_CACHE_BYTES);
    const beforeReopen = connection;
    beforeReopen.dispatchEvent(new IDBVersionChangeEvent("versionchange", {oldVersion: 2, newVersion: 3}));
    connection = await db();
    assert.notEqual(connection, beforeReopen);
    assert.equal((await totals()).bytes, CIPHER_CACHE_BYTES, "A new connection must retain durable accounting");
    await put("settings", "unrelated", {kept: true});
    await clearAccount("A");
    assert.equal((await totals()).bytes, 60 * 1024 * 1024);
    assert.deepEqual(await get("settings", "unrelated"), {kept: true});
  } finally {
    IDBObjectStore.prototype.openCursor = original;
    for (const account of ["A", "B", "C", "D", "E"]) await clearAccount(account);
  }
});

test("version changes close the live cache and rejected opens leave no blocking ghost connection", {timeout: 2000}, async () => {
  const previous = await db();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("fotoro-v1");
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Rejected upgrade leaked an open connection"));
  });
  const reopened = await db();
  assert.notEqual(reopened, previous);
  assert.equal(reopened.version, 2);
  await cacheCipher("A:after-reopen", new Uint8Array([7]));
  assert.deepEqual(await get("read", "A:after-reopen"), new Uint8Array([7]));
});
