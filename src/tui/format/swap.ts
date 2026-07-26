/**
 * Pure swap-preview formatting for the builder's center pane. A swap's bought
 * amount is only known once a live 0x quote is fetched; this turns that quote's
 * already-readable prices into the "buy" line, and falls back to a placeholder
 * when no quote is available yet. No SDK / network / colour — just strings.
 */
import { Zer0XReadablePrices } from "../../models/0x-models";

export interface SwapQuotePreview {
  buyAmount: string; // readable decimal string for the expected output
  buyMinimum: string; // readable decimal string for the slippage-protected minimum
}

/** Pull the preview-relevant fields out of a quote's readable prices. */
export const toSwapPreview = (p: Zer0XReadablePrices): SwapQuotePreview => ({
  buyAmount: p.buyAmount,
  buyMinimum: p.buyMinimum,
});

/**
 * The builder's "buy" line: the live expected output (with the slippage-protected
 * minimum) when a 0x quote is known, else a placeholder noting that the amount
 * resolves at send time. `fmt` formats each readable amount (e.g. truncation).
 */
export const swapBuyLine = (
  buySymbol: string,
  preview: SwapQuotePreview | undefined,
  fmt: (s: string) => string = (s) => s,
): string =>
  preview
    ? `≈ ${fmt(preview.buyAmount)} ${buySymbol}  ·  min ${fmt(preview.buyMinimum)}`
    : `${buySymbol}  (amount at send)`;
