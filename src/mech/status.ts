import { WalletBalanceBucket } from "@railgun-community/engine";

import { walletForID } from "@railgun-community/wallet";
import { ChainType, TXIDVersion } from "@railgun-community/shared-models";
import { getCurrentEthersWallet } from "../wallet/public-utils";

import { getCurrentRailgunID } from "../wallet/wallet-util";
import configDefaults from "../config/config-defaults";
import { getCurrentNetwork } from "../engine/engine";

import deployments from "./deployments";

export async function findAvailableMech() {
  const entries = await status();

  return entries.find(
    (e) =>
      e.isMechDeployed &&
      e.isNFTShielded &&
      !e.isNFTBlocked &&
      !e.isNFTSpendable,
  );
}

export async function status(): Promise<
  Array<{
    mechAddress: string;
    tokenAddress: string;
    tokenId: bigint;
    isMechDeployed: boolean;
    isNFTShielded: boolean;
    isNFTSpendable: boolean;
    isNFTBlocked: boolean;
  }>
> {
  const { railgunNeuralLink } = deployments;

  const result: Array<{
    mechAddress: string;
    tokenAddress: string;
    tokenId: bigint;
    isMechDeployed: boolean;
    isNFTShielded: boolean;
    isNFTSpendable: boolean;
    isNFTBlocked: boolean;
  }> = [];

  const { provider } = getCurrentEthersWallet();
  if (!provider) throw new Error("Couldnt get provider");

  for (const entry of await bucketBalancesForToken(railgunNeuralLink)) {
    const mech = deployments.mech(entry.tokenId);

    const code = await provider.getCode(mech.address);
    const isMechDeployed = !!code && code != "0x";

    result.push({
      mechAddress: mech.address,
      tokenAddress: railgunNeuralLink,
      tokenId: entry.tokenId,
      isNFTShielded: true,
      isNFTSpendable: entry.bucket === WalletBalanceBucket.Spendable,
      isNFTBlocked: entry.bucket === WalletBalanceBucket.ShieldBlocked,

      isMechDeployed,
    });
  }

  return result;
}

async function bucketBalancesForToken(tokenAddress: string): Promise<
  {
    bucket: WalletBalanceBucket;
    tokenAddress: string;
    tokenId: bigint;
  }[]
> {
  const wallet = walletForID(getCurrentRailgunID());

  const balancesByBucket = await wallet.getTokenBalancesByBucket(
    TXIDVersion.V2_PoseidonMerkle,
    { id: chainId(), type: ChainType.EVM },
  );

  return Object.entries(balancesByBucket).flatMap(([bucket, balances]) => {
    return Object.values(balances)
      .filter(
        ({ balance, tokenData }) =>
          tokenAddress === tokenData.tokenAddress.toLowerCase() &&
          BigInt(1) === BigInt(balance),
      )
      .map(({ tokenData }) => ({
        bucket: bucket as WalletBalanceBucket,
        tokenAddress: tokenData.tokenAddress,
        tokenId: BigInt(tokenData.tokenSubID),
      }));
  });
}

function chainId() {
  const { chainId } = configDefaults.networkConfig[getCurrentNetwork()];
  return chainId;
}
