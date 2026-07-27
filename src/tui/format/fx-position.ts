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
import { tag } from "./tags";
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
