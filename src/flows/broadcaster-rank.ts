/**
 * Pure ranking/format helpers for the broadcaster comparison modal: dedupe by
 * address (a broadcaster can be advertised by several waku peers), sort by the
 * computed fee (lowest first), and express each as a "bonus %" vs the cheapest.
 * Renderer-agnostic + unit-tested.
 */

export interface BroadcasterRow {
  address: string;
  feeAmount?: bigint; // computed fee in the token's smallest unit (undefined = unknown)
  feeReadable: string; // pre-formatted fee for display
  reliability: number; // 0..1
  wallets: number; // available signing wallets
}

export interface RankOpts {
  /**
   * Favourites in precedence order — index 0 outranks index 1, whatever they
   * cost. An ordered list rather than a set because "these are my preferred
   * broadcasters" and "this is the one I want" are different statements, and
   * only the second can pick a default without asking.
   */
  favorites?: string[];
  blocked?: Set<string>; // addresses removed entirely
}

// Addresses are compared case-insensitively throughout, matching how the
// editor's prefOf already treats them. An address stored in one case and
// discovered in another is the same broadcaster, and a rank that disagreed with
// the star beside it would be its own bug.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Position in the precedence list; anything unlisted sorts after all of them. */
export const favoriteRank = (favorites: string[], address: string): number => {
  const index = favorites.findIndex((f) => same(f, address));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
};

/**
 * The highest-precedence favourite that is actually available right now.
 *
 * Precedence is a standing preference, not a guarantee: a broadcaster that is
 * offline or does not serve this fee token is skipped rather than blocking the
 * send. Returns undefined when none of the favourites are reachable.
 */
export const preferredFavorite = (
  favorites: string[],
  available: string[],
): string | undefined => {
  const reachable = available.map((a) => a.toLowerCase());
  const match = favorites.find((address) => reachable.includes(address.toLowerCase()));
  if (match === undefined) return undefined;
  // Return the AVAILABLE spelling — the caller looks the broadcaster back up by
  // this string, and the stored favourite may differ in case.
  return available[reachable.indexOf(match.toLowerCase())];
};

/** The lowest known fee in a set of rows — the baseline `bonusPct` compares to. */
export const cheapestFee = (rows: BroadcasterRow[]): bigint | undefined => {
  let cheapest: bigint | undefined;
  for (const { feeAmount } of rows) {
    if (feeAmount === undefined) continue;
    if (cheapest === undefined || feeAmount < cheapest) cheapest = feeAmount;
  }
  return cheapest;
};

/**
 * Move an address within an ordered list. Out-of-range moves clamp rather than
 * wrap: dragging the top entry up again should do nothing, not send it last.
 */
export const moveInList = (
  list: string[],
  address: string,
  delta: number,
): string[] => {
  const from = list.findIndex((a) => same(a, address));
  if (from === -1) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return list;
  const next = [...list];
  next.splice(from, 1);
  next.splice(to, 0, address);
  return next;
};

/**
 * Dedupe by address (keep the cheapest known fee), drop blocked broadcasters,
 * then sort: favourites in precedence order first, then fee ascending (unknown
 * fees last).
 */
export const rankBroadcasters = (
  rows: BroadcasterRow[],
  opts: RankOpts = {},
): BroadcasterRow[] => {
  const favorites = opts.favorites ?? [];
  const blocked = opts.blocked ?? new Set<string>();
  const byAddr = new Map<string, BroadcasterRow>();
  for (const r of rows) {
    if (blocked.has(r.address)) continue;
    const ex = byAddr.get(r.address);
    if (!ex) {
      byAddr.set(r.address, r);
      continue;
    }
    const better =
      r.feeAmount !== undefined &&
      (ex.feeAmount === undefined || r.feeAmount < ex.feeAmount);
    if (better) byAddr.set(r.address, r);
  }
  return [...byAddr.values()].sort((a, b) => {
    // Precedence beats price: a favourite is ranked because the user decided
    // it should be, and a cheaper one does not overrule that.
    const ar = favoriteRank(favorites, a.address);
    const br = favoriteRank(favorites, b.address);
    if (ar !== br) return ar - br;
    if (a.feeAmount === undefined) return 1; // unknown fees sink to the bottom
    if (b.feeAmount === undefined) return -1;
    return a.feeAmount < b.feeAmount ? -1 : a.feeAmount > b.feeAmount ? 1 : 0;
  });
};

/** Percentage above the cheapest known fee (cheapest → 0). */
export const bonusPct = (
  feeAmount: bigint | undefined,
  cheapest: bigint | undefined,
): number => {
  if (feeAmount === undefined || cheapest === undefined || cheapest === 0n) return 0;
  return Number(((feeAmount - cheapest) * 10000n) / cheapest) / 100;
};
