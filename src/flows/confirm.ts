/**
 * The gate between an estimate and a proof.
 *
 * `runTransaction` calls `confirm` after the gas estimate and before anything
 * is proved or broadcast, which makes it the last cheap place to refuse. Two
 * jobs happen here and they are easy to mistake for one: refusing a send whose
 * measured broadcaster fee will not fit, and folding a chosen gas tier into the
 * estimate so the review — and the fee the broadcaster is quoted — reflect it.
 *
 * In `flows/` because both are properties of the transaction, not of the
 * screen. A host that skipped this would pay for a proof the SDK then rejects,
 * and would quote a tier it never applied.
 *
 * ON REFUSAL REPORTING: `runTransaction` collapses every falsy `confirm` into
 * the single sentinel `{ ok: false, error: "cancelled" }`, so a caller cannot
 * tell a fee refusal from a user changing their mind. The deck does not care —
 * both mean "no transaction" and the reason was already shown in the status
 * line. A scripted caller does care, because those are different exit codes and
 * only one of them is worth retrying. Hence `onRefuse`: the gate says why
 * before it returns false, and the notification stays the deck's business.
 */
import { NETWORK_CONFIG, NetworkName } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { GasChoice } from "./collect/gas";
import {
  applyOverrideToDetails,
  applyOverrideToTx,
  priceField,
  GasOverride,
} from "../railgun/gas/gas-selection";
import type { PublicTransactionDetails } from "../railgun/transaction/public/public-tx";
import { LegsState } from "./caps";
import { overspentTokens, TokenOverspend } from "./balance";
import { getPrivateERC20BalancesForChain } from "../railgun/balance/balance-util";
import { getInputProvider } from "../core/input";
import { PrivateGasEstimate } from "../models/transaction-models";
import { RailgunDisplayBalance } from "../models/balance-models";

/** Why the gate said no. Reported before the sentinel swallows the distinction. */
export type GateRefusal = {
  kind: "fee-shortfall";
  overspend: TokenOverspend;
  message: string;
};

export interface ConfirmOptions {
  /** Told why, before `false` is returned. */
  onRefuse?: (refusal: GateRefusal) => void;
  /**
   * Whether to show the refusal through the input provider. On by default,
   * because the deck's only channel for it is the status line. A host that
   * reports through `onRefuse` turns it off rather than emitting twice.
   */
  notify?: boolean;
}

const baseDecimals = (chainName: NetworkName): number =>
  NETWORK_CONFIG[chainName].baseToken.decimals;

const recomputeCost = (
  override: GasOverride,
  gasUnits: bigint,
  decimals: number,
): number => parseFloat(formatUnits(priceField(override) * gasUnits, decimals));

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

/** The sentence a refusal is reported as, in one place so both hosts agree. */
export const shortfallMessage = (over: TokenOverspend): string =>
  `Broadcaster fee leaves ${over.token.symbol} short by ` +
  `${formatUnits(over.overBy, over.token.decimals)} — reduce the amount or ` +
  `pick a different fee token.`;

export const applyGasDetailsConfirm =
  (choice: GasChoice, legs?: LegsState, opts: ConfirmOptions = {}) =>
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
        const message = shortfallMessage(over);
        opts.onRefuse?.({ kind: "fee-shortfall", overspend: over, message });
        if (opts.notify !== false) {
          getInputProvider().notify(message);
        }
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
