/**
 * The consequence of a position, shown next to the controls that set it.
 *
 * Collateral and debt are the two things a user chooses; debt ratio, leverage,
 * and the prices that trigger a rebalance or a liquidation are the four things
 * they actually care about, and all four are derived. Showing only the inputs
 * means the user computes the outputs in their head, which is where positions
 * get opened at leverage nobody intended.
 */
import { FxRisk, FxRiskZone } from "../../railgun/transaction/fx/risk";
import { FxPositionState } from "../../railgun/transaction/fx/position-state";
import { tag } from "./tags";
import {
  debtTokenForFullClose,
  repayFromAvailable,
} from "../../railgun/transaction/fx/full-close";
import { asLeverage, asPercent, asUsdPrice, markedBar } from "./slider";

/** Safe is green, rebalancing is a warning, liquidation is not. */
export const zoneColour = (zone: FxRiskZone): string =>
  zone === "safe" ? "green" : zone === "rebalance" ? "yellow" : "red";

const ZONE_NOTE: Record<FxRiskZone, string> = {
  safe: "",
  rebalance: "the protocol would rebalance this position",
  liquidation: "this position would be liquidated",
};

export interface FxRiskView {
  risk: FxRisk;
  /** The collateral's own symbol — the trigger prices are quoted in it. */
  collateralSymbol: string;
  /** WAD thresholds, so the meter can mark where they fall. */
  rebalanceDebtRatio: bigint;
  liquidationDebtRatio: bigint;
  /** Cells available for the meter. */
  width?: number;
}

/**
 * The risk block: a meter with both thresholds marked on it, then the two
 * prices that matter.
 *
 * The meter runs 0..1 of debt ratio rather than 0..threshold, so the marks stay
 * where they are as the slider moves and the bar is read against a fixed scale.
 */
export const fxRiskLines = ({
  risk,
  collateralSymbol,
  rebalanceDebtRatio,
  liquidationDebtRatio,
  width = 24,
}: FxRiskView): string[] => {
  const wad = Number(10n ** 18n);
  const colour = zoneColour(risk.zone);
  // Both marks come from the renderer's narrow-glyph allowlist: anything whose
  // width the terminal gets to decide breaks the row it sits in.
  const meter = markedBar(risk.debtRatio, width, [
    { at: Number(rebalanceDebtRatio) / wad, glyph: "│" },
    { at: Number(liquidationDebtRatio) / wad, glyph: "✕" },
  ]);

  const lines = [
    `${tag("debt", "gray")}   ${tag(meter, colour)}  ` +
      `${tag(asPercent(risk.debtRatio, 1), colour)} ${tag("·", "gray")} ${asLeverage(risk.leverage)}`,
    `${tag("rebal", "gray")}  ${asUsdPrice(risk.rebalancePrice)} ${tag(collateralSymbol, "gray")}` +
      `    ${tag("liq", "gray")} ${asUsdPrice(risk.liquidationPrice)} ${tag(collateralSymbol, "gray")}`,
  ];

  const note = ZONE_NOTE[risk.zone];
  if (note) lines.push(tag(`▲ ${note}`, colour));
  return lines;
};

/**
 * The collateral row: how much of the balance is being put up, and what that
 * is worth.
 */
export const fxCollateralLine = (
  fraction: number,
  amount: string,
  symbol: string,
  usd: number | undefined,
  width = 16,
): string =>
  `${tag(markedBar(fraction, width, []), "cyan")} ${asPercent(fraction)}  ` +
  `${amount} ${tag(symbol, "gray")}` +
  (usd !== undefined && isFinite(usd) && usd > 0
    ? `  ${tag(`≈ $${usd.toFixed(2)}`, "gray")}`
    : "");

/**
 * A position in one line, for the picker.
 *
 * The picker used to list ids. Choosing between "#4241" and "#4242" is not a
 * choice anyone can make — the whole reason to open this screen is that one of
 * them needs attention, and the id does not say which. Collateral, debt and the
 * ratio do, and the zone word says it without arithmetic.
 */
export const fxPositionSummary = (
  state: FxPositionState | undefined,
  collateralSymbol: string,
  format: (amount: bigint, decimals: number) => string,
  /** Cells available. Segments that do not fit are dropped, lowest value first. */
  width?: number,
): string => {
  // Absent is not zero. A position whose state could not be read must not
  // render as an empty, healthy one — that is an invitation to borrow against
  // collateral that may not be there.
  if (!state) return "could not read this position";
  // Emptied. The pool never burns a position NFT — closing zeroes both legs
  // and the NFT stays held. Zero debt at zero collateral would otherwise
  // render as a perfectly healthy position at 0.0% — the most reassuring row on
  // the screen, for something with nothing in it.
  if (state.collateralAmount === 0n && state.debtAmount === 0n) {
    return "emptied — nothing left in it";
  }
  const wad = Number(10n ** 18n);
  const ratio = Number(state.debtRatio) / wad;
  const rebalance = Number(state.rebalanceDebtRatio) / wad;

  // The zone word carries the warning ON ITS OWN. It used to be "safe" with a
  // separate "▲ near rebalance" appended, and in a list narrow enough to clip
  // the tail that rendered as "82.2% safe ▲" — the word reassuring, the marker
  // meaningless without the phrase it belonged to, on a position eight points
  // off being rebalanced. A position is never both.
  const word =
    state.debtRatio >= state.liquidationDebtRatio
      ? "▲ liquidatable"
      : state.debtRatio >= state.rebalanceDebtRatio
        ? "▲ rebalancing"
        : ratio >= rebalance - 0.1
          ? "▲ near rebal"
          : "safe";

  // Most valuable first, and DROPPED rather than chopped when the space runs
  // out. A hard slice cuts mid-number — "0.015" for 0.0155 — which is worse
  // than saying less, because a truncated figure still reads as a figure.
  const segments = [
    `${asPercent(ratio, 1)} ${word}`,
    `${format(state.debtAmount, 18)} fxUSD`,
    `${format(state.collateralAmount, state.collateralDecimals)} ${collateralSymbol}`,
  ];
  if (width === undefined) return segments.join(" · ");

  const [risk, ...rest] = segments;
  let line = risk;
  for (const segment of rest) {
    const next = `${line} · ${segment}`;
    if (next.length > width) break;
    line = next;
  }
  return line;
};

/** Everything about a position, for a screen with room to say it. */
export const fxPositionDetailLines = (
  label: string,
  state: FxPositionState | undefined,
  collateralSymbol: string,
  format: (amount: bigint, decimals: number) => string,
): string[] => {
  if (!state) {
    return [
      tag(label, "magenta"),
      "",
      tag("This position could not be read.", "yellow"),
      tag("The pool reports a nonexistent position as a zero-debt one, so no", "gray"),
      tag("figures are shown rather than figures that would look healthy.", "gray"),
    ];
  }
  if (state.collateralAmount === 0n && state.debtAmount === 0n) {
    return [
      tag(label, "magenta"),
      "",
      tag("This position is empty.", "yellow"),
      tag("Its debt is repaid and its collateral withdrawn. The position itself", "gray"),
      tag("always survives a close — f(x) empties it rather than destroying it,", "gray"),
      tag("so this is the normal end state. Nothing is owed or at risk.", "gray"),
      "",
      tag("Keeping it costs nothing, and Manage can top it up and borrow", "gray"),
      tag("against it again rather than minting a new one.", "gray"),
      "",
      // The trade is real and only the user can weigh it, so both halves are
      // stated rather than one recommended. The id is the linkable part: the
      // NFT is shielded and the executor rotates every send, but the tokenId
      // does not, so everything done through one position is provably the same
      // position.
      tag("Reuse is cheaper; a fresh position is more private. This id is", "gray"),
      tag("public, so repeated use links those actions to each other.", "gray"),
    ];
  }
  const wad = Number(10n ** 18n);
  const ratio = Number(state.debtRatio) / wad;
  const colour = zoneColour(
    state.debtRatio >= state.liquidationDebtRatio
      ? "liquidation"
      : state.debtRatio >= state.rebalanceDebtRatio
        ? "rebalance"
        : "safe",
  );
  const meter = markedBar(ratio, 32, [
    { at: Number(state.rebalanceDebtRatio) / wad, glyph: "│" },
    { at: Number(state.liquidationDebtRatio) / wad, glyph: "✕" },
  ]);
  return [
    tag(label, "magenta"),
    "",
    `${tag("collateral", "gray")}  ${format(state.collateralAmount, state.collateralDecimals)} ${collateralSymbol}`,
    `${tag("debt", "gray")}        ${format(state.debtAmount, 18)} fxUSD`,
    "",
    `${tag("debt ratio", "gray")}  ${tag(asPercent(ratio, 1), colour)}`,
    `            ${tag(meter, colour)}`,
    `            ${tag(`│ rebalance ${asPercent(Number(state.rebalanceDebtRatio) / wad, 0)}`, "gray")}` +
      `   ${tag(`✕ liquidation ${asPercent(Number(state.liquidationDebtRatio) / wad, 0)}`, "gray")}`,
    "",
    tag("Manage, Close, or Close fully from the command palette.", "gray"),
  ];
};

export interface FxRiskDeltaView extends FxRiskView {
  /** Where the position is before the action. Omitted when opening a new one. */
  before?: FxRisk;
}

/**
 * The risk block for an action on an EXISTING position: where it is now, and
 * where this puts it.
 *
 * A single resulting figure is not enough to decide with. "52.8%" only means
 * something against the 49.2% it came from — the direction and the size of the
 * step are the whole content of the decision, and asking someone to remember
 * the previous number while moving a slider is asking them to do the diff in
 * their head.
 */
export const fxRiskDeltaLines = (view: FxRiskDeltaView): string[] => {
  const { before, risk } = view;
  const lines = fxRiskLines(view);
  if (!before) return lines;
  const moved = Math.abs(before.debtRatio - risk.debtRatio) > 1e-9;
  if (!moved) return lines;
  const colour = zoneColour(risk.zone);
  // Prepended, so the meter underneath is read as the RESULT of this move.
  return [
    `${tag("was", "gray")}    ${tag(asPercent(before.debtRatio, 1), "gray")}` +
      ` ${tag("→", "gray")} ${tag(asPercent(risk.debtRatio, 1), colour)}` +
      `   ${tag(asLeverage(before.leverage), "gray")} ${tag("→", "gray")} ${asLeverage(risk.leverage)}`,
    ...lines,
  ];
};

export interface FxCloseView {
  state: FxPositionState;
  /** fxUSD being put toward the debt, 18 decimals. */
  repayAmount: bigint;
  collateralSymbol: string;
  /** What the released collateral comes back as, when a swap is folded in. */
  receiveSymbol?: string;
  /**
   * RAILGUN's unshield fee, basis points. Required: defaulting it to zero would
   * quietly restore the "equal to the debt closes it" error this exists to
   * prevent, on the one screen the user checks before sending.
   */
  railgunUnshieldFeeBps: bigint;
  format: (amount: bigint, decimals: number) => string;
}

/**
 * What closing actually does to this position.
 *
 * "Amount: 1880.03" says nothing about whether that finishes the job. The two
 * outcomes are categorically different — a full close burns the NFT and
 * returns everything, a partial one leaves a live position with less collateral
 * behind it — and which one you get depends on a number you had to look up.
 */
export const fxCloseLines = ({
  state,
  repayAmount,
  collateralSymbol,
  receiveSymbol,
  railgunUnshieldFeeBps,
  format,
}: FxCloseView): string[] => {
  // Both fees come off before the repay lands — RAILGUN's leaving the shield,
  // then the pool's on the repay itself — so an amount equal to the debt does
  // NOT clear it. Comparing against the raw debt previewed "closes fully" and
  // then built a partial, which is how a position ends up as dust nobody meant
  // to leave behind. The threshold is the same one the build sizes against.
  const requiredForFull = debtTokenForFullClose({
    debt: state.debtAmount,
    repayFeeRatio: state.repayFeeRatio,
    railgunUnshieldFeeBps,
  });
  const full = repayAmount >= requiredForFull;
  const shortfall = full ? 0n : requiredForFull - repayAmount;
  // What actually reaches the pool, not what leaves the wallet. Quoting the
  // gross overstated the repay and printed "leaves 0 fxUSD owed" next to a
  // position that was still open.
  const applied = full
    ? state.debtAmount
    : repayFromAvailable(repayAmount, state.repayFeeRatio, railgunUnshieldFeeBps);
  const owed = state.debtAmount - applied;
  // Collateral is released in proportion to the debt cleared. Exact for a full
  // close; for a partial one the protocol's own accounting is the authority
  // and this is the shape of the answer, not the answer.
  const released =
    state.debtAmount > 0n
      ? (state.collateralAmount * applied) / state.debtAmount
      : state.collateralAmount;
  const back = receiveSymbol && receiveSymbol !== collateralSymbol
    ? `${collateralSymbol} → ${receiveSymbol}`
    : collateralSymbol;

  const lines = [
    full
      ? // NOT "burnt". Measured on mainnet: tx 0x73d732bc… sent f(x)'s own
        // full-close sentinel on both legs, succeeded, and left the position at
        // 0/0 with ownerOf still returning the RAILGUN proxy. The pool empties
        // a position; it never destroys the NFT. Saying otherwise told users
        // their position would disappear and then left it on the screen.
        tag("clears the debt and takes the collateral back — the position is kept, empty", "yellow")
      : // Not gray. A partial close leaves a live position accruing interest
        // that can still be liquidated, and it is the outcome the user did not
        // ask for — quieter than the safe one is the wrong way round.
        //
        // Below display precision the remainder and the shortfall both print as
        // "0" and "<0.000001", which read as "nothing owed, nothing needed" on
        // a line insisting the position survives. In that case name the cause
        // and the fix instead of quoting figures too small to mean anything.
        tag(
          owed === 0n || format(owed, 18) === format(0n, 18)
            ? `PARTIAL — the fees leave a dust debt behind, so the position ` +
                `survives. Set Amount to ${format(requiredForFull, 18)} to close it outright.`
            : `PARTIAL — leaves ${format(owed, 18)} fxUSD owed, still accruing. ` +
                `Set Amount to ${format(requiredForFull, 18)} to close it outright.`,
          "red",
        ),
    `${tag("repay", "gray")}  ${format(applied, 18)} fxUSD`,
    `${tag("back", "gray")}   ${format(released, state.collateralDecimals)} ${back}` +
      (full ? "" : `  ${tag("(approx — the pool settles it)", "gray")}`),
  ];
  if (repayAmount > requiredForFull) {
    // Overshooting is not an error — the excess simply is not used — but a
    // number larger than the requirement reads as if it will be spent.
    //
    // Measured against requiredForFull, not the bare debt. The gross-up over the
    // debt is not surplus: it is the unshield and repay fees, and it is what
    // MAKES the close full. Against the debt this fires on every close the card
    // prefills, printing "the rest is not used" under "clears the debt" — an
    // instruction to lower the amount into exactly the partial close the
    // prefill exists to prevent.
    lines.push(
      tag(
        `only ${format(requiredForFull, 18)} fxUSD is needed; the rest is not used`,
        "gray",
      ),
    );
  }
  return lines;
};
