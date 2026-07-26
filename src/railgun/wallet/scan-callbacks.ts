import {
  MerkletreeScanUpdateEvent,
  POIProofEventStatus,
  POIProofProgressEvent,
  RailgunBalancesEvent,
  delay,
  isDefined,
} from "@railgun-community/shared-models";
import { type BatchListUpdateEvent} from "@railgun-community/wallet"
import {
  updatePrivateBalancesForChain,
  updatePublicBalancesForChain,
} from "../balance/balance-cache";
import { ChainIDToNameMap } from "../../models/network-models";
import { NetworkName } from "@railgun-community/shared-models";
import { getCurrentNetwork, rescanBalances, getTreeHeight } from "../engine/engine";
import { walletManager } from "./wallet-manager";
import { emitCoreEvent } from "../../core/events";

const currentChain = (): NetworkName | undefined => {
  try {
    return getCurrentNetwork();
  } catch {
    return undefined; // pre-boot
  }
};

/**
 * "Incomplete" is how the engine asks to CONTINUE to the next batch, so it must
 * not be throttled or a cold sync stalls and balances stop loading. What has to
 * be prevented is OVERLAPPING full scans: if Incomplete fires again while our
 * rescan is still running, skip this one — the next Incomplete continues.
 */
let rescanInFlight = false;

/**
 * The wallet is fully synced only once BOTH merkletrees report Complete.
 * Progress alone is not a completion gate: a cold sync churns Incomplete →
 * rescan and can sit near 100% for a long time without being done.
 */
type Tree = "utxo" | "txid";
const treeDone: Record<Tree, boolean> = { utxo: false, txid: false };
const lastStatus: Record<Tree, string> = { utxo: "", txid: "" };

const log = (text: string, level: "info" | "warn" | "error" = "info") =>
  emitCoreEvent({ type: "log", level, text });

/**
 * One callback per merkletree, reporting progress as core events.
 *
 * Registered for both trees. The renderer draws a bar per tree and only calls
 * the wallet synced when both have finished, so a single shared callback cannot
 * express what it needs — and without any producer at all, the bars never move
 * and nothing re-reads balances when a scan lands.
 */
const makeMerkletreeScanCallback =
  (tree: Tree) => async (callbackInfo: MerkletreeScanUpdateEvent) => {
    const pct = callbackInfo.progress * 100;
    if (tree === "utxo") walletManager.balanceScanProgress = pct;

    const chainName = currentChain();
    // Live height (<tree#>:<leaves>) so a cold sync shows real numbers rather
    // than a percentage that means little on its own.
    const height = chainName ? await getTreeHeight(chainName, tree) : undefined;
    emitCoreEvent({
      type: "scan:progress",
      chain: chainName,
      tree,
      progress: pct,
      treeNumber: height?.tree,
      leaves: height?.leaves,
    });

    // Transitions only — logging every progress tick would bury the pane.
    if (callbackInfo.scanStatus !== lastStatus[tree]) {
      lastStatus[tree] = callbackInfo.scanStatus;
      log(`[scan] ${tree} merkletree ${callbackInfo.scanStatus} (${pct.toFixed(0)}%)`);
    }

    if (callbackInfo.scanStatus === "Started" || callbackInfo.scanStatus === "Updated") {
      treeDone[tree] = false;
    }
    if (callbackInfo.scanStatus === "Complete") {
      treeDone[tree] = true;
      if (tree === "utxo") rescanInFlight = false;
      emitCoreEvent({ type: "scan:complete", chain: currentChain(), tree });
      if (treeDone.utxo && treeDone.txid) {
        walletManager.merkelScanComplete = true;
        log("[scan] historical sync complete (utxo + txid)");
      }
    }

    // Only the UTXO tree drives the balance-rescan continuation; the TXID tree
    // continues its own scan internally.
    if (tree === "utxo" && callbackInfo.scanStatus === "Incomplete" && !rescanInFlight) {
      rescanInFlight = true;
      rescanBalances(getCurrentNetwork()).finally(() => {
        rescanInFlight = false;
      });
    }
  };

export const utxoMerkletreeScanCallback = makeMerkletreeScanCallback("utxo");
export const txidMerkletreeScanCallback = makeMerkletreeScanCallback("txid");

export const formatLatestBalancesEvent = async () => {
  const currentPrivateBalances = walletManager.latestPrivateBalanceEvents;
  if (!isDefined(currentPrivateBalances)) {
    walletManager.latestPrivateBalanceEvents = [];
    return;
  }
  if (!isDefined(walletManager.latestPrivateBalanceEvents)) {
    return;
  }

  // sort into each balance bucket, only take the latest one.
  const buckets: MapType<RailgunBalancesEvent> = {};
  for (const balanceEvent of walletManager.latestPrivateBalanceEvents) {
    buckets[balanceEvent.balanceBucket] = balanceEvent;
  }

  // Applied as they arrive rather than gated on merkelScanComplete: these
  // events are authoritative from the engine, and under a cold sync the
  // merkletree scan churns Incomplete → rescan and may not report Complete for
  // a long time. Gating on it meant balances stayed empty for the whole of it.
  let updated = false;
  for (const bucketType in buckets) {
    const balanceEvent = buckets[bucketType];
    const { chain } = balanceEvent;
    const chainName = ChainIDToNameMap[chain.id];
    await updatePrivateBalancesForChain(chainName, balanceEvent);
    await updatePublicBalancesForChain(chainName);
    updated = true;
    if (!walletManager.menuLoaded) {
      walletManager.menuLoaded = true;
    }
  }

  delete walletManager.latestPrivateBalanceEvents;
  walletManager.latestPrivateBalanceEvents = [];

  // The cache moved — whoever derives balances from it should re-read.
  if (updated) emitCoreEvent({ type: "balances:refreshed", chain: currentChain() });
};

export const scanBalancesCallback = async (
  tokenBalances: RailgunBalancesEvent,
) => {
  walletManager.latestPrivateBalanceEvents?.push(tokenBalances);
};

export const latestBalancePoller = async (pollingInterval: number) => {
  await formatLatestBalancesEvent().catch((err) => {
    emitCoreEvent({ type: "status:message", text: err.message });
  });
  await delay(pollingInterval);
  latestBalancePoller(pollingInterval);
};

export const getPOIStatusString = () => {
  const event = walletManager.poiProgressEvent;
  const status = `POI Status: ${event.status} | TX: ${event.index}/${event.totalCount
    } | Progress: ${event.progress.toFixed(2)}\nTxID: ${event.txid
    }\nPOI List ID: ${event.listKey}`;

  return status;
};

export const poiScanCallback = async (poiProgressEvent: POIProofProgressEvent) => {
  walletManager.poiProgressEvent = poiProgressEvent;

  if (poiProgressEvent.status === POIProofEventStatus.InProgress) {
    const poiStatus = getPOIStatusString();
    emitCoreEvent({
      type: "status:message",
      text: poiStatus,
      durationMs: 15000,
      replace: true,
    });
  }
};

export const batchListCallback = async (batchListProgressEvent: BatchListUpdateEvent) =>{
  const status = `${batchListProgressEvent.status}`
  if(status.includes('100%')){
    emitCoreEvent({
      type: "status:message",
      text: status,
      durationMs: 15000,
    });
  } else {
    emitCoreEvent({
      type: "status:message",
      text: status,
      durationMs: 15000,
    });

  }
}
