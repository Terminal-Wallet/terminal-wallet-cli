/**
 * The debt-ratio guard on a partial f(x) close.
 *
 * Built from a real failure: tx 0x77cb1c3b… mined SUCCESSFULLY on 2026-08-17
 * having done nothing. RelayAdapt caught `ErrorDebtRatioTooLarge` from the pool
 * and re-shielded everything, so the position was untouched and the user paid
 * for a proof and a broadcaster to achieve it.
 *
 * The numbers below are that transaction's, read off chain, and are used as the
 * control: the guard must reject the withdrawal that actually reverted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capWithdrawForDebtRatio,
  projectDebtRatio,
  targetRatioFor,
} from "../../../src/railgun/transaction/fx/close-guard";

/** Position 1981, wstETH-Long, at block 25775126. */
const LIVE = {
  rawColls: 1_381_408_723_865n,
  rawDebts: 2_205_914_396_163_667n,
  debt: 2_205_914_396_163_667n, // long: native debt == raw
  collateralAmount: 1_112_546_362_187n,
  debtRatio: 841_544_618_970_177_202n,
  maxRatio: 866_666_666_666_666_666n,
  repayAmount: 2_196_007_594_983_290n, // 99.5509% of debt
  withdrawColl: 1_107_549_896_488n, // 99.5509% of native collateral
};

test("CONTROL: the withdrawal that actually reverted is rejected", () => {
  const out = capWithdrawForDebtRatio(LIVE);
  assert.ok(out.clamped, "the guard passed through the withdrawal that reverted");
  assert.ok(
    out.withdrawColl < LIVE.withdrawColl,
    `expected a reduction, got ${out.withdrawColl}`,
  );
});

test("CONTROL: the proposal really would have breached the cap", () => {
  // Reproduces the on-chain arithmetic in raw units, to show the guard is
  // rejecting something that genuinely fails rather than being cautious.
  // The pool received 1,375,448,981,774 raw — 99.5686% — against 99.5509% of
  // the debt.
  const after = projectDebtRatio(
    LIVE.debtRatio,
    LIVE.rawColls,
    LIVE.rawDebts,
    1_375_448_981_774n,
    LIVE.repayAmount,
  );
  assert.ok(
    after > LIVE.maxRatio,
    `projected ${after} should exceed the ${LIVE.maxRatio} cap`,
  );
  // ~0.876 against a 0.8667 cap.
  assert.ok(after > 870_000_000_000_000_000n && after < 885_000_000_000_000_000n);
});

test("the clamped withdrawal lands under the cap even if the conversion inflates it", () => {
  const out = capWithdrawForDebtRatio(LIVE);
  // Convert back to raw the way the manager does, then add the slip the guard
  // assumes, and confirm the residual is still inside the range.
  const raw = (out.withdrawColl * LIVE.rawColls) / LIVE.collateralAmount;
  const inflated = (raw * 10_005n) / 10_000n;
  const after = projectDebtRatio(
    LIVE.debtRatio,
    LIVE.rawColls,
    LIVE.rawDebts,
    inflated,
    LIVE.repayAmount,
  );
  assert.ok(after > 0n, "the residual has no collateral left");
  assert.ok(after <= LIVE.maxRatio, `projected ${after} still breaches the cap`);
});

test("the repay is never what gets reduced", () => {
  // The tokens were unshielded to repay. Withdrawing less collateral fixes the
  // ratio; repaying less would strand the debt token in the batch and is not
  // what the user asked for.
  const out = capWithdrawForDebtRatio(LIVE);
  assert.equal(LIVE.repayAmount, 2_196_007_594_983_290n, "input was mutated");
  assert.ok(out.withdrawColl > 0n, "clamped all the way to withdrawing nothing");
});

test("an ordinary partial close is left alone", () => {
  // Half the debt, half the collateral, on the same position. The residual is
  // large, so the conversion slip cannot move the ratio meaningfully and the
  // proportional withdrawal stands.
  const half = {
    ...LIVE,
    repayAmount: LIVE.debt / 2n,
    withdrawColl: LIVE.collateralAmount / 2n,
  };
  const out = capWithdrawForDebtRatio(half);
  assert.equal(out.clamped, false, "an ordinary close was clamped");
  assert.equal(out.withdrawColl, half.withdrawColl);
});

test("a proportional close holds the ratio where it started", () => {
  const after = projectDebtRatio(
    LIVE.debtRatio,
    LIVE.rawColls,
    LIVE.rawDebts,
    LIVE.collateralAmount / 2n === 0n ? 0n : LIVE.rawColls / 2n,
    LIVE.rawDebts / 2n,
  );
  const drift =
    after > LIVE.debtRatio ? after - LIVE.debtRatio : LIVE.debtRatio - after;
  assert.ok(drift < 1_000_000_000n, `ratio moved by ${drift} on a proportional close`);
});

test("repaying everything reports no residual ratio", () => {
  const after = projectDebtRatio(
    LIVE.debtRatio,
    LIVE.rawColls,
    LIVE.rawDebts,
    LIVE.rawColls,
    LIVE.rawDebts,
  );
  assert.equal(after, 0n, "a fully repaid position has no ratio to breach");
});

test("CONTROL: withdrawing everything while debt remains is unrepresentable", () => {
  // The failure mode in the limit. It must not read as a small number.
  const after = projectDebtRatio(
    LIVE.debtRatio,
    LIVE.rawColls,
    LIVE.rawDebts,
    LIVE.rawColls,
    LIVE.rawDebts / 2n,
  );
  assert.equal(after, -1n, "no collateral against live debt reported a finite ratio");
});

test("degenerate inputs return the proposal rather than dividing by zero", () => {
  for (const patch of [
    { rawColls: 0n },
    { rawDebts: 0n },
    { debt: 0n },
    { collateralAmount: 0n },
    { maxRatio: 0n },
    { debtRatio: 0n },
    { withdrawColl: 0n },
  ]) {
    assert.doesNotThrow(() => capWithdrawForDebtRatio({ ...LIVE, ...patch }));
  }
});

test("the target sits below the pool maximum, not on it", () => {
  // Landing exactly on the cap is landing on the revert: the whole problem is
  // that the arrival point cannot be controlled precisely.
  const out = capWithdrawForDebtRatio(LIVE);
  assert.ok(out.targetRatio < LIVE.maxRatio, "aimed at the cap itself");
  assert.ok(out.targetRatio >= LIVE.debtRatio, "aimed below where the position already is");
});

test("CONTROL: a fixed margin below the cap would clamp closes that are fine", () => {
  // Why the target is a midpoint rather than a constant. This pool caps at
  // 0.8667 and the position sits at 0.8415, so a 4% margin lands at 0.8320 —
  // under the position — and would clamp every close on it.
  const fixed = (LIVE.maxRatio * 9_600n) / 10_000n;
  assert.ok(fixed < LIVE.debtRatio, "the fixed margin is no longer below the position");
  assert.ok(targetRatioFor(LIVE.debtRatio, LIVE.maxRatio) >= LIVE.debtRatio);
});

test("the target degenerates safely on a position already over the cap", () => {
  // Nothing to aim at; do not invent headroom that does not exist.
  const over = targetRatioFor(900_000_000_000_000_000n, LIVE.maxRatio);
  assert.equal(over, 900_000_000_000_000_000n);
});

test("the guard never increases a withdrawal", () => {
  for (const frac of [10n, 50n, 90n, 99n, 995n]) {
    const denom = frac > 100n ? 1000n : 100n;
    const out = capWithdrawForDebtRatio({
      ...LIVE,
      repayAmount: (LIVE.debt * frac) / denom,
      withdrawColl: (LIVE.collateralAmount * frac) / denom,
    });
    assert.ok(
      out.withdrawColl <= (LIVE.collateralAmount * frac) / denom,
      `guard increased the withdrawal at ${frac}/${denom}`,
    );
  }
});
