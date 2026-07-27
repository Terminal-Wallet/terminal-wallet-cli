/**
 * The UI state store.
 *
 * A tiny subscribe/setState container rather than a framework: the adapter folds
 * core events into it, screens read from it and redraw only on change. Kept
 * dependency-free so it can be driven and asserted on in tests without mounting
 * anything.
 */

import { CoreHistoryItem } from "../core/events";

export type BroadcasterStatus = "available" | "disconnected";

/** A shielded NFT row — a protocol position, named. */
export interface NftBalance {
  label: string;
  amount: string;
  /** Set when the collection is recognised, so a picker can filter on it. */
  kind?: string;
}

export interface TokenBalance {
  symbol: string;
  amount: string; // pre-formatted display string
  usd?: string; // formatted USD value, if a price is known
  bucket?: string; // POI bucket label (private rows only)
}

export interface WalletState {
  walletName: string;
  publicAddress: string;
  privateAddress: string;
  network: string;
  baseSymbol: string;
  broadcasters: BroadcasterStatus;
  showPrivate: boolean;
  publicBalances: TokenBalance[];
  privateBalances: TokenBalance[];
  /** Shielded NFTs. The engine has always reported these; the wallet now keeps them. */
  privateNFTs: NftBalance[];
  scanProgress: number; // 0..100, -1 = idle (overall; legacy UIs)
  scanLabel: string;
  /** Epoch ms after which `status` is stale. Undefined means it never expires. */
  statusUntil?: number;
  utxoProgress: number; // UTXO merkletree scan: 0..100, -1 = idle
  txidProgress: number; // TXID merkletree scan: 0..100, -1 = idle
  utxoSynced: boolean; // UTXO historical scan finished
  txidSynced: boolean; // TXID historical scan finished (both → fully synced)
  utxoTree: number; // UTXO merkletree current tree number (-1 = unknown)
  utxoLeaves: number; // UTXO merkletree leaf count in the current tree (-1 = unknown)
  txidTree: number; // TXID merkletree current tree number (-1 = unknown)
  txidLeaves: number; // TXID merkletree leaf count in the current tree (-1 = unknown)
  utxoReady: boolean; // UTXO caught up (latched ✓; reset on network change)
  txidReady: boolean; // TXID caught up (latched ✓; reset on network change)
  status: string; // transient status line
  history: CoreHistoryItem[];
  logs: string[]; // captured stdio/SDK log lines (newest last), capped
  privateUSD: string; // formatted private portfolio total ("—" if no prices)
  publicUSD: string; // formatted public portfolio total
}

/** Max log lines kept in memory (ring buffer — oldest dropped). */
export const LOG_CAP = 500;

/** Pure: append a line to a capped log buffer (newest last). Tested. */
export const appendLog = (logs: string[], line: string): string[] => {
  const next = logs.length >= LOG_CAP ? logs.slice(logs.length - LOG_CAP + 1) : logs.slice();
  next.push(line);
  return next;
};

const initialState: WalletState = {
  walletName: "—",
  publicAddress: "—",
  privateAddress: "—",
  network: "Ethereum",
  baseSymbol: "ETH",
  broadcasters: "disconnected",
  showPrivate: true,
  publicBalances: [],
  privateBalances: [],
  privateNFTs: [],
  scanProgress: -1,
  scanLabel: "",
  utxoProgress: -1,
  txidProgress: -1,
  utxoSynced: false,
  txidSynced: false,
  utxoTree: -1,
  utxoLeaves: -1,
  txidTree: -1,
  txidLeaves: -1,
  utxoReady: false,
  txidReady: false,
  status: "",
  history: [],
  logs: [],
  privateUSD: "—",
  publicUSD: "—",
};

type Listener = (s: WalletState) => void;

let state: WalletState = { ...initialState };
const listeners = new Set<Listener>();

export const getState = (): WalletState => state;

export const subscribe = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const setState = (patch: Partial<WalletState>): void => {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
};

export const togglePrivate = (): void =>
  setState({ showPrivate: !state.showPrivate });
