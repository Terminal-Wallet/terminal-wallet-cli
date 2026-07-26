/**
 * Pure dashboard display helpers — extracted from blessed-entry so the dashboard
 * content logic is unit-testable without a screen.
 */
import { BroadcasterStatus, WalletState } from "../store";
import { Tagger } from "./history";

/** Truncate a long address to head…tail; pass short values through unchanged. */
export const shortAddr = (a: string): string =>
  a && a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;

/** Number of filled cells for a 0..100 progress value over `width` cells. */
export const barCells = (pct: number, width = 24): number =>
  Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);

/** Render a plain (uncolored) progress bar string. */
export const progressBar = (pct: number, width = 24): string => {
  const filled = barCells(pct, width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.max(
    0,
    Math.min(100, pct),
  ).toFixed(0)}%`;
};

export const broadcasterLabel = (status: BroadcasterStatus): string =>
  status === "available" ? "Available" : "Disconnected";

// ---- Stat card content builders (state → multi-line content) ---------------
// Each takes the renderer's `tag` (color wrapper); tests pass a passthrough.

export const walletCard = (s: WalletState, tag: Tagger): string =>
  [tag(s.walletName, "white"), "", tag(shortAddr(s.publicAddress), "gray")].join(
    "\n",
  );

export const networkCard = (s: WalletState, tag: Tagger): string =>
  [tag(s.network, "cyan"), "", tag("click to switch", "gray")].join("\n");

export const broadcasterCard = (s: WalletState, tag: Tagger): string =>
  [
    s.broadcasters === "available"
      ? tag("● Available", "green")
      : tag("● Disconnected", "yellow"),
    "",
    tag("waku relay", "gray"),
  ].join("\n");

export const balanceCard = (s: WalletState, tag: Tagger): string => {
  const [bal] = s.showPrivate ? s.privateBalances : s.publicBalances;
  const total = s.showPrivate ? s.privateUSD : s.publicUSD;
  const head = bal
    ? `${bal.amount} ${bal.symbol}${bal.usd ? tag(`  ${bal.usd}`, "green") : ""}`
    : "—";
  return [
    tag(head, "white"),
    total && total !== "—" ? tag(`Σ ${total}`, "green") : "",
    tag(`${s.showPrivate ? "private" : "public"} · click to toggle`, "gray"),
  ].join("\n");
};
