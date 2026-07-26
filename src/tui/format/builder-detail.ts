/**
 * The clear-signing breakdown: everything known about a transaction before it
 * is sent.
 *
 * Rendered live on the builder and reused verbatim by the review modal, so what
 * the user approves is the same text they were reading while composing. This is
 * the last thing between a typo and a spend, which is why it is pure — it takes
 * an explicit view of the build rather than reading the builder's mutable state,
 * so every case can be asserted without mounting anything.
 *
 * Amounts, balance impact, the broadcaster fee, RAILGUN protocol fees per token
 * and a USD total. Anything unknown is omitted rather than guessed at.
 */
import { formatUnits, parseUnits } from "ethers";
import { RailgunDisplayBalance } from "../../models/balance-models";
import { tag, short } from "./tags";
import { fmtAmount } from "./deck";
import { protocolFee, feePct } from "../../flows/fee";
import { balanceUSD, formatUSD } from "../../price/portfolio";

/** Shield/unshield fee rates for a chain, in basis points out of 1e9. */
export interface FeeBasisPoints {
  shield: bigint;
  unshield: bigint;
}

/** One (token, amount, recipient) the transaction moves. */
export interface DetailLeg {
  token: RailgunDisplayBalance;
  amount: string;
  recipient?: string;
}

export interface BuilderView {
  /** "Send" | "Shield" | "Unshield" … — decides which protocol fee applies. */
  verb: string;
  flowId?: string;
  legs: DetailLeg[];
  /** Swaps only: the token being bought, once chosen. */
  buyToken?: RailgunDisplayBalance;
  /** Token prices by address, when known. */
  prices: Record<string, number>;
  feeBasisPoints?: FeeBasisPoints;
  /** Broadcaster fee preview, when a broadcaster is selected and quoted. */
  broadcasterFee?: { text: string; usd?: number };
}

const usdOf = (
  token: RailgunDisplayBalance,
  amountStr: string,
  prices: Record<string, number>,
): number | undefined => {
  try {
    return balanceUSD(
      { ...token, amount: parseUnits(amountStr, token.decimals) },
      prices,
    );
  } catch {
    // An amount mid-edit is regularly unparseable; showing no USD is correct.
    return undefined;
  }
};

/**
 * RAILGUN's own fee on each token moved.
 *
 * Shields and unshields are charged at different rates, and a private swap
 * incurs both — unshield on the sell side, shield on what comes back. The buy
 * amount is not known until the quote is executed, so that side shows the rate
 * rather than a figure that would be wrong.
 */
export const protocolFeeLines = (
  view: BuilderView,
): { lines: string[]; usd: number } => {
  const bp = view.feeBasisPoints;
  if (!bp) {
    return { lines: [], usd: 0 };
  }

  const lines: string[] = [];
  let usd = 0;

  const line = (
    label: string,
    token: RailgunDisplayBalance,
    amountStr: string,
    basisPoints: bigint,
  ) => {
    try {
      const fee = protocolFee(parseUnits(amountStr, token.decimals), basisPoints);
      const readable = formatUnits(fee, token.decimals);
      const inUsd = balanceUSD({ ...token, amount: fee }, view.prices);
      if (inUsd !== undefined) {
        usd += inUsd;
      }
      lines.push(
        `   ${tag(
          `${label}  ${fmtAmount(readable, 6)} ${token.symbol} (${feePct(basisPoints).toFixed(2)}%)`,
          "gray",
        )}`,
      );
    } catch {
      /* unparseable amount mid-edit */
    }
  };

  if (view.verb === "Shield") {
    for (const leg of view.legs) line("shield fee", leg.token, leg.amount, bp.shield);
  } else if (view.verb === "Unshield") {
    for (const leg of view.legs) line("unshield fee", leg.token, leg.amount, bp.unshield);
  } else if (view.flowId === "private-swap" && view.legs.length) {
    const [sell] = view.legs;
    line("unshield fee", sell.token, sell.amount, bp.unshield);
    if (view.buyToken) {
      lines.push(
        `   ${tag(
          `shield fee   ~${feePct(bp.shield).toFixed(2)}% of ${view.buyToken.symbol} out`,
          "gray",
        )}`,
      );
    }
  }

  return { lines, usd };
};

/**
 * What each leg moves, and what it costs you.
 *
 * The balance-impact line is the one that catches mistakes: "reduces ETH 2.5 by
 * 2.4 (96.0%)" reads very differently from "2.4 ETH" when the decimal point is
 * in the wrong place.
 */
export const amountLines = (
  view: BuilderView,
): { lines: string[]; usd: number; haveUsd: boolean } => {
  const lines: string[] = [];
  let usd = 0;
  let haveUsd = false;

  for (const { token, amount, recipient } of view.legs) {
    const inUsd = usdOf(token, amount, view.prices);
    if (inUsd !== undefined) {
      usd += inUsd;
      haveUsd = true;
    }
    lines.push(
      `${tag(amount, "white")} ${token.symbol}${
        inUsd !== undefined ? tag(`  (${formatUSD(inUsd)})`, "gray") : ""
      }`,
    );
    if (recipient !== undefined) {
      lines.push(`   ${tag(`→ ${recipient ? short(recipient) : "—"}`, "cyan")}`);
    }
    try {
      const held = Number(formatUnits(token.amount, token.decimals));
      const sending = Number(amount);
      if (held > 0 && sending > 0) {
        lines.push(
          `   ${tag(
            `reduces ${token.symbol} ${fmtAmount(formatUnits(token.amount, token.decimals), 5)} ` +
              `by ${amount} (${((sending / held) * 100).toFixed(1)}%)`,
            "gray",
          )}`,
        );
      }
    } catch {
      /* unparseable amount mid-edit */
    }
  }

  return { lines, usd, haveUsd };
};
