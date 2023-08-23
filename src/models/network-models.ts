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
  [ChainIDs.EthereumGoerli]: NetworkName.EthereumGoerli,
  [ChainIDs.BNBChain]: NetworkName.BNBChain,
  [ChainIDs.PolygonPOS]: NetworkName.Polygon,
  [ChainIDs.Arbitrum]: NetworkName.Arbitrum,
  [ChainIDs.Hardhat]: NetworkName.Hardhat,
  [ChainIDs.PolygonMumbai]: NetworkName.PolygonMumbai,
  [ChainIDs.ArbitrumGoerli]: NetworkName.ArbitrumGoerli,
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
    priority: 1,
    weight: 1,
    stallTimeout: 2500,
    maxLogsPerBatch: 20,
  };
};
