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

/*
 * Goes directly to RailgunSW
 */
export async function populateShieldTransaction({
  shieldNFTs = [],
  shieldERC20s = [],
}: {
  shieldNFTs?: RailgunNFTAmountRecipient[];
  shieldERC20s?: RailgunERC20AmountRecipient[];
}): Promise<TransactionRequest> {
  const chainName = getCurrentNetwork();

  const { shieldPrivateKey, fromWalletAddress } =
    await getCurrentShieldPrivateKey();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const { estimatedGasDetails } = await _gasEstimate(
    chainName,
    shieldERC20s,
    shieldNFTs,
  );

  const { transaction } = await populateShield(
    txIDVersion,
    chainName,
    shieldPrivateKey,
    shieldERC20s,
    shieldNFTs,
    estimatedGasDetails,
  );

  transaction.from = fromWalletAddress;
  return transaction;
}

async function _gasEstimate(
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
