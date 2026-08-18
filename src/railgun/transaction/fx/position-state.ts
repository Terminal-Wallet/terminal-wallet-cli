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
import { Contract } from "ethers";
import {
  KNOWN_POOLS,
  getFxPool,
  getFxPosition,
  resolvePool,
} from "@railgun-community/cookbook";
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
 * How much of a position is left.
 *
 * - `live`   — a position with a meaningful amount in it
 * - `dust`   — still OPEN, with debt still accruing, but too small to render
 * - `empty`  — nothing in it: closed out, or an id that never existed
 *
 * `dust` exists because a partial close that repays almost everything leaves a
 * residue, and a residue is not a closed position. The debt keeps accruing and
 * the position can still be liquidated, so it must not read as finished — but
 * it also must not read as an ordinary holding, because every figure on the row
 * rounds to zero and the row looks broken.
 *
 * Scale-free on purpose. A currency threshold would need a price and a guess at
 * what "small" means for a protocol whose positions range over several orders
 * of magnitude. The honest definition is the one the screen already implies:
 * if the amount cannot be shown at the precision the wallet renders, the wallet
 * cannot tell the user anything useful about its size.
 */
export type FxPositionScale = "live" | "dust" | "empty";

/** Decimal places the position rows render collateral at. */
export const FX_POSITION_DP = 4n;

export const fxPositionScale = (
  state: Pick<FxPositionState, "collateralAmount" | "collateralDecimals">,
): FxPositionScale => {
  const { collateralAmount, collateralDecimals } = state;
  if (collateralAmount <= 0n) return "empty";
  // Does it survive rounding to FX_POSITION_DP places?
  const shown =
    (collateralAmount * 10n ** FX_POSITION_DP) /
    10n ** BigInt(collateralDecimals);
  return shown === 0n ? "dust" : "live";
};

/** A dust position is still open, and saying otherwise is the dangerous read. */
export const fxScaleNote = (scale: FxPositionScale): string =>
  scale === "dust"
    ? "residual position — too small to show, still open and still accruing debt"
    : "";

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
 * than reverting, so a wrong id reads as a perfectly healthy position with no
 * debt. Zero collateral was once taken as proof of that — but f(x) empties a
 * position on close rather than destroying it, so a real, held, closed-out
 * position looks identical. `ownerOf` is what actually separates them, and it
 * is only consulted on that zero/zero path.
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
      // Zero on both legs has two meanings and the pool reports them
      // identically: a position that does not exist, and one that has been
      // emptied but whose NFT is still held. A close that repays and withdraws
      // by explicit amount reaches zero WITHOUT burning — only the pool's own
      // full-close sentinel burns — so the second is a real state a wallet sits
      // in, and calling it unreadable told the user their position had
      // vanished when it was still theirs and still listed.
      //
      // ownerOf separates them: it reverts for a burnt or never-minted id.
      const exists = await new Contract(
        resolvePool(poolName as never).address,
        ["function ownerOf(uint256) view returns (address)"],
        provider,
      )
        .ownerOf(positionId)
        .then(() => true)
        .catch(() => false);
      if (!exists) return undefined;
      return {
        collateralAmount: 0n,
        collateralDecimals: Number(position.collateralDecimals),
        debtAmount: 0n,
        debtRatio: 0n,
        rebalanceDebtRatio: pool.rebalanceDebtRatio,
        liquidationDebtRatio: pool.liquidationDebtRatio,
        borrowFeeRatio: pool.borrowFeeRatio,
        repayFeeRatio: pool.repayFeeRatio,
      };
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
