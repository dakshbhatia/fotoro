import { requireVault, type UnlockedVault } from "./vault";
export const sameVault = (session: UnlockedVault) => {
  try {
    return requireVault() === session;
  } catch {
    return false;
  }
};
export const assertVault = (session: UnlockedVault) => {
  if (!sameVault(session)) throw new Error("VAULT_LOCKED");
};
