/**
 * How one RPC endpoint reads, everywhere it is shown.
 *
 * Three facts belong on every row and they are independent of each other:
 *
 *   enabled  — the user's setting. Says nothing about whether it works.
 *   block    — whether it ANSWERS, and how current it is.
 *   origin   — where it came from, and therefore where it can be changed.
 *
 * The old editor showed the first alone and called it "enabled", which is why
 * an endpoint could be dead for weeks with nothing on screen saying so. Any
 * surface listing endpoints uses `rpcRowLine` so the three never drift apart
 * between one dialog and the next.
 */
import { RpcProbe } from "../../railgun/network/rpc-probe";

/**
 * Where an endpoint came from, which is what decides whether it can be removed
 * HERE or only somewhere else.
 *
 * - `builtin` ships with the app.
 * - `config`  comes from twallet.config.json (or the remote config), which
 *              REPLACES the built-in list outright — so a machine with an
 *              override has no built-ins in play at all, and a list of one is
 *              correct rather than broken.
 * - `custom`  was added in this editor and lives on the keychain.
 *
 * Only `custom` is removable here. Calling the other two "shipped" was wrong:
 * it told someone their own configured endpoint came from us.
 */
export type RpcOrigin = "builtin" | "config" | "custom";

export interface RpcRow {
  url: string;
  /** The user's setting. Independent of whether it works. */
  enabled: boolean;
  origin: RpcOrigin;
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
 * `lead` is the height of the furthest-ahead endpoint that answered, so a
 * straggler is reported by how far back it is. Being hundreds of blocks behind
 * is the failure that looks most like success — it answers, the number is
 * plausible, and everything reading through it gets stale state.
 */
export const rpcStatusLabel = (row: RpcRow, lead?: bigint): string => {
  if (!row.enabled) return "disabled";
  if (!row.probe) return "checking…";
  if (!row.probe.ok) return row.probe.reason;
  const { blockNumber, latencyMs } = row.probe;
  const height = blockNumber.toLocaleString("en-US");
  const behind = lead !== undefined ? lead - blockNumber : 0n;
  // One block of drift is ordinary propagation, not a fault.
  if (behind > 1n) return `${height}  ${behind} behind`;
  return `${height}  ${latencyMs}ms`;
};

/** Which colour the status cell carries. Kept here so every surface agrees. */
export const rpcStatusTone = (
  row: RpcRow,
  lead?: bigint,
): "gray" | "green" | "yellow" | "red" => {
  if (!row.enabled) return "gray";
  if (!row.probe) return "gray";
  if (!row.probe.ok) return "red";
  if (lead !== undefined && lead - row.probe.blockNumber > 1n) return "yellow";
  return "green";
};

/** Width of the URL column for a set of rows, so columns line up. */
export const rpcUrlWidth = (rows: RpcRow[], max = 46): number =>
  Math.min(max, rows.reduce((w, r) => Math.max(w, shortenUrl(r.url).length), 0));

/**
 * THE row. Every list of endpoints renders through this.
 *
 * `tag` is injected so the same layout serves a blessed list (colour markup)
 * and a plain picker (no markup) without either owning the other's concerns.
 */
export const rpcRowLine = (
  row: RpcRow,
  opts: {
    lead?: bigint;
    urlWidth?: number;
    tag?: (text: string, tone: string) => string;
  } = {},
): string => {
  const paint = opts.tag ?? ((text: string) => text);
  const width = opts.urlWidth ?? shortenUrl(row.url).length;
  const box = row.enabled ? paint("[x]", "green") : "[ ]";
  const status = paint(
    rpcStatusLabel(row, opts.lead),
    rpcStatusTone(row, opts.lead),
  );
  // Origin is a capability, not decoration: it is the difference between an
  // endpoint that can be removed here and one that can only be turned off.
  const kind =
    row.origin === "custom"
      ? `  ${paint("custom", "cyan")}`
      : row.origin === "config"
        ? `  ${paint("config", "magenta")}`
        : "";
  return `${box} ${shortenUrl(row.url).padEnd(width + 2)}${status}${kind}`;
};

/**
 * The single line under the list.
 *
 * Counts what MATTERS — enabled endpoints that answered — rather than how many
 * are configured. "6 providers" is reassuring and says nothing; "1 of 4
 * answering" is the thing worth knowing before a send fails.
 */
export const rpcSummaryLine = (rows: RpcRow[]): string => {
  // An override replaces the built-in list, so a short list is the override
  // working — but "where did my endpoints go" is the obvious reading unless it
  // is said out loud.
  const overridden = rows.some((r) => r.origin === "config")
    ? " · built-ins replaced by twallet.config.json"
    : "";
  const enabled = rows.filter((r) => r.enabled);
  if (!enabled.length) {
    return `no endpoints enabled — the wallet cannot reach this chain${overridden}`;
  }
  const pending = enabled.filter((r) => !r.probe).length;
  const live = enabled.filter((r) => r.probe?.ok).length;
  if (pending) {
    return `${live} of ${enabled.length} answering · ${pending} checking${overridden}`;
  }
  if (!live) return `NONE of ${enabled.length} enabled endpoints answered${overridden}`;
  return `${live} of ${enabled.length} enabled answering${overridden}`;
};

/** The furthest-ahead height anything reported, or undefined if nothing did. */
export const leadBlock = (rows: RpcRow[]): bigint | undefined => {
  const heights = rows
    .map((r) => (r.probe?.ok ? r.probe.blockNumber : undefined))
    .filter((h): h is bigint => h !== undefined);
  return heights.length ? heights.reduce((a, b) => (b > a ? b : a)) : undefined;
};

/**
 * Turning every shipped endpoint off, and back on.
 *
 * Working around a bad default otherwise means finding each one and toggling
 * it, which is the fiddly part of a job you are only doing because something is
 * already broken. Refuses when it would leave nothing enabled — a chain with no
 * reachable endpoint is not a state to arrive at by keystroke.
 */
export const onlyCustomToggle = (
  rows: RpcRow[],
): { rows: RpcRow[]; changed: boolean; reason?: string } => {
  const others = rows.filter((r) => r.origin !== "custom");
  if (!others.length) {
    return { rows, changed: false, reason: "every endpoint here is already a custom one" };
  }
  const turningOff = others.some((r) => r.enabled);
  if (turningOff && !rows.some((r) => r.origin === "custom" && r.enabled)) {
    return {
      rows,
      changed: false,
      reason: "add or enable a custom endpoint first — this would leave none",
    };
  }
  return {
    rows: rows.map((r) =>
      r.origin !== "custom" ? { ...r, enabled: !turningOff, probe: undefined } : r,
    ),
    changed: true,
  };
};

/** Why this endpoint cannot be removed here, and where it can be changed. */
export const rpcRemovalRefusal = (row: RpcRow): string | undefined =>
  row.origin === "custom"
    ? undefined
    : row.origin === "config"
      ? "set in twallet.config.json — edit that file, or press space to disable"
      : "a built-in endpoint — press space to disable it instead";
