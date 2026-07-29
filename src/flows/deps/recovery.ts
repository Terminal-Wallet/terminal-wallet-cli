/**
 * Recovery deps adapter: a stranded ephemeral account, swept back into RAILGUN.
 *
 * Recovery used to submit outside the runner, on the reasoning that the shared
 * private send RATCHETS the ephemeral index on any type-4 send and a recovery
 * is built against a PAST index — ratcheting would step over a live account.
 * That reasoning is right about the send and wrong about the pipeline: which
 * send function runs is exactly what `deps.send` parameterises, so the
 * invariant is kept by pointing it at `submitRecoveryTransaction` rather than
 * by leaving the pipeline altogether.
 *
 * Leaving it cost the whole event contract. `runTransaction` is the only
 * emitter of `tx:result`, and that event is what clears the progress bar, what
 * writes the outcome to the log pane, and what recovers the chain's revert
 * reason. Bypassing it meant a recovery emitted proof progress and then nothing
 * at all: the bar sat at 100% forever, and because `footerStatus` gives the bar
 * precedence over the status line, every message after it — including the
 * failure — was invisible. The flow looked hung and left no trace.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { TransactionRunDeps, SendOutcome, runTransaction, RunResult } from "../run";
import { FeeMode } from "../spec";
import {
  Proved7702RelayAdapt,
  RecoverySelection,
  RecoveryGasChoice,
  getProvedEphemeralRecoveryTransaction,
  submitRecoveryTransaction,
} from "../../railgun/wallet/ephemeral-recovery";
import { getTransactionURLForChain } from "../../railgun/network/network-util";
import { waitForRelayedTx } from "../../railgun/transaction/public/public-tx";
import { resetBalanceScan } from "../../railgun/wallet/private-wallet";
import { getRelayAdaptFailure } from "../../railgun/transaction/relay-adapt-error";
import { emitCoreEvent } from "../../core/events";

export interface RecoverySpec {
  chainName: NetworkName;
  encryptionKey: string;
  /** The PAST index holding the stranded assets. Never the current one. */
  targetIndex: number;
  selection: RecoverySelection;
  fee: FeeMode;
  /**
   * The gas tier chosen on the builder's gas row.
   *
   * Carried explicitly because the builder tears down before the submit is
   * awaited, and its teardown clears the process-wide gas override — so a
   * recovery that read the override at build time always found it gone and
   * silently fell back to the cheapest tier.
   */
  gas?: RecoveryGasChoice;
}

const broadcasterFor = (fee: FeeMode) =>
  fee.kind === "broadcaster" ? fee.broadcaster : undefined;

/**
 * Say what the batch actually did, once it mines.
 *
 * A relay-adapt batch reports success at broadcast and can still revert
 * internally — `requireSuccess = false` means the transaction mines either way.
 * The private send path already reports this; recovery has to as well, or the
 * one flow whose entire job is rescuing a batch that mined and reverted would
 * itself mine, revert, and be reported as "sent".
 */
const watchRelayAdaptOutcome = async (
  chainName: NetworkName,
  hash: string,
  url: string,
): Promise<void> => {
  try {
    const settlement = await waitForRelayedTx(chainName, hash);
    if (settlement.kind !== "mined") {
      // A recovery that reverts leaves the funds exactly where they were, so
      // the message has to say the rescue did not happen — "mined" here would
      // send the user away from funds that are still stranded.
      emitCoreEvent({
        type: "status:message",
        text:
          settlement.kind === "reverted"
            ? `Recovery REVERTED — the funds are still at the ephemeral account. ${url}`
            : `Recovery broadcast, but its outcome could not be confirmed (${settlement.reason}) — ${url}`,
        durationMs: 120000,
        replace: true,
      });
      return;
    }
    const failure = await getRelayAdaptFailure(chainName, hash);
    emitCoreEvent({
      type: "status:message",
      text: failure
        ? `Recovery mined but the batch did not complete (${failure}). The funds are still at the ephemeral account — ${url}`
        : `Recovery mined: ${url}`,
      durationMs: 30000,
      replace: true,
    });
  } catch (err) {
    // Watching is best-effort; the transaction is already broadcast and the
    // explorer link is the fallback. Saying nothing would be worse than saying
    // it could not be checked.
    emitCoreEvent({
      type: "status:message",
      text: `Recovery broadcast, but its outcome could not be confirmed (${(err as Error).message}) — ${url}`,
      durationMs: 30000,
      replace: true,
    });
  }
};

export const createRecoveryDeps = (): TransactionRunDeps<
  RecoverySpec,
  undefined,
  Proved7702RelayAdapt,
  SendOutcome
> => ({
  // The ephemeral signer override has to span estimate → prove → populate as
  // one window — it is process-wide, and a second flow entering it mid-build
  // would sign this batch as a different account. So the build is indivisible
  // and lives entirely in `prove`; there is no separate estimate to run.
  estimateGas: async () => undefined,
  prove: (spec, _gas, onProgress) =>
    getProvedEphemeralRecoveryTransaction(
      spec.chainName,
      spec.encryptionKey,
      spec.targetIndex,
      spec.selection,
      broadcasterFor(spec.fee),
      onProgress,
      spec.gas,
    ),
  // NOT sendPrivateTransaction: that ratchets the ephemeral index, and this
  // batch was built against a past one. See the header.
  //
  // Everything else that path does after the broadcast still has to happen,
  // because relay-adapt builds its action data with `requireSuccess = false`
  // and a batch can therefore MINE and still have failed inside. That is
  // exactly how the funds this flow is rescuing got stranded in the first
  // place, so reporting "sent" the moment the broadcaster accepts would let a
  // recovery fail the same way and be recorded as a success.
  send: async (spec, proved) => {
    const hash = await submitRecoveryTransaction(
      spec.chainName,
      proved,
      broadcasterFor(spec.fee),
    );
    const url = getTransactionURLForChain(spec.chainName, hash);
    // Deliberately NOT awaited: the send has succeeded as far as the pipeline
    // is concerned, and the batch's own outcome arrives whenever it mines.
    // Balances change either way, so the scan is reset regardless.
    resetBalanceScan();
    void watchRelayAdaptOutcome(spec.chainName, hash, url);
    return { hash, url };
  },
});

export const runRecoveryTransaction = (
  spec: RecoverySpec,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, createRecoveryDeps());
