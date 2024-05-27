import { Chain, NetworkName } from "@railgun-community/shared-models";
import { getChainForName } from "../network/network-util";
import {
  WakuBroadcasterClient,
  WakuBroadcasterTransaction,
  BroadcasterOptions,
} from "../models/waku-models";

let wakuBroadcasterTransaction: WakuBroadcasterTransaction;
let wakuLoaded = false;
let isConnected = false;

const broadcasterOptions: BroadcasterOptions = {
  pubSubTopic: "/waku/2/railgun-broadcaster",
  additionalDirectPeers: [],
};

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
  await wakuClient.start(chain, broadcasterOptions, wakuStatusCallback);
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
