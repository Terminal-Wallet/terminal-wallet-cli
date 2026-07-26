/**
 * Generic Relay-Adapt cross-contract calls — the rail that 0x swaps AND every
 * cookbook recipe (LP add/remove, Beefy deposit/withdraw, combo meals) ride.
 *
 * A "recipe" produces CrossContractInputs (unshield amounts + shield addresses +
 * the contract calls + a min gas limit). This module turns any such inputs into
 * a gas estimate and a proved transaction — so wiring a new cookbook recipe is
 * just: build its RecipeOutput → CrossContractInputs → run.
 */
import {
  NetworkName,
  RailgunERC20Recipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import { RecipeERC20Amount } from "@railgun-community/cookbook";
import { ContractTransaction } from "ethers";
import { emitCoreEvent } from "../../core/events";
import { getCurrentRailgunID } from "../wallet/wallet-util";
import { getCurrentNetwork } from "../engine/engine";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import { getTransactionGasDetails } from "./private/private-tx";
import { getOutputGasEstimate } from "./private/unshield-tx";

/**
 * The `minGasLimit` that results in no on-chain gas floor at all.
 *
 * The SDK does not pass this value to the contract directly. Every relay-adapt
 * contract — V2, V3 and the 7702 one — computes
 * `minGasLimitForContract = minGasLimit - 150000n` and bakes THAT into the
 * action data as `require(gasleft() > minGasLimitForContract)`. So the offset
 * is what "no floor" costs: 150_000n in gives exactly 0 out.
 *
 * Both neighbouring values are wrong. A literal `0n` yields -150_000n, which is
 * not encodable as the contract's unsigned parameter. `undefined` makes the SDK
 * substitute its own multi-million default, which forces the transaction to
 * CARRY that much gas and reverts the estimate on the floor check.
 *
 * With the floor at zero the estimate reflects real execution, and the
 * submitted limit is `calculateGasLimit(estimate)` — estimate x1.2 — which
 * `setGasDetailsForTransaction` writes over whatever populate had set.
 */
export const NO_CROSS_CONTRACT_GAS_FLOOR = 150_000n;

/** The output every recipe (0x swap, LP, Beefy, combo) reduces to. */
export interface CrossContractInputs {
  relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[];
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[];
  crossContractCalls: ContractTransaction[];
  /**
   * Always NO_CROSS_CONTRACT_GAS_FLOOR. Required rather than optional because
   * undefined is not "no floor" — the SDK substitutes its own default.
   */
  minGasLimit: bigint;
}

export const getCrossContractGasEstimate = async (
  chainName: NetworkName,
  inputs: CrossContractInputs,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
  );
  if (!gasDetailsResult) return undefined;

  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = gasDetailsResult as PrivateGasDetails;

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    crossContractCalls,
    minGasLimit,
  } = inputs;

  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls(
    txIDVersion,
    chainName,
    railgunWalletID,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    [],
    relayAdaptShieldERC20Addresses,
    [],
    crossContractCalls,
    originalGasDetails,
    feeTokenDetails,
    sendWithPublicWallet,
    minGasLimit,
  );
  return getOutputGasEstimate(
    originalGasDetails,
    gasEstimate,
    feeTokenInfo,
    feeTokenDetails,
    broadcasterSelection,
    overallBatchMinGasPrice,
  );
};

export const getProvedCrossContractTransaction = async (
  encryptionKey: string,
  inputs: CrossContractInputs,
  privateGasEstimate: PrivateGasEstimate,
): Promise<RailgunPopulateTransactionResponse | undefined> => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const progressCallback = (progress: number, progressStats: string) => {
    emitCoreEvent({
      type: "tx:progress",
      phase: "prove",
      pct: progress,
      message: isDefined(progressStats)
        ? `Transaction Proof Generation [${progressStats}]`
        : "Transaction Proof Generation",
    });
  };

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    crossContractCalls,
    minGasLimit,
  } = inputs;

  const { broadcasterFeeERC20Recipient, overallBatchMinGasPrice, estimatedGasDetails } =
    privateGasEstimate;
  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;

  try {
    await generateCrossContractCallsProof(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      relayAdaptUnshieldERC20Amounts,
      [],
      relayAdaptShieldERC20Addresses,
      [],
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      minGasLimit,
      progressCallback,
    ).finally(() => {
      emitCoreEvent({ type: "tx:progress", phase: "prove", pct: 100, message: "Proof complete" });
    });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        relayAdaptUnshieldERC20Amounts,
        [],
        relayAdaptShieldERC20Addresses,
        [],
        crossContractCalls,
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );
    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    console.log("ERROR getting proved cross-contract tx:", (err as Error).message);
    return undefined;
  }
};
