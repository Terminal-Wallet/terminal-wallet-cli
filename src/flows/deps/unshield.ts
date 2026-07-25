/**
 * Unshield deps adapters — ERC20 unshield and base-token unshield onto the
 * generic runTransaction pipeline. Mirrors transfer-deps; shares the send step.
 */
import { RailgunPopulateTransactionResponse } from "@railgun-community/shared-models";
import { PrivateGasEstimate } from "../../models/transaction-models";
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { UnshieldSpec, UnshieldBaseSpec } from "../spec";
import {
  getUnshieldERC20TransactionGasEstimate,
  getProvedUnshieldERC20Transaction,
} from "../../railgun/transaction/private/unshield-tx";
import {
  getUnshieldBaseTokenGasEstimate,
  getProvedUnshieldBaseTokenTransaction,
} from "../../railgun/transaction/private-base/unshield-base-tx";
import { sendPrivateTransaction } from "../send-private";

type Proved = RailgunPopulateTransactionResponse;

const broadcasterOf = (fee: UnshieldSpec["fee"]) =>
  fee.kind === "broadcaster" ? fee.broadcaster : undefined;

/** Injection point so the binding is testable without the SDK. */
export interface UnshieldImpls {
  estimate: typeof getUnshieldERC20TransactionGasEstimate;
  prove: typeof getProvedUnshieldERC20Transaction;
  send: typeof sendPrivateTransaction;
}

const defaultUnshieldImpls: UnshieldImpls = {
  estimate: getUnshieldERC20TransactionGasEstimate,
  prove: getProvedUnshieldERC20Transaction,
  send: sendPrivateTransaction,
};

export const createUnshieldDeps = (
  impls: UnshieldImpls = defaultUnshieldImpls,
): TransactionRunDeps<
  UnshieldSpec,
  PrivateGasEstimate,
  Proved,
  SendOutcome
> => ({
  estimateGas: async (spec) => {
    const gas = await impls.estimate(
      spec.chainName,
      spec.recipients,
      spec.encryptionKey,
      broadcasterOf(spec.fee),
    );
    if (!gas) throw new Error("Failed to estimate gas for unshield.");
    return gas;
  },
  prove: async (spec, gas) => {
    const proved = await impls.prove(
      spec.encryptionKey,
      spec.recipients,
      gas,
    );
    if (!proved) throw new Error("Failed to generate unshield proof.");
    return proved;
  },
  send: (spec, proved) =>
    impls.send(proved, spec.fee, spec.chainName, spec.type),
});

export const runUnshieldTransaction = (
  spec: UnshieldSpec,
  confirm?: (spec: UnshieldSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createUnshieldDeps(), confirm });

/** Injection point so the binding is testable without the SDK. */
export interface UnshieldBaseImpls {
  estimate: typeof getUnshieldBaseTokenGasEstimate;
  prove: typeof getProvedUnshieldBaseTokenTransaction;
  send: typeof sendPrivateTransaction;
}

const defaultUnshieldBaseImpls: UnshieldBaseImpls = {
  estimate: getUnshieldBaseTokenGasEstimate,
  prove: getProvedUnshieldBaseTokenTransaction,
  send: sendPrivateTransaction,
};

export const createUnshieldBaseDeps = (
  impls: UnshieldBaseImpls = defaultUnshieldBaseImpls,
): TransactionRunDeps<
  UnshieldBaseSpec,
  PrivateGasEstimate,
  Proved,
  SendOutcome
> => ({
  estimateGas: async (spec) => {
    const gas = await impls.estimate(
      spec.chainName,
      spec.recipient,
      spec.encryptionKey,
      broadcasterOf(spec.fee),
    );
    if (!gas) throw new Error("Failed to estimate gas for base unshield.");
    return gas;
  },
  prove: async (spec, gas) => {
    const proved = await impls.prove(
      spec.encryptionKey,
      spec.recipient,
      gas,
    );
    if (!proved) throw new Error("Failed to generate base unshield proof.");
    return proved;
  },
  send: (spec, proved) =>
    impls.send(proved, spec.fee, spec.chainName, spec.type),
});

export const runUnshieldBaseTransaction = (
  spec: UnshieldBaseSpec,
  confirm?: (spec: UnshieldBaseSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createUnshieldBaseDeps(), confirm });
