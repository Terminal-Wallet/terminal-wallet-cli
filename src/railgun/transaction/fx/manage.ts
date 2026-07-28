/**
 * One screen for adjusting a position, and the rule that turns it into a recipe.
 *
 * The cookbook ships four separate actions — topup, topup-and-borrow,
 * borrow-more, repay — and the wallet used to expose them as four cards. That
 * asks the wrong question first. You do not decide "I would like to perform a
 * top-up-and-borrow"; you decide you want more collateral in, or less debt
 * owed, and the verb is a consequence. So the screen takes two deltas and
 * works out which recipe expresses them.
 *
 * The four actions do not span every pair. Collateral can only go IN — none of
 * them withdraws it, since taking collateral out is what closing is for — and
 * adding collateral while repaying is not a shipped combination. Both of those
 * are refused by name here rather than silently rounded to something adjacent,
 * because "it did something other than what the sliders said" is the worst
 * outcome available on a screen that moves real collateral.
 */
import { FxAdjustAction } from "./adjust";

export type FxManagePlan =
  | { ok: true; action: FxAdjustAction; collateralDelta: bigint; debtDelta: bigint }
  | { ok: false; reason: string };

export interface FxManageDeltas {
  /** Collateral to ADD, in collateral decimals. Never negative. */
  collateralDelta: bigint;
  /** fxUSD to borrow (positive) or repay (negative), 18 decimals. */
  debtDelta: bigint;
}

/**
 * Which recipe a pair of deltas means.
 *
 * `repay` carries the amount to repay as a POSITIVE number, because that is
 * what the cookbook step takes — the sign lives in the action, not the
 * argument. Everything above this function speaks in signed deltas so the
 * sliders can be symmetric; this is the one place that converts.
 */
export const planFxManage = ({
  collateralDelta,
  debtDelta,
}: FxManageDeltas): FxManagePlan => {
  if (collateralDelta < 0n) {
    return {
      ok: false,
      reason: "collateral cannot be withdrawn — close the position to release it",
    };
  }
  if (collateralDelta === 0n && debtDelta === 0n) {
    return { ok: false, reason: "nothing to change" };
  }
  if (collateralDelta > 0n && debtDelta < 0n) {
    return {
      ok: false,
      reason:
        "adding collateral while repaying is not one recipe — do them as two transactions",
    };
  }
  if (debtDelta < 0n) {
    return { ok: true, action: "repay", collateralDelta: 0n, debtDelta: -debtDelta };
  }
  if (collateralDelta > 0n && debtDelta > 0n) {
    return { ok: true, action: "topup-and-borrow", collateralDelta, debtDelta };
  }
  if (collateralDelta > 0n) {
    return { ok: true, action: "topup", collateralDelta, debtDelta: 0n };
  }
  return { ok: true, action: "borrow-more", collateralDelta: 0n, debtDelta };
};

/** The verb to show once the deltas settle, so the card names what it will do. */
export const fxManageVerb = (plan: FxManagePlan): string => {
  if (!plan.ok) return "Manage";
  switch (plan.action) {
    case "topup":
      return "Add collateral";
    case "topup-and-borrow":
      return "Add & borrow";
    case "borrow-more":
      return "Borrow";
    case "repay":
      return "Repay";
  }
};
