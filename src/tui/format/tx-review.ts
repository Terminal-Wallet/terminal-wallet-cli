/**
 * The transaction review body — everything known about one history entry, as
 * text.
 *
 * Pure: it takes the entry and the chain and returns a string, so it is
 * testable without mounting anything. The network is a parameter rather than
 * read from the engine, which also means a review can be rendered for a chain
 * that is not the active one.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { CoreHistoryItem } from "../../core/history";
import { tag } from "./tags";
import { fmtAmount, explorerTxUrl } from "./deck";
import { fmtHistoryTime } from "./history";

/**
 * blessed reads `{` and `}` as markup, so anything the user supplied has to be
 * stripped of them — otherwise a memo containing a brace corrupts the rest of
 * the panel, or worse, injects styling.
 */
const sanitize = (text: string): string => text.replace(/[{}]/g, "");

const label = (text: string): string => tag(text.padEnd(9), "gray");

export const txReviewBody = (
  item: CoreHistoryItem,
  network: NetworkName,
): string => {
  const direction =
    item.direction === "in"
      ? tag("● received", "green")
      : item.direction === "out"
        ? tag("● sent", "yellow")
        : tag("● activity", "gray");
  const separator = tag("─".repeat(46), "gray");

  let url: string | undefined;
  try {
    url = explorerTxUrl(network, item.txid);
  } catch {
    // No explorer configured for this chain; the review is still worth showing.
  }

  const lines: string[] = [
    `${tag(item.category.toUpperCase(), "cyan")}    ${direction}`,
    separator,
    `${label("When")}${fmtHistoryTime(item.timestamp)}`,
  ];
  if (item.blockNumber) {
    lines.push(`${label("Block")}#${item.blockNumber.toLocaleString("en-US")}`);
  }
  if (item.version !== undefined) {
    lines.push(`${label("Version")}v${item.version}`);
  }

  lines.push("", tag("Amounts", "white"));
  lines.push(
    ...(item.amounts.length
      ? item.amounts.map((a) => `  ${tag(fmtAmount(a.amount), "white")} ${a.symbol}`)
      : [tag("  —", "gray")]),
  );

  if (item.change?.length) {
    lines.push("", tag("Change", "gray"));
    lines.push(...item.change.map((a) => `  ${fmtAmount(a.amount)} ${a.symbol}`));
  }

  lines.push(
    "",
    `${label("Fee")}${
      item.fee
        ? `${tag(fmtAmount(item.fee.amount), "magenta")} ${item.fee.symbol}  ${tag("via broadcaster", "gray")}`
        : tag("— (self-signed)", "gray")
    }`,
  );

  if (item.memo) {
    lines.push("", `${label("Memo")}${tag(sanitize(item.memo), "white")}`);
  }

  lines.push("", tag("Tx ID", "gray"), `  ${item.txid}`);
  if (url) {
    lines.push("", tag("Explorer", "gray"), `  ${tag(url, "blue")}`);
  }

  return lines.join("\n");
};
