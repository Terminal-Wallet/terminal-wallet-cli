import {
  Chain,
  NETWORK_CONFIG,
  NetworkName,
} from "@railgun-community/shared-models";
import { WrappedTokenInfo } from "../models/token-models";
import configDefaults from "../config/config-defaults";
import { HDNodeWallet, JsonRpcProvider, Mnemonic, Wallet } from "ethers";
import { getFallbackProviderForNetwork } from "@railgun-community/wallet";

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
    .provider as JsonRpcProvider;
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
