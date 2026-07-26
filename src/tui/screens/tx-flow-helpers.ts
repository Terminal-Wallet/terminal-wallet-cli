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
import { populatePublicERC20ApprovalTransactions } from "../../railgun/transaction/approval-erc20";
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
/**
 * Refuse a send whose real broadcaster fee will not fit.
 *
 * The builder reserves an approximate fee while composing, computed against a
 * nominal gas figure. The estimate returns the measured one, which for a
 * relay-adapt swap is several times larger — so a build that looked affordable
 * can fail at the SDK with "private balance too low to pay broadcaster fee".
 * That is recoverable but only after the user has waited for a proof, and the
 * message does not say by how much.
 *
 * The real fee is known here, before proving. Returns the shortfall, or
 * undefined when it fits.
 */
export const feeShortfall = async (
  legs: LegsState,
  gas: PrivateGasEstimate,
  chainName: NetworkName,
  /** Injection point so the check is testable without an engine. */
  loadBalances: (
    chain: NetworkName,
  ) =>
    | RailgunDisplayBalance[]
    | Promise<RailgunDisplayBalance[]> = getPrivateERC20BalancesForChain,
): Promise<TokenOverspend | undefined> => {
  const recipient = gas.broadcasterFeeERC20Recipient;
  if (!recipient) return undefined; // self-signed: gas is paid publicly
  const fee = {
    tokenAddress: recipient.tokenAddress,
    amount: BigInt(recipient.amount),
  };
  const [over] = overspentTokens(legs, fee);
  if (over) return over;

  // overspentTokens only evaluates tokens that appear in the legs, because the
  // legs are where it gets balances from. A fee paid in a token this send is
  // not moving is therefore invisible to it — which is exactly the case where
  // the fee has a whole balance to itself and is easiest to get wrong.
  const inLegs = legs.legs.some(
    (l) =>
      l.token?.tokenAddress.toLowerCase() === fee.tokenAddress.toLowerCase(),
  );
  if (inLegs) return undefined;

  // Fails open: a balance read that cannot answer must not block a send the
  // SDK would have accepted. This gate exists to give a better message than
  // the SDK's, not to become a second way for a send to die.
  try {
    const token = (await loadBalances(chainName)).find(
      (b) => b.tokenAddress.toLowerCase() === fee.tokenAddress.toLowerCase(),
    );
    if (!token) return undefined;
    return overspentTokens({ legs: [{ id: "__fee", token }], seq: 1 }, fee)[0];
  } catch {
    return undefined;
  }
};

export const applyGasDetailsConfirm =
  (choice: GasChoice, legs?: LegsState) =>
  async (
    spec: { chainName: NetworkName },
    gas: PrivateGasEstimate,
  ): Promise<boolean> => {
    // The measured fee, checked before a proof is generated. Refusing here
    // costs nothing; the same refusal from the SDK costs a proof and says
    // nothing about how much to reduce by.
    if (legs) {
      const over = await feeShortfall(legs, gas, spec.chainName);
      if (over) {
        getInputProvider().notify(
          `Broadcaster fee leaves ${over.token.symbol} short by ` +
            `${formatUnits(over.overBy, over.token.decimals)} — reduce the amount or ` +
            `pick a different fee token.`,
        );
        return false;
      }
    }
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
