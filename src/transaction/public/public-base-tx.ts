import {
  NetworkName,
  RailgunERC20AmountRecipient,
} from "@railgun-community/shared-models";
import { ContractTransaction } from "ethers";

import { getCurrentWalletPublicAddress } from "../../wallet/wallet-util";
import {
  PublicTransactionDetails,
  calculatePublicTransactionGasDetais,
} from "./public-tx";

export const populatePublicBaseTokenTransaction = async (
  erc20AmountRecipient: RailgunERC20AmountRecipient,
) => {
  const { recipientAddress, amount } = erc20AmountRecipient;

  const transaction: ContractTransaction = {
    to: recipientAddress,
    value: amount,
    data: "",
  };
  return transaction;
};

export const populateAndCalculateGasForBaseTokenTransaction = async (
  chainName: NetworkName,
  erc20AmountRecipient: RailgunERC20AmountRecipient,
): Promise<PublicTransactionDetails> => {
  const transaction = await populatePublicBaseTokenTransaction(
    erc20AmountRecipient,
  );
  const fromAddress = getCurrentWalletPublicAddress();
  transaction.from = fromAddress;

  const { privateGasEstimate, populatedTransaction } =
    await calculatePublicTransactionGasDetais(chainName, transaction);

  return { privateGasEstimate, populatedTransaction };
};
