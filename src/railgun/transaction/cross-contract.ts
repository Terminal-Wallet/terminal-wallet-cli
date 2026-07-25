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

/** The output every recipe (0x swap, LP, Beefy, combo) reduces to. */
export interface CrossContractInputs {
  relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[];
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[];
  crossContractCalls: ContractTransaction[];
  minGasLimit?: bigint;
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
