import {
  getSerializedNFTBalances,
  walletForID,
} from "@railgun-community/wallet";
import {
  Chain,
  ChainType,
  TXIDVersion,
} from "@railgun-community/shared-models";

import { getCurrentRailgunID } from "../../wallet/wallet-util";

import { getCurrentNetwork } from "../../engine/engine";

import { mechAddress, nftAddress } from "../deployments";
import { getCurrentEthersWallet } from "../../wallet/public-utils";

/*
 *
 * Based on the calculations of what the current deterministic mech ought to be
 * it checks whether the respective NeuralLink NFT is shielded, and whether it
 * is spendable. The SDK has some deep dependencies requiring POI to be produced
 * before allowing unshielding
 *
 */
export async function mechStatus(): Promise<{
  address: string;
  tokenAddress: string;
  isMechDeployed: boolean;
  isNFTShielded: boolean;
  isNFTSpendable: boolean;
}> {
  const wallet = getCurrentEthersWallet();
  const address = mechAddress();
  const code = await wallet.provider?.getCode(address);

  const { isNFTShielded, isNFTSpendable } = await nftStatus();

  return {
    address,
    tokenAddress: nftAddress(),
    isMechDeployed: !!code && code != "0x",
    isNFTShielded,
    isNFTSpendable,
  };
}

async function nftStatus(): Promise<{
  isNFTShielded: boolean;
  isNFTSpendable: boolean;
}> {
  const wallet = walletForID(getCurrentRailgunID());

  const tokenAddress = nftAddress().toLowerCase();
  const tokenId = BigInt(mechAddress());

  const isFound = async (spendable: boolean) => {
    const balances = await wallet.getTokenBalances(
      TXIDVersion.V2_PoseidonMerkle,
      getCurrentChain(),
      spendable,
    );
    const myNFTs = getSerializedNFTBalances(balances);
    return myNFTs.some(
      (e) =>
        e.nftAddress.toLowerCase() == tokenAddress &&
        BigInt(e.tokenSubID) == tokenId,
    );
  };

  if (await isFound(true)) {
    return {
      isNFTShielded: true,
      isNFTSpendable: true,
    };
  } else if (await isFound(false)) {
    return {
      isNFTShielded: true,
      isNFTSpendable: false,
    };
  } else {
    return {
      isNFTShielded: false,
      isNFTSpendable: false,
    };
  }
}

function getCurrentChain(): Chain {
  const network = getCurrentNetwork();

  const ids = {
    Ethereum: 1,
    BNB_Chain: 56,
    Polygon: 137,
    Arbitrum: 42161,
    Ethereum_Sepolia: 11155111,
    Polygon_Amoy: 80002,
  };

  const id = (ids as any)[network];
  if (!id) {
    throw new Error(`Network not found ${name}`);
  }

  return { id, type: ChainType.EVM };
}
