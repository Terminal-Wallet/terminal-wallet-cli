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

const DEFAULT_TRUSTED_FEE_SIGNER =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";
const broadcasterOptions: BroadcasterOptions = {
  trustedFeeSigner: DEFAULT_TRUSTED_FEE_SIGNER,
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
 * The trusted fee signers, and so the only broadcasters this app will use.
 *
 * Falls back to the baked-in signer rather than to an empty list. An empty
 * allow list is not a stricter filter but the absence of one, so a remote
 * config that failed to load — the case `fallbackRemoteConfig` exists for —
 * would otherwise widen the app from one permitted broadcaster to every
 * broadcaster on the network, exactly when least is known about them.
 */
export const trustedFeeSigners = (): string[] => {
  const configured = asList(remoteConfig.trustedFeeSigner);
  return configured.length > 0 ? configured : [DEFAULT_TRUSTED_FEE_SIGNER];
};

/**
 * The broadcaster address filters.
 *
 * An empty allow list means "no address restriction" — the SDK's filter is
 * `!allowlist || allowlist.includes(address)`, so `undefined` admits everyone
 * and a populated list admits ONLY its members.
 *
 * The allow list is the trusted fee signers. Both sides of the SDK's filter
 * speak the same address space: `AddressFilter.filter` runs over the keys of
 * the fee cache, which are `feeMessageData.railgunAddress` — the exact field
 * `trustedFeeSigner` is matched against when a fee message arrives. So an
 * address that can sign an authorized fee is a broadcaster address, and
 * restricting the filter to that set restricts the app to those broadcasters.
 *
 * This is deliberately narrower than the SDK's own trust model. On its own,
 * `broadcasterOptions.trustedFeeSigner` admits an untrusted broadcaster whose
 * quote falls within a variance band of an authorized fee; the allow list
 * removes that band and leaves only the signers themselves. A favourite that is
 * not a trusted signer therefore never becomes selectable — intended, since a
 * favourite is a preference among permitted broadcasters, not a grant.
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
  initializeLists(trustedFeeSigners(), asList(remoteConfig.blacklist));
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
