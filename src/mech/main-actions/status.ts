import { Interface, ZeroAddress } from "ethers";
import { WalletBalanceBucket } from "@railgun-community/engine";

import { walletForID } from "@railgun-community/wallet";
import { ChainType, TXIDVersion } from "@railgun-community/shared-models";

import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getCurrentNetwork } from "../../engine/engine";
import { getCurrentEthersWallet } from "../../wallet/public-utils";
import deployments from "../deployments";
import configDefaults from "../../config/config-defaults";

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
  const mech = deployments.mech();
  try {
    const wallet = getCurrentEthersWallet();
    const code = await wallet.provider?.getCode(mech.address);

    const { pending, spendable, blocked, minted } = await nftStatus();

    return {
      address: mech.address,
      tokenAddress: mech.tokenAddress,
      isMechDeployed: !!code && code != "0x",
      isNFTMinted: minted,
      isNFTSpendable: spendable,
      isNFTShielded: spendable || pending,
      isNFTBlocked: blocked,
    };
  } catch (e) {
    console.log(e);
    throw e;
  }
}

async function nftStatus() {
  const wallet = walletForID(getCurrentRailgunID());

  const balancesByBucket = await wallet.getTokenBalancesByBucket(
    TXIDVersion.V2_PoseidonMerkle,
    { id: chainId(), type: ChainType.EVM },
  );

  const mech = deployments.mech();

  const _isMinted = await isMinted();

  const { tokenAddress, tokenId } = mech;

  const collect = (bucket: WalletBalanceBucket) =>
    !!balancesByBucket[bucket] &&
    Object.values(balancesByBucket[bucket]).some(
      (bucket) =>
        BigInt(1) === BigInt(bucket.balance) &&
        tokenAddress === bucket.tokenData.tokenAddress.toLowerCase() &&
        tokenId === BigInt(bucket.tokenData.tokenSubID),
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
  const mech = deployments.mech();
  // so far we do onwerOf, final contracgt will feature different call

  // Create an Interface for ownerOf(uint256) — exact signature matters
  const iface = new Interface([
    "function ownerOf(uint256 tokenId) view returns (address)",
  ]);

  // Encode calldata
  const data = iface.encodeFunctionData("ownerOf", [mech.tokenId]);

  // eth_call (read-only)
  const result = await getCurrentEthersWallet().provider?.call({
    to: mech.tokenAddress,
    data: data,
  });
  if (!result) throw new Error("Could not load Owner");

  // Decode result
  const [owner] = iface.decodeFunctionResult("ownerOf", result);
  return owner.toLowerCase() !== ZeroAddress;
}

function chainId() {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];
  return chainId;
}
