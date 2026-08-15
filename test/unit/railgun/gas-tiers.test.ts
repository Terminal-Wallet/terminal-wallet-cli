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
  TIP_FLOOR_BASE_FEE_PCT,
  maxFeeFor,
  tipFloor,
  tiersFromRewards,
} from "../../../src/railgun/gas/gas-fee";

const gwei = (v: string) => parseUnits(v, "gwei");

/**
 * The base fee the fixtures below were measured at. Low enough that the
 * absolute floor still binds, so these assertions describe the same quiet-chain
 * calibration they always did.
 */
const FIXTURE_BASE_FEE = gwei("0.062");

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
  const { slow, average, fast } = tiersFromRewards(rewards(), FIXTURE_BASE_FEE);
  assert.equal(average, gwei("0.05"));
  assert.equal(fast, gwei("0.3434"));
  assert.equal(slow, gwei("0.025"), "p25 is below the floor, so the floor applies");
});

test("the tiers are ordered and distinguishable", () => {
  const { slow, average, fast } = tiersFromRewards(rewards(), FIXTURE_BASE_FEE);
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
  const { slow, average, fast } = tiersFromRewards(quiet, FIXTURE_BASE_FEE);
  assert.equal(slow, average, "expected the floor to bind both");
  assert.ok(slow <= average && average <= fast, "ordering broke");
});

test("what the old percentiles produced, for contrast", () => {
  // Same blocks, sampled where the tiers used to sample. "Fast" is the 2 gwei
  // default — a fixed price wearing a percentile's clothes — and the default
  // tip is 0.6, which against a 0.062 base fee is a 10x gas price.
  const { average, fast } = tiersFromRewards(rewardsAtOldPercentiles(), FIXTURE_BASE_FEE);
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
  const { slow, average, fast } = tiersFromRewards(quiet, FIXTURE_BASE_FEE);
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
  const { fast } = tiersFromRewards(blocks, FIXTURE_BASE_FEE);
  assert.equal(fast, gwei("0.03"), "a single spike block moved the tier");
});

// --- the floor scales with the base fee -------------------------------------

test("at the calibration base fee the absolute floor still binds", () => {
  // The anti-regression control. Scaling the floor must not disturb the quiet-
  // chain calibration the percentiles were lowered to achieve: 25% of a 0.062
  // gwei base fee is 0.0155, below MIN_PRIORITY_FEE, so nothing moves.
  assert.equal(tipFloor(FIXTURE_BASE_FEE), MIN_PRIORITY_FEE);
});

test("on a busy chain the floor scales instead", () => {
  // A 30 gwei base fee makes the absolute floor one twelve-hundredth of the
  // base fee, which is no floor at all.
  const busy = gwei("30");
  assert.equal(tipFloor(busy), (busy * TIP_FLOOR_BASE_FEE_PCT) / 100n);
  assert.ok(tipFloor(busy) > MIN_PRIORITY_FEE);
});

test("CONTROL: the absolute floor alone is meaningless once the chain is busy", () => {
  // What the floor was before it scaled, shown rather than described: the same
  // 0.025 gwei whether the base fee is 0.062 or 30 gwei.
  const busy = gwei("30");
  const ratio = busy / MIN_PRIORITY_FEE;
  assert.ok(ratio > 1000n, `a floor ${ratio}x below the base fee is not a floor`);
});

test("the floor is never below the absolute minimum", () => {
  // Including a chain reporting no base fee at all, where the scaled figure is
  // zero and a zero tip is never mined.
  for (const base of [0n, 1n, gwei("0.001"), gwei("0.062"), gwei("30")]) {
    assert.ok(tipFloor(base) >= MIN_PRIORITY_FEE, `floor collapsed at base ${base}`);
  }
});

test("the floor is monotonic in the base fee", () => {
  // A higher base fee must never produce a lower floor.
  let previous = 0n;
  for (const base of [0n, gwei("0.062"), gwei("1"), gwei("30"), gwei("300")]) {
    const floor = tipFloor(base);
    assert.ok(floor >= previous, `floor fell from ${previous} to ${floor}`);
    previous = floor;
  }
});

test("a busy chain lifts every tier to the scaled floor", () => {
  // The failure this fixes: measured tips are low precisely when most of the
  // block is already stuck, so the percentiles alone quote an unmineable tip.
  const busy = gwei("30");
  const stalled = Array.from({ length: 40 }, () => [gwei("0.01"), gwei("0.02"), gwei("0.03")]);
  const { slow, average, fast } = tiersFromRewards(stalled, busy);
  const floor = tipFloor(busy);
  assert.equal(slow, floor);
  assert.equal(average, floor);
  assert.equal(fast, floor, "a measured tip below the floor was quoted as-is");
});

test("a measured tip above the scaled floor is still preferred", () => {
  // The floor is a floor, not an override — it must not flatten a real market.
  const busy = gwei("30");
  const hot = Array.from({ length: 40 }, () => [gwei("8"), gwei("12"), gwei("20")]);
  const { slow, average, fast } = tiersFromRewards(hot, busy);
  assert.equal(slow, gwei("8"));
  assert.equal(average, gwei("12"));
  assert.equal(fast, gwei("20"));
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
  assert.equal(ceiling, tip + base * 3n);
});

/** Base fee after n consecutive FULL blocks, which is the 12.5%/block cap. */
const afterFullBlocks = (base: bigint, blocks: number): bigint => {
  let risen = base;
  for (let block = 0; block < blocks; block += 1) risen = (risen * 1125n) / 1000n;
  return risen;
};

test("headroom outlasts a slow 7702 proof", () => {
  // The regression this replaces. A cross-contract relay-adapt proof regularly
  // runs past 89 seconds, which is all the old 2x bought once the broadcaster's
  // 1.2x gas-limit padding is taken into account — so the ceiling went
  // underwater while proving and the send was refused after the user had paid
  // to generate the proof.
  //
  // 10 blocks is ~120s at 12s blocks.
  const base = gwei("0.088");
  const tip = gwei("0.02");
  const covered = (maxFeeFor(tip, base) * 12n) / 10n; // the broadcaster's padding
  const risen = afterFullBlocks(base, 10);
  assert.ok(
    covered > risen,
    `ceiling ${covered} does not cover a base fee of ${risen} ten full blocks later`,
  );
});

test("CONTROL: 2x headroom would not have survived that", () => {
  // Shown rather than described: the same ten blocks against the old constant.
  const base = gwei("0.088");
  const tip = gwei("0.02");
  const oldCeiling = ((tip + base * 2n) * 12n) / 10n;
  assert.ok(
    oldCeiling < afterFullBlocks(base, 10),
    "the old headroom already covered ten full blocks, so it was not the cause",
  );
});

test("headroom is bounded — it is not a blank cheque", () => {
  // The fee scales linearly with this, so a runaway multiplier is a permanent
  // premium paid on every relayed send.
  const base = gwei("1");
  const ceiling = maxFeeFor(0n, base);
  assert.ok(ceiling <= base * 4n, "headroom grew past 4x; the fee scales with it");
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
