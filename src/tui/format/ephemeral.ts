/**
 * The 7702 ephemeral console's text, and the two guards that protect it.
 *
 * Relay-adapt transactions execute from a per-call ephemeral account derived at
 * an index the wallet ratchets forward. The index is the only thing that keeps
 * a fresh account fresh, so the two operations that move it by hand — advance,
 * and set — are the dangerous ones. Their warnings live here, pure and tested,
 * rather than inside a modal where their wording could drift.
 *
 * Rewinding is the sharp edge. A 7702 authorization is signed against nonce 0,
 * so pointing the wallet back at an account that has already transacted yields
 * an authorization the network rejects, and funds routed through it can strand.
 */
import { formatUnits } from "ethers";
import { tag } from "./tags";
import { EphemeralAssetScan } from "../../railgun/wallet/ephemeral-recovery";
import { EphemeralHistoryEntry } from "../../railgun/wallet/ephemeral-util";

export type IndexParse =
  | { ok: true; index: number }
  | { ok: false; message: string };

/**
 * An ephemeral index is a non-negative integer and nothing else.
 *
 * Truncating rather than rejecting a fractional entry matches the original
 * console, but the range check is what matters: a negative index derives a
 * different account silently.
 */
export const parseIndex = (raw: string | undefined): IndexParse => {
  if (raw === undefined || !raw.trim()) {
    return { ok: false, message: "Cancelled." };
  }
  const index = Math.trunc(Number(raw.trim()));
  if (!Number.isInteger(index) || index < 0) {
    return { ok: false, message: "Index must be a non-negative integer." };
  }
  return { ok: true, index };
};

/**
 * Whether moving to `target` needs the strand-funds confirmation.
 *
 * Only rewinding does. Setting the index forward lands on an account that has
 * never been used, which is the same situation as advancing.
 */
export const rewindsIndex = (current: number, target: number): boolean =>
  target < current;

/** Verbatim from the console this replaces — the wording is the guard. */
export const rewindWarning = (current: number): string =>
  `Setting the index below the current (${current}) can reuse an already-spent ` +
  `ephemeral, which makes the nonce-0 7702 authorization invalid and can strand ` +
  `funds. Continue?`;

export const advanceWarning = (current: number, address: string): string =>
  `Advance the ephemeral index past ${current}? The current address (${address}) ` +
  `will be skipped for future ops.`;

/** What is sitting at an ephemeral address right now. */
export const balanceLines = (
  index: number,
  address: string,
  scan: EphemeralAssetScan,
): string[] => {
  const lines = [`${tag(`ephemeral [${index}]`, "cyan")}  ${tag(address, "gray")}`, ""];
  const native = formatUnits(scan.nativeWei, 18);
  lines.push(`  ${"ETH".padEnd(8)} ${tag(native, scan.nativeWei > 0n ? "green" : "gray")}`);
  for (const token of scan.erc20s) {
    lines.push(
      `  ${token.symbol.padEnd(8)} ${tag(
        formatUnits(token.balance, token.decimals),
        "green",
      )}  ${tag(token.tokenAddress, "gray")}`,
    );
  }
  for (const nft of scan.nfts) {
    lines.push(`  ${"position".padEnd(8)} ${tag(nft.label, "green")}  ${tag(nft.nftAddress, "gray")}`);
  }
  if (scan.nativeWei === 0n && scan.erc20s.length === 0 && scan.nfts.length === 0) {
    lines.push(`  ${tag("(nothing stranded at this ephemeral)", "gray")}`);
  }
  if (scan.unreadable > 0) {
    // Louder than the curated-list note: that one says the scan may not have
    // looked everywhere, this one says part of it looked and got no answer.
    lines.push(
      "",
      tag(
        `warning: ${scan.unreadable} balance(s) could not be read — this account is NOT confirmed empty. Retry before writing it off.`,
        "red",
      ),
    );
  }
  if (scan.method === "tokenlist") {
    // Worth saying plainly: an empty result from this scan is not proof the
    // account is empty, only that nothing on the curated list is there.
    lines.push(
      "",
      tag(
        "note: log scan unavailable — curated token list only; arbitrary tokens may be missed.",
        "yellow",
      ),
    );
  }
  return lines;
};

/** Which ephemerals have been used, and where the wallet currently points. */
export const historyLines = (
  currentIndex: number,
  earlierOmitted: number,
  entries: EphemeralHistoryEntry[],
): string[] => {
  const lines = [`current index ${tag(`${currentIndex}`, "cyan")}`, ""];
  if (earlierOmitted > 0) {
    lines.push(tag(`(${earlierOmitted} earlier ephemeral(s) omitted)`, "gray"));
  }
  for (const entry of entries) {
    const isCurrent = entry.index === currentIndex;
    const marker = isCurrent ? tag("→", "cyan") : "  ";
    const status = isCurrent
      ? tag("current", "cyan")
      : entry.usedForUnshield
        ? tag("unshield/swap", "green")
        : tag("used", "gray");
    lines.push(
      `${marker} [${`${entry.index}`.padStart(4)}] ${entry.address}  ${status}`,
    );
  }
  return lines;
};
