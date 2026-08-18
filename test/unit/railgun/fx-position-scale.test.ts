/**
 * Telling a residual position from a closed one.
 *
 * A partial close that repays almost everything leaves a residue. It is still
 * OPEN — debt keeps accruing and it can still be liquidated — but every figure
 * on its row rounds to zero, so it looks either finished or broken. Position
 * 1981 ended exactly there on 2026-08-18: ~5.3e9 wei of wstETH collateral
 * against live debt, after a close that repaid 99.55%.
 *
 * Reading that as "closed" is the dangerous direction, which is why `empty` is
 * reserved for a position with NO collateral at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  fxPositionScale,
  fxScaleNote,
} from "../../../src/railgun/transaction/fx/position-state";

const at = (collateralAmount: bigint, collateralDecimals = 18) => ({
  collateralAmount,
  collateralDecimals,
});

test("an ordinary position is live", () => {
  assert.equal(fxPositionScale(at(parseUnits("1.5", 18))), "live");
  assert.equal(fxPositionScale(at(parseUnits("0.01", 18))), "live");
});

test("CONTROL: what position 1981 was left as reads as residual, not closed", () => {
  // ~5.3e9 wei of an 18-decimal collateral: 0.0000000000 at any precision the
  // wallet shows, but the position is open and owes money.
  const scale = fxPositionScale(at(5_282_000_000n));
  assert.equal(scale, "dust");
  assert.notEqual(scale, "empty");
  assert.match(fxScaleNote(scale), /still open/);
});

test("the boundary is the precision the rows actually render", () => {
  // 4 dp. 0.0001 survives; anything under it cannot be shown.
  assert.equal(fxPositionScale(at(parseUnits("0.0001", 18))), "live");
  assert.equal(fxPositionScale(at(parseUnits("0.00009", 18))), "dust");
});

test("only a position with no collateral is empty", () => {
  // Burnt, or an id that never existed. getPositionDebtRatio returns 0 for a
  // non-existent position, so collateral is the discriminator.
  assert.equal(fxPositionScale(at(0n)), "empty");
  assert.equal(fxPositionScale(at(-1n)), "empty");
  assert.equal(fxPositionScale(at(1n)), "dust", "one wei is still held");
});

test("it scales with the token's own decimals", () => {
  // The same nominal amount on an 8-decimal collateral is not dust.
  assert.equal(fxPositionScale(at(9_000n, 8)), "dust");
  assert.equal(fxPositionScale(at(parseUnits("0.5", 8), 8)), "live");
});

test("CONTROL: dust is never described as closed or finished", () => {
  // The whole point. A residue that reads as done hides accruing debt.
  const note = fxScaleNote("dust");
  assert.doesNotMatch(note, /closed|finished|complete/i);
  assert.match(note, /accruing/);
});

test("live and empty carry no note", () => {
  assert.equal(fxScaleNote("live"), "");
  assert.equal(fxScaleNote("empty"), "");
});
