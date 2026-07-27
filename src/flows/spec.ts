/**
 * Transaction specs — the data describing WHAT a transaction does.
 *
 * A spec is produced by input collection and consumed by the deps adapters.
 * Pure: no SDK calls, no renderer, no IO. That is what makes the whole pipeline
 * testable without a chain or a terminal attached.
 *
 * FeeMode answers "who pays the gas" — it is a FUNDING choice, deliberately
 * kept separate from how a transaction executes. The two axes cross (a
 * base-token unshield can be broadcast or self-signed), so folding them
 * together would multiply out into variants instead of composing.
 */
import {
  isDefined,
  NetworkName,
  RailgunERC20AmountRecipient,
  SelectedBroadcaster,
} from "@railgun-community/shared-models";
import { ContractTransaction, parseUnits } from "ethers";
import { RailgunSelectedAmount } from "../models/balance-models";
import { RailgunTransaction } from "../models/transaction-models";
import { Zer0XSwap } from "../models/0x-models";
import { WalletCache } from "../models/wallet-models";

/** How the transaction fee is paid. */
export type FeeMode =
  | { kind: "broadcaster"; broadcaster: SelectedBroadcaster }
  | { kind: "self-signer"; signer: WalletCache } // your public wallet pays gas
  | { kind: "external-signer"; label: string }; // an imported external key pays gas

/** A private transfer specification. */
export interface TransferSpec {
  type: RailgunTransaction.Transfer;
  chainName: NetworkName;
  recipients: RailgunERC20AmountRecipient[];
  encryptionKey: string;
  memo?: string;
  fee: FeeMode;
}

/** Unshield ERC20s to a public address. */
export interface UnshieldSpec {
  type: RailgunTransaction.Unshield;
  chainName: NetworkName;
  recipients: RailgunERC20AmountRecipient[];
  encryptionKey: string;
  fee: FeeMode;
}

/** Unshield the wrapped base token (uses Relay-Adapt). */
export interface UnshieldBaseSpec {
  type: RailgunTransaction.UnshieldBase;
  chainName: NetworkName;
  recipient: RailgunERC20AmountRecipient;
  encryptionKey: string;
  fee: FeeMode;
}

/** Public ERC20 transfer (plain ethers tx from the current wallet — no proof). */
export interface PublicTransferSpec {
  type: RailgunTransaction.PublicTransfer;
  chainName: NetworkName;
  recipient: RailgunERC20AmountRecipient;
}

/** Public base-token transfer (no proof). */
export interface PublicBaseSpec {
  type: RailgunTransaction.PublicBaseTransfer;
  chainName: NetworkName;
  recipient: RailgunERC20AmountRecipient;
}

/** Shield ERC20s (public→private). Signed from the public wallet; needs approvals first. */
export interface ShieldSpec {
  type: RailgunTransaction.Shield;
  chainName: NetworkName;
  recipients: RailgunERC20AmountRecipient[];
}

/** Shield the base token (wrap + shield). */
export interface ShieldBaseSpec {
  type: RailgunTransaction.ShieldBase;
  chainName: NetworkName;
  recipient: RailgunERC20AmountRecipient;
  /**
   * Required even though shielding is self-signed and needs no proof: wrapping
   * and shielding the base token runs through Relay-Adapt as an EIP-7702
   * bundle, and the ephemeral account that executes it is derived from this
   * key. The deps adapter resolves the ephemeral from it at estimate time — the
   * address itself is deliberately not part of the spec, since it is derived,
   * secret-adjacent, and must be the same one at estimate and at proof.
   */
  encryptionKey: string;
}

/** Private 0x swap (cross-contract via Relay-Adapt). `inputs` is the 0x quote. */
export interface PrivateSwapSpec {
  type: RailgunTransaction.Private0XSwap;
  chainName: NetworkName;
  inputs: Zer0XSwap;
  encryptionKey: string;
  fee: FeeMode;
}

/**
 * Public 0x swap — a plain ethers swap (no proof), signed from the public wallet
 * after the sell-token approval pre-step. `swapTransaction` is the 0x call.
 */
export interface PublicSwapSpec {
  type: RailgunTransaction.Public0XSwap;
  chainName: NetworkName;
  swapTransaction: ContractTransaction;
}

/**
 * Consolidate selected amounts into recipients, summing amounts that share the
 * same token + recipient. (Moved verbatim from transaction-builder.)
 */
export const getERC20AmountRecipients = (
  amountSelections: RailgunSelectedAmount[],
): RailgunERC20AmountRecipient[] => {
  const amountRecipients = amountSelections.map((info) => {
    const { tokenAddress, selectedAmount: amount, recipientAddress } = info;
    return { tokenAddress, amount, recipientAddress };
  });

  const consolidatedAmounts: RailgunERC20AmountRecipient[] = [];
  const recipientMap: MapType<MapType<RailgunERC20AmountRecipient>> = {};

  amountRecipients.forEach((info) => {
    const { tokenAddress, recipientAddress } = info;
    if (!isDefined(recipientMap[tokenAddress])) {
      recipientMap[tokenAddress] = {};
    }
    if (!isDefined(recipientMap[tokenAddress][recipientAddress])) {
      recipientMap[tokenAddress][recipientAddress] = info;
    } else {
      recipientMap[tokenAddress][recipientAddress].amount += info.amount;
    }
  });

  for (const tokenAddress in recipientMap) {
    for (const recipientAddress in recipientMap[tokenAddress]) {
      consolidatedAmounts.push(recipientMap[tokenAddress][recipientAddress]);
    }
  }

  return consolidatedAmounts;
};

/**
 * Relay-Adapt is required for base-token unshields and for every flow that
 * runs a cookbook recipe against a contract — the 0x swap and the Morpho vault
 * round trips.
 */
export const useRelayAdapt = (type: RailgunTransaction): boolean =>
  type === RailgunTransaction.UnshieldBase ||
  type === RailgunTransaction.Private0XSwap ||
  type === RailgunTransaction.MorphoVaultDeposit ||
  type === RailgunTransaction.MorphoVaultRedeem ||
  type === RailgunTransaction.FxMintOpen ||
  type === RailgunTransaction.FxMintClose ||
  type === RailgunTransaction.FxMintTopup ||
  type === RailgunTransaction.FxMintTopupBorrow ||
  type === RailgunTransaction.FxMintBorrowMore ||
  type === RailgunTransaction.FxMintRepay;

/**
 * HOW a transaction executes — the second axis, orthogonal to FeeMode.
 *
 * FeeMode answers "who pays the gas". This answers "what account executes it".
 * They cross rather than nest: a base-token unshield is a 7702 bundle that can
 * be broadcast OR self-signed, while a base-token shield is a 7702 bundle that
 * is ALWAYS self-signed. Folding the two together would produce
 * broadcaster-7702 / self-7702 variants and multiply out — which is exactly
 * what made the old builder's switches duplicate.
 *
 * Master's own transaction layer already separates them: the private-tx gas
 * helper takes `broadcasterSelection` and `is7702Transaction` as independent
 * parameters, and pins Type4 "regardless of broadcaster routing".
 */
export type ExecutionMode = { kind: "direct" } | { kind: "ephemeral-7702" };

/**
 * Derived from the transaction type, never chosen at a call site — whether a
 * flow needs an ephemeral account is a property of the flow, not a preference.
 *
 * Note ShieldBase: wrapping and shielding the base token runs through
 * Relay-Adapt as a type-4 bundle and derives an ephemeral account, but it is
 * signed from the public wallet rather than relayed. So it is 7702 WITHOUT
 * being a `useRelayAdapt` flow, which is precisely why one predicate cannot
 * serve both questions.
 */
export const executionMode = (type: RailgunTransaction): ExecutionMode =>
  type === RailgunTransaction.UnshieldBase ||
  type === RailgunTransaction.Private0XSwap ||
  type === RailgunTransaction.MorphoVaultDeposit ||
  type === RailgunTransaction.MorphoVaultRedeem ||
  type === RailgunTransaction.FxMintOpen ||
  type === RailgunTransaction.FxMintClose ||
  type === RailgunTransaction.FxMintTopup ||
  type === RailgunTransaction.FxMintTopupBorrow ||
  type === RailgunTransaction.FxMintBorrowMore ||
  type === RailgunTransaction.FxMintRepay ||
  type === RailgunTransaction.ShieldBase
    ? { kind: "ephemeral-7702" }
    : { kind: "direct" };

export const isEphemeral7702 = (type: RailgunTransaction): boolean =>
  executionMode(type).kind === "ephemeral-7702";

/**
 * Build one recipient from a token, a typed amount string, and an address.
 * Returns undefined for anything unusable — an unparseable amount, zero or
 * negative, or a blank address — so callers get a single validity check rather
 * than having to pre-validate each field.
 */
export const buildRecipient = (
  token: { tokenAddress: string; decimals: number },
  amountStr: string,
  recipientAddress: string,
): RailgunERC20AmountRecipient | undefined => {
  if (!recipientAddress.trim()) {
    return undefined;
  }
  let amount: bigint;
  try {
    amount = parseUnits(amountStr, token.decimals);
  } catch {
    return undefined;
  }
  if (amount <= 0n) {
    return undefined;
  }
  return {
    tokenAddress: token.tokenAddress,
    amount,
    recipientAddress: recipientAddress.trim(),
  };
};
