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
const configs = readFileSync(join(SRC, "tui/screens/tx-builder-configs.ts"), "utf-8");
const deps = readFileSync(join(SRC, "flows/deps/recovery.ts"), "utf-8");

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
  // Quoting less than the floor would show a fee smaller than the one paid.
  const at = configs.indexOf('"ephemeral-recovery": (chainName)');
  assert.ok(at > 0, "the recovery flow has no builder config");
  assert.match(
    configs.slice(at, at + 700),
    /gasUnitsHint: RECOVERY_GAS_ESTIMATE_FLOOR/,
  );
});

test("recovery does not send through the ratcheting path", () => {
  // sendPrivateTransaction ratchets the ephemeral index on any type-4 send. A
  // recovery is built against a PAST index, so ratcheting would step over a
  // live account. `deps.send` is the seam that keeps this true, so it is
  // asserted where the seam lives rather than at the call site.
  assert.match(deps, /send: async \(spec, proved\) => \{[\s\S]{0,200}submitRecoveryTransaction\(/);
  // A CALL, not a mention: the header names sendPrivateTransaction to explain
  // why it is not used, and a guard that cannot tell the two apart punishes
  // the comment that documents the invariant.
  assert.ok(
    !/sendPrivateTransaction\(/.test(deps),
    "recovery must not send through the path that ratchets",
  );
  assert.ok(
    !/runCrossContractTransaction\(/.test(deps),
    "runCrossContractTransaction sends via the ratcheting private path",
  );
});

test("recovery runs through the pipeline that emits a terminating tx:result", () => {
  // The bug this pins: recovery built and submitted its own batch, outside
  // runTransaction. runTransaction is the ONLY emitter of "tx:result", and that
  // event is what resets scanProgress, writes the outcome to the log pane, and
  // recovers the chain's revert reason. Without it the proof's progress events
  // left the footer bar stuck at 100% — and footerStatus gives the bar
  // precedence over the status line, so the failure message underneath it was
  // never rendered. The flow looked hung and left no trace anywhere.
  assert.match(deps, /runTransaction\(spec, createRecoveryDeps\(\)\)/);

  const at = configs.indexOf("const submitRecovery");
  assert.ok(at > 0, "submitRecovery not found");
  const body = configs.slice(at, at + 1400);
  assert.match(body, /runRecoveryTransaction\(/);
  assert.ok(
    !/getProvedEphemeralRecoveryTransaction\(/.test(body),
    "building the batch at the call site is what bypassed the runner",
  );
});

test("the progress callback is actually wired from the entry point", () => {
  // The previous version of this guard only checked that the proof call
  // MENTIONS onProgress. Both signatures had the parameter and nothing passed
  // it between them, so every recovery reported no progress at all and the
  // guard was green throughout.
  const at = recovery.indexOf("return buildProved7702Batch(");
  assert.ok(at > 0, "the build call is gone");
  const call = recovery.slice(at, at + 500);
  assert.match(call, /onProgress,/, "onProgress must be passed down, not just declared");
  assert.match(call, /gasChoice,/, "the chosen gas tier must be passed down too");
});

test("a recovery uses the gas tier it was given, not the cheapest one", () => {
  // The gas row was decorative. trySend calls closeBuilder() — which runs
  // clearGasFeeSelection() — BEFORE awaiting the submit, so the build always
  // found no selection and took its "conservative" branch: the SLOW tier,
  // floored at MIN_PRIORITY_FEE (0.025 gwei). A broadcaster asked to carry ~4M
  // gas for a tip at the bottom of the distribution rejects it as an
  // unmineable tip, and raising the tier changed nothing.
  assert.match(recovery, /gasChoice\.maxPriorityFeePerGas/);
  // The fallback now bids the top of the market with the shared headroom,
  // rather than a hand-rolled cheaper one. A refusal is free; a batch that
  // sits unmined is not.
  assert.match(recovery, /maxFeeFor\(fast, baseFeePerGas\)/);
  assert.ok(
    !/parseUnits\("0\.02", "gwei"\)/.test(recovery),
    "the hand-rolled 0.02 gwei floor is what made this unmineable",
  );
  assert.ok(
    !/baseFeePerGas \* 5n\) \/ 4n/.test(recovery),
    "1.25x base headroom was below the shared maxFeeFor",
  );
  // And the choice has to reach the spec at all.
  assert.match(deps, /gas\?: RecoveryGasChoice/);
  assert.match(deps, /spec\.gas/);
  assert.match(configs, /gas: s\.gas,/);
});

test("the recovery proof reports progress to its caller, not straight to the bus", () => {
  // Whoever emits tx:progress owes the UI a terminating event. This module
  // cannot promise one — it does not know whether the send succeeded — so it
  // hands progress up to the runner, which does.
  const at = recovery.indexOf("generateCrossContractCallsProof7702(");
  assert.ok(at > 0, "the proof call is gone");
  const body = recovery.slice(at, at + 1200);
  assert.match(body, /onProgress\?\./, "progress must go to the caller's callback");
  assert.ok(
    !/emitCoreEvent\(/.test(body),
    "emitting progress here is what stranded the bar at 100%",
  );
});

test("the on-chain floor stays at no-floor, which is a different lever", () => {
  // minGasLimit is baked in as a gasleft() require; raising it forces the tx to
  // carry gas AND can revert the estimate on the check itself. The carried
  // limit is the lever being used here.
  assert.match(recovery, /recoveryMinGasLimit = NO_CROSS_CONTRACT_GAS_FLOOR/);
});

test("a recovery that mines and reverts is not reported as sent", () => {
  // Relay-adapt builds its action data with requireSuccess = false, so a batch
  // mines whether or not its inner calls succeeded — which is exactly how the
  // funds this flow rescues got stranded. Reporting success at broadcast would
  // let a recovery fail the same way and be recorded as a success.
  assert.match(deps, /getRelayAdaptFailure\(/);
  assert.match(deps, /waitForRelayedTx\(/);
  assert.match(deps, /did not complete/);
  assert.match(deps, /resetBalanceScan\(\)/);
});
