import {
  Chain,
  FallbackProviderJsonConfig,
  NETWORK_CONFIG,
  NetworkName,
  isDefined,
} from "@railgun-community/shared-models";
import { WrappedTokenInfo } from "../models/token-models";
import configDefaults from "../config/config-defaults";
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet } from "ethers";
import { getFallbackProviderForNetwork } from "@railgun-community/wallet";
import { RemoteConfig } from "../models/network-models";

export const getChainForName = (chainName: NetworkName): Chain => {
  return NETWORK_CONFIG[chainName].chain;
};

export const getWrappedTokenInfoForChain = (
  chainName: NetworkName,
): WrappedTokenInfo => {
  const { symbol, wrappedSymbol, wrappedAddress, decimals } =
    NETWORK_CONFIG[chainName].baseToken;
  const { shortPublicName } = NETWORK_CONFIG[chainName];
  return { symbol, decimals, wrappedSymbol, wrappedAddress, shortPublicName };
};

export const getTransactionURLForChain = (
  chainName: NetworkName,
  txHash: string,
) => {
  const { blockscan } = configDefaults.networkConfig[chainName];
  return `${blockscan}tx/${txHash}`;
};

export const getRailgunProxyAddressForChain = (chainName: NetworkName) => {
  return NETWORK_CONFIG[chainName].proxyContract;
};

export const getRailgunRelayAdaptAddressForChain = (chainName: NetworkName) => {
  return NETWORK_CONFIG[chainName].relayAdaptContract;
};

export const getProviderURLForChain = (chainName: NetworkName) => {
  return configDefaults.networkConfig[chainName].providers[0].provider;
};

export const getProviderForURL = (rpcEndpoint: string) => {
  return new JsonRpcProvider(rpcEndpoint);
};

// gas estimates should use this
export const getFallbackProviderForChain = (chainName: NetworkName): ReturnType<typeof getFallbackProviderForNetwork> => {
  return getFallbackProviderForNetwork(chainName);
};

// sending transactions should use this.
export const getFirstPollingProviderForChain = (
  chainName: NetworkName,
): JsonRpcProvider => {
  const fallbackProvider = getFallbackProviderForChain(chainName);
  return fallbackProvider.provider.providerConfigs[0]
    .provider as unknown as JsonRpcProvider;
};

export const getProviderForChain = (chainName: NetworkName): ReturnType<typeof getFallbackProviderForNetwork> => {
  return getFallbackProviderForChain(chainName);
};

export const getEthersWallet = (
  mnemonic: string,
  derivationIndex: number,
  chainName: NetworkName,
): Wallet => {
  const derivationPathIndex = `m/44'/60'/0'/0/${derivationIndex}`;
  const provider = getFirstPollingProviderForChain(chainName);
  const walletInfo = HDNodeWallet.fromMnemonic(
    Mnemonic.fromPhrase(mnemonic),
    derivationPathIndex,
  );
  const wallet = new Wallet(walletInfo.privateKey, provider);
  return wallet;
};


export let remoteConfig: RemoteConfig;


// Set the active remote config (used to install the built-in fallback when the remote fetch or
// parse fails, so the app runs on baked-in defaults instead of exiting).
export const setRemoteConfig = (config: RemoteConfig) => {
  remoteConfig = config;
};

// Fetch the remote config. Returns undefined on any failure (fetch or parse) — the caller falls
// back to the built-in default config rather than the app hard-exiting.
export const loadConfigForNetwork = async (): Promise<
  RemoteConfig | undefined
> => {
  // Remote config will be added to a single chain;
  // optional ENVIRONMENT variable REMOTE_CONFIG_RPC to an rpc on Ethereum.
  // the OFFICIAL remote-config contract address is 0x5e982525d50046A813DBf55Ae72a3E00e99fbC94

  // mac/linux
  // export REMOTE_CONFIG_RPC=http...

  // windows cmd
  // set REMOTE_CONFIG_RPC=http..

  const remoteConfigUrl =
    process.env.REMOTE_CONFIG_RPC ?? "https://ethereum-rpc.publicnode.com";
  const remoteConfigContract = '0x5e982525d50046A813DBf55Ae72a3E00e99fbC94'
  const provider = new JsonRpcProvider(remoteConfigUrl);
  const contract = new Contract(remoteConfigContract, [
    'function getConfig() public view returns (string memory str)',
  ], provider);


  const raw = await contract.getConfig().catch((err: any) => {
    // Log only the host — a user-supplied REMOTE_CONFIG_RPC may embed an API key.
    let host = remoteConfigUrl;
    try {
      ({ host } = new URL(remoteConfigUrl));
    } catch {
      /* keep as-is if not a parseable URL */
    }
    console.error(`[remote-config] Failed to fetch config from ${host}. ${err.message}`);
    console.error(
      '[remote-config] Falling back to built-in defaults. Set REMOTE_CONFIG_RPC to a healthy Ethereum RPC to use remote config.',
    );
    return undefined;
  });
  if (!isDefined(raw)) {
    return undefined;
  }
  try {
    const config = JSON.parse(raw) as RemoteConfig;
    remoteConfig = config;
    return config;
  } catch (err) {
    console.error(
      `[remote-config] Failed to parse config; falling back to built-in defaults. ${(err as Error).message}`,
    );
    return undefined;
  }
}