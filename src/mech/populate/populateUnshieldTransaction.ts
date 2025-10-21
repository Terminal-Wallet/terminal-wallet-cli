import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  NetworkName,
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
import { TransactionRequest } from "ethers";

export async function populateUnshieldTransaction({
  nftOut,
  erc20Out,
  transactions,
  nftIn,
  erc20In,
}: {
  nftOut: RailgunNFTAmount[];
  erc20Out: RailgunERC20Amount[];
  transactions: any;
  nftIn: RailgunNFTAmountRecipient[];
  erc20In: RailgunERC20AmountRecipient[];
}): Promise<TransactionRequest> {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const gasDetailsResult = await getTransactionGasDetails(NetworkName.Polygon);
  if (!gasDetailsResult) throw new Error("lol...");

  const _password = await getSaltedPassword();
  if (!_password) throw new Error("lol....");

  const response = await gasEstimateForUnprovenCrossContractCalls(
    txIDVersion,
    NetworkName.Polygon,
    railgunWalletID,
    _password,
    erc20Out,
    nftOut,
    erc20In,
    nftIn,
    transactions,
    gasDetailsResult.originalGasDetails,
    gasDetailsResult.feeTokenDetails,
    true,
    undefined,
  );

  const pos = await getOutputGasEstimate(
    gasDetailsResult.originalGasDetails,
    response.gasEstimate,
    gasDetailsResult.feeTokenInfo,
    gasDetailsResult.feeTokenDetails,
    undefined,
    gasDetailsResult.overallBatchMinGasPrice,
  );

  await generateCrossContractCallsProof(
    txIDVersion,
    NetworkName.Polygon,
    railgunWalletID,
    _password,
    erc20Out,
    nftOut,
    erc20In,
    nftIn,
    transactions,
    pos.broadcasterFeeERC20Recipient,
    true,
    gasDetailsResult.overallBatchMinGasPrice,
    undefined,
    () => {},
  );

  const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
    await populateProvedCrossContractCalls(
      txIDVersion,
      NetworkName.Polygon,
      railgunWalletID,
      erc20Out,
      nftOut,
      erc20In,
      nftIn,
      transactions,
      pos.broadcasterFeeERC20Recipient,
      true,
      gasDetailsResult.overallBatchMinGasPrice,
      pos.estimatedGasDetails,
    );

  // const selfSignerInfo = getWalletInfoForName(getCurrentWalletName());

  // lol I think we dont need this shit to broadcast but whatever
  const lolProvedTransaction = {
    transaction,
    nullifiers,
    preTransactionPOIsPerTxidLeafPerList,
  };

  return transaction;
}
