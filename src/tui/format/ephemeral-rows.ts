/**
 * The ephemeral index list, as data.
 *
 * The console used to ask you to TYPE an index. That only works if you already
 * know which one holds the stranded funds, and the whole reason you are in this
 * screen is that you do not — the wallet ratcheted past it without telling you.
 * Typing the current index, the one number you do know, is the case guaranteed
 * to find nothing.
 *
 * So the model is a list of accounts with what is at each one, and the actions
 * hang off the selected row. Pure: the screen renders these and the scan fills
 * them in.
 */
import { formatUnits } from "ethers";
import { EphemeralAssetScan } from "../../railgun/wallet/ephemeral-recovery";
import { EphemeralHistoryEntry } from "../../railgun/wallet/ephemeral-util";

export interface IndexRow {
  index: number;
  address: string;
  /** The index the wallet will derive from for the next relay-adapt send. */
  isCurrent: boolean;
  /** Seen as an unshield recipient in local history — definitely used. */
  usedForUnshield: boolean;
  /** Undefined until this row has been scanned; the distinction is visible. */
  scan?: EphemeralAssetScan;
}

/** Whether a scanned row is holding anything at all. */
export const holdsAssets = (row: IndexRow): boolean =>
  row.scan !== undefined &&
  (row.scan.nativeWei > 0n ||
    row.scan.erc20s.length > 0 ||
    row.scan.nfts.length > 0);

/**
 * Newest first. The interesting accounts are the ones just behind the current
 * index — that is where a half-finished send leaves things — and a list that
 * opens on index 0 buries them.
 */
export const buildIndexRows = (
  currentIndex: number,
  entries: EphemeralHistoryEntry[],
  scans: Map<number, EphemeralAssetScan> = new Map(),
): IndexRow[] =>
  [...entries]
    .sort((a, b) => b.index - a.index)
    .map((entry) => ({
      index: entry.index,
      address: entry.address,
      isCurrent: entry.index === currentIndex,
      usedForUnshield: entry.usedForUnshield,
      scan: scans.get(entry.index),
    }));

const short = (address: string): string =>
  address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;

/** What a scanned row is holding, in one phrase. */
export const assetSummary = (row: IndexRow): string => {
  if (!row.scan) return "—";
  const parts: string[] = [];
  if (row.scan.nativeWei > 0n) {
    parts.push(`${Number(formatUnits(row.scan.nativeWei, 18)).toFixed(6)} ETH`);
  }
  if (row.scan.erc20s.length === 1) {
    const [token] = row.scan.erc20s;
    parts.push(
      `${Number(formatUnits(token.balance, token.decimals)).toFixed(4)} ${token.symbol}`,
    );
  } else if (row.scan.erc20s.length > 1) {
    parts.push(`${row.scan.erc20s.length} tokens`);
  }
  // A position is the most valuable thing that can be sitting here and the
  // least visible: it has no symbol and no balance, so a summary built only
  // from tokens calls an account holding one "empty" while `holdsAssets`
  // highlights the same row as holding funds.
  if (row.scan.nfts.length === 1) {
    parts.push(row.scan.nfts[0].label);
  } else if (row.scan.nfts.length > 1) {
    parts.push(`${row.scan.nfts.length} positions`);
  }
  return parts.length ? parts.join(" · ") : "empty";
};

/** A row's state word: what makes it worth looking at, or not. */
export const rowState = (row: IndexRow): string =>
  row.isCurrent ? "current" : row.usedForUnshield ? "used" : "";

/**
 * One list line. Columns are padded so indexes, addresses and holdings line up
 * down the list — the point of the screen is comparing rows to each other.
 */
export const rowLabel = (row: IndexRow): string =>
  `#${String(row.index).padEnd(4)} ${short(row.address).padEnd(15)} ` +
  `${rowState(row).padEnd(8)} ${row.scan ? assetSummary(row) : "not scanned"}`;

/** A one-line verdict for the header: how much has been looked at so far. */
export const scanVerdict = (rows: IndexRow[]): string => {
  const scanned = rows.filter((row) => row.scan !== undefined);
  if (scanned.length === 0) return "not scanned yet";
  const holding = scanned.filter(holdsAssets);
  if (holding.length === 0) {
    return `${scanned.length} scanned · nothing stranded`;
  }
  return `${scanned.length} scanned · ${holding.length} holding funds`;
};
