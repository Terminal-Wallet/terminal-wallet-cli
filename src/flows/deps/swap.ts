/**
 * 0x swap deps. The PRIVATE swap reduces to CrossContractInputs and runs
 * through the generic cross-contract pipeline (so LP / Beefy / combo recipes
 * wire in the same way); that pipeline branches on execution mode, so the swap
 * still executes as a 7702 relay-adapt. The PUBLIC swap is a plain ethers tx
 * (no proof) and stays here.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { PrivateGasEstimate, RailgunTransaction } from "../../models/transaction-models";
import { Zer0XSwap } from "../../models/0x-models";
import {
  TransactionRunDeps,
  SendOutcome,
  runTransaction,
  RunResult,
} from "../run";
import { FeeMode, PrivateSwapSpec, PublicSwapSpec } from "../spec";
import { NO_CROSS_CONTRACT_GAS_FLOOR, CrossContractInputs } from "../../railgun/transaction/cross-contract";
import {
  CrossContractSpec,
  runCrossContractTransaction,
} from "./cross-contract";
import { calculateGasForPublicSwapTransaction } from "../../railgun/transaction/zeroX/0x-swap";
import { PublicTransactionDetails } from "../../railgun/transaction/public/public-tx";
import { sendPublicTransaction } from "../send-public";

/** The 0x quote IS a recipe output — reduce it to the generic cross-contract inputs. */
export const swapToCrossContractInputs = (
  swap: Zer0XSwap,
): CrossContractInputs => ({
  relayAdaptUnshieldERC20Amounts: swap.relayAdaptUnshieldERC20Amounts,
  relayAdaptShieldERC20Addresses: swap.relayAdaptShieldERC20Addresses,
  crossContractCalls: swap.crossContractCalls,
  // The recipe's own floor; the swap's variable 0x call needs it. Only the
  // deterministic ops fall back to NO_CROSS_CONTRACT_GAS_FLOOR.
  minGasLimit: swap.minGasLimit ?? NO_CROSS_CONTRACT_GAS_FLOOR,
});

export const runPrivateSwapTransaction = (
  spec: PrivateSwapSpec,
  confirm?: (
    spec: { chainName: NetworkName; fee: FeeMode },
    gas: PrivateGasEstimate,
  ) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> => {
  const crossContract: CrossContractSpec = {
    type: RailgunTransaction.Private0XSwap,
    chainName: spec.chainName,
    inputs: swapToCrossContractInputs(spec.inputs),
    encryptionKey: spec.encryptionKey,
    fee: spec.fee,
  };
  return runCrossContractTransaction(crossContract, confirm);
};

// ---- Public 0x swap (no proof; sign after the approval pre-step) ------------
type PublicPrepared = PublicTransactionDetails;

export const createPublicSwapDeps = (): TransactionRunDeps<
  PublicSwapSpec,
  PublicPrepared,
  PublicPrepared,
  SendOutcome
> => ({
  estimateGas: (spec) =>
    calculateGasForPublicSwapTransaction(spec.chainName, spec.swapTransaction),
  // no prove
  send: (spec, prepared) =>
    sendPublicTransaction(prepared.populatedTransaction, spec.chainName),
});

export const runPublicSwapTransaction = (
  spec: PublicSwapSpec,
  confirm?: (spec: PublicSwapSpec, gas: PublicPrepared) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createPublicSwapDeps(), confirm });
