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
  getProvedEphemeralRecoveryTransaction,
  submitRecoveryTransaction,
} from "../../railgun/wallet/ephemeral-recovery";
import { getTransactionURLForChain } from "../../railgun/network/network-util";

export interface RecoverySpec {
  chainName: NetworkName;
  encryptionKey: string;
  /** The PAST index holding the stranded assets. Never the current one. */
  targetIndex: number;
  selection: RecoverySelection;
  fee: FeeMode;
}

const broadcasterFor = (fee: FeeMode) =>
  fee.kind === "broadcaster" ? fee.broadcaster : undefined;

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
    ),
  // NOT sendPrivateTransaction: that ratchets the ephemeral index, and this
  // batch was built against a past one. See the header.
  send: async (spec, proved) => {
    const hash = await submitRecoveryTransaction(
      spec.chainName,
      proved,
      broadcasterFor(spec.fee),
    );
    return { hash, url: getTransactionURLForChain(spec.chainName, hash) };
  },
});

export const runRecoveryTransaction = (
  spec: RecoverySpec,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, createRecoveryDeps());
