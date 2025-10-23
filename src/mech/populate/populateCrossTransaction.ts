import { ContractTransaction, TransactionRequest } from "ethers";
import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  RailgunERC20Amount,
  RailgunERC20AmountRecipient,
  RailgunNFTAmount,
  RailgunNFTAmountRecipient,
  TXIDVersion,
} from "@railgun-community/shared-models";

import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getTransactionGasDetails } from "../../transaction/private/private-tx";
import { getSaltedPassword } from "../../wallet/wallet-password";

import { getOutputGasEstimate } from "../../transaction/private/unshield-tx";

import { getCurrentNetwork } from "../../engine/engine";

export async function populateCrossTransaction({
  // Assets to unshield FROM Railgun (these will be available in contract calls)
  unshieldNFTs,
  unshieldERC20s,

  // Custom transactions
  crossContractCalls,

  // Assets to shield back INTO Railgun (optional, can be empty)
  shieldNFTs,
  shieldERC20s,
}: {
  unshieldNFTs: RailgunNFTAmount[];
  unshieldERC20s?: RailgunERC20Amount[];
  crossContractCalls: ContractTransaction[];
  shieldNFTs?: RailgunNFTAmountRecipient[];
  shieldERC20s?: RailgunERC20AmountRecipient[];
}): Promise<TransactionRequest> {
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const networkName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();

  const gasDetailsResult = await getTransactionGasDetails(networkName);
  if (!gasDetailsResult) throw new Error("Failed to get gas details");

  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) throw new Error("Failed to get encryption key");

  const sendWithPublicWallet = true; // You'll pay gas yourself in ETH

  const gasEstimateResponse = await gasEstimateForUnprovenCrossContractCalls(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s || [],
    unshieldNFTs,
    shieldERC20s || [],
    shieldNFTs || [],
    crossContractCalls,
    gasDetailsResult.originalGasDetails,
    gasDetailsResult.feeTokenDetails,
    sendWithPublicWallet,
    undefined,
  );

  console.log(`Estimated gas: ${gasEstimateResponse.gasEstimate}`);

  const finalGasDetails = await getOutputGasEstimate(
    gasDetailsResult.originalGasDetails,
    gasEstimateResponse.gasEstimate,
    gasDetailsResult.feeTokenInfo,
    gasDetailsResult.feeTokenDetails,
    undefined,
    gasDetailsResult.overallBatchMinGasPrice,
  );

  console.log("Generating proof...");

  await generateCrossContractCallsProof(
    txIDVersion,
    networkName,
    railgunWalletID,
    encryptionKey,
    unshieldERC20s || [],
    unshieldNFTs,
    shieldERC20s || [], // ✅ RailgunERC20Recipient[]
    shieldNFTs || [], // ✅ RailgunNFTAmountRecipient[]
    crossContractCalls,
    finalGasDetails.broadcasterFeeERC20Recipient,
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    undefined,
    () => console.log(`Proof generation in progress...`),
  );

  const response = await populateProvedCrossContractCalls(
    txIDVersion,
    networkName,
    railgunWalletID,
    unshieldERC20s || [],
    unshieldNFTs,
    shieldERC20s || [],
    shieldNFTs || [],
    crossContractCalls,
    finalGasDetails.broadcasterFeeERC20Recipient,
    sendWithPublicWallet,
    gasDetailsResult.overallBatchMinGasPrice,
    finalGasDetails.estimatedGasDetails,
  );
  return response.transaction;
}
