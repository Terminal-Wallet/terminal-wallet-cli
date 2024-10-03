import {
  NetworkName,
  RailgunERC20AmountRecipient,
  isDefined,
} from "@railgun-community/shared-models";
import { Contract, ContractTransaction } from "ethers";
import { ERC20_ABI } from "../abi";
import { getTokenInfo } from "../balance/token-util";
import { getProviderForChain } from "../network/network-util";

export const MAX_UINT_ALLOWANCE = 2n ** 256n - 1n;
// senderAddress<spenderAddress<tokenAddress<approvalAmount>>>
export type ApprovalMap = MapType<bigint>;
export type SpenderMap = MapType<ApprovalMap>;
export type TokenWalletMap = MapType<SpenderMap>;
export type PopulatedApproval = {
  symbol: string;
  populatedTransaction: ContractTransaction;
};
export const approvedTokenToWalletMap: TokenWalletMap = {};

const initializeApprovalCache = (
  senderAddress: string,
  spenderAddress: string,
) => {
  approvedTokenToWalletMap[senderAddress] ??= {};
  approvedTokenToWalletMap[senderAddress][spenderAddress] ??= {};
};

export const loadApprovedTokenMap = (tokenWalletMap: TokenWalletMap) => {
  for (const walletAddress in tokenWalletMap) {
    const approvalMap = tokenWalletMap[walletAddress];
    approvedTokenToWalletMap[walletAddress] = approvalMap;
  }
};

export const updateApprovalCache = (
  erc20Address: string,
  senderAddress: string,
  spenderAddress: string,
  amount: bigint,
) => {
  initializeApprovalCache(senderAddress, spenderAddress);
  approvedTokenToWalletMap[senderAddress][spenderAddress][erc20Address] =
    amount;
};

export const checkApprovalCache = (
  erc20Address: string,
  senderAddress: string,
  spenderAddress: string,
) => {
  initializeApprovalCache(senderAddress, spenderAddress);
  if (
    !isDefined(
      approvedTokenToWalletMap[senderAddress][spenderAddress][erc20Address],
    )
  ) {
    return undefined;
  }
  return approvedTokenToWalletMap[senderAddress][spenderAddress][erc20Address];
};

export const populatePublicERC20ApprovalTransactions = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  sender: string,
  spender: Optional<string>,
): Promise<PopulatedApproval[]> => {
  if (!isDefined(spender)) {
    return [];
  }

  const populatedTransactions: PopulatedApproval[] = [];
  const provider = getProviderForChain(chainName) as unknown as any;
  for (const amountRecipient of erc20AmountRecipients) {
    try {
      const contract = new Contract(
        amountRecipient.tokenAddress,
        ERC20_ABI,
        provider,
      );

      const { symbol } = await getTokenInfo(
        chainName,
        amountRecipient.tokenAddress,
      );

      // eslint-disable-next-line no-await-in-loop
      const currentAllowance: bigint =
        checkApprovalCache(amountRecipient.tokenAddress, sender, spender) ??
        (await contract.allowance(sender, spender));

      updateApprovalCache(
        amountRecipient.tokenAddress,
        sender,
        spender,
        currentAllowance,
      );

      if (currentAllowance >= amountRecipient.amount) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const populatedTransaction = await contract.approve.populateTransaction(
        spender,
        MAX_UINT_ALLOWANCE,
      );
      populatedTransaction.from = sender;
      const populatedApproval: PopulatedApproval = {
        symbol,
        populatedTransaction,
      };
      populatedTransactions.push(populatedApproval);
    } catch (err: any) {
      console.log(
        `Could not populate transaction for some token: ${err.message}`,
      );
    }
  }
  return populatedTransactions;
};
