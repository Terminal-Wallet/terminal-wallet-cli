/**
 * Pure overspend-aware balance model — the single primitive behind amount
 * validation, fee validation, and "max / send all". No blessed/SDK side-effects:
 * it takes balances + the leg state + an already-computed fee reservation as
 * inputs and answers "how much of this token is still spendable here?".
 *
 * Key rules (mirrored from the rest of the builder):
 *  - "alloted" = what the OTHER legs already commit for the same token, so the
 *    leg being edited validates against its siblings, not itself.
 *  - Only a BROADCASTER fee reduces a (private) token balance, and only when the
 *    fee token IS this token. Self-sign / external-signer pay public gas
 *    separately, so they reserve nothing from the private set.
 *  - Tokens are matched by exact tokenAddress (case-insensitive). The native
 *    entry uses the "native" sentinel (see native-token.ts) and is its own pool;
 *    native ETH and WETH do NOT share supply.
 */
import { formatUnits, parseUnits } from "ethers";
import { FeeMode } from "./spec";
import { RailgunDisplayBalance } from "../models/balance-models";
import { LegsState } from "./caps";

/** A fee that draws from a shielded token balance (broadcaster fee only). */
export interface FeeReservation {
  tokenAddress: string;
  amount: bigint;
  /**
   * What the wallet holds of the FEE token.
   *
   * Supplied so the fee can be checked against its own balance. Without it the
   * fee is only ever weighed against tokens that appear in the legs, so a fee
   * in a token you hold little or none of passes every check here and fails at
   * proof time — after the password, after the wait. Optional because a caller
   * that has not loaded balances can still express a reservation; it just
   * cannot have that check.
   */
  token?: RailgunDisplayBalance;
}

const sameToken = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Parse a (possibly blank/invalid) decimal amount to base units; 0n otherwise. */
export const parseAmount = (
  amount: string | undefined,
  decimals: number,
): bigint => {
  if (!amount?.trim()) return 0n;
  try {
    const v = parseUnits(amount.trim(), decimals);
    return v > 0n ? v : 0n;
  } catch {
    return 0n;
  }
};

/**
 * Base-units already committed to `tokenAddress` across all legs, EXCLUDING the
 * leg currently being edited (so a leg validates against its siblings).
 */
export const allotted = (
  legs: LegsState,
  tokenAddress: string,
  editingLegId?: string,
): bigint => {
  let sum = 0n;
  for (const l of legs.legs) {
    if (editingLegId && l.id === editingLegId) continue;
    if (!l.token || !sameToken(l.token.tokenAddress, tokenAddress)) continue;
    sum += parseAmount(l.amount, l.token.decimals);
  }
  return sum;
};

/**
 * Base-units of `tokenAddress` reserved to pay the fee. Only a broadcaster fee in
 * THIS token reduces the balance; self-sign / external-signer reserve 0.
 */
export const feeReserved = (
  fee: FeeReservation | undefined,
  tokenAddress: string,
): bigint => (fee && sameToken(fee.tokenAddress, tokenAddress) ? fee.amount : 0n);

/**
 * Turn a FeeMode + an already-computed broadcaster fee amount into a reservation.
 * Only broadcaster mode reserves from the private set; the amount is computed by
 * the caller (SDK, async) and passed in to keep this module SDK-free.
 */
export const feeReservationFor = (
  fee: FeeMode | undefined,
  broadcasterFeeAmount: bigint | undefined,
): FeeReservation | undefined =>
  fee?.kind === "broadcaster" && broadcasterFeeAmount && broadcasterFeeAmount > 0n
    ? { tokenAddress: fee.broadcaster.tokenAddress, amount: broadcasterFeeAmount }
    : undefined;

/**
 * The gas a self-signed transaction spends from the very balance it is moving.
 *
 * A base-token send or shield pays gas in the same asset it moves, so the wallet
 * needs value + gas. Committing the whole balance leaves nothing for the second
 * term and the node rejects the send — after the user has already approved it.
 * Modelled as a reservation so the amount hint, "max", and the send-time
 * overspend check all account for it through the same path a broadcaster fee
 * takes.
 *
 * Returns undefined when the price is unknown, so an unavailable fee oracle
 * leaves the amount unrestricted rather than reserving zero and implying the
 * question was asked.
 */
export const gasReservationFor = (
  tokenAddress: string | undefined,
  gasUnits: bigint,
  pricePerGas: bigint | undefined,
): FeeReservation | undefined =>
  tokenAddress !== undefined && pricePerGas !== undefined && pricePerGas > 0n && gasUnits > 0n
    ? { tokenAddress, amount: gasUnits * pricePerGas }
    : undefined;

export interface ExpectedBalanceOpts {
  editingLegId?: string;
  fee?: FeeReservation;
}

/**
 * Headroom available to the leg being edited: wallet balance minus what the OTHER
 * legs already commit for this token minus any same-token broadcaster fee. May be
 * negative if siblings + fee already exceed the balance.
 */
export const expectedBalance = (
  token: RailgunDisplayBalance,
  legs: LegsState,
  opts?: ExpectedBalanceOpts,
): bigint =>
  token.amount -
  allotted(legs, token.tokenAddress, opts?.editingLegId) -
  feeReserved(opts?.fee, token.tokenAddress);

/** Whether `enteredAmount` (base units) exceeds the expected balance. */
export const wouldOverspend = (
  expected: bigint,
  enteredAmount: bigint,
): boolean => enteredAmount > expected;

export interface OverspendCheck {
  expected: bigint; // headroom (may be negative)
  entered: bigint; // parsed entered amount (0n when blank/invalid)
  overspendBy?: bigint; // entered - expected, when positive
  ok: boolean; // !overspend (blank amount against non-negative headroom is ok)
}

/**
 * Evaluate a candidate amount string against the expected balance. Required-ness
 * (blank vs set) is handled by the builder's own validate(); this answers only the
 * overspend question.
 */
export const checkAmount = (
  token: RailgunDisplayBalance,
  amount: string | undefined,
  legs: LegsState,
  opts?: ExpectedBalanceOpts,
): OverspendCheck => {
  const expected = expectedBalance(token, legs, opts);
  const entered = parseAmount(amount, token.decimals);
  const over = entered - expected;
  return {
    expected,
    entered,
    overspendBy: over > 0n ? over : undefined,
    ok: over <= 0n,
  };
};

/** The max spendable amount for the editing leg as a decimal string ("send all"). */
export const maxAmount = (
  token: RailgunDisplayBalance,
  legs: LegsState,
  opts?: ExpectedBalanceOpts,
): string => {
  const expected = expectedBalance(token, legs, opts);
  return formatUnits(expected > 0n ? expected : 0n, token.decimals);
};

export interface TokenOverspend {
  token: RailgunDisplayBalance;
  overBy: bigint; // base units the total commitment exceeds the balance by
  /** Base units of this token reserved for the fee (0 when the fee is elsewhere). */
  feeShare: bigint;
  /**
   * The amounts alone fit; the fee is what took it over.
   *
   * The two are not the same problem and do not have the same answer — one is
   * "send less", the other is "send less OR pay the fee in something else" —
   * so the distinction is carried rather than left for the reader to work out
   * from two numbers.
   */
  causedByFee: boolean;
}

/**
 * Distinct tokens whose TOTAL committed amount across all legs (+ a same-token
 * broadcaster fee) exceeds the wallet balance. This is the aggregate send-block
 * check (no editing-leg exclusion — every leg counts). A token overspends exactly
 * when its expectedBalance (with all legs counted) is negative.
 *
 * Note: a fee paid in a token that is NOT one of the leg tokens is not checked
 * here (its balance isn't in the leg set) — that case stays advisory.
 */
export const overspentTokens = (
  legs: LegsState,
  fee?: FeeReservation,
): TokenOverspend[] => {
  const seen = new Map<string, RailgunDisplayBalance>();
  for (const l of legs.legs) {
    if (l.token) seen.set(l.token.tokenAddress.toLowerCase(), l.token);
  }
  // The FEE's token, even when no leg carries it. A fee is a commitment
  // against a balance exactly as an amount is; checking only the tokens being
  // SENT is how a fee larger than the balance it draws from reaches the proof.
  if (fee?.token) {
    const key = fee.token.tokenAddress.toLowerCase();
    if (!seen.has(key)) seen.set(key, fee.token);
  }
  const out: TokenOverspend[] = [];
  for (const token of seen.values()) {
    const expected = expectedBalance(token, legs, { fee });
    if (expected >= 0n) continue;
    const feeShare = feeReserved(fee, token.tokenAddress);
    // Would the amounts alone have fit? If so the fee is the cause, and the
    // answer is a different one.
    const withoutFee = expectedBalance(token, legs, { fee: undefined });
    out.push({
      token,
      overBy: -expected,
      feeShare,
      causedByFee: feeShare > 0n && withoutFee >= 0n,
    });
  }
  return out;
};

/** Display helper: "expected 4.20 USDC" / "expected 4.20 USDC · over by 0.10". */
export const formatExpected = (
  check: OverspendCheck,
  token: RailgunDisplayBalance,
): string => {
  const exp = formatUnits(check.expected > 0n ? check.expected : 0n, token.decimals);
  const base = `expected ${exp} ${token.symbol}`;
  return check.overspendBy
    ? `${base} · over by ${formatUnits(check.overspendBy, token.decimals)} ${token.symbol}`
    : base;
};
