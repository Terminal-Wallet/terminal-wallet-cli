/**
 * Persisted broadcaster preferences: a favourites list and a blocklist (hidden
 * entirely). Keyed by the broadcaster's railgun (0zk) address, stored in the
 * keychain alongside the other settings.
 *
 * The favourites array is ORDERED — its index is the precedence, and the first
 * entry that is actually reachable becomes the default broadcaster for a send.
 * So this is not just a display sort; it decides who relays your transaction.
 */
import { walletManager } from "./wallet-manager";
import { saveKeychainFile } from "./wallet-cache";
import configDefaults from "../../config/config-defaults";
import { moveInList } from "../../flows/broadcaster-rank";

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

/**
 * Set a broadcaster's preference (favorite/blocked/none) and persist.
 *
 * A new favourite goes to the BOTTOM of the precedence list. Promoting it is a
 * separate, deliberate act — starring a broadcaster should not silently demote
 * the one the user already chose to rely on.
 */
export const setBroadcasterPref = (address: string, pref: BroadcasterPref): void => {
  const kc = walletManager.keyChain;
  // A broadcaster is in at most one list.
  kc.broadcasterFavorites = without(getBroadcasterFavorites(), address);
  kc.broadcasterBlocklist = without(getBroadcasterBlocklist(), address);
  if (pref === "favorite") kc.broadcasterFavorites.push(address);
  else if (pref === "blocked") kc.broadcasterBlocklist.push(address);
  persist();
};

/**
 * Move a favourite up (negative delta) or down the precedence list.
 *
 * The list order IS the precedence, and position 0 is the one that gets picked
 * by default, so this is how a user says "use this one".
 */
export const moveBroadcasterFavorite = (address: string, delta: number): void => {
  const kc = walletManager.keyChain;
  kc.broadcasterFavorites = moveInList(getBroadcasterFavorites(), address, delta);
  persist();
};
