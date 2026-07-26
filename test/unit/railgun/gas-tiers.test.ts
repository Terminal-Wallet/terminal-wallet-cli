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
  tiersFromRewards,
} from "../../../src/railgun/gas/gas-fee";

const gwei = (v: string) => parseUnits(v, "gwei");

/**
 * One row per block, one column per requested percentile. Shaped like the real
 * distribution: the low percentiles are near zero, the high one is pinned to
 * the 2 gwei default. Columns are [p25, p50, p75] under the current settings.
 */
const rewards = (): bigint[][] =>
  Array.from({ length: 40 }, () => [gwei("0.001"), gwei("0.025"), gwei("0.289")]);

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
  assert.equal(average, gwei("0.025"));
  assert.equal(fast, gwei("0.289"));
  assert.equal(slow, gwei("0.005"), "below the floor, so the floor applies");
});

test("the tiers are ordered and distinguishable", () => {
  const { slow, average, fast } = tiersFromRewards(rewards());
  assert.ok(slow < average, "slow is not cheaper than average");
  assert.ok(average < fast, "average is not cheaper than fast");
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

test("the floor is small enough to be honest", () => {
  // Blocks demonstrably include tips of 0.001 gwei. A floor far above that is
  // its own overpayment on the cheapest tier.
  assert.ok(MIN_PRIORITY_FEE <= gwei("0.005"));
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
