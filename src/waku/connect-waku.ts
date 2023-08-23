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
    "/dns4/relayerv4.wecamefromapes.com/tcp/8000/wss/p2p/16Uiu2HAmCMBVq9am26T61B7FyZ6JbEDusH4c7M7AYVMwNnRuP2cg",
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
  const { RailgunWakuRelayerClient, RelayerTransaction } = (await import(
    "@railgun-community/waku-relayer-client"
  )) as {
    RailgunWakuRelayerClient: WakuRelayerClient;
    RelayerTransaction: WakuRelayerTransaction;
  };
  wakuClient = RailgunWakuRelayerClient;
  wakuRelayerTransaction = RelayerTransaction;
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
