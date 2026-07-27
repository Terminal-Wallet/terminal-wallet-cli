/**
 * Core event bus — the OUTPUT half of the seam between the wallet core and
 * whatever is rendering it.
 *
 * Principle: CORE EMITS, THE RENDERER SUBSCRIBES. Nothing in this file, and
 * nothing that imports it from the core side, may import a renderer or style
 * output — that direction is enforced by scripts/check-core-boundary.sh.
 *
 * A single renderer-side adapter is expected to subscribe and fold events into
 * its own state; core never learns who is listening, or whether anyone is. That
 * is what lets the same core drive a terminal UI, the headless diagnostic, and
 * a test harness without knowing the difference.
 *
 * Deliberately dependency-free — a plain Set of handlers rather than Node's
 * EventEmitter — so it bundles cleanly and adds no runtime surface.
 */
import type {
  NetworkName,
  RailgunWalletBalanceBucket,
} from "@railgun-community/shared-models";
import type { CoreHistoryItem } from "./history";

export type { CoreHistoryAmount, CoreHistoryItem } from "./history";

/** A single token line, already formatted for display. */
export interface CoreTokenBalance {
  symbol: string;
  amount: string;
  usd?: string; // formatted USD value (e.g. "$12.34"), if a price is known
  bucket?: RailgunWalletBalanceBucket; // POI bucket (private rows only)
}

/** Phases a transaction moves through, surfaced to the UI as it runs. */
export type TxPhase =
  | "estimate"
  | "prove"
  | "send" // umbrella for broadcast or self-sign
  | "sign"
  | "broadcast"
  | "watch"
  | "confirmed"
  | "failed";

export type CoreEvent =
  | {
      type: "wallet:changed";
      walletName: string;
      network: NetworkName;
      publicAddress: string;
      railgunAddress: string;
      railgunId: string;
    }
  | { type: "network:changed"; network: NetworkName; baseSymbol: string }
  | { type: "scan:progress"; chain?: NetworkName; tree?: "utxo" | "txid"; progress: number; treeNumber?: number; leaves?: number } // 0..100 + live merkletree height
  | { type: "scan:complete"; chain?: NetworkName; tree?: "utxo" | "txid" }
  | {
      type: "balances:updated";
      chain: NetworkName;
      bucket?: RailgunWalletBalanceBucket;
      private: CoreTokenBalance[];
      public: CoreTokenBalance[];
      /** Shielded NFTs — protocol positions, not fungible balances. */
      nfts?: { label: string; amount: string; kind?: string }[];
      privateUSD?: string; // formatted portfolio totals, if prices are known
      publicUSD?: string;
    }
  | {
      type: "poi:progress";
      status: string;
      index: number;
      total: number;
      progress: number;
    }
  | { type: "broadcaster:status"; connected: boolean }
  | { type: "history:updated"; items: CoreHistoryItem[] }
  | { type: "balances:refreshed"; chain?: NetworkName } // cache drained → UI should re-read
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | {
      type: "status:message";
      text: string;
      durationMs?: number;
      replace?: boolean;
    }
  | { type: "tx:progress"; phase: TxPhase; pct?: number; message?: string }
  | {
      type: "tx:result";
      ok: boolean;
      hash?: string;
      url?: string;
      error?: string;
    };

export type CoreEventHandler = (event: CoreEvent) => void;

const handlers = new Set<CoreEventHandler>();

/** Subscribe to core events. Returns an unsubscribe function. */
export const onCoreEvent = (handler: CoreEventHandler): (() => void) => {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
};

/** Emit a core event to all subscribers. Safe to call before any UI is attached. */
export const emitCoreEvent = (event: CoreEvent): void => {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // A faulty UI handler must never crash core logic.
    }
  }
};
