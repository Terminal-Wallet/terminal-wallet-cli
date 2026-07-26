/**
 * Which priority-fee percentiles the slow / average / fast tiers come from.
 *
 * Tips in a block are steeply skewed and effectively bimodal: most pay almost
 * nothing, and a large cohort pays whatever their wallet defaults to — 2 gwei,
 * overwhelmingly. A percentile high enough to sample that cohort stops
 * measuring the market and starts reporting a constant.
 *
 * That is what happened: the tiers were p60/p80/p95, "fast" was 2.0000 gwei
 * essentially always, and the default tip was the p80 figure. A transaction
 * went out at a 0.765 gwei tip into a 0.057 gwei base fee — thirteen times the
 * gas price it needed.
 *
 * The fixture below is real mainnet shape, measured at a 0.062 gwei base fee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  MIN_PRIORITY_FEE,
  REWARD_PERCENTILES,
  maxFeeFor,
  tiersFromRewards,
} from "../../../src/railgun/gas/gas-fee";

const gwei = (v: string) => parseUnits(v, "gwei");

/**
 * One row per block, one column per requested percentile. Shaped like the real
 * distribution: the low percentiles are near zero, the high one is pinned to
 * the 2 gwei default. Columns are [p25, p50, p75] under the current settings.
 */
const rewards = (): bigint[][] =>
  Array.from({ length: 40 }, () => [gwei("0.0014"), gwei("0.05"), gwei("0.3434")]);

/** The same blocks sampled at p60/p80/p95, as the tiers used to be. */
const rewardsAtOldPercentiles = (): bigint[][] =>
  Array.from({ length: 40 }, () => [gwei("0.05"), gwei("0.6"), gwei("2.0")]);

test("the tiers sit below the wallet-default cohort", () => {
  assert.deepEqual(REWARD_PERCENTILES, [25, 50, 75]);
  // p80 and above sample the defaults, not the market.
  assert.ok(
    REWARD_PERCENTILES.every((p) => p < 80),
    "a tier percentile reaches the 2 gwei default cohort",
  );
});

test("tiers come out of the measured distribution", () => {
  const { slow, average, fast } = tiersFromRewards(rewards());
  assert.equal(average, gwei("0.05"));
  assert.equal(fast, gwei("0.3434"));
  assert.equal(slow, gwei("0.025"), "p25 is below the floor, so the floor applies");
});

test("the tiers are ordered and distinguishable", () => {
  const { slow, average, fast } = tiersFromRewards(rewards());
  assert.ok(slow < average, "slow is not cheaper than average");
  assert.ok(average < fast, "average is not cheaper than fast");
});

test("a market below the floor collapses slow into average", () => {
  // Not a defect: every tier is max(percentile, floor), so when the median tip
  // is at or under the minimum sensible one there is no cheaper option to
  // offer. Ordering is non-decreasing by construction; separation is not
  // guaranteed, and pretending otherwise would mean quoting a slow tier that
  // cannot be mined.
  const quiet = Array.from({ length: 40 }, () => [
    gwei("0.0001"),
    gwei("0.001"),
    gwei("0.3"),
  ]);
  const { slow, average, fast } = tiersFromRewards(quiet);
  assert.equal(slow, average, "expected the floor to bind both");
  assert.ok(slow <= average && average <= fast, "ordering broke");
});

test("what the old percentiles produced, for contrast", () => {
  // Same blocks, sampled where the tiers used to sample. "Fast" is the 2 gwei
  // default — a fixed price wearing a percentile's clothes — and the default
  // tip is 0.6, which against a 0.062 base fee is a 10x gas price.
  const { average, fast } = tiersFromRewards(rewardsAtOldPercentiles());
  assert.equal(fast, gwei("2.0"));
  assert.equal(average, gwei("0.6"));
  const baseFee = gwei("0.062");
  assert.ok(
    (average + baseFee) / baseFee >= 10n,
    "the old default should demonstrate the overpayment it caused",
  );
});

test("no tier is ever a zero tip", () => {
  // A transaction offering no tip may never be mined, and a percentile can be
  // 0 when most sampled blocks report no tip at it.
  const quiet = Array.from({ length: 40 }, () => [0n, 0n, 0n]);
  const { slow, average, fast } = tiersFromRewards(quiet);
  assert.equal(slow, MIN_PRIORITY_FEE);
  assert.equal(average, MIN_PRIORITY_FEE);
  assert.equal(fast, MIN_PRIORITY_FEE);
});

test("the floor is what slow actually means", () => {
  // Below the median the distribution is degenerate, not merely cheap: p25 was
  // 0.0014 gwei against a p50 of 0.05. So in quiet conditions the floor — not
  // the percentile — is the slow tier, and it has to be a tip that gets mined
  // rather than the smallest a block has ever accepted.
  assert.ok(MIN_PRIORITY_FEE >= gwei("0.02"), "too low to be trusted as slow");
  assert.ok(MIN_PRIORITY_FEE <= gwei("0.05"), "a floor above the median is not slow");
});

test("the median across blocks, not the mean", () => {
  // A few spike blocks drag a mean far above the fee a normal transaction
  // needs, which is the failure mode this smoothing exists to avoid.
  const blocks = [
    ...Array.from({ length: 39 }, () => [gwei("0.01"), gwei("0.02"), gwei("0.03")]),
    [gwei("500"), gwei("500"), gwei("500")], // one MEV block
  ];
  const { fast } = tiersFromRewards(blocks);
  assert.equal(fast, gwei("0.03"), "a single spike block moved the tier");
});

// --- the ceiling ------------------------------------------------------------

test("the max fee leaves room for the base fee to rise", () => {
  // Set to exactly tip + base it covers only the base fee at the moment it was
  // read. A proof takes long enough for that to stop being true, and the
  // broadcaster rejects what no longer covers the current base fee.
  const base = gwei("0.088");
  const tip = gwei("0.02");
  const ceiling = maxFeeFor(tip, base);
  assert.ok(ceiling > tip + base, "no headroom at all");
  assert.equal(ceiling, tip + base * 2n);
});

test("headroom survives several full blocks", () => {
  // Base fee rises at most 12.5% per block. The ceiling should still cover it
  // after a realistic proof-generation delay.
  const base = gwei("0.088");
  const ceiling = maxFeeFor(gwei("0.02"), base);
  let risen = base;
  for (let block = 0; block < 5; block += 1) risen = (risen * 1125n) / 1000n;
  assert.ok(
    ceiling > risen,
    `ceiling ${ceiling} does not cover a base fee of ${risen} five full blocks later`,
  );
});

test("the ceiling is not a price", () => {
  // What a self-signed transaction actually pays is base + tip, whatever the
  // ceiling is — the headroom costs nothing there. It is not free for a
  // broadcaster send, whose fee scales with the ceiling, which is why the
  // multiplier is deliberate rather than generous.
  const base = gwei("0.088");
  const tip = gwei("0.02");
  const paid = base + tip;
  assert.ok(maxFeeFor(tip, base) > paid);
  // Still far below what the old p80 default cost: 0.765 tip on a 0.057 base.
  assert.ok(maxFeeFor(tip, base) < gwei("0.822"));
});
