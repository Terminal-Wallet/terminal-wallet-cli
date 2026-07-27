/**
 * What an f(x) position is worth and what would kill it.
 *
 * Typing a collateral amount and a debt amount tells you nothing about whether
 * the position is sane. The numbers that matter are derived: how leveraged it
 * is, and how far the collateral can fall before the protocol rebalances it or
 * liquidates it. Those are what a slider should be moving against.
 *
 * Pure and unit-tested, because it is the arithmetic a user decides on. The
 * pool's own thresholds come from the chain (`getFxPool`), not from constants
 * here — they are governance parameters and they move.
 */

/** The pool's debt ratios are WAD-scaled: 0.88 arrives as 880000000000000000. */
export const WAD = 10n ** 18n;

/** Where a position sits relative to the pool's two thresholds. */
export type FxRiskZone = "safe" | "rebalance" | "liquidation";

export interface FxRiskInput {
  collateralAmount: bigint;
  collateralDecimals: number;
  /** USD per whole collateral token. */
  collateralPriceUsd: number;
  /** fxUSD owed, 18 decimals. fxUSD is a dollar, so this is also its value. */
  debtAmount: bigint;
  /** WAD. Above this the protocol rebalances the position. */
  rebalanceDebtRatio: bigint;
  /** WAD. Above this it is liquidated. */
  liquidationDebtRatio: bigint;
}

export interface FxRisk {
  /** debt / collateral value, as a fraction. 0 when there is no debt. */
  debtRatio: number;
  /** 1 / (1 - debtRatio) — 40% debt is 1.7x. Infinity once debt >= value. */
  leverage: number;
  /** Collateral price at which the position starts rebalancing. */
  rebalancePrice: number;
  /** Collateral price at which it is liquidated. */
  liquidationPrice: number;
  zone: FxRiskZone;
  /** USD value of the collateral at the price given. */
  collateralValueUsd: number;
  /** USD value of the debt. */
  debtUsd: number;
}

const toNumber = (amount: bigint, decimals: number): number =>
  Number(amount) / 10 ** decimals;

/**
 * The position's risk at a given collateral price.
 *
 * Returned as floats on purpose: this is a figure shown to a person deciding
 * how much to borrow, not a value any contract consumes. The exact amounts sent
 * on chain stay bigint all the way down.
 */
export const fxPositionRisk = (input: FxRiskInput): FxRisk => {
  const {
    collateralAmount,
    collateralDecimals,
    collateralPriceUsd,
    debtAmount,
    rebalanceDebtRatio,
    liquidationDebtRatio,
  } = input;

  const collateral = toNumber(collateralAmount, collateralDecimals);
  const debtUsd = toNumber(debtAmount, 18);
  const collateralValueUsd = collateral * collateralPriceUsd;

  const rebalanceAt = Number(rebalanceDebtRatio) / Number(WAD);
  const liquidationAt = Number(liquidationDebtRatio) / Number(WAD);

  // No collateral is not a position. Reporting 0 would read as safe, and the
  // caller is mid-edit with an empty field rather than holding something
  // dangerous — so say "no debt supported" and let the gates refuse it.
  if (collateral <= 0 || collateralPriceUsd <= 0) {
    return {
      debtRatio: debtUsd > 0 ? Infinity : 0,
      leverage: debtUsd > 0 ? Infinity : 1,
      rebalancePrice: 0,
      liquidationPrice: 0,
      zone: debtUsd > 0 ? "liquidation" : "safe",
      collateralValueUsd: 0,
      debtUsd,
    };
  }

  const debtRatio = debtUsd / collateralValueUsd;
  // Debt at or above the collateral's value has no finite leverage; the
  // position is underwater rather than highly levered.
  const leverage = debtRatio >= 1 ? Infinity : 1 / (1 - debtRatio);

  // The ratio is debt / (collateral x price), so the price that puts the ratio
  // at a threshold is debt / (collateral x threshold).
  const priceAt = (threshold: number) =>
    threshold <= 0 ? 0 : debtUsd / (collateral * threshold);

  return {
    debtRatio,
    leverage,
    rebalancePrice: priceAt(rebalanceAt),
    liquidationPrice: priceAt(liquidationAt),
    zone:
      debtRatio >= liquidationAt
        ? "liquidation"
        : debtRatio >= rebalanceAt
          ? "rebalance"
          : "safe",
    collateralValueUsd,
    debtUsd,
  };
};

/**
 * The fxUSD debt that puts a position at `targetRatio` of its collateral value.
 *
 * This is what a loan slider moves: the user picks a debt ratio and this says
 * what that is in fxUSD. Returns 18-decimal fxUSD, floored — rounding up would
 * hand back a figure fractionally riskier than the one on screen.
 */
export const fxDebtForRatio = (
  collateralAmount: bigint,
  collateralDecimals: number,
  collateralPriceUsd: number,
  targetRatio: number,
): bigint => {
  if (targetRatio <= 0 || collateralPriceUsd <= 0 || collateralAmount <= 0n) {
    return 0n;
  }
  const collateral = toNumber(collateralAmount, collateralDecimals);
  const debt = collateral * collateralPriceUsd * targetRatio;
  if (!isFinite(debt) || debt <= 0) return 0n;
  return BigInt(Math.floor(debt * 1e18));
};

/**
 * The most a position may be levered from the builder.
 *
 * Opening at the rebalance threshold means opening into a position the protocol
 * immediately acts on, so the slider stops short of it. The margin is a
 * fraction of the threshold rather than a fixed number of points, because both
 * thresholds are governance parameters.
 */
export const fxMaxOpenRatio = (rebalanceDebtRatio: bigint): number =>
  (Number(rebalanceDebtRatio) / Number(WAD)) * 0.9;
