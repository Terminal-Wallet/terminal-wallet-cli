import {
  RailgunProxyContract,
  RelayAdaptContract,
} from "@railgun-community/shared-models";

import { getCurrentNetwork } from "../engine/engine";
import configDefaults from "../config/config-defaults";

import { encodeMechCreate, predictMechAddress } from "./encode";

// universal addresses:
const erc6551Factory = "0x000000006551c19487814612e58fe06813775758";
const mechMastercopy = "0xc62046fbbcf02725949afeab16dcf75f5066e2bb";
const railgunNeuralLink = "0xd53c76d176c45f93bd86da63842abbc6d467c3ea";

function chainId() {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];
  return chainId;
}

export default {
  railgunSmartWallet: () => ({
    address: RailgunProxyContract[getCurrentNetwork()].toLowerCase(),
  }),
  relayAdapt: () => ({
    address: RelayAdaptContract[getCurrentNetwork()].toLowerCase(),
  }),
  railgunNeuralLink,
  mech: (tokenId: bigint) => ({
    address: predictMechAddress({
      factory: erc6551Factory,
      chainId: chainId(),
      mastercopy: mechMastercopy,
      tokenAddress: railgunNeuralLink,
      tokenId,
    }),
    tokenAddress: railgunNeuralLink,
    tokenId,
  }),
};

export function mechDeploymentTx(tokenId: bigint) {
  return {
    to: erc6551Factory,
    data: encodeMechCreate({
      mastercopy: mechMastercopy,
      chainId: chainId(),
      tokenAddress: railgunNeuralLink,
      tokenId,
    }),
  };
}
