/**
 * Private-transfer deps adapter — wraps the existing private-tx impl so a
 * Transfer runs through the generic runTransaction pipeline. This is the
 * template for migrating the other tx types: each provides estimate/prove/send
 * deps; the runner handles phases, progress, and errors.
 */
import { RailgunPopulateTransactionResponse } from "@railgun-community/shared-models";
import { PrivateGasEstimate } from "../../models/transaction-models";
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { TransferSpec } from "../spec";
import {
  getPrivateTransactionGasEstimate,
  getProvedPrivateTransaction,
} from "../../railgun/transaction/private/private-tx";
import { sendPrivateTransaction } from "../send-private";

type Proved = RailgunPopulateTransactionResponse;

/**
 * The SDK-facing calls this adapter binds to, injectable so the binding itself
 * is testable without a chain. Same shape as SendPrivateDeps — an adapter whose
 * whole job is wiring is worth being able to verify the wiring of.
 */
export interface TransferImpls {
  estimate: typeof getPrivateTransactionGasEstimate;
  prove: typeof getProvedPrivateTransaction;
  send: typeof sendPrivateTransaction;
}

const defaultImpls: TransferImpls = {
  estimate: getPrivateTransactionGasEstimate,
  prove: getProvedPrivateTransaction,
  send: sendPrivateTransaction,
};

export const createTransferDeps = (
  impls: TransferImpls = defaultImpls,
): TransactionRunDeps<
  TransferSpec,
  PrivateGasEstimate,
  Proved,
  SendOutcome
> => ({
  estimateGas: async (spec) => {
    const broadcaster =
      spec.fee.kind === "broadcaster" ? spec.fee.broadcaster : undefined;
    const gas = await impls.estimate(
      spec.chainName,
      spec.recipients,
      spec.encryptionKey,
      broadcaster,
      spec.memo ?? "",
    );
    // The impl resolves undefined on failure rather than throwing. Left
    // unchecked that undefined flows into prove as the gas estimate, and the
    // failure surfaces much later as something unrelated.
    if (!gas) throw new Error("Failed to estimate gas for transfer.");
    return gas;
  },

  // getProvedPrivateTransaction emits its own tx:progress while proving.
  prove: async (spec, gas) => {
    const proved = await impls.prove(
      spec.encryptionKey,
      spec.recipients,
      gas,
      spec.memo ?? "",
    );
    if (!proved) throw new Error("Failed to generate transfer proof.");
    return proved;
  },

  send: (spec, proved) =>
    impls.send(proved, spec.fee, spec.chainName, spec.type),
});

/**
 * Run a private transfer through the pipeline (emits tx:progress/tx:result).
 * `confirm` is the review gate run after the estimate, before prove/broadcast.
 */
export const runTransferTransaction = (
  spec: TransferSpec,
  confirm?: (spec: TransferSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createTransferDeps(), confirm });
