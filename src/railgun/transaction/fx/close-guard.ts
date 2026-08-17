/**
 * Keeping a partial close inside the pool's debt-ratio range.
 *
 * `computeFxClose` withdraws collateral in proportion to the debt repaid, which
 * leaves the debt ratio where it started — correct arithmetic, and safe for most
 * of the range. It is sized in NATIVE collateral, because that is what
 * `PoolManager.operate` takes. The pool underneath works in RAW units, and the
 * manager converts on the way in.
 *
 * That conversion does not round-trip exactly. Measured on mainnet: a withdrawal
 * of 99.5509% of native collateral arrived at the pool as 99.5686% of raw
 * collateral, 0.0177 points MORE than the debt repaid.
 *
 * Normally that is noise. On a near-total close it is not, because the residual
 * position is what the ratio is computed over, and the residual is tiny. The
 * sensitivity is `withdrawRaw / collAfter` — 231x when 99.5% is being closed —
 * so 0.02% of extra withdrawal became a 4.1% worse ratio, taking a position at
 * 0.8415 to 0.8760 against a 0.8667 cap. The pool reverted with
 * ErrorDebtRatioTooLarge, and because RelayAdapt catches a failed sub-call and
 * re-shields, the transaction MINED SUCCESSFULLY having done nothing.
 *
 * The constraint is that collateral must not fall too far relative to debt, so
 * the fix is to withdraw LESS — never to repay less. The repay is what the user
 * asked for and what their tokens were unshielded for; the leftover collateral
 * stays in the position and comes out on the next withdrawal.
 *
 * Pure and side-effect free: the chain reads happen in the caller.
 */

/** Ratios are 1e18-scaled, matching `getDebtRatioRange` and `getPositionDebtRatio`. */
export const FX_RATIO_PRECISION = 10n ** 18n;

const BPS = 10_000n;

/**
 * Assumed worst-case inflation of the native -> raw conversion, in basis points.
 *
 * Measured at 1.97 bps on mainnet. 5 covers that with room without being so
 * wide that ordinary closes are clamped, and it is only ever applied as a
 * headroom assumption — it never inflates what is actually sent.
 */
export const FX_CONVERSION_SLIP_BPS = 5n;

/**
 * Where a clamped close is aimed: half way from the position's CURRENT ratio to
 * the pool's maximum.
 *
 * A fixed margin below the cap does not work, because it can land BELOW where
 * the position already is — this pool caps at 0.8667 and the position that
 * failed sat at 0.8415, so a 4% margin would demand 0.8320 and clamp every
 * close on it, including ones that were never in danger. A proportional close
 * holds the ratio where it started, so anything at or under the current ratio
 * must pass untouched.
 *
 * The midpoint is always at least the current ratio, so ordinary closes are not
 * touched, and always strictly under the cap, so a clamped one has real room.
 * It spends half the available headroom on safety, which scales with how much
 * headroom there actually is rather than assuming a number.
 */
export const targetRatioFor = (debtRatio: bigint, maxRatio: bigint): bigint =>
  maxRatio <= debtRatio ? debtRatio : debtRatio + (maxRatio - debtRatio) / 2n;

export interface FxCloseGuardInput {
  /** Position collateral in the pool's raw units. */
  rawColls: bigint;
  /** Position debt in the pool's raw units. */
  rawDebts: bigint;
  /** Position debt in native debt-token units (equals rawDebts on a long). */
  debt: bigint;
  /** Position collateral in native units, as PoolManager.operate takes it. */
  collateralAmount: bigint;
  /** Current debt ratio, 1e18-scaled. */
  debtRatio: bigint;
  /** The pool's maximum debt ratio, 1e18-scaled. */
  maxRatio: bigint;
  /** Debt to repay, native units, as computeFxClose sized it. */
  repayAmount: bigint;
  /** Collateral to withdraw, native units, as computeFxClose sized it. */
  withdrawColl: bigint;
}

export interface FxCloseGuardResult {
  /** The withdrawal to actually send. Never larger than the one proposed. */
  withdrawColl: bigint;
  /** Whether the proposal had to be reduced. */
  clamped: boolean;
  /** Ratio the proposal would have produced, worst case, 1e18-scaled. */
  projectedRatio: bigint;
  /** Ratio the returned withdrawal aims at, 1e18-scaled. */
  targetRatio: bigint;
}

/**
 * The debt ratio a close would leave behind.
 *
 * The ratio is proportional to debt/collateral at a fixed price, and both sides
 * move together here, so it can be projected from the current ratio without
 * reading the oracle:
 *
 *   after = before x (debtAfter / debtBefore) x (collBefore / collAfter)
 */
export const projectDebtRatio = (
  debtRatio: bigint,
  rawColls: bigint,
  rawDebts: bigint,
  withdrawRaw: bigint,
  repayRaw: bigint,
): bigint => {
  const collAfter = rawColls - withdrawRaw;
  const debtAfter = rawDebts - repayRaw;
  // Nothing left to owe is not a ratio breach; it is a closed position.
  if (debtAfter <= 0n) return 0n;
  // No collateral left against debt that remains is the breach this exists to
  // prevent, and it has no finite ratio to report.
  if (collAfter <= 0n) return -1n;
  return (debtRatio * debtAfter * rawColls) / (rawDebts * collAfter);
};

/**
 * Reduce a proposed withdrawal until the position it leaves is inside the
 * pool's range, assuming the conversion inflates the withdrawal against us.
 *
 * A full close never reaches here — it is sent as the pool's own sentinel and
 * leaves no residual to have a ratio.
 */
export const capWithdrawForDebtRatio = (
  input: FxCloseGuardInput,
): FxCloseGuardResult => {
  const {
    rawColls,
    rawDebts,
    debt,
    collateralAmount,
    debtRatio,
    maxRatio,
    repayAmount,
    withdrawColl,
  } = input;

  const target = targetRatioFor(debtRatio, maxRatio);
  const unchanged = (projectedRatio: bigint): FxCloseGuardResult => ({
    withdrawColl,
    clamped: false,
    projectedRatio,
    targetRatio: target,
  });

  // Degenerate inputs are the caller's problem, not this function's; refusing to
  // divide by them is the whole contribution here.
  if (
    rawColls <= 0n ||
    rawDebts <= 0n ||
    debt <= 0n ||
    collateralAmount <= 0n ||
    maxRatio <= 0n ||
    debtRatio <= 0n ||
    withdrawColl <= 0n
  ) {
    return unchanged(0n);
  }

  // Both legs in the raw units the pool's own check uses. On a long the debt is
  // already raw; on a short it is scaled, so it is converted proportionally
  // rather than assumed.
  const toRaw = (native: bigint) => (native * rawColls) / collateralAmount;
  const repayRaw = (rawDebts * repayAmount) / debt;
  const proposedRaw = toRaw(withdrawColl);
  const worstRaw = (proposedRaw * (BPS + FX_CONVERSION_SLIP_BPS)) / BPS;

  const projected = projectDebtRatio(
    debtRatio,
    rawColls,
    rawDebts,
    worstRaw,
    repayRaw,
  );
  // Repaid in full, or already inside the range with the slip absorbed.
  if (projected === 0n) return unchanged(projected);
  if (projected > 0n && projected <= target) return unchanged(projected);

  // collAfter must satisfy:
  //   before x (debtAfter / rawDebts) x (rawColls / collAfter)  <=  target
  const debtAfter = rawDebts - repayRaw;
  const collAfterMin =
    (debtRatio * debtAfter * rawColls) / (rawDebts * target) + 1n;
  if (collAfterMin >= rawColls) {
    // No withdrawal at all keeps this position inside the range.
    return { withdrawColl: 0n, clamped: true, projectedRatio: projected, targetRatio: target };
  }

  // Undo the slip assumption so the figure SENT, once inflated, still lands
  // under the target rather than on it.
  const allowedWorstRaw = rawColls - collAfterMin;
  const allowedRaw = (allowedWorstRaw * BPS) / (BPS + FX_CONVERSION_SLIP_BPS);
  const allowedNative = (allowedRaw * collateralAmount) / rawColls;
  const capped = allowedNative < withdrawColl ? allowedNative : withdrawColl;

  return {
    withdrawColl: capped < 0n ? 0n : capped,
    clamped: capped < withdrawColl,
    projectedRatio: projected,
    targetRatio: target,
  };
};
