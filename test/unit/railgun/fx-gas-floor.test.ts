/**
 * The gas floor, pinned to the transaction that taught us what it should be.
 *
 * The first real mainnet fx mint (0x252155ef…) carried 3,016,590 and consumed
 * 2,917,543 without completing. Traced per leg: unshield 1,121,136, approve +
 * 0x swap 209,278, fx operate 548,398, shield 885,471 — and the shield's inner
 * call into the RailgunSmartWallet was given 780,728, consumed 768,540, and
 * reverted with no revert data. Near-total consumption with no data is out of
 * gas rather than a `require`.
 *
 * Because relay-adapt builds its action data with `requireSuccess = false`,
 * that did not fail the batch: the transaction mined, the position and the
 * fxUSD were minted, and both were left at the ephemeral account.
 *
 * The swap is only 7.5% of the batch, so a bare open would have used ~2.58M and
 * hit the same wall — which is why the floor is not split per flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { FXMINT_GAS_FLOOR } from "../../../src/railgun/transaction/fx/mint";
import config from "../../../src/config/config-defaults";

/** Observed on mainnet, tx 0x252155ef…, from the call trace. */
const CARRIED = 3_016_590n;
const CONSUMED = 2_917_543n;
const SWAP_LEG = 209_278n;
/** What the shield's inner RailgunSmartWallet call got before reverting. */
const SHIELD_INNER_GIVEN = 780_728n;

test("the swap is a small part of the batch, so the floor is not combo-only", () => {
  // The intuition is that only the swapping path needs the bigger floor. The
  // trace says otherwise: the swap is 7.5%, and the expensive legs are the
  // unshield and the protocol call, which a bare open pays in full.
  const bare = CONSUMED - SWAP_LEG;
  assert.ok(SWAP_LEG * 10n < CONSUMED, "the swap should be under 10% of the batch");
  assert.ok(
    bare > 2_500_000n,
    "a bare open still spends most of the batch and hits the same shield",
  );
});

test("the floor gives the shield materially more than it had when it failed", () => {
  // It failed with 780,728 available to its inner call. The floor has to buy
  // enough headroom that the same call gets substantially more.
  const extraOverTheFailedRun = FXMINT_GAS_FLOOR - CARRIED;
  assert.ok(
    extraOverTheFailedRun > SHIELD_INNER_GIVEN,
    `only ${extraOverTheFailedRun} more than the run that failed with ${SHIELD_INNER_GIVEN} available`,
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

test("fxUSD and the pool collateral are in the token list the scanner walks", () => {
  // Recovery finds a stranded token two ways: the curated list, or a Transfer
  // log within ~10,000 blocks. Relying on the log window means value stranded
  // at an ephemeral account goes invisible about a day and a half later —
  // which is exactly what the first real mint would have done with its fxUSD.
  const listed = config.tokenConfig[NetworkName.Ethereum].map((a: string) =>
    a.toLowerCase(),
  );
  assert.ok(
    listed.includes("0x085780639cc2cacd35e474e71f4d000e2405d8f6"),
    "fxUSD is not listed, so stranded fxUSD becomes unfindable",
  );
  assert.ok(
    listed.includes("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"),
    "wstETH is not listed, so stranded collateral becomes unfindable",
  );
});
