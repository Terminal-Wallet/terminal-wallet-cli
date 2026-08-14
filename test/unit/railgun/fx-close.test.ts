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

/**
 * A wstETH-Long position, read from mainnet, in NATIVE units.
 *
 * Cookbook `-fx.3` takes the position's native collateral and debt directly —
 * what `getFxPosition` reports — rather than the raw figures plus the pool
 * totals it needed to derive them from.
 */
const POSITION = {
  collateral: 1_604_358_184_743_053_894n,
  debt: 1_880_030_086_474_238_325_175n,
};
const POOL = {
  repayFeeRatio: 0n,
  withdrawFeeRatio: 0n,
};

const amounts = (availableDebtToken: bigint) =>
  computeFxClose({
    ...POSITION,
    ...POOL,
    availableDebtToken,
    railgunUnshieldFeeBps: 25n,
  });

test("enough of the debt token to cover the debt closes the position outright", () => {
  const full = amounts(POSITION.debt * 2n);
  assert.equal(full.partialClose, false, "the position should be burnt");
  assert.ok(full.withdrawColl > 0n, "collateral comes back");
});

test("less than the debt is a partial close, and the position survives", () => {
  const partial = amounts(POSITION.debt / 4n);
  assert.equal(partial.partialClose, true);
  assert.ok(partial.repayAmount > 0n);
  assert.ok(
    partial.repayAmount < POSITION.debt,
    "a partial close must not claim to repay the whole debt",
  );
});

test("the repay is sized against what survives the unshield fee", () => {
  // RAILGUN takes its cut on the way out, so a repay sized on the amount SENT
  // would try to spend money that never arrives.
  const sent = POSITION.debt / 2n;
  const a = amounts(sent);
  assert.ok(a.debtTokenAfterUnshield < sent, "the fee should reduce what lands");
  assert.ok(
    a.repayAmount <= a.debtTokenAfterUnshield,
    "cannot repay more of the debt token than actually arrived",
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
  assert.match(close, /Not enough of the debt token is shielded/);
});

/**
 * WBTC-Short shaped: an 8-decimal debt token whose raw figure is 18dp
 * normalised, so the raw and native figures differ by 10^10 for the same debt.
 * The long pools have them equal, which is why passing the wrong one was
 * invisible until a second side existed.
 */
const SHORT = {
  collateral: 1_000_000_000_000_000_000_000n, // fxUSD collateral, native
  debt: 2_000_000n, // 0.02 WBTC owed, native
  rawDebt: 2_000_000n * 10n ** 10n, // the same debt, raw
};

test("raw debt where native is wanted still releases almost no collateral", () => {
  // `-fx.3` renamed the field from `rawDebts` to `debt` and added a guard, but
  // the guard is `typeof debt !== 'bigint'` — it catches the RENAME, not the
  // mistake its message describes. A raw figure is still a bigint, so it still
  // sails through and reads as a debt 10^10 larger than the wallet can cover:
  // the close repays what it has and withdraws a proportional sliver.
  const available = SHORT.debt * 2n; // native WBTC, twice the debt
  const common = {
    collateral: SHORT.collateral,
    repayFeeRatio: 0n,
    withdrawFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
    availableDebtToken: available,
  };
  const right = computeFxClose({ ...common, debt: SHORT.debt });
  const wrong = computeFxClose({ ...common, debt: SHORT.rawDebt });

  assert.equal(right.partialClose, false, "native units clear the debt outright");
  assert.equal(wrong.partialClose, true, "raw units read as an uncoverable debt");
  assert.ok(
    wrong.withdrawColl * 1_000_000n < right.withdrawColl,
    "the raw figure strands the collateral it was supposed to release",
  );
});

test("the pre--fx.3 field name is refused rather than ignored", () => {
  // The half the guard does cover: the old key arrives as `undefined`, which
  // would otherwise compute against a missing debt.
  assert.throws(
    () =>
      computeFxClose({
        collateral: SHORT.collateral,
        repayFeeRatio: 0n,
        withdrawFeeRatio: 0n,
        railgunUnshieldFeeBps: 25n,
        availableDebtToken: SHORT.debt,
        rawDebts: SHORT.debt,
      } as unknown as Parameters<typeof computeFxClose>[0]),
    /NATIVE debtToken/,
  );
});

test("the close passes native debt, and the pool's own debt token", () => {
  // Guards the two ways this path was long-only: it read `position.rawDebts`
  // (see the control above) and unshielded fxUSD by name, when a short's debt
  // is the volatile asset and on one pool it is 8-decimal.
  assert.match(close, /debt: position\.debt/);
  assert.doesNotMatch(close, /position\.rawDebts/);
  assert.match(close, /tokenAddress: pool\.debtToken/);
  assert.match(close, /decimals: pool\.debtDecimals/);
  assert.doesNotMatch(close, /FX_ADDRESSES\.fxUSD/);
});

test("the close passes the position's native collateral, not its raw", () => {
  assert.match(close, /collateral: position\.collateralAmount/);
  assert.doesNotMatch(close, /position\.rawColls/);
});

test("the withdraw fee is read, not defaulted to zero", () => {
  // Required since -fx.3. It was optional before, defaulting to 0n — right for
  // a long, and over-declaring a short's reshielded collateral by the fee.
  assert.match(close, /withdrawFeeRatio: poolState\.withdrawFeeRatio/);
});

test("the adjust path repays in the same units and the same token", () => {
  const adjust = readFileSync(
    join(SRC, "railgun/transaction/fx/adjust.ts"),
    "utf-8",
  );
  assert.match(adjust, /debt: position\.debt/);
  assert.doesNotMatch(adjust, /position\.rawDebts/);
  assert.match(adjust, /availableDebtToken: shieldedDebtToken/);
  assert.match(adjust, /tokenAddress: pool\.debtToken/);
  assert.doesNotMatch(adjust, /FX_ADDRESSES\.fxUSD/);
});
