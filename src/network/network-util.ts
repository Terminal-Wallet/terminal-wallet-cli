import {
  Chain,
  FallbackProviderJsonConfig,
  NETWORK_CONFIG,
  NetworkName,
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
export const getFallbackProviderForChain = (chainName: NetworkName) => {
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

export const getProviderForChain = (chainName: NetworkName) => {
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


export const loadConfigForNetwork = async () => {

  // Remote config will be added to a single chain;
  // optional ENVIRONMENT variable REMOTE_CONFIG_RPC to an rpc on Ethereum.
  // the OFFICIAL remote-config contract address is 0x5e982525d50046A813DBf55Ae72a3E00e99fbC94

  // mac/linux
  // export REMOTE_CONFIG_RPC=http...

  // windows cmd
  // set REMOTE_CONFIG_RPC=http..

  const remoteConfigUrl = process.env.REMOTE_CONFIG_RPC ?? 'https://eth.llamarpc.com';
  const remoteConfigContract = '0x5e982525d50046A813DBf55Ae72a3E00e99fbC94'
  const provider = new JsonRpcProvider(remoteConfigUrl);
  const contract = new Contract(remoteConfigContract, [
    'function getConfig() public view returns (string memory str)',
  ], provider);

  const raw = await contract.getConfig();
  const config = JSON.parse(raw) as RemoteConfig;
  remoteConfig = config;
  return config;
}