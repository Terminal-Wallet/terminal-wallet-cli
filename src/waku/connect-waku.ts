import { Chain, NetworkName } from "@railgun-community/shared-models";
import { getChainForName } from "../network/network-util";
import {
  WakuRelayerClient,
  WakuRelayerTransaction,
  RelayerOptions,
} from "../models/waku-models";

let wakuRelayerTransaction: WakuRelayerTransaction;
let wakuLoaded = false;
let isConnected = false;

const relayerOptions: RelayerOptions = {
  pubSubTopic: "/waku/2/railgun-relayer",
  additionalDirectPeers: [
  ],
};

const wakuStatusCallback = (chain: Chain, status: string) => {
  if (status === "Connected") {
    isConnected = true;
  } else {
    isConnected = false;
  }
};

export let wakuClient: WakuRelayerClient;

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
  return wakuRelayerTransaction;
};

export const initWakuClient = async () => {
  if (isWakuLoaded()) {
    return;
  }
  const waku = await import("@railgun-community/waku-relayer-client-node");
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  wakuClient = waku.WakuRelayerClient as WakuRelayerClient;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  wakuRelayerTransaction = waku.RelayerTransaction as WakuRelayerTransaction;
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
  await wakuClient.start(chain, relayerOptions, wakuStatusCallback);
};

export const stopWakuClient = async () => {
  await wakuClient.stop();
};

export const resetWakuClient = async () => {
  await wakuClient.tryReconnect();
};
