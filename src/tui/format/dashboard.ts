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

const miniBar = (pct: number): string => {
  const filled = barCells(pct, 5);
  return "█".repeat(filled) + "░".repeat(5 - filled);
};

/**
 * One merkletree's sync line: position, and whether it is caught up.
 *
 * The ✓ latches. Once a tree is synced it stays ticked through the routine
 * re-scans that follow every new block — the live bar is for the initial sync
 * only. Without the latch the card flickers between a bar and a tick forever,
 * which reads as something being wrong.
 */
/**
 * Whether a merkletree is caught up. The single rule — the sync card and the
 * builder's proof warning both call this, and must agree.
 *
 * A progress of 0 means "not scanning", not "no progress": the engine emits one
 * once a scan completes. Only a percentage strictly between the ends counts as
 * in flight.
 */
export const treeSynced = (tree: {
  leaves: number;
  progress: number;
  ready: boolean;
}): boolean =>
  tree.ready || (tree.leaves > 0 && !(tree.progress > 0 && tree.progress < 100));

export const syncTreeLine = (
  label: string,
  tree: number,
  leaves: number,
  pct: number,
  ready: boolean,
  tag: Tagger,
): string => {
  const position =
    tree >= 0 && leaves >= 0 ? `${tree}:${leaves.toLocaleString("en-US")}` : "—";
  const scanning = pct > 0 && pct < 100;
  const right = treeSynced({ leaves, progress: pct, ready })
    ? tag("✓", "green")
    : scanning
      ? tag(miniBar(pct), "yellow")
      : tag("…", "gray");
  return `${tag(label, "gray")} ${tag(position, "white")} ${right}`;
};
