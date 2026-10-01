import type {WrappedKeyV1} from "@fotoro/contracts";
import {get, put} from "../exchange/cache";
import {requireVault, encryptPrivate, decryptPrivate, type UnlockedVault} from "../vault/vault";
import {assertVault} from "../vault/scope";

const writes = new WeakMap<UnlockedVault, Promise<void>>();
export async function loadUploadPause(session = requireVault()): Promise<boolean> {
  await writes.get(session);
  assertVault(session);
  const value = await get<WrappedKeyV1>("settings", session.accountId + ":consumer-upload-pause");
  assertVault(session);
  if (!value) return false;
  const decoded = decryptPrivate<{paused: boolean}>(value);
  if (typeof decoded.paused !== "boolean") throw new Error("INVALID_SYNC_PREFERENCE");
  return decoded.paused;
}
export function saveUploadPause(paused: boolean, session = requireVault()): Promise<void> {
  const task = (writes.get(session) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    assertVault(session);
    const encrypted = encryptPrivate({paused});
    await put("settings", session.accountId + ":consumer-upload-pause", encrypted);
    assertVault(session);
  });
  writes.set(session, task);
  void task.finally(() => {if (writes.get(session) === task) writes.delete(session);}).catch(() => undefined);
  return task;
}
