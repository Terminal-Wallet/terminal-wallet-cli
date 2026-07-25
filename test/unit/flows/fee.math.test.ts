import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { protocolFee, feePct, FEE_DENOM } from "../../../src/flows/fee";

test("protocolFee computes a 0.25% fee (2.5M bp) on an amount", () => {
  // 0.25% of 100 tokens = 0.25 tokens
  assert.equal(protocolFee(parseUnits("100", 18), 2_500_000n), parseUnits("0.25", 18));
  // 0.25% of 1 WBTC (8 decimals)
  assert.equal(protocolFee(parseUnits("1", 8), 2_500_000n), parseUnits("0.0025", 8));
});

test("feePct converts basis points to a percentage", () => {
  assert.equal(feePct(2_500_000n), 0.25);
  assert.equal(feePct(FEE_DENOM), 100);
  assert.equal(feePct(0n), 0);
});
