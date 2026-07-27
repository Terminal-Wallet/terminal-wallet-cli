/**
 * The four ways to change a position that already exists.
 *
 * They share a shape — unshield the NFT, `operate` a delta, shield the NFT back
 * — and differ only in which delta is non-zero and what has to be unshielded to
 * pay for it. The position ALWAYS survives, so unlike a close it must always
 * come back; an adjust that shields no NFT would leave it at an ephemeral
 * account the wallet ratchets past.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NetworkName } from "@railgun-community/shared-models";
import { computeFxRepay } from "@railgun-community/cookbook";
import { txBuilderConfigs } from "../../../src/tui/screens/tx-builder-configs";

const adjust = readFileSync(
  join(resolve(process.cwd(), "src"), "railgun/transaction/fx/adjust.ts"),
  "utf-8",
);

const fieldsOf = (id: string) => txBuilderConfigs[id](NetworkName.Ethereum).fields;

test("borrowing against posted collateral spends nothing up front", () => {
  // No token and no amount row: the collateral is already in the position.
  const fields = fieldsOf("fx-mint-borrow-more");
  assert.ok(fields.includes("debt"));
  assert.ok(!fields.includes("token"), "there is nothing to pay with");
  assert.ok(!fields.includes("amount"));
});

test("a topup spends collateral, and can be paid for with any token", () => {
  const fields = fieldsOf("fx-mint-topup");
  assert.ok(fields.includes("token"), "swap → topup");
  assert.ok(fields.includes("amount"));
  assert.ok(!fields.includes("debt"), "a plain topup borrows nothing");
});

test("topup-and-borrow takes both an amount and a debt", () => {
  const fields = fieldsOf("fx-mint-topup-borrow");
  assert.ok(fields.includes("amount"));
  assert.ok(fields.includes("debt"));
  assert.ok(fields.includes("token"));
});

test("a repay is always in fxUSD, and does not pretend otherwise", () => {
  // Same asymmetry as close: the debt is denominated in fxUSD and no shipped
  // combo swaps into it.
  const fields = fieldsOf("fx-mint-repay");
  assert.ok(fields.includes("amount"));
  assert.ok(!fields.includes("token"), "a pay-with row would imply a swap no recipe performs");
  assert.match(adjust, /action === "repay"[\s\S]{0,120}fxUSD/);
});

test("every adjust card acts on a position it must first choose", () => {
  for (const id of [
    "fx-mint-topup",
    "fx-mint-topup-borrow",
    "fx-mint-borrow-more",
    "fx-mint-repay",
  ]) {
    const cfg = txBuilderConfigs[id](NetworkName.Ethereum);
    assert.ok(cfg.fields.includes("position"), `${id} has no position row`);
    assert.ok(cfg.loadPositions, `${id} cannot list positions`);
    assert.ok(cfg.previewLegs, `${id} does not describe its batch`);
    assert.equal(cfg.relayAdapt, true, `${id} is not relay-adapt`);
  }
});

test("the position is unshielded in and shielded back — an adjust never burns it", () => {
  assert.match(adjust, /relayAdaptUnshieldNFTAmounts: \[positionNFT\]/);
  assert.match(adjust, /nfts: \[\{ \.\.\.positionNFT, recipient: railgunAddress \}\]/);
  // A close may legitimately shield nothing back; an adjust may not.
  assert.match(adjust, /produced no position NFT to shield back/);
});

test("the repay is bounded by what survives the unshield fee", () => {
  const rawDebts = 1_880_030_086_474_238_325_175n;
  const sent = rawDebts / 2n;
  const a = computeFxRepay({
    rawDebts,
    shieldedFxUSD: sent,
    desiredRepayAmount: sent,
    repayFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
  });
  assert.ok(a.fxUSDAfterUnshield < sent, "the fee reduces what lands");
  assert.ok(a.repayAmount <= a.fxUSDAfterUnshield, "cannot repay what never arrived");
  assert.match(adjust, /railgunUnshieldFeeBps: fees\.unshield/);
});

test("the pool's fee ratios are read, never assumed", () => {
  // borrowFeeRatio and repayFeeRatio are governance parameters.
  assert.match(adjust, /getFxPool\(poolRef, provider\)/);
  assert.match(adjust, /borrowFeeRatio: poolState\.borrowFeeRatio/);
  assert.match(adjust, /repayFeeRatio: poolState\.repayFeeRatio/);
});
