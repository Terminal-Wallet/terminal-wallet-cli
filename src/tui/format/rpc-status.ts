/**
 * How one RPC endpoint reads on the editor's list.
 *
 * Two independent facts share the row and must not be confused for each other:
 * whether the user ENABLED it, and whether it ANSWERS. The old editor showed
 * only the first and called it "enabled", which is why an endpoint could be
 * dead for weeks without anything on screen saying so.
 */
import { RpcProbe } from "../../railgun/network/rpc-probe";

export interface RpcRow {
  url: string;
  /** The user's setting. Independent of whether it works. */
  enabled: boolean;
  /** Shipped with the app; only custom entries can be removed. */
  isDefault: boolean;
  /** undefined while the probe is still out. */
  probe?: RpcProbe;
}

/** Longest first, so a shorter host does not read as a truncation of a longer. */
export const shortenUrl = (url: string, max = 44): string => {
  if (url.length <= max) return url;
  // Keep the host and the tail: an API key's last characters are what
  // distinguishes two otherwise identical provider URLs.
  const head = url.slice(0, max - 9);
  return `${head}…${url.slice(-8)}`;
};

/**
 * The status cell.
 *
 * `lead` is the block height of the furthest-ahead endpoint that answered, so
 * a straggler can be reported by how far behind it is. Being 200 blocks back is
 * the failure that looks most like success — it answers, it returns a plausible
 * number, and it serves stale state to everything that reads through it.
 */
export const rpcStatusLabel = (row: RpcRow, lead?: bigint): string => {
  if (!row.probe) return "checking…";
  if (!row.probe.ok) return row.probe.reason;
  const { blockNumber, latencyMs } = row.probe;
  const height = blockNumber.toLocaleString("en-US");
  const behind = lead !== undefined ? lead - blockNumber : 0n;
  // One block of drift is ordinary propagation, not a fault.
  if (behind > 1n) return `${height}  ${behind} behind`;
  return `${height}  ${latencyMs}ms`;
};

/**
 * The single line under the list.
 *
 * Counts what MATTERS — enabled endpoints that answered — rather than how many
 * are configured. "6 providers" is reassuring and says nothing; "1 of 4
 * answering" is the thing worth knowing before a send fails.
 */
export const rpcSummaryLine = (rows: RpcRow[]): string => {
  const enabled = rows.filter((r) => r.enabled);
  if (!enabled.length) return "no endpoints enabled — the wallet cannot reach this chain";
  const pending = enabled.filter((r) => !r.probe).length;
  const live = enabled.filter((r) => r.probe?.ok).length;
  if (pending) return `${live} of ${enabled.length} answering · ${pending} still checking`;
  if (!live) return `NONE of ${enabled.length} enabled endpoints answered`;
  return `${live} of ${enabled.length} enabled endpoints answering`;
};

/** The furthest-ahead height anything reported, or undefined if nothing did. */
export const leadBlock = (rows: RpcRow[]): bigint | undefined => {
  const heights = rows
    .map((r) => (r.probe?.ok ? r.probe.blockNumber : undefined))
    .filter((h): h is bigint => h !== undefined);
  return heights.length ? heights.reduce((a, b) => (b > a ? b : a)) : undefined;
};
