/**
 * The feeders — everything the deck has to go and fetch, because it does not
 * arrive on its own.
 *
 * Most of what the UI shows is pushed by the core bus as it happens: scan
 * progress, balances after a scan, transaction phases. These four cover what
 * the bus never announces. Identity has to be re-stated because nothing emits
 * "you are still on this wallet"; balances have to be re-read and priced;
 * gas, block height and merkletree heights have no event at all and are polled;
 * and history is only loaded on request.
 *
 * A factory rather than module functions, because the polling state — the price
 * series, the last gas estimate, the last block — belongs to one deck. Two decks
 * in one process would otherwise share it, which is exactly the kind of hidden
 * global this rebuild exists to remove.
 */
import { NetworkName, delay } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { emitCoreEvent } from "../core/events";
import { getPrivateNFTsForChain } from "../railgun/balance/balance-cache";
import { describeNFTs } from "../railgun/balance/nft-util";
import { fxPositionCollections } from "../railgun/transaction/fx/position";
import {
  poolCollateralSymbol,
  readFxPositionState,
} from "../railgun/transaction/fx/position-state";
import { fxPositionSummary, fxPositionDetailLines } from "./format/fx-position";
import { LEFT_W } from "./layout";
import { mapLimited } from "../util/concurrency";
import { KNOWN_POOLS } from "@railgun-community/cookbook";
import { fmtAmount } from "./format/deck";
import { getState, setState, setStatusMessage } from "./store";
import { pushSeries } from "./format/deck";
import { RailgunDisplayBalance } from "../models/balance-models";
import { CustomGasEstimate } from "../models/gas-models";
import {
  getPrivateBalancesByBucketForChain,
  getPublicERC20BalancesForChain,
} from "../railgun/balance/balance-util";
import { getTokenPricesUSD } from "../price/defillama";
import {
  balanceUSD,
  portfolioTotalUSD,
  formatUSD,
} from "../price/portfolio";
import {
  getCurrentNetwork,
  getTreeHeight,
} from "../railgun/engine/engine";
import {
  getFirstPollingProviderForChain,
  getWrappedTokenInfoForChain,
} from "../railgun/network/network-util";
import {
  getCurrentWalletName,
  getCurrentWalletPublicAddress,
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../railgun/wallet/wallet-util";
import { isWakuConnected } from "../railgun/waku/connect-waku";
import { getGasEstimates } from "../railgun/gas/gas-fee";
import { loadTransactionHistory } from "../railgun/transaction-history";

export interface Feeders {
  refreshIdentity: () => void;
  refreshBalances: () => Promise<void>;
  refreshChainStats: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  /** Latest gas estimate, for the cards. Undefined until the first poll lands. */
  gasEstimate: () => CustomGasEstimate | undefined;
  /** Latest block height, for the cards. Zero until the first poll lands. */
  blockNumber: () => number;
  /** Rolling USD series per symbol, for the sparklines. */
  priceHistory: () => Record<string, number[]>;
  /** Poll chain stats until stopped. */
  startPolling: () => void;
  stopPolling: () => void;
}

/**
 * Cells the rail can give a position's detail line.
 *
 * The rail is LEFT_W wide; take off its border and the row's own indent. A
 * line built for a width nobody checked is how this ended up truncated twice.
 */
const RAIL_DETAIL_W = LEFT_W - 2 - 5;

export const createFeeders = (render: () => void): Feeders => {
  const priceHistory: Record<string, number[]> = {};
  let gasEstimate: CustomGasEstimate | undefined;
  let blockNumber = 0;
  let polling = false;

  /**
   * Re-state who and where we are. Called on a timer as well as after a switch,
   * because a renderer that attaches late has otherwise missed the only
   * announcement it was going to get.
   */
  const refreshIdentity = (): void => {
    try {
      const network = getCurrentNetwork();
      const { symbol } = getWrappedTokenInfoForChain(network);
      emitCoreEvent({
        type: "wallet:changed",
        walletName: getCurrentWalletName(),
        network,
        publicAddress: getCurrentWalletPublicAddress(),
        railgunAddress: getCurrentRailgunAddress(),
        railgunId: getCurrentRailgunID(),
      });
      emitCoreEvent({ type: "network:changed", network, baseSymbol: symbol });
      emitCoreEvent({
        type: "broadcaster:status",
        connected: isWakuConnected(),
      });
    } catch {
      // Reachable before a wallet is loaded; there is simply nothing to state.
    }
  };

  /**
   * The position rows, each with its live risk.
   *
   * Best-effort per position: one that cannot be read still appears, saying so,
   * because a position missing from the portfolio is worse than one with no
   * figures. Bounded, though a wallet holding enough of these for the ceiling
   * to matter does not exist yet.
   */
  const positionRows = async (
    network: NetworkName,
  ): Promise<
    {
      label: string;
      amount: string;
      kind?: string;
      detail?: string;
      detailLines?: string[];
    }[]
  > => {
    const collections = fxPositionCollections();
    const held = describeNFTs(getPrivateNFTsForChain(network), collections);
    return mapLimited(held, 4, async (nft) => {
      const base = { label: nft.label, amount: nft.amount.toString(), kind: nft.kind };
      if (nft.kind !== "fx-position") return base;
      const pool = KNOWN_POOLS.find(
        (p) => p.address.toLowerCase() === nft.nftAddress.toLowerCase(),
      );
      if (!pool) return base;
      const state = await readFxPositionState(
        network,
        pool.name,
        BigInt(nft.tokenSubID),
      ).catch(() => undefined);
      const symbol = poolCollateralSymbol(pool.name);
      const fmt = (a: bigint, d: number) => fmtAmount(formatUnits(a, d), 4);
      return {
        ...base,
        // The rail is 44 cells wide and the row is indented, so it gets what
        // fits; the full picture is a click away rather than chopped in half.
        detail: fxPositionSummary(state, symbol, fmt, RAIL_DETAIL_W),
        detailLines: fxPositionDetailLines(nft.label, state, symbol, fmt),
      };
    });
  };

  const readBalances = async (): Promise<void> => {
    try {
      const network = getCurrentNetwork();
      // Private balances are split per (token, bucket) for display, so funds
      // pending POI are visibly distinct from spendable ones. The send picker
      // deliberately stays spendable-only — see the flow capability matrix.
      const priv = await getPrivateBalancesByBucketForChain(network);
      const pub = await getPublicERC20BalancesForChain(network, true);
      const prices = await getTokenPricesUSD(network, [
        ...new Set([...priv, ...pub].map((b) => b.tokenAddress)),
      ]);

      const format = (b: RailgunDisplayBalance & { unresolved?: boolean }) => {
        if (b.unresolved) {
          // No amount and no USD: both would be derived from decimals nobody
          // could read. The row exists so the holding is visible; the figure
          // arrives when the metadata does.
          return { symbol: b.symbol, amount: "unreadable — retrying", unresolved: true };
        }
        const usd = balanceUSD(b, prices);
        return {
          symbol: b.symbol,
          amount: formatUnits(b.amount, b.decimals),
          usd: usd !== undefined ? formatUSD(usd) : undefined,
        };
      };

      // One sample per distinct symbol: a symbol appears once per bucket, and
      // sampling each would make the sparkline read as volatility.
      const sampled = new Set<string>();
      for (const b of [...priv, ...pub]) {
        // No decimals means no value; sampling it would push a zero into the
        // series and draw a crash that did not happen.
        if ((b as { unresolved?: boolean }).unresolved) continue;
        if (sampled.has(b.symbol)) continue;
        sampled.add(b.symbol);
        priceHistory[b.symbol] = pushSeries(
          priceHistory[b.symbol] ?? [],
          balanceUSD(b, prices) ?? 0,
        );
      }

      const havePrices = Object.keys(prices).length > 0;
      emitCoreEvent({
        type: "balances:updated",
        chain: network,
        private: priv.map((b) => ({ ...format(b), bucket: b.bucket })),
        public: pub.map(format),
        // A position is one indivisible thing, so it carries a count rather
        // than a formatted balance, and no USD — an fx position is worth its
        // collateral minus its debt, which is not a single number.
        //
        // It DOES carry its risk. The rail listed positions by name alone,
        // which says nothing about the one thing a position can do to you
        // while you are not looking; a wallet whose portfolio shows a position
        // approaching rebalance is the only place that gets noticed without
        // going to find it.
        nfts: await positionRows(network),
        // Omitted rather than zero when no price is known — a portfolio total of
        // $0.00 is a claim, and the wrong one.
        privateUSD: havePrices
          ? formatUSD(portfolioTotalUSD(priv.filter((b) => !b.unresolved), prices))
          : undefined,
        publicUSD: havePrices
          ? formatUSD(portfolioTotalUSD(pub, prices))
          : undefined,
      });
    } catch (err) {
      emitCoreEvent({
        type: "log",
        level: "warn",
        text: `[balance] display read failed: ${(err as Error).message}`,
      });
    }
  };

  const refreshChainStats = async (): Promise<void> => {
    try {
      const network = getCurrentNetwork();
      gasEstimate =
        (await getGasEstimates(network).catch(() => gasEstimate)) ?? gasEstimate;
      const hex = await getFirstPollingProviderForChain(network).send(
        "eth_blockNumber",
        [],
      );
      blockNumber = Number(BigInt(hex));

      const [utxo, txid] = await Promise.all([
        getTreeHeight(network, "utxo"),
        getTreeHeight(network, "txid"),
      ]);

      // A tree that is already built emits no scan event, so on boot nothing
      // would ever mark it caught up. Latch it here: built, and not mid-scan.
      const state = getState();
      const utxoReady =
        state.utxoReady ||
        (!!utxo &&
          utxo.leaves > 0 &&
          (state.utxoProgress < 0 || state.utxoProgress >= 100));
      const txidReady =
        state.txidReady ||
        (!!txid &&
          txid.leaves > 0 &&
          (state.txidProgress < 0 || state.txidProgress >= 100));

      setState({
        ...(utxo ? { utxoTree: utxo.tree, utxoLeaves: utxo.leaves } : {}),
        ...(txid ? { txidTree: txid.tree, txidLeaves: txid.leaves } : {}),
        utxoReady,
        txidReady,
      });
      render();
    } catch {
      // Pre-boot, or a provider that is not answering. The next poll retries.
    }
  };

  const readHistory = async (): Promise<void> => {
    try {
      await loadTransactionHistory(
        getCurrentNetwork() as NetworkName,
        getCurrentRailgunID(),
      );
    } catch (err) {
      setStatusMessage(`History failed: ${(err as Error).message}`);
    }
  };

  /**
   * Run `work`, and if more requests arrive while it is running, run it once
   * more afterwards — never concurrently.
   *
   * Both of these read a cache the engine is still filling. The engine emits
   * one balance event per bucket, so `balances:refreshed` arrives in a burst
   * and fired a burst of overlapping reads; each does several awaits (balances,
   * public balances, prices) before emitting, so they finish out of order and
   * the LAST TO FINISH wins — which is not the last to start. A read that began
   * against a half-filled cache could land after one that saw everything, and
   * the rail would sit on the older picture until something happened to trigger
   * another refresh. Which is what "doesn't fully load until you refresh by
   * hand" was.
   *
   * Coalescing rather than dropping: the trailing run is what guarantees the
   * final state reflects the last event, instead of whichever request happened
   * to win the race.
   */
  const coalesce = (work: () => Promise<void>): (() => Promise<void>) => {
    let running = false;
    let again = false;
    return async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await work();
        } while (again);
      } finally {
        running = false;
      }
    };
  };

  const refreshBalances = coalesce(readBalances);
  const refreshHistory = coalesce(readHistory);

  const poll = async (): Promise<void> => {
    while (polling) {
      await refreshChainStats();
      await delay(15 * 1000);
    }
  };

  return {
    refreshIdentity,
    refreshBalances,
    refreshChainStats,
    refreshHistory,
    gasEstimate: () => gasEstimate,
    blockNumber: () => blockNumber,
    priceHistory: () => priceHistory,
    startPolling: () => {
      if (polling) return;
      polling = true;
      void poll();
    },
    stopPolling: () => {
      polling = false;
    },
  };
};
