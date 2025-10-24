import { TransactionRequest } from "ethers";
import {
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import {
  RailgunERC20AmountRecipient,
  RailgunNFTAmountRecipient,
  TXIDVersion,
} from "@railgun-community/shared-models";

import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getTransactionGasDetails } from "../../transaction/private/private-tx";
import { getSaltedPassword } from "../../wallet/wallet-password";

import { getOutputGasEstimate } from "../../transaction/private/unshield-tx";

import { getCurrentNetwork } from "../../engine/engine";

export async function populateUnshieldTransaction({
  // Assets to unshield FROM Railgun (these will be available in contract calls)
  unshieldNFTs,
  unshieldERC20s,
}: {
  unshieldNFTs: RailgunNFTAmountRecipient[];
  unshieldERC20s: RailgunERC20AmountRecipient[];
}): Promise<TransactionRequest> {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const networkName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();

  const gasDetailsResult = await getTransactionGasDetails(networkName);
  if (!gasDetailsResult) throw new Error("Failed to get gas details");

  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) throw new Error("Failed to get encryption key");

  const sendWithPublicWallet = true;

  const { gasEstimate } = await gasEstimateForUnprovenUnshield(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s,
    unshieldNFTs,
    gasDetailsResult.originalGasDetails,
    gasDetailsResult.feeTokenDetails,
    sendWithPublicWallet,
  );

  const { estimatedGasDetails } = await getOutputGasEstimate(
    gasDetailsResult.originalGasDetails,
    gasEstimate,
    gasDetailsResult.feeTokenInfo,
    gasDetailsResult.feeTokenDetails,
    undefined,
    gasDetailsResult.overallBatchMinGasPrice,
  );

  await generateUnshieldProof(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s,
    unshieldNFTs,
    undefined,
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    () => console.log(`Proof generation in progress...`),
  );

  const { transaction, nullifiers } = await populateProvedUnshield(
    txIDVersion,
    networkName,
    railgunWalletID,
    unshieldERC20s,
    unshieldNFTs,
    undefined, // No broadcaster fee
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    estimatedGasDetails,
  );

  return transaction;
}
