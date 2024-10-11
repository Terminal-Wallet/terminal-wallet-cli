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
import { ChainIDToNameMap } from "../models/network-models";
import { getCurrentNetwork, rescanBalances } from "../engine/engine";
import { walletManager } from "./wallet-manager";
import { setStatusText } from "../ui/status-ui";

export const merkelTreeScanCallback = async (
  callbackInfo: MerkletreeScanUpdateEvent,
) => {
  walletManager.balanceScanProgress = callbackInfo.progress * 100;

  if (callbackInfo.scanStatus === "Complete") {
    walletManager.merkelScanComplete = true;
  }
  if (callbackInfo.scanStatus === "Incomplete") {
    rescanBalances(getCurrentNetwork());
  }
};

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

  for (const bucketType in buckets) {
    if (walletManager.merkelScanComplete) {
      const balanceEvent = buckets[bucketType];
      const { chain } = balanceEvent;
      const chainName = ChainIDToNameMap[chain.id];
      await updatePrivateBalancesForChain(chainName, balanceEvent);
      await updatePublicBalancesForChain(chainName);
      if (!walletManager.menuLoaded) {
        walletManager.menuLoaded = true;
      }
    }
  }

  delete walletManager.latestPrivateBalanceEvents;
  walletManager.latestPrivateBalanceEvents = [];
};

export const scanBalancesCallback = async (
  tokenBalances: RailgunBalancesEvent,
) => {
  walletManager.latestPrivateBalanceEvents?.push(tokenBalances);
};

export const latestBalancePoller = async (pollingInterval: number) => {
  await formatLatestBalancesEvent().catch((err) => {
    setStatusText(err.message);
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
    setStatusText(poiStatus, 15000, true);
  }
};

export const batchListCallback = async (batchListProgressEvent: BatchListUpdateEvent) =>{
  const status = `${batchListProgressEvent.status}`
  if(status.includes('100%')){
    setStatusText(status, 15000, false);
  } else {
    setStatusText(status, 15000, false);

  }
}
