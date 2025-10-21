import { formatUnits, TransactionRequest } from "ethers";

import {
  NetworkName,
  RailgunERC20AmountRecipient,
  RailgunNFTAmountRecipient,
  TransactionGasDetails,
  TXIDVersion,
} from "@railgun-community/shared-models";
import {
  gasEstimateForShield,
  populateShield,
} from "@railgun-community/wallet";

import { getCurrentShieldPrivateKey } from "../../wallet/public-utils";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getWrappedTokenInfoForChain } from "../../network/network-util";
import {
  calculateEstimatedGasCost,
  getPublicGasDetails,
} from "../../gas/gas-util";
import { getCurrentNetwork } from "../../engine/engine";

export async function populateShieldTransaction({
  nftIn,
  erc20In,
}: {
  nftIn: RailgunNFTAmountRecipient[];
  erc20In: RailgunERC20AmountRecipient[];
}): Promise<TransactionRequest> {
  const chainName = getCurrentNetwork();

  const { shieldPrivateKey, fromWalletAddress } =
    await getCurrentShieldPrivateKey();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const { estimatedGasDetails } = await gasEstimationStupidModeOn(
    chainName,
    erc20In,
    nftIn,
  );

  const { transaction } = await populateShield(
    txIDVersion,
    chainName,
    shieldPrivateKey,
    erc20In,
    nftIn,
    estimatedGasDetails,
  );

  // Public wallet to shield from.
  transaction.from = fromWalletAddress;
  return transaction;
}

async function gasEstimationStupidModeOn(
  chainName: NetworkName,
  erc20: RailgunERC20AmountRecipient[],
  nft: RailgunNFTAmountRecipient[],
): Promise<PrivateGasEstimate> {
  const { shieldPrivateKey, fromWalletAddress } =
    await getCurrentShieldPrivateKey();
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const { gasEstimate } = await gasEstimateForShield(
    txIDVersion,
    chainName,
    shieldPrivateKey,
    erc20,
    nft,
    fromWalletAddress,
  );

  const gasDetails = (await getPublicGasDetails(
    chainName,
    gasEstimate,
    true,
  )) as TransactionGasDetails;
  const _estimatedCost = calculateEstimatedGasCost(gasDetails);

  const formattedCost = parseFloat(
    formatUnits(_estimatedCost, wrappedInfo.decimals),
  );

  return {
    symbol: wrappedInfo.symbol,
    overallBatchMinGasPrice: 0n,
    estimatedGasDetails: gasDetails,
    estimatedCost: formattedCost,
    broadcasterFeeERC20Recipient: undefined,
  };
}
