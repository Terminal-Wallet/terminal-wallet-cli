/**
 * A recovery must not be sized by an estimate of the batch that failed.
 *
 * Relay-adapt builds its action data with `requireSuccess = false`. When the
 * shield reverts during estimation, the estimate measures a batch that did NOT
 * shield — and the carried limit, being that estimate x1.2, is then too small
 * for the batch that does. The wrongness is self-consistent, so retrying at the
 * same size fails identically. That is what happened twice on mainnet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RECOVERY_GAS_ESTIMATE_FLOOR } from "../../../src/railgun/wallet/ephemeral-recovery";

const SRC = resolve(process.cwd(), "src");
const recovery = readFileSync(join(SRC, "railgun/wallet/ephemeral-recovery.ts"), "utf-8");
const screen = readFileSync(join(SRC, "tui/screens/ephemeral-recover.ts"), "utf-8");

/** Observed on mainnet, from the call traces. */
const MINT_SHIELD_GIVEN = 780_728n;
const RECOVERY_SHIELD_GIVEN = 881_920n;
/** The limit the failed recovery actually carried. */
const FAILED_RECOVERY_LIMIT = 2_140_882n;
/** calculateGasLimit adds 20%. */
const carried = (estimate: bigint) => (estimate * 12000n) / 10000n;

test("the floor carries more than the attempt that failed", () => {
  assert.ok(
    carried(RECOVERY_GAS_ESTIMATE_FLOOR) > FAILED_RECOVERY_LIMIT,
    "a floor at or under the failed limit would fail the same way",
  );
});

test("the floor leaves room for a shield larger than either observed failure", () => {
  const headroom = carried(RECOVERY_GAS_ESTIMATE_FLOOR) - FAILED_RECOVERY_LIMIT;
  assert.ok(
    headroom > RECOVERY_SHIELD_GIVEN,
    `only ${headroom} more than a run whose shield already had ${RECOVERY_SHIELD_GIVEN}`,
  );
  assert.ok(RECOVERY_SHIELD_GIVEN > MINT_SHIELD_GIVEN, "the later failure had more, and still failed");
});

test("the floor is applied to the estimate, not to the populated transaction", () => {
  // The fee is quoted from the estimate. Flooring afterwards would have a
  // broadcaster price a batch smaller than the one submitted.
  assert.match(recovery, /flooredEstimate/);
  const at = recovery.indexOf("const privateGasEstimate");
  assert.ok(
    recovery.slice(at, at + 200).includes("flooredEstimate"),
    "the priced estimate must be the floored one",
  );
  assert.ok(
    !/transaction\.gasLimit\s*=/.test(recovery),
    "flooring the populated transaction desyncs the quote from what is sent",
  );
});

test("the fee preview quotes the same figure the batch will carry", () => {
  // Quoting 2.8M while carrying the floor would show a fee smaller than the
  // one actually paid.
  assert.match(screen, /RECOVERY_GAS_UNITS = RECOVERY_GAS_ESTIMATE_FLOOR/);
});

test("the on-chain floor stays at no-floor, which is a different lever", () => {
  // minGasLimit is baked in as a gasleft() require; raising it forces the tx to
  // carry gas AND can revert the estimate on the check itself. The carried
  // limit is the lever being used here.
  assert.match(recovery, /recoveryMinGasLimit = NO_CROSS_CONTRACT_GAS_FLOOR/);
});
