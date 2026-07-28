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

  const refreshBalances = async (): Promise<void> => {
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

      const format = (b: RailgunDisplayBalance) => {
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
        // collateral minus its debt, which is a read the rail does not do.
        nfts: describeNFTs(
          getPrivateNFTsForChain(network),
          fxPositionCollections(),
        ).map((nft) => ({
          label: nft.label,
          amount: nft.amount.toString(),
          kind: nft.kind,
        })),
        // Omitted rather than zero when no price is known — a portfolio total of
        // $0.00 is a claim, and the wrong one.
        privateUSD: havePrices
          ? formatUSD(portfolioTotalUSD(priv, prices))
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

  const refreshHistory = async (): Promise<void> => {
    try {
      await loadTransactionHistory(
        getCurrentNetwork() as NetworkName,
        getCurrentRailgunID(),
      );
    } catch (err) {
      setStatusMessage(`History failed: ${(err as Error).message}`);
    }
  };

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
