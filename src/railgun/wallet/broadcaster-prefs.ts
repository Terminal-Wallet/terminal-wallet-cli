/**
 * Persisted broadcaster preferences: a favorites list (floated to the top of the
 * selection screen) and a blocklist (hidden entirely). Keyed by the broadcaster's
 * railgun (0zk) address. Stored in the keychain alongside the other settings.
 */
import { walletManager } from "./wallet-manager";
import { saveKeychainFile } from "./wallet-cache";
import configDefaults from "../../config/config-defaults";

export type BroadcasterPref = "favorite" | "blocked" | "none";

const persist = () => {
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

export const getBroadcasterFavorites = (): string[] =>
  walletManager.keyChain.broadcasterFavorites ?? [];

export const getBroadcasterBlocklist = (): string[] =>
  walletManager.keyChain.broadcasterBlocklist ?? [];

export const getBroadcasterPref = (address: string): BroadcasterPref =>
  getBroadcasterFavorites().includes(address)
    ? "favorite"
    : getBroadcasterBlocklist().includes(address)
      ? "blocked"
      : "none";

const without = (list: string[], address: string) => list.filter((a) => a !== address);

/** Set a broadcaster's preference (favorite/blocked/none) and persist. */
export const setBroadcasterPref = (address: string, pref: BroadcasterPref): void => {
  const kc = walletManager.keyChain;
  // A broadcaster is in at most one list.
  kc.broadcasterFavorites = without(getBroadcasterFavorites(), address);
  kc.broadcasterBlocklist = without(getBroadcasterBlocklist(), address);
  if (pref === "favorite") kc.broadcasterFavorites.push(address);
  else if (pref === "blocked") kc.broadcasterBlocklist.push(address);
  persist();
};
