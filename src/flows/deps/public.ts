/**
 * Public transfer deps adapters (no proof step — estimate produces the populated
 * tx, send signs it). Uses the optional-prove form of runTransaction.
 */
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { PublicTransferSpec, PublicBaseSpec } from "../spec";
import {
  populateAndCalculateGasForERC20Transaction,
  PublicTransactionDetails,
} from "../../railgun/transaction/public/public-tx";
import { populateAndCalculateGasForBaseTokenTransaction } from "../../railgun/transaction/public/public-base-tx";
import { sendPublicTransaction } from "../send-public";

type Prepared = PublicTransactionDetails;

/** Injection point so the binding is testable without the SDK. */
export interface PublicTransferImpls {
  estimate: typeof populateAndCalculateGasForERC20Transaction;
  send: typeof sendPublicTransaction;
}

const defaultPublicTransferImpls: PublicTransferImpls = {
  estimate: populateAndCalculateGasForERC20Transaction,
  send: sendPublicTransaction,
};

export const createPublicTransferDeps = (
  impls: PublicTransferImpls = defaultPublicTransferImpls,
): TransactionRunDeps<
  PublicTransferSpec,
  Prepared,
  Prepared,
  SendOutcome
> => ({
  estimateGas: (spec) =>
    impls.estimate(spec.chainName, spec.recipient),
  // no prove
  send: (spec, prepared) =>
    impls.send(prepared.populatedTransaction, spec.chainName),
});

export const runPublicTransferTransaction = (
  spec: PublicTransferSpec,
  confirm?: (spec: PublicTransferSpec, gas: Prepared) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createPublicTransferDeps(), confirm });

/** Injection point so the binding is testable without the SDK. */
export interface PublicBaseImpls {
  estimate: typeof populateAndCalculateGasForBaseTokenTransaction;
  send: typeof sendPublicTransaction;
}

const defaultPublicBaseImpls: PublicBaseImpls = {
  estimate: populateAndCalculateGasForBaseTokenTransaction,
  send: sendPublicTransaction,
};

export const createPublicBaseDeps = (
  impls: PublicBaseImpls = defaultPublicBaseImpls,
): TransactionRunDeps<
  PublicBaseSpec,
  Prepared,
  Prepared,
  SendOutcome
> => ({
  estimateGas: (spec) =>
    impls.estimate(spec.chainName, spec.recipient),
  send: (spec, prepared) =>
    impls.send(prepared.populatedTransaction, spec.chainName),
});

export const runPublicBaseTransaction = (
  spec: PublicBaseSpec,
  confirm?: (spec: PublicBaseSpec, gas: Prepared) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createPublicBaseDeps(), confirm });
