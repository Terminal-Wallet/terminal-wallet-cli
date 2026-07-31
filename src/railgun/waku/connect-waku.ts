import {
  Chain,
  isDefined,
  NetworkName,
} from "@railgun-community/shared-models";
import { getChainForName, remoteConfig } from "../network/network-util";
import {
  WakuBroadcasterClient,
  WakuBroadcasterTransaction,
  BroadcasterOptions,
} from "../../models/waku-models";

let wakuBroadcasterTransaction: WakuBroadcasterTransaction;
let wakuLoaded = false;
let isConnected = false;
export let baseAllowList: string[] | undefined = undefined;
export let baseBlockList: string[] | undefined = undefined;
export let wakuClient: WakuBroadcasterClient;

const trustedFeeSigner =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";
const broadcasterOptions: BroadcasterOptions = {
  trustedFeeSigner,
};

/**
 * Normalize a config value that is declared `string | string[]`.
 *
 * The filter these feed does `allowlist.includes(address)`. On an array that is
 * a membership test; on a string it is a SUBSTRING test, which is a different
 * question with a coincidentally similar answer.
 */
const asList = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * The broadcaster address filters.
 *
 * An empty allow list means "no address restriction" — the SDK's filter is
 * `!allowlist || allowlist.includes(address)`, so `undefined` admits everyone
 * and a populated list admits ONLY its members.
 *
 * That last part is why this is not handed the trusted fee signer. It used to
 * be: `initializeLists(remoteConfig.trustedFeeSigner as string[], …)`, which
 * set the allow list to a single fee-signer address and therefore filtered
 * every broadcaster except that one out of existence — a favourite could never
 * become available, because it was never in the list to begin with. The two are
 * unrelated controls. Fee-signature trust is enforced by the SDK through
 * `broadcasterOptions.trustedFeeSigner`, which is set separately in
 * `startWakuClient` and is untouched by this.
 */
export const initializeLists = (allowList: string[], blockList: string[]) => {
  baseAllowList = allowList.length > 0 ? allowList : undefined;
  baseBlockList = blockList.length > 0 ? blockList : undefined;
  wakuClient.setAddressFilters(baseAllowList, baseBlockList);
};

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
  // No address allow list: every broadcaster is admitted, minus the blocklist.
  // The trusted fee signer is NOT an allow list — see initializeLists.
  initializeLists([], asList(remoteConfig.blacklist));
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
  // const peerOverrides = remoteConfig.additionalDirectPeers ?? [];
  // broadcasterOptions.additionalDirectPeers = peerOverrides;
  broadcasterOptions.pubSubTopic = "/waku/2/rs/5/1"; //remoteConfig.wakuPubSubTopic;
  if (isDefined(remoteConfig.trustedFeeSigner)) {
    broadcasterOptions.trustedFeeSigner = remoteConfig.trustedFeeSigner;
  }
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
