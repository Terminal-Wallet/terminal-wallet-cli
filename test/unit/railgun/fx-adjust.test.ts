/**
 * The four ways to change a position that already exists, behind one card.
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

test("one card offers both axes and the position they act on", () => {
  // Four cards became one. The four RECIPES are unchanged — only the surface
  // collapsed, because nobody decides to perform a "top-up-and-borrow"; they
  // decide they want collateral in or debt down, and the verb follows.
  const cfg = txBuilderConfigs["fx-mint-manage"](NetworkName.Ethereum);
  assert.ok(cfg.fields.includes("position"), "no position row");
  assert.ok(cfg.fields.includes("collateralPct"), "no collateral axis");
  assert.ok(cfg.fields.includes("debtDelta"), "no debt axis");
  assert.ok(cfg.fields.includes("token"), "nothing to pay collateral with");
  assert.ok(cfg.loadPositions, "cannot list positions");
  assert.ok(cfg.previewLegs, "does not describe its batch");
  assert.equal(cfg.relayAdapt, true);
});

test("the four cards it replaced are gone, not merely hidden", () => {
  // Left in the config map they would still be reachable by flow id, and the
  // palette would be the only thing enforcing the new shape.
  for (const id of [
    "fx-mint-topup",
    "fx-mint-topup-borrow",
    "fx-mint-borrow-more",
    "fx-mint-repay",
  ]) {
    assert.equal(txBuilderConfigs[id], undefined, `${id} is still routable`);
  }
});

test("the debt axis is signed, so one control covers borrow and repay", () => {
  // A target-ratio control cannot express "add collateral and leave the debt
  // alone" — the commonest de-risking move — because the ratio falls on its
  // own once the collateral lands.
  const configs = readFileSync(
    join(resolve(process.cwd(), "src"), "tui/screens/tx-builder-configs.ts"),
    "utf-8",
  );
  assert.match(configs, /planFxManage\(/);
  assert.match(configs, /debtDeltaFrac/);
});

test("a repay is always in fxUSD, and does not pretend otherwise", () => {
  // Same asymmetry as close: the debt is denominated in fxUSD and no shipped
  // combo swaps into it. Still true at the recipe layer, which the card
  // collapse did not touch.
  assert.match(adjust, /action === "repay"[\s\S]{0,120}fxUSD/);
});

test("the position is unshielded in and shielded back — an adjust never burns it", () => {
  assert.match(adjust, /relayAdaptUnshieldNFTAmounts: \[positionNFT\]/);
  assert.match(adjust, /nfts: \[\{ \.\.\.positionNFT, recipient: railgunAddress \}\]/);
  // A close may legitimately shield nothing back; an adjust may not.
  assert.match(adjust, /produced no position NFT to shield back/);
});

test("the repay is bounded by what survives the unshield fee", () => {
  const debt = 1_880_030_086_474_238_325_175n;
  const sent = debt / 2n;
  const a = computeFxRepay({
    // Native debt-token units. The cookbook took the raw figure here until
    // -fx.3; the wallet always passed the native one, so this is a rename.
    debt,
    availableDebtToken: sent,
    desiredRepayAmount: sent,
    repayFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
  });
  assert.ok(a.debtTokenAfterUnshield < sent, "the fee reduces what lands");
  assert.ok(
    a.repayAmount <= a.debtTokenAfterUnshield,
    "cannot repay what never arrived",
  );
  assert.match(adjust, /railgunUnshieldFeeBps: fees\.unshield/);
});

test("the pool's fee ratios are read, never assumed", () => {
  // borrowFeeRatio and repayFeeRatio are governance parameters.
  assert.match(adjust, /getFxPool\(poolRef, provider\)/);
  assert.match(adjust, /borrowFeeRatio: poolState\.borrowFeeRatio/);
  assert.match(adjust, /repayFeeRatio: poolState\.repayFeeRatio/);
});
