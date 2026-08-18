/**
 * What it actually takes to close an f(x) position outright.
 *
 * A close is full only when the repay covers the whole debt. Below that the
 * recipe silently becomes a PARTIAL close, leaving a residue that keeps
 * accruing interest. The difference between the two is often a fraction of a
 * percent of the debt, and nothing on screen said so — the user was left to
 * work the number out from two fee ratios.
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

/**
 * How much debt a given shielded amount actually clears.
 *
 * The forward direction of `debtTokenForFullClose`, and the figure a preview
 * must quote: the gross amount is not what reaches the pool, so reporting it as
 * the repay overstates what the batch does and can show a debt of zero
 * remaining while the position is still open.
 */
export const repayFromAvailable = (
  availableDebtToken: bigint,
  repayFeeRatio: bigint,
  railgunUnshieldFeeBps: bigint,
): bigint => {
  if (availableDebtToken <= 0n) return 0n;
  const afterUnshield =
    (availableDebtToken * (BPS_DENOM - railgunUnshieldFeeBps)) / BPS_DENOM;
  return (afterUnshield * FEE_DENOM) / (FEE_DENOM + repayFeeRatio);
};

/** Debt token that must be INSIDE the batch to clear the debt, fees included. */
export const inBatchDebtTokenForFullClose = (
  debt: bigint,
  repayFeeRatio: bigint,
): bigint => (debt <= 0n ? 0n : divUp(debt * (FEE_DENOM + repayFeeRatio), FEE_DENOM));

/** What survives RAILGUN's unshield fee. */
export const netOfUnshieldFee = (
  gross: bigint,
  railgunUnshieldFeeBps: bigint,
): bigint => (gross * (BPS_DENOM - railgunUnshieldFeeBps)) / BPS_DENOM;

/**
 * How much of a token to sell to raise `needed` of another, learned from a
 * quote rather than a price feed.
 *
 * `probeGuaranteed` must be the quote's GUARANTEED (minimum) output, not its
 * expected fill: sizing against the expected one builds a batch that mines
 * having done nothing whenever the fill comes in a basis point light.
 *
 * The buffer covers the difference between the probe's rate and the rate at a
 * larger size, since a bigger sell moves through more of the book.
 */
export const sellAmountForDebtToken = (input: {
  needed: bigint;
  probeSell: bigint;
  probeGuaranteed: bigint;
  bufferBps: bigint;
}): bigint => {
  const { needed, probeSell, probeGuaranteed, bufferBps } = input;
  if (needed <= 0n) return 0n;
  if (probeSell <= 0n || probeGuaranteed <= 0n) {
    throw new Error(
      "sellAmountForDebtToken: the probe quote returned nothing to derive a rate from",
    );
  }
  const atProbeRate = divUp(needed * probeSell, probeGuaranteed);
  return divUp(atProbeRate * (BPS_DENOM + bufferBps), BPS_DENOM);
};
