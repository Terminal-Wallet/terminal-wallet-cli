/**
 * When a protocol action fuses a 0x swap into the same batch.
 *
 * Without the combo, entering a position takes two transactions: swap to the
 * token the protocol wants, then act. That is two proofs, two fees, and the
 * intermediate token sitting shielded in between. The combo does it in one
 * batch — but only when there is actually something to trade.
 *
 * The combo itself cannot be exercised offline: its swap leg quotes against the
 * live 0x API at build time. This decision is the part that can be, and it is
 * also the part that goes wrong — asking 0x to trade a token for itself is a
 * failed batch, and the fx combo rejects it outright in its constructor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsSwapLeg } from "../../../src/railgun/transaction/morpho/vault";
import { TOKENS } from "../../_support";

const VAULT_ASSET = TOKENS.USDC.address;

test("no counterpart means no swap — the plain recipe handles it", () => {
  assert.equal(needsSwapLeg(undefined, VAULT_ASSET), false);
});

test("naming the token the action already deals in is not a trade", () => {
  assert.equal(needsSwapLeg(VAULT_ASSET, VAULT_ASSET), false);
});

test("case is not a difference — the engine lowercases, the cookbook checksums", () => {
  assert.equal(needsSwapLeg(VAULT_ASSET.toLowerCase(), VAULT_ASSET), false);
  assert.equal(needsSwapLeg(VAULT_ASSET, VAULT_ASSET.toLowerCase()), false);
  assert.equal(needsSwapLeg(VAULT_ASSET.toUpperCase(), VAULT_ASSET), false);
});

test("a different token is a trade, and gets the combo", () => {
  assert.equal(needsSwapLeg(TOKENS.WETH.address, VAULT_ASSET), true);
});

test("the fx pools' collateral is what an open position compares against", async () => {
  const { KNOWN_POOLS } = await import("@railgun-community/cookbook");
  const wstETH = KNOWN_POOLS.find((p) => p.name === "wstETH-Long");
  assert.ok(wstETH);
  // Paying with the collateral itself must take the plain recipe: the combo's
  // own constructor throws on it (assertSwapTokenIsNotCollateral).
  assert.equal(needsSwapLeg(wstETH.collateralToken, wstETH.collateralToken), false);
  assert.equal(needsSwapLeg(TOKENS.WETH.address, wstETH.collateralToken), true);
});
