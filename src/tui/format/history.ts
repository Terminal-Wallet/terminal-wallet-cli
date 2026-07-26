/**
 * Pure formatters for the Activity panel — separated from blessed so they can be
 * unit-tested without mounting a screen or loading a wallet. The renderer passes
 * its own `tag` (color wrapper); tests pass a passthrough.
 */
import { CoreHistoryItem } from "../../core/events";

export type Tagger = (text: string, color: string) => string;

export const fmtHistoryTime = (ts?: number): string => {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "—";
  }
};

export const formatHistoryRows = (
  items: CoreHistoryItem[],
  tag: Tagger,
): string[] => {
  if (!items.length) return [tag("  (no activity yet)", "gray")];
  return items.map((h) => {
    const icon =
      h.direction === "in"
        ? tag("↓", "green")
        : h.direction === "out"
        ? tag("↑", "yellow")
        : tag("·", "gray");
    const amts =
      h.amounts.map((a) => `${a.amount} ${a.symbol}`).join(", ") || "—";
    const memo = h.memo ? tag(`  "${h.memo}"`, "gray") : "";
    return `${icon} ${h.category.padEnd(9)} ${amts.padEnd(26)} ${tag(
      fmtHistoryTime(h.timestamp),
      "gray",
    )}${memo}`;
  });
};
