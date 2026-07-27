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
