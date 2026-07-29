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
import { LegsState } from "../../flows/caps";
import { overspentTokens, TokenOverspend } from "../../flows/balance";
import {
  getCurrentWalletName,
  getCurrentWalletPublicAddress,
  getWalletInfoForName,
} from "../../railgun/wallet/wallet-util";
import { getCurrentEthersWallet } from "../../railgun/wallet/public-utils";
import {
  getPrivateERC20BalancesForChain,
  getWrappedTokenBalance,
} from "../../railgun/balance/balance-util";
import { getInputProvider } from "../../core/input";
import { toFeeMode } from "../../flows/transfer-flow";
import { FeeMode, getERC20AmountRecipients } from "../../flows/spec";
import {
  MAX_UINT_ALLOWANCE,
  populatePublicERC20ApprovalTransactions,
  updateApprovalCache,
} from "../../railgun/transaction/approval-erc20";
import { emitCoreEvent } from "../../core/events";
import { calculatePublicTransactionGasDetais } from "../../railgun/transaction/public/public-tx";
import { runApprovals } from "../../flows/approval-flow";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { RailgunDisplayBalance } from "../../models/balance-models";

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
/** How long to wait for an approval before giving up on it. */
const APPROVAL_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

const runErc20ApprovalFlow = async (
  chainName: NetworkName,
  tokens: RailgunERC20AmountRecipient[],
  spender: string | undefined,
  owner: string,
): Promise<boolean> => {
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
      // The spend's gas estimate runs immediately after this and reads the
      // allowance from chain state. While the approval is still in the mempool
      // there is no allowance, so the transfer it authorises has nothing to
      // take and the estimate reverts — as "SafeERC20: low-level call failed",
      // which names neither the approval nor the reason.
      emitCoreEvent({
        type: "status:message",
        text: "Waiting for the approval to confirm…",
      });
      const receipt = await result.wait(1, APPROVAL_CONFIRM_TIMEOUT_MS);
      if (!receipt || receipt.status !== 1) {
        throw new Error("the approval transaction reverted");
      }
      // The cache decides whether to ask again. Without this the allowance now
      // on chain is invisible for the rest of the session.
      if (tx.to && spender) {
        updateApprovalCache(String(tx.to), owner, spender, MAX_UINT_ALLOWANCE);
      }
      return { hash: result.hash };
    },
  });
  return result.ok;
};

export const runErc20Approvals = async (
  chainName: NetworkName,
  tokens: RailgunERC20AmountRecipient[],
  spender: string | undefined,
): Promise<boolean> => {
  const owner = getCurrentWalletPublicAddress();
  try {
    return await runErc20ApprovalFlow(chainName, tokens, spender, owner);
  } catch (err) {
    // An approval that never confirmed is a failed approval, not a crashed
    // send: report it here rather than letting it surface as an estimate that
    // reverts for reasons the message does not mention.
    getInputProvider().notify(
      `Approval did not complete — ${(err as Error).message}. Nothing was spent.`,
    );
    return false;
  }
};

/**
 * The confirm gate lives in flows/confirm.ts — refusing a send whose measured
 * fee will not fit, and folding a chosen gas tier into the estimate, are
 * properties of the transaction rather than of the screen. Re-exported so the
 * builder's call sites are unchanged.
 */
export {
  feeShortfall,
  applyGasDetailsConfirm,
  applyGasPublicConfirm,
} from "../../flows/confirm";
export type { GateRefusal, ConfirmOptions } from "../../flows/confirm";

/** Public (ethers) gate: applies the choice to the populated tx that gets signed. */
