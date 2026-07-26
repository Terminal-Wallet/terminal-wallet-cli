/**
 * Generic cross-contract deps adapter. Any recipe (0x swap, LP, Beefy, combo)
 * whose output reduces to CrossContractInputs runs through this: estimate →
 * prove → broadcaster/self-sign. Always Relay-Adapt, and always 7702. Wiring a new cookbook
 * recipe = produce its CrossContractInputs + a CrossContractSpec; no new adapter.
 */
import {
  NetworkName,
  RailgunPopulateTransactionResponse,
} from "@railgun-community/shared-models";
import { PrivateGasEstimate, RailgunTransaction } from "../../models/transaction-models";
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { FeeMode } from "../spec";
import {
  CrossContractInputs,
  getCrossContractGasEstimate,
  getProvedCrossContractTransaction,
} from "../../railgun/transaction/cross-contract";
import { sendPrivateTransaction } from "../send-private";

/** A private transaction built from a cookbook/0x recipe's cross-contract output. */
export interface CrossContractSpec {
  /** Used for relay-adapt selection + UI labeling (e.g. Private0XSwap). */
  type: RailgunTransaction;
  chainName: NetworkName;
  inputs: CrossContractInputs;
  encryptionKey: string;
  fee: FeeMode;
}

type Proved = RailgunPopulateTransactionResponse;

export const createCrossContractDeps = (): TransactionRunDeps<
  CrossContractSpec,
  PrivateGasEstimate,
  Proved,
  SendOutcome
> => ({
  estimateGas: async (spec) => {
    const broadcaster =
      spec.fee.kind === "broadcaster" ? spec.fee.broadcaster : undefined;
    const gas = await getCrossContractGasEstimate(
      spec.chainName,
      spec.inputs,
      spec.encryptionKey,
      broadcaster,
    );
    if (!gas) throw new Error("Failed to estimate gas for cross-contract tx.");
    return gas;
  },
  prove: async (spec, gas) => {
    const proved = await getProvedCrossContractTransaction(
      spec.encryptionKey,
      spec.inputs,
      gas,
    );
    if (!proved) throw new Error("Failed to generate cross-contract proof.");
    return proved;
  },
  send: (spec, proved) =>
    sendPrivateTransaction(proved, spec.fee, spec.chainName, spec.type),
});

export const runCrossContractTransaction = (
  spec: CrossContractSpec,
  confirm?: (spec: CrossContractSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createCrossContractDeps(), confirm });
