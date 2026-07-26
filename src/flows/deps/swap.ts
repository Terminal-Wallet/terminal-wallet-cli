/**
 * 0x swap deps.
 *
 * The PRIVATE swap runs its own 7702 estimate and proof rather than the generic
 * cross-contract pipeline: it realigns the ephemeral index before the SDK
 * derives the taker, and it is the path the 7702 work was built against. The
 * PUBLIC swap is a plain ethers tx (no proof) and stays here too.
 */
import {
  NetworkName,
  RailgunPopulateTransactionResponse,
} from "@railgun-community/shared-models";
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
  calculateGasForPublicSwapTransaction,
  getZer0XSwapTransactionGasEstimate,
  getProvedZer0XSwapTransaction,
} from "../../railgun/transaction/zeroX/0x-swap";
import { sendPrivateTransaction } from "../send-private";
import { PublicTransactionDetails } from "../../railgun/transaction/public/public-tx";
import { sendPublicTransaction } from "../send-public";

/**
 * The 0x quote reduced to the generic cross-contract shape.
 *
 * Kept for recipes that genuinely are generic (LP, Beefy, combo). The private
 * swap does NOT use it — see createPrivateSwapDeps.
 */
export const swapToCrossContractInputs = (
  swap: Zer0XSwap,
): CrossContractInputs => ({
  relayAdaptUnshieldERC20Amounts: swap.relayAdaptUnshieldERC20Amounts,
  relayAdaptShieldERC20Addresses: swap.relayAdaptShieldERC20Addresses,
  crossContractCalls: swap.crossContractCalls,
  minGasLimit: swap.minGasLimit ?? NO_CROSS_CONTRACT_GAS_FLOOR,
});

/**
 * Private 0x swap deps.
 *
 * These call the swap's own 7702 estimate and proof rather than reducing to the
 * generic cross-contract pipeline. The swap needs its ephemeral index realigned
 * with history before the SDK derives the taker address, and it is the path the
 * 7702 work was built and tested against — a generic route has to reproduce all
 * of that exactly, and every difference is silent.
 */
export const createPrivateSwapDeps = (): TransactionRunDeps<
  PrivateSwapSpec,
  PrivateGasEstimate,
  RailgunPopulateTransactionResponse,
  SendOutcome
> => ({
  estimateGas: async (spec) => {
    const broadcaster =
      spec.fee.kind === "broadcaster" ? spec.fee.broadcaster : undefined;
    const gas = await getZer0XSwapTransactionGasEstimate(
      spec.chainName,
      spec.inputs,
      spec.encryptionKey,
      broadcaster,
    );
    if (!gas) throw new Error("Failed to estimate gas for the private swap.");
    return gas;
  },
  prove: async (spec, gas) => {
    const proved = await getProvedZer0XSwapTransaction(
      spec.encryptionKey,
      spec.inputs,
      gas,
    );
    if (!proved) throw new Error("Failed to generate the private swap proof.");
    return proved;
  },
  send: (spec, proved) =>
    sendPrivateTransaction(
      proved,
      spec.fee,
      spec.chainName,
      RailgunTransaction.Private0XSwap,
    ),
});

export const runPrivateSwapTransaction = (
  spec: PrivateSwapSpec,
  confirm?: (
    spec: { chainName: NetworkName; fee: FeeMode },
    gas: PrivateGasEstimate,
  ) => Promise<boolean>,
): Promise<RunResult<SendOutcome>> =>
  runTransaction(spec, { ...createPrivateSwapDeps(), confirm });

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
