/**
 * What an f(x) position actually is, right now.
 *
 * The wallet knows it holds a position because it holds the NFT, and that is
 * all the NFT says. Everything that makes the position decidable — how much
 * collateral is behind it, how much fxUSD it owes, how close that is to being
 * rebalanced — lives in the PoolManager and has to be read.
 *
 * Without it every management screen asks you to type a number blind: you pick
 * "#4242" from a list of ids, adjust something, and find out what you did
 * afterwards. With it the same screens can answer the only question that
 * matters — where is this position now, and where does this action put it.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { KNOWN_POOLS, getFxPool, getFxPosition } from "@railgun-community/cookbook";
import { getProviderForChain } from "../../network/network-util";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fx-position");

/** A position's live collateral, debt and the thresholds it is judged against. */
export interface FxPositionState {
  collateralAmount: bigint;
  collateralDecimals: number;
  /** fxUSD owed, 18 decimals. */
  debtAmount: bigint;
  /** WAD. The pool's own figure — not re-derived, so it cannot disagree. */
  debtRatio: bigint;
  /** WAD. Above this the protocol rebalances. */
  rebalanceDebtRatio: bigint;
  /** WAD. Above this it is liquidated. */
  liquidationDebtRatio: bigint;
  /** WAD. Charged on new borrowing. */
  borrowFeeRatio: bigint;
  /** WAD. Charged on repayment. */
  repayFeeRatio: bigint;
}

/**
 * Read one position.
 *
 * Returns undefined rather than throwing: a management screen that cannot read
 * one position should still list the others, and a picker that refuses to open
 * because a single RPC call failed is worse than one row showing no figures.
 * The caller is expected to say so rather than render a blank as a zero — see
 * `positionSummary`, which distinguishes them.
 *
 * `getPositionDebtRatio` returns 0 for a position that does not exist rather
 * than reverting, so a burnt or wrong id reads as a perfectly healthy position
 * with no debt. The guard is that the collateral must be non-zero too: a live
 * position always has some, and a burnt one has none.
 */
export const readFxPositionState = async (
  chainName: NetworkName,
  poolName: string,
  positionId: bigint,
): Promise<FxPositionState | undefined> => {
  const provider = getProviderForChain(chainName);
  try {
    const [position, pool] = await Promise.all([
      getFxPosition(positionId, poolName as never, provider),
      getFxPool(poolName as never, provider),
    ]);
    if (position.collateralAmount === 0n && position.debt === 0n) {
      // Nothing behind it. The pool reports a nonexistent position as a
      // zero-debt one, so this is the shape a closed or wrong id takes.
      return undefined;
    }
    return {
      collateralAmount: position.collateralAmount,
      collateralDecimals: Number(position.collateralDecimals),
      debtAmount: position.debt,
      debtRatio: position.debtRatio,
      rebalanceDebtRatio: pool.rebalanceDebtRatio,
      liquidationDebtRatio: pool.liquidationDebtRatio,
      borrowFeeRatio: pool.borrowFeeRatio,
      repayFeeRatio: pool.repayFeeRatio,
    };
  } catch (err) {
    log.debug(`could not read position ${poolName} #${positionId}`, err);
    return undefined;
  }
};

/**
 * The collateral a pool takes, as a symbol.
 *
 * `FxPoolEntry` carries the collateral's ADDRESS but not its symbol. The pool
 * name states the asset the position is EXPOSED to — "wstETH-Long",
 * "WBTC-Short" — and which side of the pool that asset sits on flips: it is the
 * collateral on a long, and the debt on a short. A short deposits fxUSD and
 * borrows the volatile asset, so reading the name as the collateral is right
 * for one side and backwards for the other.
 *
 * Falls back to the whole name rather than to an empty string, so a pool this
 * predates still renders something true.
 */
export const poolCollateralSymbol = (poolName: string): string => {
  const pool = KNOWN_POOLS.find((entry) => entry.name === poolName);
  // Every short pool in the set is collateralised in fxUSD; there is no symbol
  // on the descriptor to read it from, and a token lookup for a label is not
  // worth a round trip.
  if (pool?.side === "short") return "fxUSD";
  return poolName.split("-")[0] || poolName;
};
