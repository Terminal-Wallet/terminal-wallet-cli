/** Network fixtures. */
import { NetworkName } from "@railgun-community/shared-models";

export const defaultNetwork = NetworkName.Ethereum;

export const NETWORKS = {
  ethereum: NetworkName.Ethereum,
  polygon: NetworkName.Polygon,
  arbitrum: NetworkName.Arbitrum,
  bsc: NetworkName.BNBChain,
} satisfies Record<string, NetworkName>;
