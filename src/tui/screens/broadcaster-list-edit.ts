/**
 * Pure model for the broadcaster allow/blocklist editor. Persistence + the
 * one-list invariant live in wallet/broadcaster-prefs; this owns the renderer-
 * agnostic bits the editor needs: the pref of an address, the cycle order, and
 * the editor's row list (favorites first, then blocked, then any extra known
 * broadcasters). Unit-tested; no side effects.
 */
import { BroadcasterPref } from "../../railgun/wallet/broadcaster-prefs";

export interface BroadcasterLists {
  favorites: string[];
  blocklist: string[];
}

const has = (list: string[], a: string): boolean =>
  list.some((x) => x.toLowerCase() === a.toLowerCase());

/** Which list an address currently sits in. */
export const prefOf = (lists: BroadcasterLists, address: string): BroadcasterPref =>
  has(lists.favorites, address)
    ? "favorite"
    : has(lists.blocklist, address)
      ? "blocked"
      : "none";

/** Editor cycle: none → favorite → blocked → none. */
export const cyclePref = (p: BroadcasterPref): BroadcasterPref =>
  p === "none" ? "favorite" : p === "favorite" ? "blocked" : "none";

export interface BroadcasterRow {
  address: string;
  pref: BroadcasterPref;
}

/**
 * Editor rows: favorites, then blocked, then any extra `known` addresses (live
 * broadcasters not yet classified), de-duplicated case-insensitively.
 */
export const buildBroadcasterRows = (
  lists: BroadcasterLists,
  known: string[] = [],
): BroadcasterRow[] => {
  const seen = new Set<string>();
  const rows: BroadcasterRow[] = [];
  const add = (a: string) => {
    const k = a?.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    rows.push({ address: a.trim(), pref: prefOf(lists, a) });
  };
  lists.favorites.forEach(add);
  lists.blocklist.forEach(add);
  known.forEach(add);
  return rows;
};
