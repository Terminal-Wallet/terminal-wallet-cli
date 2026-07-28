/**
 * A position, said in one line, and a move said as a step.
 *
 * Figures below are the real mainnet ones read from the wstETH-Long pool:
 * #1980 sits at a 49.15% debt ratio, #1981 at 80.85%, against a rebalance
 * threshold of 88% and a liquidation threshold of 95%.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "ethers";
import {
  fxCloseLines,
  fxPositionSummary,
  fxRiskDeltaLines,
} from "../../../src/tui/format/fx-position";
import { FxPositionState } from "../../../src/railgun/transaction/fx/position-state";
import { fxPositionRisk } from "../../../src/railgun/transaction/fx/risk";

const strip = (s: string) => s.replace(/\{[^}]*\}/g, "");
const fmt = (amount: bigint, decimals: number) =>
  Number(formatUnits(amount, decimals)).toFixed(4);

const state = (over: Partial<FxPositionState> = {}): FxPositionState => ({
  collateralAmount: 1606749600862549820n,
  collateralDecimals: 18,
  debtAmount: 1880030086474238325175n,
  debtRatio: 491524405228125399n,
  rebalanceDebtRatio: 880000000000000000n,
  liquidationDebtRatio: 950000000000000000n,
  borrowFeeRatio: 5000000n,
  repayFeeRatio: 2000000n,
  ...over,
});

test("a healthy position states both sides and calls itself safe", () => {
  const line = strip(fxPositionSummary(state(), "wstETH", fmt));
  assert.match(line, /1\.6067 wstETH/);
  assert.match(line, /1880\.0301 fxUSD/);
  assert.match(line, /49\.2%/);
  assert.match(line, /safe/);
});

test("a position close to the threshold says so before it crosses", () => {
  // #1981 at 80.85% against a rebalance at 88%. Reporting it as plain "safe"
  // is true and useless: the point of the screen is to catch it before it is
  // not.
  const line = strip(fxPositionSummary(state({ debtRatio: 808535649149876513n }), "wstETH", fmt));
  assert.match(line, /80\.9%/);
  assert.match(line, /near rebalance/);
});

test("past the threshold it is not called safe", () => {
  const line = strip(fxPositionSummary(state({ debtRatio: 900000000000000000n }), "wstETH", fmt));
  assert.match(line, /rebalancing/);
  assert.ok(!/safe/.test(line));
});

test("a position that could not be read is not rendered as an empty one", () => {
  // The dangerous default: zeroes read as a healthy position with no debt,
  // which invites borrowing against collateral that may not be there.
  const line = strip(fxPositionSummary(undefined, "wstETH", fmt));
  assert.match(line, /unavailable|could not read/i);
  assert.ok(!/safe/.test(line));
  assert.ok(!/0\.0000/.test(line), "an unreadable position must not show figures");
});

const risk = (collateral: bigint, debt: bigint) =>
  fxPositionRisk({
    collateralAmount: collateral,
    collateralDecimals: 18,
    collateralPriceUsd: 4000,
    debtAmount: debt,
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  });

test("a move is shown as a step, not just its destination", () => {
  const before = risk(1000000000000000000n, 2000000000000000000000n);
  const after = risk(1000000000000000000n, 2400000000000000000000n);
  const lines = fxRiskDeltaLines({
    before,
    risk: after,
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  const step = lines.find((l) => l.includes("→"));
  assert.ok(step, "no before → after line");
  assert.match(step as string, /50\.0%.*→.*60\.0%/);
});

test("opening a new position has no 'was', so none is invented", () => {
  const lines = fxRiskDeltaLines({
    risk: risk(1000000000000000000n, 2000000000000000000000n),
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  assert.ok(!lines.some((l) => l.startsWith("was")));
});

test("a slider that has not moved yet shows no step", () => {
  // Otherwise every card opens claiming "49.2% → 49.2%", which reads as a
  // change and trains the eye to ignore the line that matters.
  const same = risk(1000000000000000000n, 2000000000000000000000n);
  const lines = fxRiskDeltaLines({
    before: same,
    risk: same,
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  assert.ok(!lines.some((l) => l.startsWith("was")));
});

// --- closing --------------------------------------------------------------

const close = (repay: bigint, over: Partial<FxPositionState> = {}) =>
  fxCloseLines({
    state: state(over),
    repayAmount: repay,
    collateralSymbol: "wstETH",
    format: fmt,
  }).map(strip);

test("repaying the whole debt says the position is closed and burnt", () => {
  const lines = close(1880030086474238325175n);
  assert.ok(lines.some((l) => /closes the position fully/.test(l)));
  assert.ok(lines.some((l) => /1\.6067 wstETH/.test(l)), "does not say what comes back");
});

test("a partial close says how much is still owed", () => {
  // The distinction the card never made: 940 fxUSD against a 1880 debt leaves
  // a live position, which is a categorically different outcome to closing.
  const lines = close(940015043237119162587n);
  assert.ok(lines.some((l) => /partial/.test(l)));
  assert.ok(lines.some((l) => /940\.0150 fxUSD owed/.test(l)));
  assert.ok(!lines.some((l) => /closes the position fully/.test(l)));
});

test("collateral comes back in proportion to the debt cleared", () => {
  const lines = close(940015043237119162587n);
  // Half the debt, half the collateral.
  assert.ok(lines.some((l) => /0\.8034 wstETH/.test(l)), lines.join(" | "));
});

test("repaying more than is owed says the excess is not used", () => {
  // A number larger than the debt reads as if it will all be spent.
  const lines = close(3000000000000000000000n);
  assert.ok(lines.some((l) => /is not used/.test(l)));
  assert.ok(lines.some((l) => /closes the position fully/.test(l)));
});

test("a swap out is named, so the collateral is not reported as arriving unchanged", () => {
  const lines = fxCloseLines({
    state: state(),
    repayAmount: 1880030086474238325175n,
    collateralSymbol: "wstETH",
    receiveSymbol: "USDC",
    format: fmt,
  }).map(strip);
  assert.ok(lines.some((l) => /wstETH → USDC/.test(l)));
});
