/**
 * Pure USD valuation helpers (no IO) — turn raw balances + a price map into
 * display strings. Unit-tested; the price source (DefiLlama) lives in defillama.ts.
 */
import { formatUnits } from "ethers";

export interface PricedBalance {
  tokenAddress: string;
  amount: bigint;
  decimals: number;
}

/** USD value of one balance given an address→USD map (undefined if no price). */
export const balanceUSD = (
  b: PricedBalance,
  prices: Record<string, number>,
): number | undefined => {
  const price = prices[b.tokenAddress.toLowerCase()];
  if (typeof price !== "number") return undefined;
  return Number(formatUnits(b.amount, b.decimals)) * price;
};

/** Sum the USD value of all priced balances (unpriced tokens contribute 0). */
export const portfolioTotalUSD = (
  balances: PricedBalance[],
  prices: Record<string, number>,
): number =>
  balances.reduce((sum, b) => sum + (balanceUSD(b, prices) ?? 0), 0);

/** Format a USD number as "$1,234.56" (or "—" when undefined). */
export const formatUSD = (usd: number | undefined): string => {
  if (typeof usd !== "number" || !isFinite(usd)) return "—";
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
