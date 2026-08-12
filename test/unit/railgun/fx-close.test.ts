/**
 * Closing a position — the way out that did not exist.
 *
 * Opening was shippable on its own because a minted position NFT only has to be
 * shielded. Closing is the harder direction: the NFT must be unshielded INTO
 * the batch, because `operate` requires the executor to own it and the executor
 * is a fresh account that holds nothing until the unshield puts it there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeFxClose } from "@railgun-community/cookbook";

const SRC = resolve(process.cwd(), "src");
const close = readFileSync(join(SRC, "railgun/transaction/fx/close.ts"), "utf-8");

/** wstETH-Long #1980, read from mainnet. */
const POSITION = {
  rawColls: 1_993_186_870_026_208_618n,
  rawDebts: 1_880_030_086_474_238_325_175n,
};
const POOL = {
  collateralBalance: 4_676_686_893_881_191_905_374n,
  totalRawColls: 4_676_686_893_881_191_905_374n,
  repayFeeRatio: 0n,
};

const amounts = (shieldedFxUSD: bigint) =>
  computeFxClose({
    ...POSITION,
    ...POOL,
    shieldedFxUSD,
    railgunUnshieldFeeBps: 25n,
  });

test("enough fxUSD to cover the debt closes the position outright", () => {
  const full = amounts(POSITION.rawDebts * 2n);
  assert.equal(full.partialClose, false, "the position should be burnt");
  assert.ok(full.withdrawColl > 0n, "collateral comes back");
});

test("less than the debt is a partial close, and the position survives", () => {
  const partial = amounts(POSITION.rawDebts / 4n);
  assert.equal(partial.partialClose, true);
  assert.ok(partial.repayAmount > 0n);
  assert.ok(
    partial.repayAmount < POSITION.rawDebts,
    "a partial close must not claim to repay the whole debt",
  );
});

test("the repay is sized against what survives the unshield fee", () => {
  // RAILGUN takes its cut on the way out, so a repay sized on the amount SENT
  // would try to spend money that never arrives.
  const sent = POSITION.rawDebts / 2n;
  const a = amounts(sent);
  assert.ok(a.fxUSDAfterUnshield < sent, "the fee should reduce what lands");
  assert.ok(
    a.repayAmount <= a.fxUSDAfterUnshield,
    "cannot repay more fxUSD than actually arrived",
  );
});

test("the position NFT is unshielded into the batch, not just shielded back", () => {
  // The failure this guards is silent: without the input NFT the batch builds,
  // estimates, mines, and `operate` reverts because the executor owns nothing.
  assert.match(close, /relayAdaptUnshieldNFTAmounts: \[positionNFT\]/);
  assert.match(close, /nfts: \[\{ \.\.\.positionNFT, recipient: railgunAddress \}\]/);
});

test("a full close shields no NFT back, and that is not a gap", () => {
  assert.match(close, /toShieldNFTRecipients\(/);
  assert.match(close, /burns it/);
});

test("the RAILGUN fee is read, never assumed", () => {
  assert.match(close, /getRailgunFeeBasisPoints\(chainName\)/);
  assert.match(close, /railgunUnshieldFeeBps: fees\.unshield/);
  // No fee known means no safe repay figure — better to refuse than to guess.
  assert.match(close, /are not known for/);
});

test("a repay of nothing is refused rather than sent", () => {
  assert.match(close, /repayAmount <= 0n/);
  assert.match(close, /Not enough shielded fxUSD/);
});

/**
 * WBTC-Short shaped: an 8-decimal debt token whose raw figure is 18dp
 * normalised, so `rawDebts` and `debt` differ by 10^10 for the same debt.
 * The long pools have them equal, which is why passing the wrong one was
 * invisible until a second side existed.
 */
const SHORT = {
  rawColls: 1_000_000_000_000_000_000_000n, // fxUSD collateral
  debt: 2_000_000n, // 0.02 WBTC owed, native
  rawDebts: 2_000_000n * 10n ** 10n, // the same debt, raw
};

test("raw debt where native is wanted releases almost no collateral", () => {
  // The control for the call site below. `computeFxClose` names its input
  // `rawDebts` but measures it against native amounts — the shielded balance
  // it clamps to, and the `repayAmount` the step spends. Feed it the raw
  // figure and it reads the debt as 10^10 times larger than the wallet can
  // cover, so it repays what it has and withdraws a proportional sliver.
  const shielded = SHORT.debt * 2n; // native WBTC, twice the debt
  const common = {
    rawColls: SHORT.rawColls,
    collateralBalance: SHORT.rawColls,
    totalRawColls: SHORT.rawColls,
    repayFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
    shieldedFxUSD: shielded,
  };
  const right = computeFxClose({ ...common, rawDebts: SHORT.debt });
  const wrong = computeFxClose({ ...common, rawDebts: SHORT.rawDebts });

  assert.equal(right.partialClose, false, "native units clear the debt outright");
  assert.equal(wrong.partialClose, true, "raw units read as an uncoverable debt");
  assert.ok(
    wrong.withdrawColl * 1_000_000n < right.withdrawColl,
    "the raw figure strands the collateral it was supposed to release",
  );
});

test("the close passes native debt, and the pool's own debt token", () => {
  // Guards the two ways this path was long-only: it read `position.rawDebts`
  // (see the control above) and unshielded fxUSD by name, when a short's debt
  // is the volatile asset and on one pool it is 8-decimal.
  assert.match(close, /rawDebts: position\.debt/);
  assert.doesNotMatch(close, /rawDebts: position\.rawDebts/);
  assert.match(close, /tokenAddress: pool\.debtToken/);
  assert.match(close, /decimals: pool\.debtDecimals/);
  assert.doesNotMatch(close, /FX_ADDRESSES\.fxUSD/);
});

test("the withdraw fee is read, not defaulted to zero", () => {
  // Optional upstream, defaulting to 0n — right for a long, and over-declares
  // a short's reshielded collateral by the fee, failing the amount accounting.
  assert.match(close, /withdrawFeeRatio: poolState\.withdrawFeeRatio/);
});

test("the adjust path repays in the same units and the same token", () => {
  const adjust = readFileSync(
    join(SRC, "railgun/transaction/fx/adjust.ts"),
    "utf-8",
  );
  assert.match(adjust, /rawDebts: position\.debt/);
  assert.doesNotMatch(adjust, /rawDebts: position\.rawDebts/);
  assert.match(adjust, /tokenAddress: pool\.debtToken/);
  assert.doesNotMatch(adjust, /FX_ADDRESSES\.fxUSD/);
});
