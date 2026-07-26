/**
 * Shared steps the transaction builder runs around a send: ERC20 approvals, and
 * folding a chosen gas tier into the estimate before the review is shown.
 *
 * Trimmed to what the builder uses — the rest of the original module served the
 * retired prompt flows and depended on selectors that went with them.
 */
import {
  NETWORK_CONFIG,
  NetworkName,
  RailgunERC20AmountRecipient,
} from "@railgun-community/shared-models";
import { ContractTransaction, formatUnits } from "ethers";
import { collectGasSelection, GasChoice } from "../../flows/collect/gas";
import {
  applyOverrideToDetails,
  applyOverrideToTx,
  evmGasTypeForChain,
  priceField,
  GasOverride,
} from "../../railgun/gas/gas-selection";
import { PublicTransactionDetails } from "../../railgun/transaction/public/public-tx";
import {
  getCurrentWalletName,
  getCurrentWalletPublicAddress,
  getWalletInfoForName,
} from "../../railgun/wallet/wallet-util";
import { getCurrentEthersWallet } from "../../railgun/wallet/public-utils";
import { getWrappedTokenBalance } from "../../railgun/balance/balance-util";
import { getInputProvider } from "../../core/input";
import { toFeeMode } from "../../flows/transfer-flow";
import { FeeMode, getERC20AmountRecipients } from "../../flows/spec";
import { populatePublicERC20ApprovalTransactions } from "../../railgun/transaction/approval-erc20";
import { calculatePublicTransactionGasDetais } from "../../railgun/transaction/public/public-tx";
import { runApprovals } from "../../flows/approval-flow";
import { PrivateGasEstimate } from "../../models/transaction-models";

/**
 * Run the ERC20 approval pre-step for `spender` (Railgun proxy or 0x spender).
 * Confirms each approval via the input-provider, self-signs it. Returns whether
 * all required approvals completed. Shared by shield + public swap.
 */
const baseDecimals = (chainName: NetworkName): number =>
  NETWORK_CONFIG[chainName].baseToken.decimals;

const recomputeCost = (
  override: GasOverride,
  gasUnits: bigint,
  decimals: number,
): number => parseFloat(formatUnits(priceField(override) * gasUnits, decimals));

/** Select gas, apply to `gas.estimatedGasDetails`, recompute cost. Returns false to abort. */
const selectAndApplyDetails = async (
  chainName: NetworkName,
  gas: PrivateGasEstimate,
): Promise<boolean> => {
  const decimals = baseDecimals(chainName);
  const sel = await collectGasSelection(
    chainName,
    (gas.estimatedGasDetails as { evmGasType: number }).evmGasType,
    gas.estimatedGasDetails.gasEstimate,
    gas.symbol,
    decimals,
  );
  if (sel === undefined) return false;
  if (sel !== "keep") {
    gas.estimatedGasDetails = applyOverrideToDetails(gas.estimatedGasDetails, sel);
    gas.estimatedCost = recomputeCost(sel, gas.estimatedGasDetails.gasEstimate, decimals);
  }
  return true;
};
export const runErc20Approvals = async (
  chainName: NetworkName,
  tokens: RailgunERC20AmountRecipient[],
  spender: string | undefined,
): Promise<boolean> => {
  const owner = getCurrentWalletPublicAddress();
  const result = await runApprovals<ContractTransaction>({
    getNeeded: async () =>
      (
        await populatePublicERC20ApprovalTransactions(
          chainName,
          tokens,
          owner,
          spender,
        )
      ).map((a) => ({
        symbol: a.symbol,
        populatedTransaction: a.populatedTransaction,
      })),
    prepare: async (item) => {
      const { populatedTransaction, privateGasEstimate } =
        await calculatePublicTransactionGasDetais(
          chainName,
          item.populatedTransaction,
        );
      return {
        populatedTransaction,
        symbol: item.symbol,
        estimatedCost: `${privateGasEstimate.estimatedCost} ${privateGasEstimate.symbol}`,
      };
    },
    confirm: (message) => getInputProvider().confirm(message),
    send: async (tx) => {
      const result = await getCurrentEthersWallet().sendTransaction(tx);
      return { hash: result.hash };
    },
  });
  return result.ok;
};

/** Select an amount of the wrapped base token; returns the single recipient. */
export const applyGasDetailsConfirm =
  (choice: GasChoice) =>
  async (
    spec: { chainName: NetworkName },
    gas: PrivateGasEstimate,
  ): Promise<boolean> => {
    if (choice && choice !== "keep") {
      const decimals = baseDecimals(spec.chainName);
      gas.estimatedGasDetails = applyOverrideToDetails(gas.estimatedGasDetails, choice);
      gas.estimatedCost = recomputeCost(choice, gas.estimatedGasDetails.gasEstimate, decimals);
    }
    return true;
  };

/** Apply a pre-chosen gas override to the populated tx (public). */
export const applyGasPublicConfirm =
  (choice: GasChoice) =>
  async (
    spec: { chainName: NetworkName },
    prepared: PublicTransactionDetails,
  ): Promise<boolean> => {
    if (choice && choice !== "keep") {
      const decimals = baseDecimals(spec.chainName);
      const gasUnits = BigInt(prepared.populatedTransaction.gasLimit ?? 0n);
      prepared.populatedTransaction = applyOverrideToTx(
        prepared.populatedTransaction,
        choice,
      );
      prepared.privateGasEstimate.estimatedCost = recomputeCost(
        choice,
        gasUnits,
        decimals,
      );
    }
    return true;
  };

/** Public (ethers) gate: applies the choice to the populated tx that gets signed. */
