/**
 * What a full close actually costs, in the debt token.
 *
 * A close is full only when the repay covers the whole debt; one wei under and
 * the recipe silently becomes a PARTIAL close, leaving an open position that
 * keeps accruing. Position 1981 landed there three times, each time short by a
 * fraction of a percent, with nothing on screen naming the figure.
 *
 * This inverts computeFxRepay, so the two must agree exactly at the boundary —
 * which is what most of these check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BPS_DENOM,
  FEE_DENOM,
  debtTokenForFullClose,
  fullCloseRequirement,
} from "../../../src/railgun/transaction/fx/full-close";

/** computeFxRepay's forward sizing, reproduced so the inverse is checked against it. */
const maxRepayFor = (
  available: bigint,
  repayFeeRatio: bigint,
  unshieldBps: bigint,
): bigint => {
  const afterUnshield = (available * (BPS_DENOM - unshieldBps)) / BPS_DENOM;
  return (afterUnshield * FEE_DENOM) / (FEE_DENOM + repayFeeRatio);
};

const CASES = [
  { debt: 2_205_914_396_163_667n, repayFeeRatio: 0n, unshieldBps: 25n },
  { debt: 2_205_914_396_163_667n, repayFeeRatio: 1_000_000n, unshieldBps: 25n },
  { debt: 10n ** 18n, repayFeeRatio: 5_000_000n, unshieldBps: 25n },
  { debt: 1n, repayFeeRatio: 0n, unshieldBps: 0n },
  { debt: 999_999_999_999n, repayFeeRatio: 3_000_000n, unshieldBps: 100n },
];

test("the required amount really does buy a full close", () => {
  // The inverse must land on or above the debt under the forward formula.
  for (const c of CASES) {
    const required = debtTokenForFullClose({
      debt: c.debt,
      repayFeeRatio: c.repayFeeRatio,
      railgunUnshieldFeeBps: c.unshieldBps,
    });
    const repay = maxRepayFor(required, c.repayFeeRatio, c.unshieldBps);
    assert.ok(
      repay >= c.debt,
      `debt ${c.debt}: required ${required} only repays ${repay}`,
    );
  }
});

test("CONTROL: one wei less does NOT buy a full close", () => {
  // The figure has to be tight as well as sufficient, or it is just a guess
  // that happens to work.
  for (const c of CASES) {
    if (c.debt <= 1n) continue;
    const required = debtTokenForFullClose({
      debt: c.debt,
      repayFeeRatio: c.repayFeeRatio,
      railgunUnshieldFeeBps: c.unshieldBps,
    });
    const repay = maxRepayFor(required - 1n, c.repayFeeRatio, c.unshieldBps);
    assert.ok(
      repay < c.debt,
      `debt ${c.debt}: ${required} is not minimal, ${required - 1n} also closes`,
    );
  }
});

test("both fees are charged, in order", () => {
  // RAILGUN's on the way out of the shield, then the pool's on the repay.
  const debt = 1_000_000_000_000_000_000n;
  const none = debtTokenForFullClose({ debt, repayFeeRatio: 0n, railgunUnshieldFeeBps: 0n });
  assert.equal(none, debt, "with no fees you need exactly the debt");
  const unshieldOnly = debtTokenForFullClose({ debt, repayFeeRatio: 0n, railgunUnshieldFeeBps: 25n });
  const repayOnly = debtTokenForFullClose({ debt, repayFeeRatio: 1_000_000n, railgunUnshieldFeeBps: 0n });
  const both = debtTokenForFullClose({ debt, repayFeeRatio: 1_000_000n, railgunUnshieldFeeBps: 25n });
  assert.ok(unshieldOnly > none);
  assert.ok(repayOnly > none);
  assert.ok(both > unshieldOnly && both > repayOnly, "the fees do not compound");
});

test("a zero debt needs nothing", () => {
  assert.equal(debtTokenForFullClose({ debt: 0n, repayFeeRatio: 1n, railgunUnshieldFeeBps: 25n }), 0n);
});

test("an unshield fee that consumes everything is refused, not answered", () => {
  // No amount is sufficient, so returning a number would be a lie.
  assert.throws(() =>
    debtTokenForFullClose({ debt: 1n, repayFeeRatio: 0n, railgunUnshieldFeeBps: BPS_DENOM }),
  );
});

test("the shortfall is what is missing, and zero when nothing is", () => {
  const base = { debt: 1_000n, repayFeeRatio: 0n, railgunUnshieldFeeBps: 0n };
  const exact = fullCloseRequirement({ ...base, availableDebtToken: 1_000n });
  assert.equal(exact.shortfall, 0n);
  assert.ok(exact.closesFully);

  const short = fullCloseRequirement({ ...base, availableDebtToken: 999n });
  assert.equal(short.shortfall, 1n);
  assert.ok(!short.closesFully);

  const over = fullCloseRequirement({ ...base, availableDebtToken: 5_000n });
  assert.equal(over.shortfall, 0n, "a surplus is not a negative shortfall");
  assert.ok(over.closesFully);
});

test("CONTROL: the near-miss that kept producing partial closes", () => {
  // 99.55% of the debt is not a full close, and the gap is small enough that
  // it reads as a rounding artefact rather than a decision.
  const debt = 2_205_914_396_163_667n;
  const available = (debt * 9_955n) / 10_000n;
  const out = fullCloseRequirement({
    debt,
    repayFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
    availableDebtToken: available,
  });
  assert.ok(!out.closesFully, "99.55% should not close outright");
  assert.ok(out.shortfall > 0n);
  // Under 1% of the debt — which is exactly why it needs stating explicitly.
  assert.ok(out.shortfall * 100n < debt, `shortfall ${out.shortfall} is not small`);
});
