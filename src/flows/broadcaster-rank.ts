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
  favorites?: Set<string>; // addresses floated to the top
  blocked?: Set<string>; // addresses removed entirely
}

/**
 * Dedupe by address (keep the cheapest known fee), drop blocked broadcasters,
 * then sort: favorites first, then fee ascending (unknown fees last).
 */
export const rankBroadcasters = (
  rows: BroadcasterRow[],
  opts: RankOpts = {},
): BroadcasterRow[] => {
  const favorites = opts.favorites ?? new Set<string>();
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
    const af = favorites.has(a.address) ? 0 : 1;
    const bf = favorites.has(b.address) ? 0 : 1;
    if (af !== bf) return af - bf; // favorites first
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
