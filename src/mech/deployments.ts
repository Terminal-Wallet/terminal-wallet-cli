import { keccak256, ZeroHash } from "ethers";
import {
  RailgunProxyContract,
  RelayAdaptContract,
} from "@railgun-community/shared-models";

import { getCurrentNetwork } from "../engine/engine";
import { getCurrentEthersWallet } from "../wallet/public-utils";
import configDefaults from "../config/config-defaults";
import { encodeMechCreate, predictMechAddress } from "./encode";

// universal addresses:
const erc6551Factory = "0x000000006551c19487814612e58fe06813775758";
const mechMastercopy = "0xc62046fbbcf02725949afeab16dcf75f5066e2bb";
const railgunNeuralLink = "0x4529bd704852b3e4b7d043ea1f866dd2443844ce";

function chainId() {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];
  return chainId;
}

function tokenId() {
  return BigInt(
    keccak256(
      getCurrentEthersWallet().signMessageSync("RailgunNeuralLink tokenId"),
    ),
  );
}

export default {
  railgunSmartWallet: () => ({
    address: RailgunProxyContract[getCurrentNetwork()].toLowerCase(),
  }),
  relayAdapt: () => ({
    address: RelayAdaptContract[getCurrentNetwork()].toLowerCase(),
  }),
  mech: () => ({
    address: predictMechAddress({
      factory: erc6551Factory,
      chainId: chainId(),
      mastercopy: mechMastercopy,
      tokenAddress: railgunNeuralLink,
      tokenId: tokenId(),
    }),
    tokenAddress: railgunNeuralLink,
    tokenId: tokenId(),
  }),
};

export function mechDeploymentTx() {
  return {
    to: erc6551Factory,
    data: encodeMechCreate({
      salt: ZeroHash,
      mastercopy: mechMastercopy,
      chainId: chainId(),
      tokenAddress: railgunNeuralLink,
      tokenId: tokenId(),
    }),
  };
}
