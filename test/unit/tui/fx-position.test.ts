/**
 * The risk block, as a person reads it.
 *
 * The thresholds are marked on a fixed 0..1 scale so they stay put while the
 * slider moves — a meter that rescales as you drag makes the danger line look
 * like it is running away from you.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fxPositionRisk } from "../../../src/railgun/transaction/fx/risk";
import { fxRiskLines, zoneColour } from "../../../src/tui/format/fx-position";

const REBALANCE = 880_000_000_000_000_000n;
const LIQUIDATION = 950_000_000_000_000_000n;

const view = (debtUsd: number, width = 24) => ({
  risk: fxPositionRisk({
    collateralAmount: 10n ** 18n,
    collateralDecimals: 18,
    collateralPriceUsd: 1000,
    debtAmount: BigInt(Math.round(debtUsd)) * 10n ** 18n,
    rebalanceDebtRatio: REBALANCE,
    liquidationDebtRatio: LIQUIDATION,
  }),
  collateralSymbol: "wstETH",
  rebalanceDebtRatio: REBALANCE,
  liquidationDebtRatio: LIQUIDATION,
  width,
});

const plain = (s: string) => s.replace(/\{[^}]*\}/g, "");

test("a healthy position shows its ratio, leverage and both trigger prices", () => {
  const lines = fxRiskLines(view(400)).map(plain);
  assert.match(lines[0], /40\.0%/);
  assert.match(lines[0], /1\.7x/);
  assert.match(lines[1], /wstETH/);
  assert.equal(lines.length, 2, "a safe position needs no warning line");
});

test("both thresholds are marked, and in the right cells", () => {
  const meter = plain(fxRiskLines(view(400, 20))[0]);
  // 0.88 of 20 cells is index 17, 0.95 is index 19.
  const bar = meter.match(/[█░│✕]+/)?.[0] ?? "";
  assert.equal([...bar].length, 20, "the meter must be exactly its width");
  assert.equal(bar[17], "│", "rebalance mark");
  assert.equal(bar[19], "✕", "liquidation mark");
});

test("crossing a threshold changes the colour and says what would happen", () => {
  assert.equal(zoneColour("safe"), "green");
  assert.equal(zoneColour("rebalance"), "yellow");
  assert.equal(zoneColour("liquidation"), "red");

  const rebalancing = fxRiskLines(view(900));
  assert.equal(rebalancing.length, 3, "a warning line should appear");
  assert.match(plain(rebalancing[2]), /rebalance/);
  assert.match(rebalancing[0], /yellow-fg/);

  const liquidating = fxRiskLines(view(980));
  assert.match(plain(liquidating[2]), /liquidated/);
  assert.match(liquidating[0], /red-fg/);
});

test("a position with no debt shows no trigger prices to fear", () => {
  const lines = fxRiskLines(view(0)).map(plain);
  assert.match(lines[0], /0\.0%/);
  assert.match(lines[1], /—/, "no debt never liquidates, so there is no price");
});
