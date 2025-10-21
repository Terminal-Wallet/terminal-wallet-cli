import { keccak256 } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";

import { getCurrentNetwork } from "../engine/engine";
import { getCurrentEthersWallet } from "../wallet/public-utils";

import {
  populateDeployRailgunMech,
  predictRailgunMechAddress,
  predictRailgunNeuralLinkAddress,
} from "./encoding";

export function mechAddress() {
  return predictRailgunMechAddress({
    railgunNeuralLink: neuralLinkAddress(),
    salt: deploymentSalt(),
  });
}

export function nftAddress() {
  return neuralLinkAddress();
}

export function nftTokenId() {
  const address = mechAddress();
  return BigInt(address);
}

export function mechDeploymentTx() {
  return populateDeployRailgunMech({
    railgunNeuralLink: neuralLinkAddress(),
    salt: deploymentSalt(),
  });
}

function neuralLinkAddress() {
  const { railgunSmartWallet, relayAdapt } = config();
  return predictRailgunNeuralLinkAddress({
    railgunSmartWallet,
    relayAdapt,
  });
}

function deploymentSalt() {
  const wallet = getCurrentEthersWallet();
  return keccak256(wallet.signMessageSync("RailgunMech Deployment"));
}

function config() {
  const network = getCurrentNetwork();

  const RelayAdaptContract: Record<NetworkName, string> = {
    // Main nets
    [NetworkName.Ethereum]: "0xAc9f360Ae85469B27aEDdEaFC579Ef2d052aD405",
    [NetworkName.BNBChain]: "0xF82d00fC51F730F42A00F85E74895a2849ffF2Dd",
    [NetworkName.Polygon]: "0xF82d00fC51F730F42A00F85E74895a2849ffF2Dd",
    [NetworkName.Arbitrum]: "0xB4F2d77bD12c6b548Ae398244d7FAD4ABCE4D89b",

    // Test nets
    [NetworkName.EthereumSepolia]: "0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D",
    [NetworkName.PolygonAmoy]: "0xc340f7E17A42154674d6B50190386C9a2982D12E",

    // Dev only
    [NetworkName.Hardhat]: "0x0355B7B8cb128fA5692729Ab3AAa199C1753f726",

    // Deprecated
    [NetworkName.EthereumRopsten_DEPRECATED]: "",
    [NetworkName.EthereumGoerli_DEPRECATED]: "",
    [NetworkName.ArbitrumGoerli_DEPRECATED]: "",
    [NetworkName.PolygonMumbai_DEPRECATED]: "",
  };

  const RailgunProxyContract: Record<NetworkName, string> = {
    // Main nets
    [NetworkName.Ethereum]: "0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9",
    [NetworkName.BNBChain]: "0x590162bf4b50f6576a459b75309ee21d92178a10",
    [NetworkName.Polygon]: "0x19b620929f97b7b990801496c3b361ca5def8c71",
    [NetworkName.Arbitrum]: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9",

    // Test nets
    [NetworkName.EthereumSepolia]: "0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea",
    [NetworkName.PolygonAmoy]: "0xD1aC80208735C7f963Da560C42d6BD82A8b175B5",

    // Dev only
    [NetworkName.Hardhat]: "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",

    // Deprecated
    [NetworkName.EthereumRopsten_DEPRECATED]: "",
    [NetworkName.EthereumGoerli_DEPRECATED]: "",
    [NetworkName.ArbitrumGoerli_DEPRECATED]: "",
    [NetworkName.PolygonMumbai_DEPRECATED]: "",
  };

  return {
    railgunSmartWallet: RailgunProxyContract[network],
    relayAdapt: RelayAdaptContract[network],
  };
}
