/**
 * Hand-entered gas tiers.
 *
 * The presets come from the network and are trustworthy; a custom entry is
 * whatever was typed. Each of these three failures is silent if it is not
 * caught here — a zero max fee produces a transaction that can never be mined,
 * and a priority above the max is rejected outright by most nodes, in both
 * cases after the user has waited for a proof.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { parseCustomTier, feeDataForTier } from "../../../src/tui/screens/gas-tier";

test("a valid pair parses to wei", () => {
  const result = parseCustomTier("30", "1.5");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.maxFeePerGas, parseUnits("30", "gwei"));
  assert.equal(result.maxPriorityFeePerGas, parseUnits("1.5", "gwei"));
});

test("a zero max fee is refused", () => {
  const result = parseCustomTier("0", "0");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /greater than zero/);
});

test("a priority above the max fee is refused", () => {
  const result = parseCustomTier("10", "20");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /cannot exceed max fee/);
});

test("a priority equal to the max fee is allowed", () => {
  // Legal, and occasionally what someone means when they want it mined now.
  assert.equal(parseCustomTier("10", "10").ok, true);
});

test("a non-numeric entry is refused rather than coerced", () => {
  const result = parseCustomTier("fast", "1");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /Invalid gwei/);
});

test("a blank entry is a cancel, not an error", () => {
  assert.deepEqual(parseCustomTier(undefined, "1"), {
    ok: false,
    message: "Cancelled.",
  });
  assert.deepEqual(parseCustomTier("10", ""), { ok: false, message: "Cancelled." });
});

test("gasPrice tracks maxFeePerGas so legacy paths honour the chosen tier", () => {
  // A broadcaster submission becomes Type-1, which reads gasPrice and ignores
  // the 1559 fields. Without this the tier would be silently discarded.
  const fee = feeDataForTier(parseUnits("30", "gwei"), parseUnits("2", "gwei"));
  assert.equal(fee.gasPrice, parseUnits("30", "gwei"));
  assert.equal(fee.maxFeePerGas, parseUnits("30", "gwei"));
  assert.equal(fee.maxPriorityFeePerGas, parseUnits("2", "gwei"));
});
