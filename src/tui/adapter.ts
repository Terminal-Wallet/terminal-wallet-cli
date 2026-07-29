/**
 * Core → UI adapter: the ONLY place the core event bus is read.
 *
 * It subscribes once and folds each event into the store. Everything the screens
 * draw comes from that store, so no screen ever subscribes to the bus itself —
 * which is what keeps event handling in one place instead of scattered across
 * whatever happens to be mounted.
 *
 * Call attachCoreAdapter() once during UI boot.
 */
import { onCoreEvent, CoreEvent } from "../core/events";
import { getState, setState, appendLog } from "./store";

// Elapsed seconds since the adapter loaded — prefixed onto each log line so the
// timing of (and gaps between) events is derivable from the log pane.
const BOOT_MS = Date.now();
const runtimeStamp = (): string => `+${Date.now() - BOOT_MS}ms`;

/**
 * The waku broadcaster client announces every fee message it receives, several
 * times a second, which buries everything else in the log pane.
 *
 * Matched on those two specific lines rather than on the word "fee". This is
 * the single choke point for the whole log stream now that the logger drains
 * through it, so a broad pattern here silently discards real failures — "fee
 * too high", "insufficient fee for broadcaster", and the builder's own
 * overspend messages all contain it.
 */
const BROADCASTER_FEE_CHATTER = /Broadcaster Fee (?:STALE|receipt)/i;

export const isLogNoise = (text: string): boolean =>
  BROADCASTER_FEE_CHATTER.test(text);

/** Append one line to the log stream, stamped with elapsed runtime. */
const recordLog = (prefix: string, text: string): void => {
  setState({
    logs: appendLog(getState().logs, `${prefix} [${runtimeStamp()}] ${text}`),
  });
};

/** How long a message without an explicit lifetime stays on the bar. */
const DEFAULT_STATUS_MS = 8000;

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Show a message on the status bar for a while, then let it go.
 *
 * `statusUntil` is the authority — the renderer reads it, so a stale message is
 * never shown even if no timer fired. The timer exists only to make a render
 * happen at the moment it expires, since otherwise the last thing said would
 * stay on screen until something unrelated triggered a redraw. Every message
 * resets it, so an older one cannot clear a newer one.
 */
const setStatus = (text: string, durationMs = DEFAULT_STATUS_MS): void => {
  if (statusTimer) clearTimeout(statusTimer);
  setState({ status: text, statusUntil: Date.now() + durationMs });
  statusTimer = setTimeout(() => {
    statusTimer = undefined;
    // Re-assert rather than blank it: this only has to nudge a render, and the
    // renderer decides what is stale.
    setState({ status: getState().status });
  }, durationMs + 50);
  statusTimer.unref?.();
};

/** A message that stays until something replaces it (work in progress). */
const setStickyStatus = (text: string): void => {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = undefined;
  setState({ status: text, statusUntil: undefined });
};

const fold = (e: CoreEvent): void => {
  switch (e.type) {
    case "wallet:changed":
      setState({
        walletName: e.walletName,
        network: e.network,
        publicAddress: e.publicAddress,
        privateAddress: e.railgunAddress,
      });
      break;
    case "network:changed": {
      // Only reset sync state on an ACTUAL chain change — pushIdentity re-emits
      // this event every ~5s to refresh identity/broadcaster status, and resetting
      // each time wiped the tree heights/ready latch (card flickered back to "—").
      const changed = getState().network !== e.network;
      setState({
        network: e.network, baseSymbol: e.baseSymbol,
        ...(changed
          ? {
              utxoProgress: -1, txidProgress: -1, utxoSynced: false, txidSynced: false,
              utxoTree: -1, utxoLeaves: -1, txidTree: -1, txidLeaves: -1,
              utxoReady: false, txidReady: false,
            }
          : {}),
      });
      break;
    }
    case "scan:progress": {
      // Once a tree reports Complete (sets *Synced), KEEP it synced — the engine
      // keeps emitting progress events (cold-sync churn + live updates) that would
      // otherwise flip the ✓ back to a bar. scan:progress only advances the bar
      // and live height; the synced flag is set by scan:complete and reset on
      // network:changed.
      if (e.tree === "utxo") {
        const s = getState();
        setState({
          ...(s.utxoSynced ? {} : { utxoProgress: e.progress, scanProgress: e.progress }),
          ...(e.treeNumber !== undefined ? { utxoTree: e.treeNumber } : {}),
          ...(e.leaves !== undefined ? { utxoLeaves: e.leaves } : {}),
        });
      } else if (e.tree === "txid") {
        const s = getState();
        setState({
          ...(s.txidSynced ? {} : { txidProgress: e.progress }),
          ...(e.treeNumber !== undefined ? { txidTree: e.treeNumber } : {}),
          ...(e.leaves !== undefined ? { txidLeaves: e.leaves } : {}),
        });
      } else setState({ scanProgress: e.progress });
      break;
    }
    case "scan:complete":
      if (e.tree === "utxo" || e.tree === "txid") {
        const patch =
          e.tree === "utxo"
            ? { utxoProgress: 100, utxoSynced: true, utxoReady: true }
            : { txidProgress: 100, txidSynced: true, txidReady: true };
        const next = { ...getState(), ...patch };
        // Overall idle only once BOTH trees have finished their historical scan.
        //
        // The status line is cleared here too. "Scan kicked — balances will
        // populate as it completes" was written before anything emitted this
        // event, so it announced a completion that never arrived and sat on the
        // footer forever. Now the completion reports itself.
        const done = next.utxoSynced && next.txidSynced;
        setState(done ? { ...patch, scanProgress: -1 } : patch);
        setStatus(done ? "Balances synced." : `${e.tree} tree synced…`);
      } else {
        setState({ scanProgress: -1 }); // legacy untagged complete
      }
      break;
    case "balances:updated":
      setState({
        privateBalances: e.private,
        privateNFTs: e.nfts ?? [],
        publicBalances: e.public,
        privateUSD: e.privateUSD ?? "—",
        publicUSD: e.publicUSD ?? "—",
      });
      break;
    case "poi:progress":
      // Progress, not an announcement: it holds the bar while it is running and
      // the next update replaces it. Left to expire it would flicker away
      // between updates.
      setStickyStatus(
        `POI ${e.status} ${e.index}/${e.total} (${e.progress.toFixed(0)}%)`,
      );
      break;
    case "broadcaster:status":
      setState({ broadcasters: e.connected ? "available" : "disconnected" });
      break;
    case "history:updated":
      setState({ history: e.items });
      break;
    case "balances:refreshed":
      // Signal only — a renderer that derives balances (the deck) re-reads the
      // cache on this; the store carries no extra state for it.
      break;
    case "log": {
      if (isLogNoise(e.text)) break;
      const prefix = e.level === "error" ? "✗" : e.level === "warn" ? "▲" : "·";
      recordLog(prefix, e.text);
      break;
    }
    case "status:message":
      // Also recorded, not just displayed. The status line is one line that the
      // next message overwrites, and it is where errors and transaction hashes
      // surface — so anything worth reading there is worth being able to scroll
      // back to and copy out.
      setStatus(e.text, e.durationMs);
      recordLog("›", e.text);
      break;
    case "tx:progress": {
      // A phase with no percentage still has to show. footerStatus renders the
      // bar only while scanProgress >= 0, so a progress event carrying just a
      // message left the label set and invisible — which for a recovery meant
      // the whole slow 7702 gas estimate happened in silence, and the first
      // thing the user saw was the proof already underway.
      //
      // Zero rather than a fabricated percentage: the phase has started and
      // nothing has reported how far it is, which is exactly what an empty bar
      // beside its name says.
      const pct =
        typeof e.pct === "number"
          ? e.pct
          : Math.max(0, getState().scanProgress);
      setState({
        scanProgress: pct,
        scanLabel: e.message ?? `Transaction: ${e.phase}`,
      });
      break;
    }
    case "tx:result": {
      // The full hash and the full error, not the status line's truncation:
      // this is the record someone goes looking for afterwards.
      const detail = e.ok
        ? `Transaction sent${e.hash ? ` · ${e.hash}` : ""}${e.url ? ` · ${e.url}` : ""}`
        : `Transaction failed: ${e.error ?? "unknown error"}`;
      setState({ scanProgress: -1, scanLabel: "" });
      setStatus(
        e.ok
          ? `Transaction sent${e.hash ? ` · ${e.hash.slice(0, 10)}…` : ""}`
          : `Transaction failed: ${e.error ?? "unknown error"}`,
        30000, // an outcome is worth a longer look than a progress note
      );
      recordLog(e.ok ? "›" : "✗", detail);
      break;
    }
    default: {
      // Exhaustiveness guard: a new CoreEvent without a fold case is a type error.
      const _never: never = e;
      void _never;
    }
  }
};

let detach: (() => void) | undefined;

/** Subscribe the store to the core bus. Idempotent. Returns a detach function. */
export const attachCoreAdapter = (): (() => void) => {
  if (detach) return detach;
  detach = onCoreEvent(fold);
  return detach;
};
