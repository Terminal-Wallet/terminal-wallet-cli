/**
 * The header's gas ticker.
 *
 * It rounded anything at or above a gwei to a whole number, which on a chain
 * sitting at 14 gwei printed "14 / 14 / 14" — three prices that differ, shown
 * as one, in the one place the deck reports them. The tiers ARE the fractions
 * at ordinary gas prices, so rounding them away leaves a live-updating widget
 * that says nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { gasTicker } from "../../../src/tui/format/deck";
import { CustomGasEstimate } from "../../../src/models/gas-models";

const gwei = (n: string) => parseUnits(n, "gwei");

const estimate = (
  base: string,
  slow: string,
  average: string,
  fast: string,
): CustomGasEstimate =>
  ({
    baseFeePerGas: gwei(base),
    slow: gwei(slow),
    average: gwei(average),
    fast: gwei(fast),
    gasPrice: 0n,
    maxFeePerGas: 0n,
    maxPriorityFeePerGas: 0n,
  }) as CustomGasEstimate;

test("tiers that differ by less than a gwei still read as different", () => {
  // The reported case: rounding turned a working ticker into three equal
  // numbers.
  const ticker = gasTicker(estimate("14", "0.1", "0.45", "0.9"));
  assert.equal(ticker, "14.10 / 14.45 / 14.90 gwei");
});

test("the base fee is included, since that is what a transaction pays", () => {
  assert.equal(gasTicker(estimate("20", "1", "2", "3")), "21.00 / 22.00 / 23.00 gwei");
});

test("a busy chain stays on one line", () => {
  // Three-digit gas with two decimals each would run the stat card over, and
  // at 120 gwei the second decimal is not a number anyone acts on.
  assert.equal(gasTicker(estimate("120", "5", "10", "20")), "125.0 / 130.0 / 140.0 gwei");
});

test("sub-gwei keeps the precision that is the whole figure", () => {
  // An L2 at 0.003 gwei rounded to two decimals is 0.00.
  const ticker = gasTicker(estimate("0.001", "0.001", "0.002", "0.004"));
  assert.match(ticker, /0\.002 \/ 0\.003 \/ 0\.005 gwei/);
});

test("a zero estimate does not print a decimal fringe", () => {
  assert.equal(gasTicker(estimate("0", "0", "0", "0")), "0 / 0 / 0 gwei");
});
