/**
 * The arithmetic behind the position sliders.
 *
 * The fixture is a real mainnet wstETH-Long position, read from the chain,
 * because the pool computes its own debt ratio and that gives this
 * something to be wrong against. A formula that merely looks reasonable would
 * pass a test written from the same misunderstanding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  fxDebtForRatio,
  fxMaxOpenRatio,
  fxPositionRisk,
} from "../../../src/railgun/transaction/fx/risk";

/** wstETH-Long, read from mainnet: 0.88 rebalance, 0.95 liquidation. */
const REBALANCE = 880_000_000_000_000_000n;
const LIQUIDATION = 950_000_000_000_000_000n;

/**
 * The position as the chain reports it.
 *
 * `getPositionDebtRatio` is kept as the WAD bigint the pool actually returned —
 * written as a float it has more significant digits than a double holds, so the
 * literal would silently become a different number than the chain's.
 */
const POSITION = {
  collateralAmount: 1_993_186_870_026_208_618n,
  collateralDecimals: 18,
  debtAmount: 1_880_030_086_474_238_325_175n,
  onChainDebtRatioWad: 485_253_811_342_188_183n,
};
const ON_CHAIN_DEBT_RATIO =
  Number(POSITION.onChainDebtRatioWad) / Number(10n ** 18n);
const IMPLIED_PRICE =
  Number(POSITION.debtAmount) /
  1e18 /
  ((Number(POSITION.collateralAmount) / 1e18) * ON_CHAIN_DEBT_RATIO);

const risk = (over: Partial<Parameters<typeof fxPositionRisk>[0]> = {}) =>
  fxPositionRisk({
    collateralAmount: POSITION.collateralAmount,
    collateralDecimals: POSITION.collateralDecimals,
    collateralPriceUsd: IMPLIED_PRICE,
    debtAmount: POSITION.debtAmount,
    rebalanceDebtRatio: REBALANCE,
    liquidationDebtRatio: LIQUIDATION,
    ...over,
  });

test("the debt ratio matches what the pool computes for a real position", () => {
  // If this drifts, the formula is wrong — not the tolerance.
  assert.ok(
    Math.abs(risk().debtRatio - ON_CHAIN_DEBT_RATIO) < 1e-9,
    `got ${risk().debtRatio}, pool says ${ON_CHAIN_DEBT_RATIO}`,
  );
});

test("40% debt is 1.7x leverage, as the design reference shows", () => {
  const flat = fxPositionRisk({
    collateralAmount: 10n ** 18n,
    collateralDecimals: 18,
    collateralPriceUsd: 1000,
    debtAmount: 400n * 10n ** 18n,
    rebalanceDebtRatio: REBALANCE,
    liquidationDebtRatio: LIQUIDATION,
  });
  assert.ok(Math.abs(flat.debtRatio - 0.4) < 1e-12);
  assert.equal(Number(flat.leverage.toFixed(1)), 1.7);
});

test("rebalance and liquidation prices are below the current price, and ordered", () => {
  const r = risk();
  assert.ok(r.liquidationPrice < r.rebalancePrice, "liquidation must be the further fall");
  assert.ok(r.rebalancePrice < IMPLIED_PRICE, "a safe position rebalances below spot");
  // At exactly the rebalance price the ratio is the rebalance threshold.
  const atRebalance = risk({ collateralPriceUsd: r.rebalancePrice });
  assert.ok(Math.abs(atRebalance.debtRatio - 0.88) < 1e-9);
  assert.equal(atRebalance.zone, "rebalance");
});

test("the zone follows the thresholds, not a guess", () => {
  // The ratio scales inversely with price, so the price that lands on a
  // threshold is spot x (currentRatio / threshold). Derived rather than picked,
  // because a guessed multiplier can sit in the wrong band and still pass.
  const priceAtRatio = (target: number) =>
    IMPLIED_PRICE * (ON_CHAIN_DEBT_RATIO / target);

  assert.equal(risk().zone, "safe");
  assert.equal(risk({ collateralPriceUsd: priceAtRatio(0.87) }).zone, "safe");
  assert.equal(risk({ collateralPriceUsd: priceAtRatio(0.9) }).zone, "rebalance");
  assert.equal(risk({ collateralPriceUsd: priceAtRatio(0.96) }).zone, "liquidation");
});

test("no debt is no risk, whatever the price does", () => {
  const r = risk({ debtAmount: 0n });
  assert.equal(r.debtRatio, 0);
  assert.equal(r.leverage, 1);
  assert.equal(r.zone, "safe");
  assert.equal(r.liquidationPrice, 0, "a position with no debt never liquidates");
});

test("an empty collateral field does not read as a safe position", () => {
  // Mid-edit state: reporting 0 here would show "safe" next to a debt figure.
  const r = risk({ collateralAmount: 0n });
  assert.equal(r.zone, "liquidation");
  assert.equal(r.debtRatio, Infinity);
});

test("debt at or above the collateral value has no finite leverage", () => {
  const r = risk({ collateralPriceUsd: ON_CHAIN_DEBT_RATIO * IMPLIED_PRICE });
  assert.equal(r.leverage, Infinity);
});

test("fxDebtForRatio is the inverse of the debt ratio", () => {
  const target = 0.4;
  const debt = fxDebtForRatio(
    POSITION.collateralAmount,
    POSITION.collateralDecimals,
    IMPLIED_PRICE,
    target,
  );
  const r = risk({ debtAmount: debt });
  assert.ok(
    Math.abs(r.debtRatio - target) < 1e-9,
    `asked for ${target}, got ${r.debtRatio}`,
  );
});

test("fxDebtForRatio refuses the degenerate inputs rather than returning NaN", () => {
  assert.equal(fxDebtForRatio(0n, 18, 1000, 0.4), 0n);
  assert.equal(fxDebtForRatio(10n ** 18n, 18, 0, 0.4), 0n);
  assert.equal(fxDebtForRatio(10n ** 18n, 18, 1000, 0), 0n);
  assert.equal(fxDebtForRatio(10n ** 18n, 18, 1000, -1), 0n);
});

test("the slider stops short of the rebalance threshold", () => {
  const max = fxMaxOpenRatio(REBALANCE);
  assert.ok(max < 0.88, "opening AT the rebalance ratio opens into a rebalance");
  assert.ok(max > 0.7, "and it should still allow a useful amount of leverage");
  // Anything the slider can reach must be in the safe zone.
  const debt = fxDebtForRatio(POSITION.collateralAmount, 18, IMPLIED_PRICE, max);
  assert.equal(risk({ debtAmount: debt }).zone, "safe");
});

test("WAD is the scale the pool's ratios actually arrive in", () => {
  assert.equal(WAD, 10n ** 18n);
  assert.equal(Number(REBALANCE) / Number(WAD), 0.88);
  assert.equal(Number(LIQUIDATION) / Number(WAD), 0.95);
});
