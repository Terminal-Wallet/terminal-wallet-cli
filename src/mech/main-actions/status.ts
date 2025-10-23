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

import {
  mechAddress,
  mechDeploymentSalt,
  nftAddress,
  nftTokenId,
  relayAdaptAddress,
} from "../deployments";
import { getCurrentEthersWallet } from "../../wallet/public-utils";
import { WalletBalanceBucket } from "@railgun-community/engine";
import { Interface, ZeroAddress } from "ethers";

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
  isNFTMinted: boolean;
  isNFTShielded: boolean;
  isNFTSpendable: boolean;
  isNFTBlocked: boolean;
}> {
  const wallet = getCurrentEthersWallet();
  const address = mechAddress();
  const code = await wallet.provider?.getCode(address);

  const { pending, spendable, blocked, minted } = await nftStatus();

  return {
    address,
    tokenAddress: nftAddress(),
    isMechDeployed: !!code && code != "0x",
    isNFTMinted: minted,
    isNFTSpendable: spendable,
    isNFTShielded: spendable || pending,
    isNFTBlocked: blocked,
  };
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

async function nftStatus() {
  const wallet = walletForID(getCurrentRailgunID());

  const balancesByBucket = await wallet.getTokenBalancesByBucket(
    TXIDVersion.V2_PoseidonMerkle,
    getCurrentChain(),
  );

  const _isMinted = await isMinted();

  const tokenAddress = nftAddress().toLowerCase();
  const tokenId = nftTokenId();

  const collect = (bucket: WalletBalanceBucket) =>
    !!balancesByBucket[bucket] &&
    Object.values(balancesByBucket[bucket]).some(
      (bucket) =>
        BigInt(bucket.balance) === BigInt(1) &&
        bucket.tokenData.tokenAddress.toLowerCase() === tokenAddress &&
        BigInt(bucket.tokenData.tokenSubID) === tokenId,
    );

  return {
    minted: _isMinted,
    spendable: collect(WalletBalanceBucket.Spendable),
    pending:
      collect(WalletBalanceBucket.MissingExternalPOI) ||
      collect(WalletBalanceBucket.MissingInternalPOI) ||
      collect(WalletBalanceBucket.ShieldPending),
    blocked: collect(WalletBalanceBucket.ShieldBlocked),
  };
}

async function isMinted() {
  // so far we do onwerOf, final contracgt will feature different call

  // Create an Interface for ownerOf(uint256) — exact signature matters
  const iface = new Interface([
    "function ownerOf(uint256 tokenId) view returns (address)",
  ]);

  // Encode calldata
  const data = iface.encodeFunctionData("ownerOf", [nftTokenId()]);

  // eth_call (read-only)
  const result = await getCurrentEthersWallet().provider?.call({
    to: nftAddress(),
    data: data,
  });
  if (!result) throw new Error("Could not load Owner");

  // Decode result
  const [owner] = iface.decodeFunctionResult("ownerOf", result);
  return owner.toLowerCase() !== ZeroAddress;
}
