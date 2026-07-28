/**
 * The gas floor, pinned to the transaction that taught us what it should be.
 *
 * The first real mainnet fx mint (0x252155ef…) carried 3,016,590 and consumed
 * 2,917,543 reaching the point where it mints the position. That left 99,047,
 * of which the shield sub-call could receive at most 63/64 — 97,499. A RAILGUN
 * shield writes merkle commitments and needs far more, so it reverted.
 *
 * Because relay-adapt builds its action data with `requireSuccess = false`, that
 * did not fail the batch. The transaction mined, the position and the fxUSD were
 * minted, and both were left at the ephemeral account. Nothing said so.
 *
 * These numbers are the reason the floor is what it is. Lowering it back under
 * what was observed should require re-deriving them, not just editing a
 * constant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FXMINT_GAS_FLOOR } from "../../../src/railgun/transaction/fx/mint";

/** Observed on mainnet, tx 0x252155ef… */
const CARRIED = 3_016_590n;
const CONSUMED = 2_917_543n;
/** What a wrap-and-shield is sized at elsewhere in the wallet. */
const SHIELD_COST = 450_000n;

test("the batch consumed nearly everything it carried", () => {
  const leftover = CARRIED - CONSUMED;
  assert.equal(leftover, 99_047n);
  // 63/64 is all a sub-call can be given.
  assert.ok((leftover * 63n) / 64n < SHIELD_COST, "the shield could not have fitted");
});

test("the floor covers reaching the shield AND running it", () => {
  assert.ok(
    FXMINT_GAS_FLOOR > CONSUMED + SHIELD_COST,
    `${FXMINT_GAS_FLOOR} does not cover ${CONSUMED} observed + ${SHIELD_COST} to shield`,
  );
});

test("the floor is above what the failing transaction carried", () => {
  // The obvious regression: setting it back to something the real batch has
  // already been shown to exhaust.
  assert.ok(
    FXMINT_GAS_FLOOR > CARRIED,
    "the floor must exceed a limit already proven insufficient",
  );
});

test("the floor is not so high it starves the estimate", () => {
  // The floor is baked into the action data as a gasleft() require, so an
  // excessive one makes the transaction carry gas it cannot use and can revert
  // the estimate on the floor check itself.
  assert.ok(FXMINT_GAS_FLOOR <= 8_000_000n, "an unusable floor is its own failure");
});

test("fxUSD and the pool collateral are in the token list the scanner walks", async () => {
  // Recovery finds a stranded token two ways: the curated list, or a Transfer
  // log within ~10,000 blocks. Relying on the log window means value stranded
  // at an ephemeral account goes invisible about a day and a half later —
  // which is exactly what the first real mint would have done with its fxUSD.
  const { default: config } = await import("../../../src/config/config-defaults");
  const { NetworkName } = await import("@railgun-community/shared-models");
  const listed = config.tokenConfig[NetworkName.Ethereum].map((a) => a.toLowerCase());
  assert.ok(
    listed.includes("0x085780639cc2cacd35e474e71f4d000e2405d8f6"),
    "fxUSD is not listed, so stranded fxUSD becomes unfindable",
  );
  assert.ok(
    listed.includes("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"),
    "wstETH is not listed, so stranded collateral becomes unfindable",
  );
});
