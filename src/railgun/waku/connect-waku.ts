import {
  Chain,
  isDefined,
  NetworkName,
} from "@railgun-community/shared-models";
import { getChainForName, remoteConfig } from "../network/network-util";
import { createLogger } from "../../platform/logger";
import {
  WakuBroadcasterClient,
  WakuBroadcasterTransaction,
  BroadcasterOptions,
} from "../../models/waku-models";

const log = createLogger("waku");

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
  const signers =
    configured.length > 0 ? configured : [DEFAULT_TRUSTED_FEE_SIGNER];
  // Lowercased because the two filters disagree about case. `AddressFilter`
  // does an exact `includes`, while the SDK's fee-signer check lowercases both
  // sides — so a config carrying a mixed-case address would pass fee trust and
  // still match nothing here, removing every broadcaster with no indication
  // why. 0zk addresses are bech32 and therefore canonically lowercase, which is
  // what makes normalizing safe rather than merely hopeful.
  return signers.map((address) => address.toLowerCase());
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
  const signers = trustedFeeSigners();
  const blocked = asList(remoteConfig.blacklist);
  // The signer count decides how many broadcasters exist as far as this app is
  // concerned, and it arrives from an on-chain artifact that is edited by hand.
  // A publish that dropped four of five, or shipped a bare string where a list
  // was meant, is otherwise silent until it surfaces much later as "no
  // broadcasters available for your tokens".
  const configured = isDefined(remoteConfig.trustedFeeSigner);
  log.info(
    `broadcaster allow list: ${signers.length} trusted fee signer(s)` +
      `${configured ? "" : " (remote config carried none — using the built-in)"}` +
      `, ${blocked.length} blocked`,
  );
  initializeLists(signers, blocked);
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
