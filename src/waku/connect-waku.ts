import { Chain, NetworkName } from "@railgun-community/shared-models";
import { getChainForName, remoteConfig } from "../network/network-util";
import {
  WakuBroadcasterClient,
  WakuBroadcasterTransaction,
  BroadcasterOptions,
} from "../models/waku-models";

let wakuBroadcasterTransaction: WakuBroadcasterTransaction;
let wakuLoaded = false;
let isConnected = false;
export let baseAllowList: string[] | undefined = undefined;
export let baseBlockList: string[] | undefined = undefined;
export let wakuClient: WakuBroadcasterClient;

const trustedFeeSigner = '0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k'
const broadcasterOptions: BroadcasterOptions = {
  trustedFeeSigner,
};



export const initializeLists = (allowList: string[], blockList: string[]) => {
  baseAllowList = allowList.length > 0 ? allowList : undefined;
  baseBlockList = blockList.length > 0 ? blockList : undefined;
  wakuClient.setAddressFilters(baseAllowList, baseBlockList);
}

const wakuStatusCallback = (chain: Chain, status: string) => {
  if (status === "Connected") {
    isConnected = true;
  } else {
    isConnected = false;
  }
};


export const isWakuLoaded = () => {
  return wakuLoaded;
};

export const isWakuConnected = () => {
  return isConnected;
};

export const getWakuClient = () => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded.");
  }
  return wakuClient;
};

export const getWakuTransaction = () => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded.");
  }
  return wakuBroadcasterTransaction;
};

export const initWakuClient = async () => {
  if (isWakuLoaded()) {
    return;
  }
  const waku = await import("@railgun-community/waku-broadcaster-client-node");
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  wakuClient = waku.WakuBroadcasterClient; // as WakuBroadcasterClient;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  wakuBroadcasterTransaction = waku.BroadcasterTransaction; // as WakuBroadcasterTransaction;
  wakuLoaded = true;
  initializeLists(remoteConfig.bootstrap, remoteConfig.blacklist)
};

export const switchWakuNetwork = async (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  await wakuClient.setChain(chain);
};

export const startWakuClient = async (chainName: NetworkName) => {
  if (!isWakuLoaded()) {
    throw new Error("Waku Client is not Loaded");
  }
  if (!wakuClient) {
    throw new Error("No Waku Client?...");
  }
  const chain = getChainForName(chainName);
  const peerOverrides = remoteConfig.additionalDirectPeers ?? [];
  broadcasterOptions.additionalDirectPeers = peerOverrides;
  broadcasterOptions.pubSubTopic = remoteConfig.wakuPubSubTopic;
  wakuClient.start(chain, broadcasterOptions, wakuStatusCallback, undefined);
};

export const stopWakuClient = async () => {
  if (!wakuClient) {
    return;
  }
  await wakuClient?.stop();
};

export const resetWakuClient = async () => {
  await wakuClient.tryReconnect();
};


