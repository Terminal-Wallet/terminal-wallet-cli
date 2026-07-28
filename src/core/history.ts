/**
 * Transaction-history shapes.
 *
 * Split out of the event bus because they are a data contract in their own
 * right: the history view, the formatters, and anything that persists or
 * replays activity all speak these, and none of them should have to import the
 * bus to do it. The bus re-exports them for the `history:updated` event.
 *
 * UI-ready by construction — amounts arrive already decimal-formatted, so no
 * consumer needs token decimals or a BigInt to render a row.
 */
export interface CoreHistoryAmount {
  symbol: string;
  amount: string; // formatted
}

/** One activity-feed entry, UI-ready (amounts already decimal-formatted). */
export interface CoreHistoryItem {
  txid: string;
  category: string; // "Send" | "Receive" | "Shield" | "Unshield" | "Activity"
  direction: "in" | "out" | "neutral";
  timestamp?: number; // unix seconds
  amounts: CoreHistoryAmount[];
  memo?: string;
  blockNumber?: number;
  version?: number; // RAILGUN tx version
  fee?: CoreHistoryAmount; // broadcaster fee, formatted (absent = self-signed)
  via?: "broadcaster" | "self-signed";
  change?: CoreHistoryAmount[]; // change returned to the wallet
  /**
   * Whether this put funds INTO the shielded pool, and so started a
   * shield-pending clock.
   *
   * Not derivable from `category`. A 7702 relay-adapt bundle that unshields,
   * acts and re-shields arrives from the SDK as Unknown and is labelled "Swap"
   * or "Activity" — so anything keyed on the label misses exactly the shields
   * this wallet's DeFi flows produce.
   */
  shielded?: boolean;
}
