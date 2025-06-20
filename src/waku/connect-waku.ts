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

const broadcasterOptions: BroadcasterOptions = {
  pubSubTopic: "/waku/2/rs/0/1",
  additionalDirectPeers: [],
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

export let wakuClient: WakuBroadcasterClient;

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

export let baseAllowList: string[] | undefined = undefined;
export let baseBlockList: string[] | undefined = undefined;

