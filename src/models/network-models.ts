import {
  ChainType,
  NetworkName,
  ProviderJson,
} from "@railgun-community/shared-models";

export enum ChainIDs {
  Ethereum = 1,
  EthereumGoerli = 5,
  BNBChain = 56,
  PolygonPOS = 137,
  Arbitrum = 42161,
  Hardhat = 31337,
  PolygonMumbai = 80001,
  ArbitrumGoerli = 421613,
}

export const ChainIDToNameMap: NumMapType<NetworkName> = {
  [ChainIDs.Ethereum]: NetworkName.Ethereum,
  [ChainIDs.EthereumGoerli]: NetworkName.EthereumGoerli_DEPRECATED,
  [ChainIDs.BNBChain]: NetworkName.BNBChain,
  [ChainIDs.PolygonPOS]: NetworkName.Polygon,
  [ChainIDs.Arbitrum]: NetworkName.Arbitrum,
  [ChainIDs.Hardhat]: NetworkName.Hardhat,
  [ChainIDs.PolygonMumbai]: NetworkName.PolygonMumbai_DEPRECATED,
  [ChainIDs.ArbitrumGoerli]: NetworkName.ArbitrumGoerli_DEPRECATED,
};

export type ChainTypeMap<T> = {
  [index in ChainType]: T;
};
export type MapChainIDs<T> = {
  [index in ChainIDs]: T;
};

export type JsonProviderConfig = {
  chainId: number;
  providers: ProviderJson[];
};

export const getProviderObjectFromURL = (rpcURL: string): ProviderJson => {
  return {
    provider: rpcURL,
    priority: 3,
    weight: 2,
    stallTimeout: 2500,
    maxLogsPerBatch: 2,
  };
};

type APIKey = "zeroXApi" | string

type APIKeys = Record<APIKey, string>;

type FeatureFlags = {
  canSendPublic: boolean;
  canSendShielded: boolean;
  canShield: boolean;
  canUnshield: boolean;
  canSwapPublic: boolean;
  canSwapShielded: boolean;
  canRelayAdapt: boolean;
}

type ChainConfig = {
  name: NetworkName;
  providers: (string | ProviderJson)[]; // looks for 'provider' in or typeof == 'string'
  flags?: FeatureFlags;
}


type RPCConfig = Record<number, ChainConfig>;


export type RemoteConfig = {
  currentVersionNumber: string;
  minVersionNumber: string;
  bootstrap: string[];
  wakuPubSubTopic: string;
  additionalDirectPeers: string[];
  publicPoiAggregatorUrls: string[];
  blacklist: string[];
  apiKeys?: APIKeys;
  network: RPCConfig;
}