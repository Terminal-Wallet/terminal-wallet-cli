/**
 * Shield deps adapters (public→private). A shield is signed from the public
 * wallet — its "prove" step just POPULATES the shield tx; send signs it. An
 * ERC20 approval pre-step is handled separately (see approval-flow.ts) before
 * the pipeline runs.
 */
import { ContractTransaction } from "ethers";
import { PrivateGasEstimate } from "../../models/transaction-models";
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { ShieldSpec, ShieldBaseSpec } from "../spec";
import {
  getShieldERC20TransactionGasDetails,
  getProvedShieldERC20Transaction,
} from "../../railgun/transaction/private/shield-tx";
import {
  getShieldBaseTokenGasDetails,
  getProvedShieldBaseTokenTransaction,
} from "../../railgun/transaction/private-base/shield-base-tx";
import { sendPublicTransaction } from "../send-public";

type Prepared = ContractTransaction;

/** Injection point so the binding is testable without the SDK. */
export interface ShieldImpls {
  estimate: typeof getShieldERC20TransactionGasDetails;
  prove: typeof getProvedShieldERC20Transaction;
  send: typeof sendPublicTransaction;
}

const defaultShieldImpls: ShieldImpls = {
  estimate: getShieldERC20TransactionGasDetails,
  prove: getProvedShieldERC20Transaction,
  send: sendPublicTransaction,
};

export const createShieldDeps = (
  impls: ShieldImpls = defaultShieldImpls,
): TransactionRunDeps<
  ShieldSpec,
  PrivateGasEstimate,
  Prepared,
  SendOutcome
> => ({
  estimateGas: (spec) =>
    impls.estimate(spec.chainName, spec.recipients),
  prove: (spec, gas) =>
    impls.prove(spec.chainName, spec.recipients, gas),
  send: (spec, tx) => impls.send(tx, spec.chainName),
});

export const runShieldTransaction = (
  spec: ShieldSpec,
  confirm?: (spec: ShieldSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createShieldDeps(), confirm });

/** Injection point so the binding is testable without the SDK. */
export interface ShieldBaseImpls {
  estimate: typeof getShieldBaseTokenGasDetails;
  prove: typeof getProvedShieldBaseTokenTransaction;
  send: typeof sendPublicTransaction;
}

const defaultShieldBaseImpls: ShieldBaseImpls = {
  estimate: getShieldBaseTokenGasDetails,
  prove: getProvedShieldBaseTokenTransaction,
  send: sendPublicTransaction,
};

export const createShieldBaseDeps = (
  impls: ShieldBaseImpls = defaultShieldBaseImpls,
): TransactionRunDeps<
  ShieldBaseSpec,
  PrivateGasEstimate,
  Prepared,
  SendOutcome
> => ({
  // Both calls take the encryption key so each can derive the SAME current
  // ephemeral account for the 7702 bundle. The index only advances on a
  // successful submission, so estimate and proof resolve to one address.
  estimateGas: (spec) =>
    impls.estimate(
      spec.chainName,
      spec.recipient,
      spec.encryptionKey,
    ),
  prove: (spec, gas) =>
    impls.prove(
      spec.chainName,
      spec.recipient,
      gas,
      spec.encryptionKey,
    ),
  send: (spec, tx) => impls.send(tx, spec.chainName),
});

export const runShieldBaseTransaction = (
  spec: ShieldBaseSpec,
  confirm?: (spec: ShieldBaseSpec, gas: PrivateGasEstimate) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createShieldBaseDeps(), confirm });
