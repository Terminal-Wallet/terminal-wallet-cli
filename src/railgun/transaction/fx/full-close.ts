/**
 * What it actually takes to close an f(x) position outright.
 *
 * A close is full only when the repay covers the whole debt. Below that the
 * recipe silently becomes a PARTIAL close: the position survives, the NFT is
 * not burnt, and what is left keeps accruing interest. The difference between
 * the two is often a fraction of a percent of the debt, and nothing on screen
 * says so — the user is left to work the number out from fee ratios.
 *
 * This inverts `computeFxRepay`'s sizing. Forward, that is:
 *
 *   afterUnshield = available x (BPS - unshieldBps) / BPS
 *   maxRepay      = afterUnshield x FEE_DENOM / (FEE_DENOM + repayFeeRatio)
 *
 * and a full close needs `maxRepay >= debt`. Solving for `available` gives the
 * figure below. Every step rounds UP: landing one wei short is precisely the
 * failure this exists to prevent, and one wei of surplus is re-shielded.
 *
 * Pure and side-effect free.
 */

/** Matches the cookbook's own denominators. */
export const FEE_DENOM = 1_000_000_000n;
export const BPS_DENOM = 10_000n;

/** Ceiling division. Short by one wei is not a rounding error here. */
const divUp = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export interface FullCloseInput {
  /** Position debt, native debt-token units. */
  debt: bigint;
  /** The pool's repay fee, over FEE_DENOM. */
  repayFeeRatio: bigint;
  /** RAILGUN's unshield fee in basis points. */
  railgunUnshieldFeeBps: bigint;
}

/**
 * The minimum SHIELDED debt token needed for the close to be full.
 *
 * Both fees are taken before the repay lands: RAILGUN's on the way out of the
 * shield, then the pool's on the repay itself. So the figure is the debt
 * grossed up through both, in that order.
 */
export const debtTokenForFullClose = (input: FullCloseInput): bigint => {
  const { debt, repayFeeRatio, railgunUnshieldFeeBps } = input;
  if (debt <= 0n) return 0n;
  if (railgunUnshieldFeeBps >= BPS_DENOM) {
    // A 100% unshield fee means nothing survives the unshield, so no amount is
    // sufficient. Refuse rather than return a misleading number.
    throw new Error(
      `railgunUnshieldFeeBps must be < ${BPS_DENOM}, got ${railgunUnshieldFeeBps}`,
    );
  }
  const throughRepayFee = divUp(debt * (FEE_DENOM + repayFeeRatio), FEE_DENOM);
  return divUp(throughRepayFee * BPS_DENOM, BPS_DENOM - railgunUnshieldFeeBps);
};

export interface FullCloseRequirement {
  /** Minimum shielded debt token for a full close. */
  required: bigint;
  /** How much more is needed. Zero when the close is already full. */
  shortfall: bigint;
  /** Whether the wallet can close this position outright right now. */
  closesFully: boolean;
}

export const fullCloseRequirement = (
  input: FullCloseInput & { availableDebtToken: bigint },
): FullCloseRequirement => {
  const required = debtTokenForFullClose(input);
  const shortfall =
    input.availableDebtToken >= required ? 0n : required - input.availableDebtToken;
  return { required, shortfall, closesFully: shortfall === 0n };
};
