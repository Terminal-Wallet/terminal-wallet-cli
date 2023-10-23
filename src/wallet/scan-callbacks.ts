import {
  MerkletreeScanUpdateEvent,
  POIProofProgressEvent,
  RailgunBalancesEvent,
  delay,
  isDefined,
} from "@railgun-community/shared-models";
import {
  updatePrivateBalancesForChain,
  updatePublicBalancesForChain,
} from "../balance/balance-cache";
import { readableAmounts } from "../util/util";
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
  for (const balanceEvent of walletManager.latestPrivateBalanceEvents) {
    if (walletManager.merkelScanComplete) {
      const { chain } = balanceEvent;
      const chainName = ChainIDToNameMap[chain.id];
      await updatePrivateBalancesForChain(chainName, balanceEvent);
      await updatePublicBalancesForChain(chainName);
      // const dispTokenBalances = await readableAmounts(erc20Amounts, chainName);
      // walletManager.privateBalanceCache = dispTokenBalances;
      if (!walletManager.menuLoaded) {
        // NEED TODO: rename menuLoaded to be more clearly defined, idk what to rename yet.
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

export const poiScanCallback = async (
  poiProgressEvent: POIProofProgressEvent
) => {
  walletManager.poiProgressEvent = poiProgressEvent;
  const poiStatus = `POI Proof Generation Progress: ${poiProgressEvent.progress.toFixed(
    2,
  )}`;
  setStatusText(poiStatus);
}


// generatePOIsForWallet
// refreshReceivePOIsForWallet
// refreshSpentPOIsForWallet